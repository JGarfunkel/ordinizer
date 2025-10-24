#!/usr/bin/env tsx

import { Pinecone } from '@pinecone-database/pinecone';

interface ChunkResult {
  id: string;
  content: string;
  metadata: {
    municipalityId: string;
    domainId: string;
    chunkIndex: number;
    section?: string;
  };
  similarity?: number;
}

class PineconeChunksRetriever {
  private pinecone: Pinecone;
  private indexName = 'ordinizer-statutes';
  
  constructor() {
    if (!process.env.PINECONE_API_KEY) {
      throw new Error('PINECONE_API_KEY environment variable is required');
    }
    
    this.pinecone = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY,
    });
  }

  /**
   * Retrieve all chunks for a specific municipality and domain
   */
  async getChunks(municipalityId: string, domainId: string): Promise<ChunkResult[]> {
    try {
      console.log(`🔍 Retrieving chunks for ${municipalityId} in domain ${domainId}...`);
      
      const index = this.pinecone.index(this.indexName);
      
      // First, get index stats to understand the structure
      const stats = await index.describeIndexStats();
      console.log(`📊 Index contains ${stats.totalRecordCount} total vectors`);
      
      // Since Pinecone doesn't have a direct "list by metadata" function,
      // we'll use a query with a dummy vector and filter by metadata
      // This is a common pattern for retrieving specific chunks
      
      // Create a dummy vector (all zeros) - we'll filter by metadata only
      const dummyVector = new Array(1536).fill(0);
      
      // Query with high topK to get all chunks for this municipality/domain
      // Try without filter first to see what data exists
      const queryResponse = await index.query({
        vector: dummyVector,
        topK: 10000, // High number to get all chunks
        includeMetadata: true
      });
      
      console.log(`📦 Retrieved ${queryResponse.matches?.length || 0} total chunks from index`);
      
      // Filter locally by municipality and domain
      const filteredMatches = queryResponse.matches?.filter(match => 
        match.metadata?.municipalityId === municipalityId && 
        match.metadata?.domainId === domainId
      );
      
      console.log(`📦 Found ${filteredMatches?.length || 0} chunks after filtering for ${municipalityId}/${domainId}`);
      
      // Debug: Show sample metadata
      if (queryResponse.matches && queryResponse.matches.length > 0) {
        console.log(`🔍 Sample metadata from first chunk:`, queryResponse.matches[0].metadata);
        
        // Show a few more examples if they exist
        const sampleMatches = queryResponse.matches.slice(0, 5);
        console.log(`🔍 Checking municipality IDs in first 5 chunks:`);
        sampleMatches.forEach((match, idx) => {
          console.log(`  ${idx + 1}: municipalityId="${match.metadata?.municipalityId}", domainId="${match.metadata?.domainId}"`);
        });
        
        // Let's also check if any GLB domain chunks exist at all
        const glbChunks = queryResponse.matches?.filter(match => match.metadata?.domainId === 'glb');
        console.log(`🔍 Found ${glbChunks?.length || 0} total GLB domain chunks in the index`);
        
        if (glbChunks && glbChunks.length > 0) {
          console.log(`🔍 GLB chunks municipalities:`, [...new Set(glbChunks.map(chunk => chunk.metadata?.municipalityId))]);
        }
        
        // Check if any chunks exist for NY-NewCastle-Town in any domain
        const newCastleChunks = queryResponse.matches?.filter(match => match.metadata?.municipalityId === 'NY-NewCastle-Town');
        console.log(`🔍 Found ${newCastleChunks?.length || 0} chunks for NY-NewCastle-Town in any domain`);
        if (newCastleChunks && newCastleChunks.length > 0) {
          console.log(`🔍 NY-NewCastle-Town domains:`, [...new Set(newCastleChunks.map(chunk => chunk.metadata?.domainId))]);
        }
      }
      
      if (!filteredMatches || filteredMatches.length === 0) {
        console.log(`❌ No chunks found for ${municipalityId}/${domainId} after filtering`);
        return [];
      }
      
      // Convert to our ChunkResult format and sort by chunkIndex
      const chunks: ChunkResult[] = filteredMatches
        .map(match => ({
          id: match.id || '',
          content: (match.metadata?.content as string) || '',
          metadata: {
            municipalityId: (match.metadata?.municipalityId as string) || '',
            domainId: (match.metadata?.domainId as string) || '',
            chunkIndex: (match.metadata?.chunkIndex as number) || 0,
            section: match.metadata?.section as string
          },
          similarity: match.score
        }))
        .sort((a, b) => a.metadata.chunkIndex - b.metadata.chunkIndex);
      
      return chunks;
      
    } catch (error) {
      console.error(`❌ Error retrieving chunks: ${error}`);
      throw error;
    }
  }

  /**
   * Get chunk statistics for a municipality/domain
   */
  async getChunkStats(municipalityId: string, domainId: string): Promise<{
    totalChunks: number;
    totalCharacters: number;
    sectionsFound: string[];
    avgChunkSize: number;
  }> {
    const chunks = await this.getChunks(municipalityId, domainId);
    
    const totalChunks = chunks.length;
    const totalCharacters = chunks.reduce((sum, chunk) => sum + chunk.content.length, 0);
    const sectionsFound = [...new Set(chunks.map(chunk => chunk.metadata.section).filter(Boolean))];
    const avgChunkSize = totalChunks > 0 ? Math.round(totalCharacters / totalChunks) : 0;
    
    return {
      totalChunks,
      totalCharacters,
      sectionsFound,
      avgChunkSize
    };
  }

  /**
   * Search for chunks containing specific text (semantic search)
   */
  async searchChunks(
    municipalityId: string, 
    domainId: string, 
    searchText: string, 
    topK: number = 5
  ): Promise<ChunkResult[]> {
    try {
      console.log(`🔍 Searching for "${searchText}" in ${municipalityId}/${domainId}...`);
      
      // We need the OpenAI client to generate embeddings
      const OpenAI = (await import('openai')).default;
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      
      // Generate embedding for search text
      const response = await openai.embeddings.create({
        model: 'text-embedding-ada-002',
        input: [searchText],
      });
      
      const searchVector = response.data[0].embedding;
      
      const index = this.pinecone.index(this.indexName);
      
      // Semantic search with metadata filtering
      const queryResponse = await index.query({
        vector: searchVector,
        topK: topK * 3, // Get more results to filter locally
        includeMetadata: true,
        filter: {
          municipalityId: { $eq: municipalityId },
          domainId: { $eq: domainId }
        }
      });
      
      console.log(`📦 Found ${queryResponse.matches?.length || 0} relevant chunks`);
      
      if (!queryResponse.matches) {
        return [];
      }
      
      // Convert and return top results
      return queryResponse.matches
        .slice(0, topK)
        .map(match => ({
          id: match.id || '',
          content: (match.metadata?.content as string) || '',
          metadata: {
            municipalityId: (match.metadata?.municipalityId as string) || '',
            domainId: (match.metadata?.domainId as string) || '',
            chunkIndex: (match.metadata?.chunkIndex as number) || 0,
            section: match.metadata?.section as string
          },
          similarity: match.score
        }));
        
    } catch (error) {
      console.error(`❌ Error searching chunks: ${error}`);
      throw error;
    }
  }

  /**
   * Display chunks in a readable format
   */
  displayChunks(chunks: ChunkResult[], showContent: boolean = true): void {
    console.log(`\n📄 Displaying ${chunks.length} chunks:\n`);
    
    chunks.forEach((chunk, index) => {
      console.log(`=== Chunk ${index + 1} (Index: ${chunk.metadata.chunkIndex}) ===`);
      console.log(`ID: ${chunk.id}`);
      console.log(`Section: ${chunk.metadata.section || 'Unknown'}`);
      if (chunk.similarity !== undefined) {
        console.log(`Similarity: ${(chunk.similarity * 100).toFixed(1)}%`);
      }
      console.log(`Length: ${chunk.content.length} characters`);
      
      if (showContent) {
        console.log(`Content:`);
        console.log(chunk.content.substring(0, 300) + (chunk.content.length > 300 ? '...' : ''));
      }
      console.log('---\n');
    });
  }
}

