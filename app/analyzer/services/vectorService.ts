/**
 * VectorService: Handles all interactions with the Pinecone vector database for statute storage and retrieval.
 * Includes methods for initializing the index, chunking statute text, generating embeddings, indexing statutes, and searching for relevant sections.
 * Designed for use in the ordinance analysis process to enable efficient retrieval of relevant statute sections based on user questions.	
 */
import { Pinecone, Index } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import {
  checkRateLimit,
  recordTokenUsage,
  estimateTokens,
} from "./aiService.js";

//TODO define DocumentType as a union type and use it consistently across the application
export type DocumentType = "statute" | "guidance" | "general" | "policy" | "shared";

const DELETE_MANY_SUPPORTED = false; // this should work, but it doesn't seem to be deleting vectors as expected, so we are falling back to deleteOne for now while we investigate

/**
 * Extract Section reference from the text
 * @TODO - decide where this should live
 * @param text
 * @returns 
 */
export function extractSectionReferences(text: string): string[] {
		const sectionRegex = /(?:§|Section)\s*(\d+(?:[.-]\d+)*[A-Z]*)/gi;
		const matches = [...text.matchAll(sectionRegex)];
		return [...new Set(matches.map(m => m[0]).slice(0, 3))];
	}

/**
 * Generates the document key
 * @param entityId: always required
 * @param domains ignored if documentType is "shared", but should be an array of domains for future flexibility (currently we only use the first domain for the key)
 * @param documentType: type of the document (e.g., "statute", "guidance", "general", "policy", "shared")
 * @param filename: optional filename for shared documents
 */
export function getDocumentKey(entityId: string, 
							domains?: string[], 
							documentType?: DocumentType,
							filename?: string): string {

	if (!domains) {
		return `${entityId}-shared/`;
	}						
	return documentType === "shared" ?
			`${entityId}-shared/${filename}` :
			`${entityId}-${domains[0]}/${documentType}`;
	}

/**
 * singleton pattern to ensure only one instance of VectorService is created and shared across the application
 * 
 * // TODO - decide to create multiple instances if we want to support multiple realms with different Pinecone indexes in the future, but for now a single instance is simpler and sufficient since we are only using one index. The service is designed to be flexible and easily replaceable if we want to switch to a different vector database provider in the future.
 */
const vectorMap = new Map<string, VectorService>();
export function getVectorService(realm: string) {
	if (!vectorMap.has(realm)) {
		vectorMap.set(realm, new VectorService(realm));
	}
	return vectorMap.get(realm)!;
}

export class VectorService {
	private pinecone: Pinecone;
	private indexName = '';
	private openai;
  
	constructor(realm: string) {
		this.indexName = `ordinizer-${realm}`;
		this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
		this.pinecone = new Pinecone({
			apiKey: process.env.PINECONE_API_KEY!,
		});
	}

	setVerbose(verbose: boolean) {
		// No-op for now, but could be used to control logging in the future
	}

	/**
	 * Initialize the Pinecone index for statute storage
	 */
	async initializeIndex() {
		try {
			const existingIndexes = await this.pinecone.listIndexes();
			const indexExists = existingIndexes.indexes?.some(index => index.name === this.indexName);
      
			if (!indexExists) {
				console.log(`Creating new Pinecone index: ${this.indexName}`);
				await this.pinecone.createIndex({
					name: this.indexName,
					dimension: 1536, // OpenAI text-embedding-ada-002 dimension
					metric: 'cosine',
					spec: {
						serverless: {
							cloud: 'aws',
							region: 'us-east-1'
						}
					}
				});
        
				// Wait for index to be ready
				console.log('Waiting for index to be ready...');
				await this.waitForIndexReady();
				console.log(`Pinecone index ${this.indexName} is ready`);
			}
      
			return true;
		} catch (error) {
			console.error('Error initializing Pinecone index:', error);
			throw error;
		}
	}

	/**
	 * Wait for the index to be in a ready state
	 */
	private async waitForIndexReady(maxWaitTime = 60000) {
		const startTime = Date.now();
    
		while (Date.now() - startTime < maxWaitTime) {
			try {
				const indexStats = await this.getIndex().describeIndexStats();
				if (indexStats) {
					console.log('Index is ready!');
					return true;
				}
			} catch (error) {
				// Index might not be ready yet
			}
      
			await new Promise(resolve => setTimeout(resolve, 2000));
		}
    
		throw new Error('Index did not become ready within timeout period');
	}

