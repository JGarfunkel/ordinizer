#!/usr/bin/env tsx

/**
 * Update municipalities.json with uniqueName field and truncate displayName where appropriate
 * 
 * Usage: tsx scripts/utils/updateMunicipalityDisplayNames.ts
 */

import * as fs from 'fs/promises';
import * as path from 'path';

interface Municipality {
  id: string;
  name: string;
  displayName: string;
  singular: string;
  uniqueName?: boolean;
}

async function updateMunicipalityDisplayNames() {
  const municipalitiesPath = path.join(process.cwd(), 'data', 'municipalities.json');
  
  try {
    await fs.access(municipalitiesPath);
  } catch {
    console.error('municipalities.json not found');
    process.exit(1);
  }

  console.log('Loading municipalities.json...');
  const data = JSON.parse(await fs.readFile(municipalitiesPath, 'utf-8'));
  const municipalities: Municipality[] = data.municipalities;
  
  // Municipalities that are NOT unique (have duplicates with different types)
  const nonUniqueNames = ['Mamaroneck', 'Ossining', 'Rye', 'Pelham'];
  
  let updateCount = 0;
  
  municipalities.forEach((municipality) => {
    // Extract base name (everything before " - ")
    const baseName = municipality.displayName.split(' - ')[0];
    
    // Check if this municipality has a unique name
    const isUnique = !nonUniqueNames.includes(baseName);
    
    // Add uniqueName field
    municipality.uniqueName = isUnique;
    
    // If unique, truncate displayName to remove " - <municipalityType>"
    if (isUnique && municipality.displayName.includes(' - ')) {
      const oldDisplayName = municipality.displayName;
      municipality.displayName = baseName;
      console.log(`Updated ${municipality.id}: "${oldDisplayName}" → "${municipality.displayName}"`);
      updateCount++;
    } else if (!isUnique) {
      console.log(`Kept full name for non-unique ${municipality.id}: "${municipality.displayName}"`);
    }
  });
  
  console.log(`\nUpdated ${updateCount} municipalities`);
  console.log('Writing updated municipalities.json...');
  
  // Write back to file with proper formatting
  await fs.writeFile(municipalitiesPath, JSON.stringify({ municipalities }, null, 2));
  
  console.log('✓ municipalities.json updated successfully');
  
  // Show summary
  const uniqueCount = municipalities.filter(m => m.uniqueName).length;
  const nonUniqueCount = municipalities.filter(m => !m.uniqueName).length;
  
  console.log(`\nSummary:`);
  console.log(`- ${uniqueCount} municipalities with unique names (displayName truncated)`);
  console.log(`- ${nonUniqueCount} municipalities with non-unique names (displayName kept full)`);
}

updateMunicipalityDisplayNames()
  .then(() => {
    console.log('Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Error updating municipalities:', error);
    process.exit(1);
  });