#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';

interface Municipality {
  id: string;
  name: string;
  type: string;
  state: string;
  displayName: string;
  singular?: boolean;
}

interface MunicipalitiesFile {
  municipalities: Municipality[];
  lastUpdated: string;
}

async function updateMunicipalitiesWithSingular() {
  const filePath = path.join(process.cwd(), 'data', 'municipalities.json');
  
  console.log('Reading municipalities file...');
  const data: MunicipalitiesFile = await fs.readJson(filePath);
  
  // Count municipalities by name to identify duplicates
  const nameCount: { [name: string]: number } = {};
  data.municipalities.forEach(municipality => {
    nameCount[municipality.name] = (nameCount[municipality.name] || 0) + 1;
  });
  
  console.log('Municipality name counts:');
  Object.entries(nameCount).forEach(([name, count]) => {
    if (count > 1) {
      console.log(`  ${name}: ${count} (duplicate)`);
    }
  });
  
  // Update municipalities with singular attribute
  data.municipalities = data.municipalities.map(municipality => {
    const isDuplicate = nameCount[municipality.name] > 1;
    return {
      ...municipality,
      singular: !isDuplicate // singular is false only for duplicates
    };
  });
  
  // Update lastUpdated timestamp
  data.lastUpdated = new Date().toISOString();
  
  console.log('Writing updated municipalities file...');
  await fs.writeJson(filePath, data, { spaces: 2 });
  
  console.log('✅ Successfully updated municipalities with singular attribute');
  
  // Show summary
  const singularCount = data.municipalities.filter(m => m.singular).length;
  const nonSingularCount = data.municipalities.filter(m => !m.singular).length;
  console.log(`Summary: ${singularCount} singular, ${nonSingularCount} non-singular municipalities`);
}

// Run the script
updateMunicipalitiesWithSingular().catch(console.error);