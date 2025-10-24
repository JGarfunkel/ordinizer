#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';

interface Municipality {
  id: string;
  name: string;
  displayName: string;
  type: string;
}

interface GeoJSONFeature {
  type: string;
  properties: {
    OBJECTID: number;
    NAME: string;
    SQMILES: number;
    SHAPE_LENG: number;
    MUNICIPALITY_ID?: string;
  };
  geometry: any;
}

interface GeoJSONFeatureCollection {
  type: string;
  name: string;
  crs: any;
  features: GeoJSONFeature[];
}

async function updateGeoJsonMunicipalityIds() {
  try {
    // Load municipalities data
    const municipalitiesPath = path.join(process.cwd(), 'data', 'municipalities.json');
    const municipalitiesData = await fs.readJson(municipalitiesPath);
    const municipalities: Municipality[] = municipalitiesData.municipalities;
    console.log(`Loaded ${municipalities.length} municipalities`);

    // Load GeoJSON file
    const geoJsonPath = path.join(process.cwd(), 'data', 'westchester-boundaries.json');
    const geoData: GeoJSONFeatureCollection = await fs.readJson(geoJsonPath);
    console.log(`Loaded GeoJSON with ${geoData.features.length} features`);

    // Create a backup
    const backupPath = path.join(process.cwd(), 'data', 'westchester-boundaries.json.backup.' + Date.now());
    await fs.copy(geoJsonPath, backupPath);
    console.log(`Backup created: ${backupPath}`);

    let updatedCount = 0;
    let alreadyHadId = 0;
    let notFoundCount = 0;

    // Process each feature
    for (const feature of geoData.features) {
      if (feature.properties.MUNICIPALITY_ID) {
        alreadyHadId++;
        continue;
      }

      const geoName = feature.properties.NAME.toLowerCase().trim();
      console.log(`Processing feature: ${feature.properties.NAME}`);

      // Extract base name without type suffix
      const baseName = geoName.replace(/\s+(village|town|city)$/, '').trim();
      
      // Try to find matching municipality
      let municipality = null;

      // FIRST: Handle type-specific matching for duplicate names (Mamaroneck Village vs Town)
      if (geoName.includes(' ')) {
        const geoType = geoName.split(' ').pop()?.toLowerCase();
        if (geoType && ['village', 'town', 'city'].includes(geoType)) {
          municipality = municipalities.find(m => {
            const munName = m.name.toLowerCase();
            const munType = m.type.toLowerCase();
            
            return munName === baseName && 
              ((geoType === 'village' && munType === 'village') ||
               (geoType === 'town' && munType === 'town') ||
               (geoType === 'city' && munType === 'city'));
          });
          
          if (municipality) {
            console.log(`  ✓ Type-specific match: ${baseName} + ${geoType} → ${municipality.id}`);
          }
        }
      }

      // SECOND: Try exact name match (for singular municipalities)
      if (!municipality) {
        municipality = municipalities.find(m => 
          m.name.toLowerCase() === baseName ||
          m.displayName.toLowerCase() === geoName
        );
        
        if (municipality) {
          console.log(`  ✓ Exact name match: ${geoName} → ${municipality.id}`);
        }
      }

      // THIRD: Try variations with hyphens and spaces
      if (!municipality) {
        const nameVariations = [
          baseName,
          baseName.replace(/-/g, ''),
          baseName.replace(/\s/g, ''),
          baseName.replace(/-/g, ' '),
          geoName,
          geoName.replace(/-/g, ''),
          geoName.replace(/\s/g, ''),
          geoName.replace(/-/g, ' ')
        ];

        for (const variation of nameVariations) {
          municipality = municipalities.find(m => 
            m.name.toLowerCase() === variation ||
            m.displayName.toLowerCase() === variation
          );
          if (municipality) {
            console.log(`  ✓ Variation match: ${variation} → ${municipality.id}`);
            break;
          }
        }
      }

      if (municipality) {
        feature.properties.MUNICIPALITY_ID = municipality.id;
        console.log(`✓ Mapped "${feature.properties.NAME}" → ${municipality.id}`);
        updatedCount++;
      } else {
        console.log(`✗ No match found for: ${feature.properties.NAME}`);
        notFoundCount++;
      }
    }

    // Save updated GeoJSON
    await fs.writeJson(geoJsonPath, geoData, { spaces: 2 });

    console.log('\n=== UPDATE SUMMARY ===');
    console.log(`Features already had IDs: ${alreadyHadId}`);
    console.log(`Features updated: ${updatedCount}`);
    console.log(`Features not found: ${notFoundCount}`);
    console.log(`Total features: ${geoData.features.length}`);
    console.log(`\nGeoJSON file updated: ${geoJsonPath}`);
    console.log(`Backup saved: ${backupPath}`);

  } catch (error) {
    console.error('Error updating GeoJSON:', error);
    process.exit(1);
  }
}

// Run the script
updateGeoJsonMunicipalityIds();