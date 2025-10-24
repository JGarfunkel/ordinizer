#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';
import { execSync } from 'child_process';

// List of municipalities that had successful HTML conversions
const convertedMunicipalities = [
  'NY-Ardsley-Village', // Already good
  'NY-Bronxville-Village', // 86,550 → 6,217
  'NY-Croton-on-Hudson-Village', // 125,547 → 11,765  
  'NY-Irvington-Village', // 196,010 → 27,369
  'NY-NewCastle-Town', // Now has proper plain text
  'NY-NewRochelle-City', // 90,432 → 12,343
  'NY-NorthCastle-Town', // 128,481 → 18,277
  'NY-Yonkers-City', // 122,461 → 12,928
  'NY-Yorktown-Town' // 122,461 → 12,928
];

async function regenerateAnalyses() {
  console.log('🔄 Regenerating analyses for municipalities with converted HTML...');
  
  for (const municipality of convertedMunicipalities) {
    const analysisPath = path.join(process.cwd(), '..', 'data', 'property-maintenance', municipality, 'analysis.json');
    
    // Delete existing analysis to force regeneration
    if (await fs.pathExists(analysisPath)) {
      await fs.remove(analysisPath);
      console.log(`🗑️  Deleted existing analysis for ${municipality}`);
    }
    
    try {
      // Run analysis for this specific municipality
      console.log(`🔍 Regenerating analysis for ${municipality}...`);
      const result = execSync(`tsx analyzeStatutes.ts --domain="Property Maintenance" --municipality="${municipality}"`, {
        cwd: path.join(process.cwd()),
        encoding: 'utf-8',
        timeout: 60000 // 1 minute timeout per municipality
      });
      
      console.log(`✅ ${municipality}: Analysis regenerated successfully`);
    } catch (error) {
      console.error(`❌ ${municipality}: Failed to regenerate analysis:`, error.message);
    }
  }
  
  console.log('🎉 Analysis regeneration complete!');
}

regenerateAnalyses().catch(console.error);