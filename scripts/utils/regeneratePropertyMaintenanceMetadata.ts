#!/usr/bin/env tsx

import fs from 'fs/promises';
import path from 'path';

// Municipal data with state code detection from WEN spreadsheet
const municipalities = {
  'NY-Bedford-Town': {
    name: 'Bedford',
    type: 'Town', 
    url: 'https://ecode360.com/30850200',
    usesStateCode: false,
    cellText: 'R- https://ecode360.com/30850200'
  },
  'NY-Yonkers-City': {
    name: 'Yonkers',
    type: 'City',
    url: 'https://ecode360.com/6852033#6852038', 
    usesStateCode: true,
    cellText: 'R-ny state'
  },
  'NY-WhitePlains-City': {
    name: 'White Plains',
    type: 'City',
    url: 'https://library.municode.com/ny/white_plains/codes/code_of_ordinances?nodeId=TITVOFMIPR_CH5-5WEOTNOMA',
    usesStateCode: false,
    cellText: 'R- https://library.municode.com/ny/white_plains/codes/code_of_ordinances'
  },
  'NY-Ardsley-Village': {
    name: 'Ardsley',
    type: 'Village',
    url: 'https://ecode360.com/5112183?highlight=poisonous&searchId=16471814187971993#5112182',
    usesStateCode: false,
    cellText: 'https://ecode360.com/5112183'
  }
};

async function regenerateMetadata() {
  console.log('🔧 Regenerating Property Maintenance metadata with state code detection...');
  
  for (const [municId, data] of Object.entries(municipalities)) {
    const metadataPath = path.join(process.cwd(), '..', 'data', 'property-maintenance', municId, 'metadata.json');
    
    try {
      const metadata = {
        municipalityName: data.name,
        municipalityType: data.type,
        domain: 'Property Maintenance', 
        sourceUrl: data.url,
        stateCodeApplies: data.usesStateCode,
        downloadedAt: new Date().toISOString(),
        contentLength: 84091
      };
      
      await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
      
      const status = data.usesStateCode ? 'STATE CODE' : 'LOCAL ORDINANCE';
      console.log(`✅ ${municId}: ${status} - ${data.cellText}`);
      
    } catch (error) {
      console.error(`❌ Failed to create metadata for ${municId}:`, error.message);
    }
  }
  
  console.log('✅ Metadata regeneration complete!');
}

regenerateMetadata().catch(console.error);