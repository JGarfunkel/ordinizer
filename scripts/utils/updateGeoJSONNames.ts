#!/usr/bin/env tsx

/**
 * Update GeoJSON municipality names to match database IDs
 * This eliminates the need for complex name matching in the frontend
 */

import fs from 'fs-extra';
import path from 'path';

interface Municipality {
  id: string;
  name: string;
  type: string;
  displayName: string;
  singular: string;
}

interface GeoFeature {
  type: string;
  properties: {
    NAME: string;
    TYPE?: string;
    MUNICIPALITY_ID?: string;
  };
  geometry: any;
}

interface GeoJSON {
  type: string;
  features: GeoFeature[];
}

async function updateGeoJSONNames() {
  const municipalitiesPath = path.join(process.cwd(), 'data', 'municipalities.json');
  const geoJsonPath = path.join(process.cwd(), 'data', 'westchester-boundaries.json');
  
  console.log('Loading municipalities data...');
  const municipalitiesData = await fs.readJson(municipalitiesPath);
  const municipalities: Municipality[] = municipalitiesData.municipalities;
  
  console.log('Loading GeoJSON data...');
  const geoJsonData: GeoJSON = await fs.readJson(geoJsonPath);
  
  console.log('Mapping GeoJSON features to municipality IDs...');
  
  let updatedCount = 0;
  let unmatchedFeatures: string[] = [];
  
  for (const feature of geoJsonData.features) {
    const geoName = feature.properties.NAME.toLowerCase().trim();
    const geoType = feature.properties.TYPE?.toLowerCase()?.trim();
    
    // Find matching municipality using the same logic as our frontend
    const matchedMunicipality = findMunicipalityMatch(geoName, geoType, municipalities);
    
    if (matchedMunicipality) {
      // Update the GeoJSON feature to include the municipality ID
      feature.properties.MUNICIPALITY_ID = matchedMunicipality.id;
      console.log(`✓ Mapped "${feature.properties.NAME}" -> ${matchedMunicipality.id}`);
      updatedCount++;
    } else {
      console.log(`⚠ No match found for: "${feature.properties.NAME}" (type: ${feature.properties.TYPE})`);
      unmatchedFeatures.push(feature.properties.NAME);
    }
  }
  
  console.log(`\nUpdated ${updatedCount} features with municipality IDs`);
  if (unmatchedFeatures.length > 0) {
    console.log(`\nUnmatched features (${unmatchedFeatures.length}):`);
    unmatchedFeatures.forEach(name => console.log(`  - ${name}`));
  }
  
  // Create backup of original file
  const backupPath = geoJsonPath + '.backup';
  if (!await fs.pathExists(backupPath)) {
    await fs.copy(geoJsonPath, backupPath);
    console.log(`\nCreated backup: ${backupPath}`);
  }
  
  // Save updated GeoJSON
  await fs.writeJson(geoJsonPath, geoJsonData, { spaces: 2 });
  console.log(`\nUpdated GeoJSON saved to: ${geoJsonPath}`);
}

function findMunicipalityMatch(geoName: string, geoType: string | undefined, municipalities: Municipality[]): Municipality | undefined {
  for (const municipality of municipalities) {
    const munName = municipality.name.toLowerCase().trim();
    const munType = municipality.type.toLowerCase().trim();
    const munDisplayName = municipality.displayName.toLowerCase().trim();
    
    // Try exact name match with municipality name
    if (munName === geoName) {
      return municipality;
    }
    
    // Try exact name match with display name (remove " - Type" suffix)
    const displayNameBase = munDisplayName.split(' - ')[0];
    if (displayNameBase === geoName) {
      return municipality;
    }
    
    // Try exact name and type match if both are available
    if (geoType && munName === geoName && munType === geoType) {
      return municipality;
    }
    
    // Handle hyphenated names and spaces
    const normalizedMunName = munName.replace(/[-\s]/g, '');
    const normalizedGeoName = geoName.replace(/[-\s]/g, '');
    
    if (normalizedMunName === normalizedGeoName) {
      return municipality;
    }
    
    // Handle special cases for compound municipality names
    const normalizedDisplayBase = displayNameBase.replace(/[-\s]/g, '');
    if (normalizedDisplayBase === normalizedGeoName) {
      return municipality;
    }
  }
  
  return undefined;
}

// Run the script
updateGeoJSONNames().catch(console.error);