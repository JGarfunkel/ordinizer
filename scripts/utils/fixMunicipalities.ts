#!/usr/bin/env tsx

import fs from "fs-extra";
import { extractGoogleSheetsAsCsv } from './extractFromGoogleSheets.js';
import { parse } from "csv-parse/sync";

async function fixMunicipalities(): Promise<void> {
  console.log("Fixing municipalities data...");
  
  const csvData = await extractGoogleSheetsAsCsv('https://docs.google.com/spreadsheets/d/1Nc5xZZ9OrRgI2pnGjlBmo7yvpiQELYSEp19e73Gl_UE/edit?gid=2126758775#gid=2126758775');
  const records = parse(csvData, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });

  console.log(`Found ${records.length} records`);
  
  // The first column contains municipality names like "Ardsley (Village)", "Bedford (Town)"
  const firstColumnKey = Object.keys(records[0] || {})[0];
  console.log(`Using first column key: "${firstColumnKey}"`);
  
  const municipalities = records
    .filter(row => {
      const municipalityText = row[firstColumnKey];
      const isValid = municipalityText && municipalityText.includes('(') && municipalityText.includes(')') && 
                     !municipalityText.toLowerCase().includes('environmental') && 
                     !municipalityText.toLowerCase().includes('key:');
      return isValid;
    })
    .map(row => {
      const municipalityText = row[firstColumnKey];
      // Parse "Municipality (Type)" format
      const match = municipalityText.match(/^(.+?)\s*\((.+?)\)$/);
      if (!match) {
        console.warn(`Could not parse municipality format: ${municipalityText}`);
        return null;
      }
      
      const [, name, type] = match;
      const cleanName = name.trim();
      const cleanType = type.trim();
      
      return {
        id: `NY-${cleanName.replace(/[^a-zA-Z0-9]/g, '')}-${cleanType.replace(/[^a-zA-Z0-9]/g, '')}`,
        name: cleanName,
        type: cleanType,
        state: "NY",
        displayName: `${cleanName} - ${cleanType}`,
        singular: cleanName.replace(/[^a-zA-Z0-9]/g, '').replace(/\s+/g, '').toLowerCase()
      };
    })
    .filter(m => m !== null);

  console.log(`Processed ${municipalities.length} municipalities`);
  
  // Show first few municipalities
  municipalities.slice(0, 5).forEach(m => {
    console.log(`- ${m.id}: ${m.displayName}`);
  });

  await fs.ensureDir("../data");
  await fs.writeJson("../data/municipalities.json", {
    municipalities,
    lastUpdated: new Date().toISOString()
  }, { spaces: 2 });

  console.log(`✅ Successfully created municipalities.json with ${municipalities.length} municipalities`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fixMunicipalities().catch(console.error);
}

export { fixMunicipalities };