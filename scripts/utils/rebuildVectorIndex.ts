#!/usr/bin/env tsx

import { VectorService } from '../server/services/vectorService.js';
import fs from 'fs-extra';
import path from 'path';

/**
 * Completely rebuild the vector index by clearing it and re-indexing all cleaned statute files
 */
class VectorIndexRebuilder {
  private vectorService: VectorService;

  constructor() {
    this.vectorService = new VectorService();
  }

  /**
   * Clear the entire Pinecone index
   */
  async clearIndex(): Promise<void> {
    try {
      console.log('🗑️  Clearing entire Pinecone index...');
      
      const { Pinecone } = await import('@pinecone-database/pinecone');
      const pinecone = new Pinecone({
        apiKey: process.env.PINECONE_API_KEY!,
      });
      
      const indexName = 'ordinizer-statutes';
      const index = pinecone.index(indexName);
      
      // Delete all vectors in the index
      await index.deleteAll();
      console.log('✅ Pinecone index cleared completely');
      
      // Wait a moment for the deletion to propagate
      await new Promise(resolve => setTimeout(resolve, 2000));
      
    } catch (error) {
      console.error('❌ Error clearing index:', error);
      throw error;
    }
  }

  /**
   * Find all statute files that need to be indexed
   */
  async findStatuteFiles(): Promise<{municipality: string, domain: string, path: string}[]> {
    const dataDir = path.join(process.cwd(), 'data');
    const statuteFiles: {municipality: string, domain: string, path: string}[] = [];
    
    console.log('🔍 Scanning for statute files...');

    const domains = await fs.readdir(dataDir, { withFileTypes: true });
    
    for (const domain of domains.filter(d => d.isDirectory())) {
      const domainPath = path.join(dataDir, domain.name);
      const municipalities = await fs.readdir(domainPath, { withFileTypes: true });
      
      for (const municipality of municipalities.filter(m => m.isDirectory())) {
        const statutePath = path.join(domainPath, municipality.name, 'statute.txt');
        
        if (await fs.pathExists(statutePath)) {
          statuteFiles.push({
            municipality: municipality.name,
            domain: domain.name,
            path: statutePath
          });
        }
      }
    }

    console.log(`📊 Found ${statuteFiles.length} statute files to index`);
    return statuteFiles;
  }

  /**
   * Check if a statute file contains navigation content
   */
  private hasNavigationContent(content: string): boolean {
    const navigationPatterns = [
      /^home$/im,
      /^print$/im,
      /^email$/im,
      /^share$/im,
      /arrow_/i,
      /add_alert/i,
      /get updates/i,
    ];

    return navigationPatterns.some(pattern => pattern.test(content));
  }

  /**
   * Re-index all statute files
   */
  async reindexAll(): Promise<void> {
    const statuteFiles = await this.findStatuteFiles();
    
    let indexed = 0;
    let skipped = 0;
    let errors = 0;

    console.log('\n🔄 Re-indexing all statute files...\n');

    for (const {municipality, domain, path: statutePath} of statuteFiles) {
      try {
        const content = await fs.readFile(statutePath, 'utf-8');
        
        // Skip files that still contain navigation content
        if (this.hasNavigationContent(content)) {
          console.log(`⚠️  Skipping ${municipality}/${domain} - still contains navigation content`);
          skipped++;
          continue;
        }

        // Skip very short files (likely incomplete)
        if (content.trim().length < 100) {
          console.log(`⚠️  Skipping ${municipality}/${domain} - file too short (${content.length} chars)`);
          skipped++;
          continue;
        }

        console.log(`📄 Indexing ${municipality}/${domain}...`);
        await this.vectorService.indexStatute(municipality, domain, content);
        indexed++;
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        console.error(`❌ Error indexing ${municipality}/${domain}:`, error.message);
        errors++;
      }
    }

    console.log('\n🎉 Vector index rebuild complete!');
    console.log(`✅ Successfully indexed: ${indexed} statute files`);
    console.log(`⚠️  Skipped (contaminated/short): ${skipped} statute files`);
    console.log(`❌ Errors: ${errors} statute files`);
    
    if (skipped > 0) {
      console.log('\n💡 Note: Some files were skipped because they still contain navigation content.');
      console.log('   Run the navigation cleanup scripts first to clean these files.');
    }
  }

  /**
   * Main rebuild process
   */
  async rebuild(): Promise<void> {
    console.log('🚀 Starting complete vector index rebuild...\n');
    
    try {
      // Step 1: Clear the index
      await this.clearIndex();
      
      // Step 2: Re-index all cleaned statute files
      await this.reindexAll();
      
      console.log('\n✅ Vector index rebuild completed successfully!');
      console.log('🎯 All duplicate and contaminated chunks have been removed.');
      console.log('📊 Vector database now contains only clean, legal content.');
      
    } catch (error) {
      console.error('\n❌ Error during vector index rebuild:', error);
      throw error;
    }
  }
}

// Run the rebuild if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const rebuilder = new VectorIndexRebuilder();
  rebuilder.rebuild().catch(console.error);
}

export { VectorIndexRebuilder };