// Main function for CLI usage
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.log(`
Usage: tsx retrievePineconeChunks.ts <command> <municipalityId> <domainId> [options]

Commands:
  list <municipalityId> <domainId>              - List all chunks
  stats <municipalityId> <domainId>             - Show chunk statistics  
  search <municipalityId> <domainId> <text>     - Search chunks semantically

Examples:
  tsx retrievePineconeChunks.ts list NY-NewCastle-Town glb
  tsx retrievePineconeChunks.ts stats NY-NewCastle-Town glb
  tsx retrievePineconeChunks.ts search NY-NewCastle-Town glb "leaf blower hours"

Options for list command:
  --no-content    - Don't show chunk content, just metadata
    `);
    process.exit(1);
  }

  const command = args[0];
  const municipalityId = args[1];
  const domainId = args[2];
  
  const retriever = new PineconeChunksRetriever();
  
  try {
    switch (command) {
      case 'list':
        const showContent = !args.includes('--no-content');
        const chunks = await retriever.getChunks(municipalityId, domainId);
        retriever.displayChunks(chunks, showContent);
        break;
        
      case 'stats':
        const stats = await retriever.getChunkStats(municipalityId, domainId);
        console.log(`\n📊 Chunk Statistics for ${municipalityId}/${domainId}:`);
        console.log(`Total chunks: ${stats.totalChunks}`);
        console.log(`Total characters: ${stats.totalCharacters}`);
        console.log(`Average chunk size: ${stats.avgChunkSize} characters`);
        console.log(`Sections found: ${stats.sectionsFound.length > 0 ? stats.sectionsFound.join(', ') : 'None'}`);
        break;
        
      case 'search':
        if (args.length < 4) {
          console.error('Search command requires search text');
          process.exit(1);
        }
        const searchText = args.slice(3).join(' ');
        const searchResults = await retriever.searchChunks(municipalityId, domainId, searchText);
        console.log(`\n🔍 Search results for "${searchText}":`);
        retriever.displayChunks(searchResults, true);
        break;
        
      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
    
  } catch (error) {
    console.error(`❌ Error: ${error}`);
    process.exit(1);
  }
}

// Export for use in other scripts
export { PineconeChunksRetriever };

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}