	private getIndex() {
		return this.pinecone.index(this.indexName);
	}

	/**
	 * Check whether vectors already exist for a municipality/domain pair.
	 * Supports both current IDs (${municipalityId}-${domainId}-statute-chunk-*)
	 * and legacy IDs (${municipalityId}-${domainId}-*).
	 */
	async hasIndexedDocument(
		documentKey: string,
	): Promise<boolean> {
		try {
			await this.initializeIndex();
			const index = this.getIndex();

			const current = await index.listPaginated({ prefix: documentKey });
			if (current.vectors && current.vectors.length > 0) {
				console.log(`Pinecone contains ${current.vectors.length} vectors with prefix ${documentKey}`);
				return true;
			}

			return false;
		} catch (error) {
			console.warn(`Unable to verify vector index state for ${documentKey}:`, error);
			return false;
		}
	}

	/**
	 * Chunker specific to statutes, with intelligent splitting by paragraphs and sections to preserve 
	 * context as much as possible while fitting within token limits for embedding. 
	 * Also includes metadata for better retrieval and analysis.
	 * @param text 
	 * @param entityId 
	 * @param domainId 
	 * @returns 
	 */
	private chunkStatuteText(text: string, entityId: string, domainId: string): Array<{
		content: string;
		metadata: {
			entityId: string;
			domainId: string;
			chunkIndex: number;
			section?: string;
		};
	}> {
		const chunks: Array<{
			content: string;
			metadata: {
				entityId: string;
				domainId: string;
				chunkIndex: number;
				section?: string;
			};
		}> = [];

		// Preferred chunking: split by sentence endings with newlines for better context preservation
		let sections: string[] = [];
    
		// Primary: period followed by double newlines (paragraph boundaries)
		const doubleNewlineSections = text.split(/\.\n\s*\n/).filter(s => s.trim());
		if (doubleNewlineSections.length > 1) {
			// Add back periods where needed
			sections = doubleNewlineSections.map((section, index) => {
				return index < doubleNewlineSections.length - 1 && !section.endsWith('.') ? section + '.' : section;
			});
		} else {
			// Secondary: period followed by single newlines
			const singleNewlineSections = text.split(/\.\n/).filter(s => s.trim());
			if (singleNewlineSections.length > 1) {
				sections = singleNewlineSections.map((section, index) => {
					return index < singleNewlineSections.length - 1 && !section.endsWith('.') ? section + '.' : section;
				});
			} else {
				// Fallback: paragraph breaks only
				sections = text.split(/\n\s*\n/);
        
				// Last resort: legal sections (less preferred as it breaks up individual statutes)
				if (sections.length === 1) {
					const sectionPattern = /(?=(?:§|Section|SECTION)\s*\d+)/gi;
					sections = text.split(sectionPattern);
				}
			}
		}
    
		// If still too large, split by sentences
		if (sections.some(section => section.length > 3000)) {
			const newSections: string[] = [];
			for (const section of sections) {
				if (section.length <= 3000) {
					newSections.push(section);
				} else {
					const sentences = section.split(/(?<=[.!?])\s+/);
					let currentChunk = '';
          
					for (const sentence of sentences) {
						if (currentChunk.length + sentence.length > 1200 && currentChunk) {
							newSections.push(currentChunk.trim());
							currentChunk = sentence;
						} else {
							currentChunk += (currentChunk ? ' ' : '') + sentence;
						}
					}
          
					if (currentChunk.trim()) {
						newSections.push(currentChunk.trim());
					}
				}
			}
			sections = newSections;
		}

		// Create chunks with metadata
		sections.forEach((section, index) => {
			const trimmedSection = section.trim();
			if (trimmedSection && trimmedSection.length > 400) { // Skip very short sections
				// Extract section number if present
				const sectionMatch = trimmedSection.match(/(?:§|Section|SECTION)\s*(\d+[\w\-]*)/i);
        
				chunks.push({
					content: trimmedSection,
					metadata: {
						entityId,
						domainId,
						chunkIndex: index,
						section: sectionMatch ? sectionMatch[1] : undefined
					}
				});
			}
		});

		return chunks;
	}

