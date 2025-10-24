#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';

// Add grades to metadata files that are missing them
const gradesMap = {
  // Good grades - municipalities with comprehensive property maintenance codes
  'NY-NewCastle-Town': 'Good',
  'NY-Yonkers-City': 'Good', 
  'NY-NewRochelle-City': 'Good',
  'NY-NorthCastle-Town': 'Good',
  'NY-Yorktown-Town': 'Good',
  
  // Red grades - municipalities with limited or state-only codes
  'NY-Bedford-Town': 'Red',
  'NY-Bronxville-Village': 'Red',
  'NY-Croton-on-Hudson-Village': 'Red',
  'NY-Irvington-Village': 'Red',
  'NY-Ardsley-Village': 'Red'
};

async function addGrades() {
  console.log('🏷️ Adding grades to Property Maintenance metadata files...');
  
  const domain = 'property-maintenance';
  
  for (const [municipalityId, grade] of Object.entries(gradesMap)) {
    const metadataPath = path.join(process.cwd(), '..', 'data', domain, municipalityId, 'metadata.json');
    
    if (await fs.pathExists(metadataPath)) {
      try {
        const metadata = await fs.readJson(metadataPath);
        
        if (!metadata.grade) {
          metadata.grade = grade;
          await fs.writeJson(metadataPath, metadata, { spaces: 2 });
          console.log(`✅ ${municipalityId}: Added grade "${grade}"`);
        } else {
          console.log(`✓ ${municipalityId}: Grade already exists (${metadata.grade})`);
        }
      } catch (error) {
        console.error(`❌ ${municipalityId}: Failed to update metadata -`, error.message);
      }
    } else {
      console.log(`⚠️ ${municipalityId}: Metadata file not found`);
    }
  }
  
  console.log('🎉 Grade assignment complete!');
}

addGrades().catch(console.error);