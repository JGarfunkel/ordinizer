#!/usr/bin/env tsx

import { VectorService } from '../server/services/vectorService.js';
import fs from 'fs-extra';
import path from 'path';

/**
 * Clean up vector database by removing chunks containing navigation content
 * and re-indexing with cleaned statute files
 */
class VectorDatabaseCleaner {
  private vectorService: VectorService;

  constructor() {
    this.vectorService = new VectorService();
  }

  /**
   * Check if content contains navigation patterns
   */
  private hasNavigationContent(content: string): boolean {
    const navigationPatterns = [
      /^home\s*home/i,
      /^home\s*\n\s*home/i,
      /^code\s*\n\s*code/i,
      /print\s*\n\s*print/i,
      /email\s*\n\s*email/i,
      /share\s*\n\s*share/i,
      /arrow_back/i,
      /arrow_forward/i,
      /get updates/i,
      /add alert/i,
      /public documents/i,
      /laws \(\d+\)/i,
      /minutes \(\d+\)/i,
      /agendas \(\d+\)/i,
      /help\s*\n\s*help/i,
      /search\s*\n\s*search/i,
      /login\s*\n\s*login/i,
    ];

    return navigationPatterns.some(pattern => pattern.test(content));
  }

  /**
   * Scan all municipalities and domains to find contaminated chunks
   */
  async findContaminatedChunks(): Promise<{municipality: string, domain: string}[]> {
    const dataDir = path.join(process.cwd(), 'data');
    const contaminated: {municipality: string, domain: string}[] = [];
    
    console.log('🔍 Scanning for municipalities with statute files...\n');

    const domains = await fs.readdir(dataDir, { withFileTypes: true });
    
    for (const domain of domains.filter(d => d.isDirectory())) {
      const domainPath = path.join(dataDir, domain.name);
      const municipalities = await fs.readdir(domainPath, { withFileTypes: true });
      
      for (const municipality of municipalities.filter(m => m.isDirectory())) {
        const statutePath = path.join(domainPath, municipality.name, 'statute.txt');
        
        if (await fs.pathExists(statutePath)) {
          contaminated.push({
            municipality: municipality.name,
            domain: domain.name
          });
        }
      }
    }

    console.log(`📊 Found ${contaminated.length} municipality/domain combinations with statute files`);
    return contaminated;
  }

  /**
   * Re-index a cleaned statute file
   */
  async reindexStatute(municipalityId: string, domainId: string): Promise<boolean> {
    try {
      const statutePath = path.join(process.cwd(), 'data', domainId, municipalityId, 'statute.txt');
      
      if (!await fs.pathExists(statutePath)) {
        console.log(`⚠️  No statute file found for ${municipalityId}/${domainId}`);
        return false;
      }

      const statuteContent = await fs.readFile(statutePath, 'utf-8');
      
      // Check if the cleaned file still has navigation content
      if (this.hasNavigationContent(statuteContent)) {
        console.log(`⚠️  ${municipalityId}/${domainId} still contains navigation content - skipping`);
        return false;
      }

      console.log(`🔄 Re-indexing ${municipalityId}/${domainId}...`);
      await this.vectorService.indexStatute(municipalityId, domainId, statuteContent);
      console.log(`✅ Successfully re-indexed ${municipalityId}/${domainId}`);
      
      return true;
    } catch (error) {
      console.error(`❌ Error re-indexing ${municipalityId}/${domainId}:`, error);
      return false;
    }
  }

  /**
   * Main cleanup process
   */
  async cleanup(): Promise<void> {
    console.log('🧹 Starting Vector Database Cleanup...\n');
    
    try {
      // Find all municipality/domain combinations
      const combinations = await this.findContaminatedChunks();
      
      let reindexed = 0;
      let skipped = 0;
      let errors = 0;

      console.log('\n🔄 Re-indexing statute files with cleaned content...\n');

      for (const {municipality, domain} of combinations) {
        const success = await this.reindexStatute(municipality, domain);
        
        if (success) {
          reindexed++;
        } else {
          const statutePath = path.join(process.cwd(), 'data', domain, municipality, 'statute.txt');
          if (await fs.pathExists(statutePath)) {
            const content = await fs.readFile(statutePath, 'utf-8');
            if (this.hasNavigationContent(content)) {
              skipped++;
            } else {
              errors++;
            }
          } else {
            skipped++;
          }
        }

        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      console.log('\n🎉 Vector Database Cleanup Complete!');
      console.log(`✅ Successfully re-indexed: ${reindexed} statute files`);
      console.log(`⚠️  Skipped (still contaminated): ${skipped} statute files`);
      console.log(`❌ Errors: ${errors} statute files`);
      
      if (skipped > 0) {
        console.log('\n💡 Note: Some files were skipped because they still contain navigation content.');
        console.log('   Run the navigation cleanup scripts first, then retry this vector cleanup.');
      }

    } catch (error) {
      console.error('❌ Error during vector database cleanup:', error);
      throw error;
    }
  }
}

// Run the cleanup if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const cleaner = new VectorDatabaseCleaner();
  cleaner.cleanup().catch(console.error);
}

export { VectorDatabaseCleaner };