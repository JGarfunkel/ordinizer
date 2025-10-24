#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';

async function downloadWestchesterBoundaries() {
  try {
    console.log('Downloading Westchester County municipality boundaries...');
    
    const response = await fetch('https://gis.westchestergov.com/datasets/278ce38ecd784b79993af098f81809ed_163.geojson');
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const geoData = await response.json();
    
    const outputPath = path.join(process.cwd(), 'data', 'westchester-boundaries.json');
    await fs.writeJson(outputPath, geoData, { spaces: 2 });
    
    console.log(`✅ Successfully downloaded ${geoData.features?.length || 0} municipality boundaries`);
    console.log(`📄 Saved to: ${outputPath}`);
    
    // Log some sample municipality names
    if (geoData.features && geoData.features.length > 0) {
      console.log('\nSample municipalities found:');
      geoData.features.slice(0, 5).forEach((feature: any) => {
        console.log(`  - ${feature.properties?.NAME} (${feature.properties?.TYPE || 'Unknown'})`);
      });
    }
    
  } catch (error) {
    console.error('❌ Failed to download boundaries:', error);
    process.exit(1);
  }
}

// Run the script
downloadWestchesterBoundaries();