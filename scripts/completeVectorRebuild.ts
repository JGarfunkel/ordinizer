#!/usr/bin/env tsx

import { VectorService } from '../server/services/vectorService.js';
import fs from 'fs-extra';
import path from 'path';

/**
 * Complete the vector index rebuild by processing all cleaned statute files
 */
async function completeVectorRebuild() {
  const vectorService = new VectorService();
  const dataDir = path.join(process.cwd(), 'data');
  
  console.log('🚀 Completing vector index rebuild...\n');
  
  try {
    // Get all statute files
    const statuteFiles: {municipality: string, domain: string, path: string}[] = [];
    const domains = await fs.readdir(dataDir, { withFileTypes: true });
    
    for (const domain of domains.filter(d => d.isDirectory())) {
      const domainPath = path.join(dataDir, domain.name);
      try {
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
      } catch (error) {
        // Skip if domain directory has issues
        continue;
      }
    }
    
    console.log(`📊 Found ${statuteFiles.length} statute files to index\n`);
    
    let indexed = 0;
    let skipped = 0;
    let errors = 0;
    
    // Process in batches to avoid overwhelming the API
    const batchSize = 5;
    for (let i = 0; i < statuteFiles.length; i += batchSize) {
      const batch = statuteFiles.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async ({municipality, domain, path: statutePath}) => {
        try {
          const content = await fs.readFile(statutePath, 'utf-8');
          
          // Skip files with navigation content or too short
          if (content.length < 100 || 
              /^home$/mi.test(content) || 
              /^print$/mi.test(content) ||
              /arrow_/i.test(content)) {
            console.log(`⚠️  Skipping ${municipality}/${domain} - contaminated or too short`);
            skipped++;
            return;
          }
          
          console.log(`📄 Indexing ${municipality}/${domain}...`);
          await vectorService.indexStatute(municipality, domain, content);
          indexed++;
          
        } catch (error) {
          console.error(`❌ Error indexing ${municipality}/${domain}:`, error.message);
          errors++;
        }
      }));
      
      // Small delay between batches
      if (i + batchSize < statuteFiles.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    console.log('\n🎉 Vector index rebuild complete!');
    console.log(`✅ Successfully indexed: ${indexed} statute files`);
    console.log(`⚠️  Skipped: ${skipped} statute files`);
    console.log(`❌ Errors: ${errors} statute files`);
    
    // Test the rebuild with NewCastle
    console.log('\n🔍 Testing rebuilt index with NewCastle trees...');
    try {
      const results = await vectorService.searchRelevantSections(
        'NY-NewCastle-Town', 
        'trees', 
        'tree removal permit application', 
        5
      );
      
      console.log(`Found ${results.length} results for NewCastle trees`);
      results.forEach((r, i) => {
        console.log(`${i+1}. Score: ${r.score.toFixed(4)} | Section: ${r.section || 'N/A'}`);
        console.log(`   Content: ${r.content.substring(0, 100)}...`);
      });
      
    } catch (error) {
      console.error('❌ Error testing NewCastle:', error.message);
    }
    
  } catch (error) {
    console.error('❌ Error during rebuild:', error);
    throw error;
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  completeVectorRebuild().catch(console.error);
}

export { completeVectorRebuild };