	/**
	 * Generate embeddings for text chunks
	 */
	private async generateEmbeddings(texts: string[]): Promise<number[][]> {
		try {
			const embeddings = [];
      
			// Process each text individually to avoid token limit issues
			for (const text of texts) {
				// Truncate texts that are too long but still process them
				let processText = text;
				if (text.length > 8000) {
					processText = text.substring(0, 8000);
					console.log(`Truncating text from ${text.length} to ${processText.length} chars`);
				}
        
				const response = await this.openai.embeddings.create({
					model: 'text-embedding-ada-002',
					input: [processText],
				});
        
				embeddings.push(response.data[0].embedding);
        
				// Reduced rate limiting for faster processing
				await new Promise(resolve => setTimeout(resolve, 100));
			}
      
			return embeddings;
		} catch (error) {
			console.error('Error generating embeddings:', error);
			throw error;
		}
	}

	/**
	 * Compatibility wrapper for statute indexing.
	 * Prefer indexDocumentInPinecone() for all document types.
	 */
	async indexStatute(entityId: string, domainId: string, statuteText: string) {
		return this.indexDocumentInPinecone(statuteText, entityId, domainId, "statute", { url: "", fileName: "statute.txt", fetchedAt: "" });
	}

	/**
	 * Delete statute chunks from the vector database
	 * This is used if we need to re-index a statute, ensuring we don't have orphaned chunks from previous versions. 
	 * It also helps to keep the index clean and relevant.
	 * 
	 * //TODO change the parameters to be just the prefix
	 */
	async deleteIndexedChunksForDocument(
		prefix: string,
	) {
		try {
			const index = this.getIndex();

			console.log(`[deleteIndexedChunks] Listing vectors with prefix: "${prefix}"`);
			const ids: string[] = [];
			const listResponse = await index.listPaginated({ prefix });
			console.log(`[deleteIndexedChunks] listPaginated returned ${listResponse.vectors?.length ?? 0} vector(s)`);
			if (listResponse.vectors && listResponse.vectors.length > 0) {
				ids.push(...listResponse.vectors.map(v => v.id!).filter(Boolean));
			}
			const uniqueIds = [...new Set(ids)];
			console.log(`[deleteIndexedChunks] Unique IDs to delete: ${uniqueIds.length}`);
			if (uniqueIds.length > 0) {
				uniqueIds.forEach(id => console.log(`[deleteIndexedChunks]   - ${id}`));
			}

			if (uniqueIds.length > 0) {
				// Delete in small batches to avoid Pinecone API limits
				const batchSize = 10;
				for (let i = 0; i < uniqueIds.length; i += batchSize) {
					const batch = uniqueIds.slice(i, i + batchSize);
					if (DELETE_MANY_SUPPORTED) {
						try {
							await index.deleteMany({ ids: batch });
							console.log(`[deleteIndexedChunks] Deleted batch of ${batch.length}`);
						} catch (batchError) {
							console.error(`[deleteIndexedChunks] Batch delete failed, retrying individually:`, batchError);
							await this.deleteIndexedChunksByIds(index, batch);
						}
					} else {
						await this.deleteIndexedChunksByIds(index, batch);
					}
				}
			} else {
				console.log(`[deleteIndexedChunks] No vectors found for prefix "${prefix}" — nothing deleted`);
			}
		} catch (error) {
			console.error(`[deleteIndexedChunks] Error during deletion for prefix "${prefix}":`, error);
		}
	}

	async deleteIndexedChunksByIds(index: Index, batch: string[]) {
		for (const id of batch) {
			try {
				await index.deleteOne(id);
				console.log(`[deleteIndexedChunks] Deleted individually: ${id}`);
			} catch (singleError) {
				console.error(`[deleteIndexedChunks] Failed to delete ${id}:`, singleError);
			}
		}
	}

	/**
	 * Search for relevant statute sections for a given question
	 */
	async searchRelevantSections(
		municipalityId: string, 
		domainId: string, 
		question: string, 
		topK: number = 8
	): Promise<Array<{
		content: string;
		score: number;
		section?: string;
		chunkIndex: number;
	}>> {
		try {
			// Generate embedding for the question
			const questionEmbedding = await this.generateEmbeddings([question]);
      
			const index = this.getIndex();
      
			// Search for relevant sections with proper metadata filtering
			const searchResponse = await index.query({
				vector: questionEmbedding[0],
				topK: topK * 3, // Get more results to filter locally (24 total)
				includeMetadata: true
			});
      
			// Filter results locally by municipality and domain
			const filteredMatches = searchResponse.matches?.filter(match => 
				match.metadata?.municipalityId === municipalityId && 
				match.metadata?.domainId === domainId
			).slice(0, topK);
      
			return filteredMatches?.map(match => ({
				content: match.metadata?.content as string || '',
				score: match.score || 0,
				section: match.metadata?.section as string,
				chunkIndex: match.metadata?.chunkIndex as number || 0
			})) || [];
      
		} catch (error) {
			console.error(`Error searching for relevant sections:`, error);
			throw error;
		}
	}

