#!/usr/bin/env tsx

import { promises as fs } from 'fs';
import * as fsExtra from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';

interface MetadataFile {
  entityId?: string;
  [key: string]: any;
}

interface AnalysisResult {
  file: string;
  currentEntityId: string | undefined;
  expectedEntityId: string;
  needsUpdate: boolean;
  domain: string;
}

async function analyzeEntityIds(targetEntityId: string): Promise<AnalysisResult[]> {
  console.log(`🔍 Analyzing metadata.json files for entity: ${targetEntityId}`);
  console.log('='.repeat(60));

  // Find all metadata.json files in folders matching the target entity ID
  const pattern = `data/**/*${targetEntityId}*/metadata.json`;
  const metadataFiles = await glob(pattern);

  if (metadataFiles.length === 0) {
    console.log(`❌ No metadata.json files found for entity: ${targetEntityId}`);
    return [];
  }

  console.log(`📁 Found ${metadataFiles.length} metadata.json files:`);
  metadataFiles.forEach(file => console.log(`   - ${file}`));
  console.log();

  const results: AnalysisResult[] = [];

  for (const file of metadataFiles) {
    try {
      // Extract domain from file path
      const pathParts = file.split('/');
      const domainIndex = pathParts.findIndex(part => part === 'environmental-schools' || part === 'environmental-municipal');
      const domain = domainIndex >= 0 && domainIndex + 1 < pathParts.length ? pathParts[domainIndex + 1] : 'unknown';

      // Read and parse metadata file
      const fileContent = await fs.readFile(file, 'utf-8');
      const metadata: MetadataFile = JSON.parse(fileContent);
      const currentEntityId = metadata.entityId;
      const needsUpdate = currentEntityId !== targetEntityId;

      results.push({
        file,
        currentEntityId,
        expectedEntityId: targetEntityId,
        needsUpdate,
        domain
      });

      // Log result
      if (needsUpdate) {
        console.log(`❌ ${domain.toUpperCase()} DOMAIN - MISMATCH:`);
        console.log(`   File: ${file}`);
        console.log(`   Current: "${currentEntityId}"`);
        console.log(`   Expected: "${targetEntityId}"`);
      } else {
        console.log(`✅ ${domain.toUpperCase()} DOMAIN - CORRECT:`);
        console.log(`   File: ${file}`);
        console.log(`   EntityId: "${currentEntityId}"`);
      }
      console.log();

    } catch (error) {
      console.error(`❌ Error reading ${file}:`, error);
      results.push({
        file,
        currentEntityId: undefined,
        expectedEntityId: targetEntityId,
        needsUpdate: true,
        domain: 'error'
      });
    }
  }

  return results;
}

async function fixEntityIds(results: AnalysisResult[], dryRun: boolean = true): Promise<void> {
  const needsUpdate = results.filter(r => r.needsUpdate);
  
  if (needsUpdate.length === 0) {
    console.log('🎉 All entityId values are correct! No updates needed.');
    return;
  }

  console.log('🔧 SUMMARY:');
  console.log('='.repeat(60));
  console.log(`Files that need updates: ${needsUpdate.length}`);
  console.log(`Files that are correct: ${results.length - needsUpdate.length}`);
  console.log();

  if (dryRun) {
    console.log('🔍 DRY RUN MODE - No files will be modified');
    console.log('To actually fix the files, run: npm run check-entity-ids -- --fix');
  } else {
    console.log('🔧 FIXING MODE - Updating files...');
    
    for (const result of needsUpdate) {
      if (result.currentEntityId === undefined) {
        console.log(`⚠️  Skipping ${result.file} - could not read file`);
        continue;
      }

      try {
        // Read, update, and write back the metadata
        const fileContent = await fs.readFile(result.file, 'utf-8');
        const metadata = JSON.parse(fileContent);
        metadata.entityId = result.expectedEntityId;
        await fs.writeFile(result.file, JSON.stringify(metadata, null, 2));
        
        console.log(`✅ Updated ${result.file}`);
        console.log(`   Changed "${result.currentEntityId}" → "${result.expectedEntityId}"`);
      } catch (error) {
        console.error(`❌ Failed to update ${result.file}:`, error);
      }
    }
  }

  console.log();
}

async function main() {
  const args = process.argv.slice(2);
  const targetEntityId = args[0] || 'NY-KatonahLewisboro-CSD';
  const shouldFix = args.includes('--fix');

  console.log('🔧 Entity ID Checker & Fixer');
  console.log('='.repeat(60));
  console.log(`Target Entity: ${targetEntityId}`);
  console.log(`Mode: ${shouldFix ? 'FIX' : 'DRY RUN'}`);
  console.log();

  try {
    const results = await analyzeEntityIds(targetEntityId);
    
    if (results.length > 0) {
      await fixEntityIds(results, !shouldFix);
    }

    console.log('='.repeat(60));
    console.log('✅ Analysis complete!');
    
    if (!shouldFix && results.some(r => r.needsUpdate)) {
      console.log('💡 To fix the issues found, run:');
      console.log(`   tsx scripts/utils/checkEntityIds.ts ${targetEntityId} --fix`);
    }

  } catch (error) {
    console.error('❌ Script failed:', error);
    process.exit(1);
  }
}

// Handle direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { analyzeEntityIds, fixEntityIds };