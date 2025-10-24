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