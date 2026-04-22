import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export class VectorService {
	private pinecone: Pinecone;
	private indexName = 'ordinizer-statutes';
  
	constructor() {
		this.pinecone = new Pinecone({
			apiKey: process.env.PINECONE_API_KEY!,
		});
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
			}
      
			console.log(`Pinecone index ${this.indexName} is ready`);
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
				const indexStats = await this.pinecone.index(this.indexName).describeIndexStats();
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

	/**
	 * Split statute text into meaningful chunks
	 */
	private chunkStatuteText(text: string, municipalityId: string, domainId: string): Array<{
		content: string;
		metadata: {
			municipalityId: string;
			domainId: string;
			chunkIndex: number;
			section?: string;
		};
	}> {
		const chunks: Array<{
			content: string;
			metadata: {
				municipalityId: string;
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
						municipalityId,
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
        
				const response = await openai.embeddings.create({
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
	 * Index a statute document in the vector database
	 */
	async indexStatute(municipalityId: string, domainId: string, statuteText: string) {
		try {
			// Check for corrupted or binary files
			if (statuteText.length > 5000000) { // 5MB limit
				console.log(`⚠️  Skipping ${municipalityId}/${domainId} - file too large (${statuteText.length} bytes)`);
				return;
			}
      
			// Check for binary content (non-text characters)
			// Exclude common legal symbols like § (167), © (169), ® (174), etc.
			const binaryContentRegex = /[\x00-\x08\x0E-\x1F\x7F-\x9F\u2000-\u200F\uFEFF]/;
			if (binaryContentRegex.test(statuteText.substring(0, 1000))) {
				console.log(`⚠️  Skipping ${municipalityId}/${domainId} - appears to contain binary data`);
				return;
			}
      
			// Ensure index is ready
			await this.initializeIndex();
      
			// Delete existing chunks for this municipality/domain combination
			await this.deleteStatute(municipalityId, domainId);
      
			// Split text into chunks
			const chunks = this.chunkStatuteText(statuteText, municipalityId, domainId);
      
			if (chunks.length === 0) {
				console.log(`No valid chunks found for ${municipalityId}/${domainId}`);
				return;
			}
      
			// Process chunks silently to avoid console spam
      
			// Generate embeddings for all chunks (with truncation as needed)
			console.log(`Processing ${chunks.length} chunks for ${municipalityId}/${domainId}`);
      
			const embeddings = await this.generateEmbeddings(chunks.map(chunk => chunk.content));
			console.log(`Generated ${embeddings.length} embeddings`);
      
			// Prepare vectors for upsert
			const vectors = chunks.slice(0, embeddings.length).map((chunk, index) => ({
				id: `${municipalityId}-${domainId}-${index}`,
				values: embeddings[index],
				metadata: {
					municipalityId: municipalityId,
					municipalityName: municipalityId.replace('NY-', '').replace('-', ' '),
					domainId: domainId,
					domainName: domainId === 'weeds' ? 'Weed Management' : domainId,
					chunkIndex: index,
					section: chunk.metadata.section || '',
					content: chunk.content.substring(0, 40000), // Pinecone metadata limit
				}
			}));
      
			console.log(`Created ${vectors.length} vectors for upsert`);
      
			// Upsert in batches
			const batchSize = 100;
			const index = this.pinecone.index(this.indexName);
      
			for (let i = 0; i < vectors.length; i += batchSize) {
				const batch = vectors.slice(i, i + batchSize);
				await index.upsert(batch);
				// Batch processing silently
			}
      
			// Indexing completed silently
		} catch (error) {
			console.error(`Error indexing statute for ${municipalityId}/${domainId}:`, error);
			throw error;
		}
	}

	/**
	 * Delete statute chunks from the vector database
	 */
	async deleteStatute(municipalityId: string, domainId: string) {
		try {
			const index = this.pinecone.index(this.indexName);
      
			// Get all vectors and delete by ID pattern
			const listResponse = await index.listPaginated({
				prefix: `${municipalityId}-${domainId}-`
			});
      
			if (listResponse.vectors && listResponse.vectors.length > 0) {
				const ids = listResponse.vectors.map(v => v.id!);
        
				// Delete in small batches to avoid Pinecone API limits
				const batchSize = 10;
				for (let i = 0; i < ids.length; i += batchSize) {
					const batch = ids.slice(i, i + batchSize);
					try {
						await index.deleteMany({ ids: batch });
					} catch (batchError) {
						// Try individual deletion if batch fails
						for (const id of batch) {
							try {
								await index.deleteMany({ ids: [id] });
							} catch (singleError) {
								// Skip individual errors - might be inconsistent state
							}
						}
					}
				}
				// Deleted chunks silently
			}
		} catch (error) {
			// Skip deletion errors - might be first time indexing
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
      
			const index = this.pinecone.index(this.indexName);
      
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
			const index = this.pinecone.index(this.indexName);
			return await index.describeIndexStats();
		} catch (error) {
			console.error('Error getting index stats:', error);
			return null;
		}
	}
}

export const vectorService = new VectorService();

// ─── Standalone script-level Pinecone functions ───────────────────────────────
// These are used by the analyzer CLI (analyzeStatutes.ts) and differ from the
// server-side VectorService class above in that they use rate-limited embeddings,
// intelligent chunking, and work directly on Pinecone index handles.

import {
  checkRateLimit,
  recordTokenUsage,
  estimateTokens,
  sleep,
  QUESTION_PAUSE_MS,
  currentModel,
  extractSectionReferences,
} from "./openai.js";

let _verbose = false;
export function setVerbose(v: boolean) { _verbose = v; }
function log(message: string) { if (_verbose) console.log(`[VERBOSE] ${message}`); }

/** Conservative token estimate for legal text (~1 token per 3 chars with padding) */
export function estimateTokenCount(text: string): number {
  const base = Math.ceil(text.length / 3);
  const punct = (text.match(/[§\(\)\[\]\.,:;]/g) || []).length * 0.1;
  const nums = (text.match(/\d+/g) || []).length * 0.2;
  return Math.ceil(base + punct + nums);
}

/** Truncate text to fit within a token budget */
export function truncateToTokenLimit(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.substring(0, maxChars - 100) + "\n\n[Text truncated to fit context limit...]";
}

/** Add domain-specific keywords to a question for better vector matching */
export function enhanceQuestionForVectorSearch(question: string, domain: string): string {
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
export function chunkText(text: string, maxChunkSize = 1000): string[] {
  const chunks: string[] = [];
  const maxTokens = 5000;
  log(`Starting intelligent chunking: ${text.length} characters, max chunk size: ${maxChunkSize}`);

  let sections: string[];
  const doubleNL = text.split(/\.\n\n/).filter(s => s.trim())
    .map((s, i, a) => i < a.length - 1 && !s.endsWith(".") ? s + "." : s);

  if (doubleNL.length > 1 && doubleNL.every(s => s.length < maxChunkSize)) {
    sections = doubleNL;
    log(`Split into ${sections.length} sections by .\\n\\n separators`);
  } else {
    const singleNL = text.split(/\.\n/).filter(s => s.trim())
      .map((s, i, a) => i < a.length - 1 && !s.endsWith(".") ? s + "." : s);
    if (singleNL.length > 1 && singleNL.some(s => s.length < maxChunkSize * 0.8)) {
      sections = singleNL;
      log(`Split into ${sections.length} sections by .\\n separators`);
    } else {
      sections = text.split(/(?=§\s*\d+|Section\s+\d+|SECTION\s+\d+|Article\s+[IVXLCDM]+)/i).filter(s => s.trim());
      log(`Split into ${sections.length} sections by § markers (fallback)`);
    }
  }

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const sectionTokens = estimateTokenCount(section);
    if (section.length <= maxChunkSize && sectionTokens <= maxTokens) {
      chunks.push(section.trim());
    } else {
      const sentences = section.split(/(?<=[.!?])\s+/).filter(s => s.trim());
      let current = "";
      for (const sentence of sentences) {
        const proposed = current + (current ? " " : "") + sentence;
        if ((proposed.length > maxChunkSize || estimateTokenCount(proposed) > maxTokens) && current.trim()) {
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
      const t = estimateTokenCount(c);
      if (t > maxTokens) { console.warn(`⚠️ Filtering oversized chunk: ~${t} tokens`); return false; }
      if (c.length > 12000) { console.warn(`⚠️ Filtering large character chunk: ${c.length} chars`); return false; }
      return true;
    });

  log(`Chunking complete: ${chunks.length} total → ${validated.length} validated`);
  return validated;
}

const _scriptOpenAI = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

/** Chunk, embed, and upsert a document into Pinecone */
export async function indexDocumentInPinecone(
  documentText: string,
  municipalityId: string,
  domain: string,
  index: any,
  documentType: "statute" | "guidance" = "statute",
) {
  const chunks = chunkText(documentText, 2000);
  log(`Indexing ${documentType} for ${municipalityId}-${domain}: ${chunks.length} chunks`);
  const vectors: any[] = [];

  for (let i = 0; i < chunks.length; i++) {
    let chunk = chunks[i];
    let tokenCount = estimateTokenCount(chunk);
    log(`Chunk ${i + 1}/${chunks.length}: ${chunk.length} chars, ~${tokenCount} tokens`);
    if (tokenCount > 8000) { console.warn(`⚠️ Skipping chunk ${i + 1}: exceeds embedding limit`); continue; }
    if (tokenCount > 7500) {
      chunk = chunk.substring(0, Math.floor(7500 * 3)) + "\n\n[truncated]";
      tokenCount = estimateTokenCount(chunk);
    }
    try {
      await checkRateLimit(estimateTokens(chunk));
      const res = await _scriptOpenAI.embeddings.create({ model: "text-embedding-3-small", input: chunk });
      recordTokenUsage(res.usage?.total_tokens || estimateTokens(chunk));
      vectors.push({
        id: `${municipalityId}-${domain}-${documentType}-chunk-${i}`,
        values: res.data[0].embedding,
        metadata: { municipalityId, domainId: domain, documentType, chunkIndex: i, content: chunk },
      });
    } catch (error) {
      console.error(`Error embedding chunk ${i}:`, error);
    }
  }

  if (vectors.length > 0) {
    log(`Upserting ${vectors.length} vectors for ${municipalityId}-${domain}`);
    await index.upsert(vectors);
    log(`Indexed ${vectors.length} chunks`);
  }
}

/** Answer a question via Pinecone vector search + GPT-4o */
export async function answerQuestionWithVector(
  question: string,
  municipalityId: string,
  domain: string,
  index: any,
  existingAnswersContext = "",
  scoreInstructions?: string,
) {
  log(`Vector Q&A for ${municipalityId}-${domain}: "${question.substring(0, 100)}..."`);
  try {
    const enhanced = enhanceQuestionForVectorSearch(question, domain);
    await checkRateLimit(estimateTokens(enhanced));
    const embedRes = await _scriptOpenAI.embeddings.create({ model: "text-embedding-3-small", input: enhanced });
    const embeddingTokens = embedRes.usage?.total_tokens || estimateTokens(enhanced);
    recordTokenUsage(embeddingTokens);

    const searchResults = await index.query({
      vector: embedRes.data[0].embedding,
      filter: { municipalityId, domainId: domain },
      topK: 5,
      includeMetadata: true,
    });

    if (!searchResults.matches?.length) {
      return { answer: "Not specified in the statute.", confidence: 0, sourceRefs: [], vectorTokensUsed: embeddingTokens };
    }

    let relevantTexts = searchResults.matches
      .map((m: any, idx: number) => {
        const text = m.metadata?.content || "";
        const refs = extractSectionReferences(text);
        const refInfo = refs.length ? ` (${refs.join(", ")})` : "";
        return `--- CHUNK ${idx + 1} (score: ${m.score?.toFixed(3)}, chunk: ${m.metadata?.chunkIndex}${refInfo}) ---\n${text}`;
      })
      .join("\n\n");

    const scoreText = scoreInstructions ? `\n\nSCORING GUIDANCE: ${scoreInstructions}` : "";
    const systemPrompt = `You are analyzing municipal statutes. Based ONLY on the provided statute text, answer the user's question. If not found, respond with "Not specified in the statute." Cite section numbers when available.\n\nFocus on unique information for this specific question.${scoreText}`;
    const userPromptPrefix = `Question: ${question}\n\nRelevant statute text:\n`;
    const available = 6000 - estimateTokenCount(systemPrompt) - estimateTokenCount(userPromptPrefix);
    if (estimateTokenCount(relevantTexts) > available)
      relevantTexts = truncateToTokenLimit(relevantTexts, available);

    const userPrompt = `${userPromptPrefix}${relevantTexts}${existingAnswersContext}`;
    await checkRateLimit(estimateTokens(systemPrompt + userPrompt) + 1000);

    const answerRes = await _scriptOpenAI.chat.completions.create({
      model: currentModel || "gpt-4o",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      temperature: 0.1,
      max_tokens: 1000,
    });
    const answerTokens = answerRes.usage?.total_tokens || 1000;
    recordTokenUsage(answerTokens);
    await sleep(QUESTION_PAUSE_MS);

    const answer = answerRes.choices[0].message.content || "Not specified in the statute.";
    const avgScore = searchResults.matches.reduce((s: number, m: any) => s + (m.score || 0), 0) / searchResults.matches.length;
    const confidence = Math.max(0, Math.min(100, Math.round(avgScore * 100)));
    const sourceRefs = extractSectionReferences(relevantTexts);
    log(`Answer: ${answer.substring(0, 100)}... (confidence: ${confidence}%, ${sourceRefs.length} refs)`);
    return { answer, confidence, sourceRefs, vectorTokensUsed: answerTokens + embeddingTokens };
  } catch (error) {
    console.error("Error in vector search:", error);
    return { answer: "Not specified in the statute.", confidence: 0, sourceRefs: [], vectorTokensUsed: 0 };
  }
}