	/**
	 * Get index statistics
	 */
	async getIndexStats() {
		try {
			const index = this.getIndex();
			return await index.describeIndexStats();
		} catch (error) {
			console.error('Error getting index stats:', error);
			return null;
		}
	}

		/** Truncate text to fit within a token budget */
	truncateToTokenLimit(text: string, maxTokens: number): string {
	const maxChars = maxTokens * 4;
	if (text.length <= maxChars) return text;
	return text.substring(0, maxChars - 100) + "\n\n[Text truncated to fit context limit...]";
	}

	/** Add domain-specific keywords to a question for better vector matching */
	enhanceQuestionForVectorSearch(question: string, domain: string): string {
	const lq = question.toLowerCase();
	let enhanced = question;
	if (domain === "property-maintenance") {
		if (lq.includes("yard") || lq.includes("landscape"))
		enhanced += " curtilage vegetation grasses brush briars 10 inches 15 feet perimeter structure uncultivated plants flowers gardens pollinator";
		if (lq.includes("penalty") || lq.includes("fine"))
		enhanced += " $200 per day violation continues penalty fine";
		if (lq.includes("timeline") || lq.includes("resolving"))
		enhanced += " 30 days 10 days certified mail notice violation hearing";
	}
	if (domain === "trees" && (lq.includes("permit") || lq.includes("removal")))
		enhanced += " tree removal permit application DBH diameter inches";
	if ((domain === "glb" || domain === "gas-leaf-blower") && (lq.includes("hours") || lq.includes("time")))
		enhanced += " 8 AM 9 AM 5 PM 6 PM hours operation blower leaf";
	return enhanced;
	}

	/** Split statute text into token-safe chunks for embedding */
	chunkText(text: string, maxChunkSize = 1000): string[] {
		const chunks: string[] = [];
		const maxTokens = 5000;
		console.log(`Starting intelligent chunking: ${text.length} characters, max chunk size: ${maxChunkSize}`);

		let sections: string[];
		const doubleNL = text.split(/\.\n\n/).filter(s => s.trim())
			.map((s, i, a) => i < a.length - 1 && !s.endsWith(".") ? s + "." : s);

		if (doubleNL.length > 1 && doubleNL.every(s => s.length < maxChunkSize)) {
			sections = doubleNL;
			console.log(`Split into ${sections.length} sections by .\\n\\n separators`);
		} else {
			const singleNL = text.split(/\.\n/).filter(s => s.trim())
			.map((s, i, a) => i < a.length - 1 && !s.endsWith(".") ? s + "." : s);
			if (singleNL.length > 1 && singleNL.some(s => s.length < maxChunkSize * 0.8)) {
			sections = singleNL;
			console.log(`Split into ${sections.length} sections by .\\n separators`);
			} else {
			sections = text.split(/(?=§\s*\d+|Section\s+\d+|SECTION\s+\d+|Article\s+[IVXLCDM]+)/i).filter(s => s.trim());
			console.log(`Split into ${sections.length} sections by § markers (fallback)`);
			}
		}

		for (let i = 0; i < sections.length; i++) {
			const section = sections[i];
			const sectionTokens = estimateTokens(section);
			if (section.length <= maxChunkSize && sectionTokens <= maxTokens) {
			chunks.push(section.trim());
			} else {
			const sentences = section.split(/(?<=[.!?])\s+/).filter(s => s.trim());
			let current = "";
			for (const sentence of sentences) {
				const proposed = current + (current ? " " : "") + sentence;
				if ((proposed.length > maxChunkSize || estimateTokens(proposed) > maxTokens) && current.trim()) {
				chunks.push(current.trim());
				current = sentence;
				} else {
				current = proposed;
				}
			}
			if (current.trim()) chunks.push(current.trim());
			}
		}

		const validated = chunks
			.filter(c => c.length > 400)
			.filter(c => {
			const t = estimateTokens(c);
			if (t > maxTokens) { console.warn(`⚠️ Filtering oversized chunk: ~${t} tokens`); return false; }
			if (c.length > 12000) { console.warn(`⚠️ Filtering large character chunk: ${c.length} chars`); return false; }
			return true;
			});

		console.log(`Chunking complete: ${chunks.length} total → ${validated.length} validated`);
		return validated;
	}

