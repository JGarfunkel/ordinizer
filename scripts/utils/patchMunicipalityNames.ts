#!/usr/bin/env tsx
/**
 * Patch script to fix municipality display names in analysis.json files
 * Reads the correct name from metadata.json and updates analysis.json
 */

import fs from 'fs';
import path from 'path';

interface Metadata {
  municipality: string;
  municipalityType: string;
  domain: string;
  [key: string]: any;
}

interface AnalysisFile {
  municipality: {
    id: string;
    displayName: string;
  };
  [key: string]: any;
}

async function patchMunicipalityNames(domain: string) {
  const domainDir = path.join('data', domain);
  
  if (!fs.existsSync(domainDir)) {
    console.log(`❌ Domain directory not found: ${domainDir}`);
    return;
  }

  console.log(`🔧 Patching municipality names in ${domain} domain...`);
  
  let patchedCount = 0;
  let errorCount = 0;
  let skippedCount = 0;

  const municipalityDirs = fs.readdirSync(domainDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name)
    .filter(name => name.startsWith('NY-'));

  for (const municipalityDir of municipalityDirs) {
    const municipalityPath = path.join(domainDir, municipalityDir);
    const metadataPath = path.join(municipalityPath, 'metadata.json');
    const analysisPath = path.join(municipalityPath, 'analysis.json');

    try {
      // Check if both files exist
      if (!fs.existsSync(metadataPath)) {
        console.log(`⚠️  ${municipalityDir}: Missing metadata.json`);
        skippedCount++;
        continue;
      }

      if (!fs.existsSync(analysisPath)) {
        console.log(`⚠️  ${municipalityDir}: Missing analysis.json`);
        skippedCount++;
        continue;
      }

      // Read metadata and analysis files
      const metadata: Metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
      const analysis: AnalysisFile = JSON.parse(fs.readFileSync(analysisPath, 'utf-8'));

      // Get correct display name from metadata
      const correctDisplayName = `${metadata.municipality || 'Unknown'} - ${metadata.municipalityType || 'Municipality'}`;
      const currentDisplayName = analysis.municipality?.displayName;

      // Check if patch is needed
      if (currentDisplayName === correctDisplayName) {
        console.log(`✓ ${municipalityDir}: Already correct (${currentDisplayName})`);
        continue;
      }

      // Apply patch - handle both object and string cases
      if (!analysis.municipality) {
        analysis.municipality = {
          id: municipalityDir,
          displayName: correctDisplayName
        };
      } else if (typeof analysis.municipality === 'string') {
        // Fix malformed string municipality objects
        analysis.municipality = {
          id: municipalityDir,
          displayName: correctDisplayName
        };
      } else {
        analysis.municipality.displayName = correctDisplayName;
      }

      // Write back the patched analysis
      fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));
      
      console.log(`🔧 ${municipalityDir}: "${currentDisplayName}" → "${correctDisplayName}"`);
      patchedCount++;

    } catch (error) {
      console.error(`❌ ${municipalityDir}: Error patching - ${error}`);
      errorCount++;
    }
  }

  console.log(`\n📊 Patching complete for ${domain}:`);
  console.log(`✅ Patched: ${patchedCount}`);
  console.log(`⚠️  Skipped: ${skippedCount}`);
  console.log(`❌ Errors: ${errorCount}`);
  
  return { patched: patchedCount, skipped: skippedCount, errors: errorCount };
}

// Main execution
async function main() {
  const domain = process.argv[2];
  
  if (!domain) {
    console.log('Usage: tsx scripts/patchMunicipalityNames.ts <domain>');
    console.log('Example: tsx scripts/patchMunicipalityNames.ts trees');
    process.exit(1);
  }

  try {
    const result = await patchMunicipalityNames(domain);
    
    if (result.patched > 0) {
      console.log(`\n🎉 Successfully patched ${result.patched} municipality names!`);
      console.log('💡 The changes will take effect immediately in the UI.');
    } else {
      console.log('\n✨ All municipality names are already correct.');
    }
  } catch (error) {
    console.error(`💥 Fatal error: ${error}`);
    process.exit(1);
  }
}

// Execute main function
main();