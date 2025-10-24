#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';
import { vectorService } from '../../server/services/vectorService.js';

interface Municipality {
  id: string;
  name: string;
  displayName: string;
}

interface Domain {
  id: string;
  name: string;
  displayName: string;
}

async function indexAllStatutes() {
  console.log('🔍 Starting Pinecone statute indexing...\n');

  try {
    // Load municipalities and domains
    const municipalitiesPath = path.join(process.cwd(), 'data', 'municipalities.json');
    const domainsPath = path.join(process.cwd(), 'data', 'domains.json');
    
    if (!fs.existsSync(municipalitiesPath)) {
      throw new Error(`Municipalities file not found: ${municipalitiesPath}`);
    }
    if (!fs.existsSync(domainsPath)) {
      throw new Error(`Domains file not found: ${domainsPath}`);
    }

    const municipalitiesData = JSON.parse(fs.readFileSync(municipalitiesPath, 'utf-8'));
    const domainsData = JSON.parse(fs.readFileSync(domainsPath, 'utf-8'));
    
    const municipalities: Municipality[] = municipalitiesData.municipalities || municipalitiesData;
    const domains: Domain[] = domainsData.domains || domainsData;

    console.log(`Found ${municipalities.length} municipalities and ${domains.length} domains`);

    // Initialize Pinecone index
    await vectorService.initializeIndex();

    let indexedCount = 0;
    let skippedCount = 0;

    // Process each domain
    for (const domain of domains) {
      console.log(`\n=== Processing ${domain.displayName} ===`);
      
      const domainDir = `data/${domain.id}`;
      if (!fs.existsSync(domainDir)) {
        console.log(`❌ Domain directory not found: ${domainDir}`);
        continue;
      }

      // Process each municipality for this domain
      for (const municipality of municipalities) {
        const statutePath = `${domainDir}/${municipality.id}/statute.txt`;
        
        if (!fs.existsSync(statutePath)) {
          continue; // Skip if no statute file
        }

        try {
          process.stdout.write(`📄 Indexing ${municipality.displayName} - ${domain.displayName}...`);
          
          const statuteContent = fs.readFileSync(statutePath, 'utf-8');
          
          if (statuteContent.trim().length < 100) {
            console.log(`⚠️  Skipping ${municipality.id} - statute too short`);
            skippedCount++;
            continue;
          }

          // Index the statute
          await vectorService.indexStatute(municipality.id, domain.id, statuteContent);
          indexedCount++;
          
          console.log(` ✅`);
          
          // Add delay to respect API rate limits
          await new Promise(resolve => setTimeout(resolve, 1000));
          
        } catch (error) {
          console.error(`❌ Error indexing ${municipality.id}/${domain.id}:`, error);
          skippedCount++;
        }
      }
    }

    // Get final index statistics
    console.log('\n📊 Getting final index statistics...');
    const stats = await vectorService.getIndexStats();
    if (stats) {
      console.log('Index Statistics:', stats);
    }

    console.log(`\n🎉 Indexing complete!`);
    console.log(`✅ Successfully indexed: ${indexedCount} statutes`);
    console.log(`⚠️  Skipped: ${skippedCount} statutes`);
    
  } catch (error) {
    console.error('💥 Error during indexing process:', error);
    process.exit(1);
  }
}

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  indexAllStatutes().catch(console.error);
}

export { indexAllStatutes };