	/**
	 * Chunk, embed, and upsert a document into Pinecone.
	 *
	 * @param domains - One domain string or an array of domains. The first element
	 *   is the "primary" domain used for vector IDs and the backward-compat scalar
	 *   `domainId` metadata field. All domains are stored in the `domainIds` array
	 *   metadata field so a single set of vectors can be retrieved for any of them
	 *   via `{ domainIds: { $in: [domain] } }` filter.
	 */
	async indexDocumentInPinecone(
		documentText: string,
		entityId: string,
		domains: string | string[],
		documentType: DocumentType = "statute",
		provenance: { url: string, fileName: string, fetchedAt: string },
		dryRun = false,
	) {
	const domainList = Array.isArray(domains) ? domains : [domains];
	const primaryDomain = domainList[0];

	await this.initializeIndex();

	if (documentType === "statute") {
		if (documentText.length > 5000000) {
			console.log(`⚠️  Skipping ${entityId}/${primaryDomain} - statute file too large (${documentText.length} bytes)`);
			return;
		}
		const binaryContentRegex = /[\x00-\x08\x0E-\x1F\x7F-\x9F\u2000-\u200F\uFEFF]/;
		if (binaryContentRegex.test(documentText.substring(0, 1000))) {
			console.log(`⚠️  Skipping ${entityId}/${primaryDomain} - statute appears to contain binary data`);
			return;
		}
	}

	const prefix = getDocumentKey(entityId, domainList, documentType, provenance.fileName);
	console.debug("Generated document key prefix:", prefix);
	const alreadyIndexed = await this.hasIndexedDocument(prefix);
	if (alreadyIndexed) {
		await this.deleteIndexedChunksForDocument(prefix);
	}

	const index = this.getIndex();

	// TODO strip first line off of documentText - which would start with "# http" to the end of the line
	const firstLineEnd = documentText.indexOf("\n");
	if (firstLineEnd !== -1) {
		if (documentText.substring(0, firstLineEnd).startsWith("# http")) {
			documentText = documentText.substring(firstLineEnd + 1);
		}
	}

	const chunks = this.chunkText(documentText, 2000);
	console.log(`Indexing ${documentType} for ${entityId} [${domainList.join(", ")}]: ${chunks.length} chunks`);
	const vectors: any[] = [];

	for (let i = 0; i < chunks.length; i++) {
		let chunk = chunks[i];
		let tokenCount = estimateTokens(chunk);
		if (tokenCount > 8000) { console.warn(`⚠️ Skipping chunk ${i + 1}: exceeds embedding limit`); continue; }
		if (tokenCount > 7500) {
			chunk = chunk.substring(0, Math.floor(7500 * 3)) + "\n\n[truncated]";
			tokenCount = estimateTokens(chunk);
		}
		try {
			const estimatedChunkTokens = estimateTokens(chunk);
			await checkRateLimit(estimatedChunkTokens);
			const res = await this.openai.embeddings.create({ model: "text-embedding-3-small", input: chunk });
			recordTokenUsage(res.usage?.total_tokens || estimatedChunkTokens, estimatedChunkTokens);
			const docId = prefix + `-${i}`;
			const metadata: Record<string, any> = {
				entityId,
				domainId: primaryDomain,  // scalar — backward-compat filter
				domainIds: domainList,    // array  — use { domainIds: { $in: [d] } } to query
				documentType,
				chunkIndex: i,
				content: chunk,
				indexedAt: new Date().toISOString(),
				...(provenance || {}),
			};
			console.log(`Generated embedding for chunk ${docId}} (tokens: ${tokenCount})`);
			vectors.push({
				id: docId,
				values: res.data[0].embedding,
				metadata,
			});
		} catch (error) {
			console.error(`Error embedding chunk ${i}:`, error);
		}
	}

	if (vectors.length > 0) {
		console.log(`Planning to upsert ${vectors.length} vectors for ${entityId} [${domainList.join(", ")}]`);
		if (!dryRun) {
			await index.upsert(vectors);
			console.log(`Indexed ${vectors.length} chunks`);
		} else {
			console.log(`Dry run enabled - skipping upsert`);
		}
	}
	}

	/** Answer a question via Pinecone vector search + GPT-4o */
	/**
	 * List indexed documents in the Pinecone index.
	 * Fetches chunk-0 for each document key to retrieve metadata, up to `limit` documents.
	 */
	async listIndexedDocuments(limit = 100, prefix?: string): Promise<Array<{
		id: string;
		entityId: string;
		domainIds: string[];
		documentType: string;
		indexedAt?: string;
	}>> {
		await this.initializeIndex();
		const index = this.getIndex();

		const results: Array<{ id: string; entityId: string; domainIds: string[]; documentType: string; indexedAt?: string }> = [];
		let paginationToken: string | undefined;

		outer: while (true) {
			const response = await index.listPaginated({ limit: 100, paginationToken, ...(prefix ? { prefix } : {}) });
			const chunkZeroIds = (response.vectors ?? [])
				.map(v => v.id!)
				.filter(id => id.endsWith("-0"));

			if (chunkZeroIds.length > 0) {
				const fetched = await index.fetch(chunkZeroIds);
				for (const [vectorId, vector] of Object.entries(fetched.records ?? {})) {
					const m = vector.metadata as Record<string, any> | undefined;
					results.push({
						id: vectorId.replace(/-0$/, ""),
						entityId: m?.entityId ?? "",
						domainIds: (m?.domainIds as string[]) ?? (m?.domainId ? [m.domainId as string] : []),
						documentType: m?.documentType ?? "",
						indexedAt: m?.indexedAt,
					});
					if (results.length >= limit) break outer;
				}
			}

			paginationToken = response.pagination?.next;
			if (!paginationToken) break;
		}

		return results;
	}

	/** Answer a question via Pinecone vector search + GPT-4o */
	async getRelevantChunksForQuestion(
		question: string,
		entityId: string,
		domain: string,
		topK = 5,
		documentType?: DocumentType,
	): Promise<{ chunks: string[]; sourceRefs: string[]; tokenUsage: number }> {
		const enhanced = this.enhanceQuestionForVectorSearch(question, domain);
		const estimatedQuestionTokens = estimateTokens(enhanced);
		await checkRateLimit(estimatedQuestionTokens);
		const embedRes = await this.openai.embeddings.create({ model: "text-embedding-3-small", input: enhanced });
		const embeddingTokens = embedRes.usage?.total_tokens || estimatedQuestionTokens;
		recordTokenUsage(embeddingTokens, estimatedQuestionTokens);

		const filter: Record<string, any> = {
			entityId,
			domainIds: { $in: [domain] },
		};

		if (documentType) {
			filter.documentType = documentType;
		}

		console.log(`[DEBUG] vectorService.getRelevantChunksForQuestion: entity=${entityId}, domain=${domain}, documentType=${documentType}`);

		const searchResults = await this.getIndex().query({
			vector: embedRes.data[0].embedding,
			filter,
			topK,
			includeMetadata: true,
		});

		console.log(`[DEBUG] vectorService.getRelevantChunksForQuestion: got ${searchResults.matches?.length || 0} matches`);

		if (!searchResults.matches?.length) {
			return { chunks: [], sourceRefs: [], tokenUsage: embeddingTokens };
		}

		const chunks = searchResults.matches
			.map((m: any, idx: number) => {
				const text = m.metadata?.content || "";
				// Log metadata and preview for debugging
				console.log(`[VECTOR CHUNK] idx=${idx} score=${m.score?.toFixed(3)} chunkIndex=${m.metadata?.chunkIndex} refs=${JSON.stringify(extractSectionReferences(text))} 
								key="${m.id}" preview="${text.substring(0, 60).replace(/\n/g, ' ')}"`);

				// let's add the url to the text for better provenance in the analysis chain - we can experiment with different formats here but the goal is to make sure the model has access to the source url in a consistent way that it can learn to recognize and use effectively
				if (m.metadata?.url) {
					return `Source: ${m.metadata.url}\n\n${text}`;
				}
				return text;
			});

		const sourceRefs = extractSectionReferences(chunks.join("\n\n"));
		return { chunks, sourceRefs, tokenUsage: embeddingTokens };
	}

}

