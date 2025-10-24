#!/usr/bin/env tsx

import fs from "fs-extra";
import path from "path";

async function fixMunicipalityIds() {
  console.log("Fixing municipality IDs to align with domain directories...");
  
  // Read current municipalities
  const municipalitiesPath = path.join(process.cwd(), 'data', 'municipalities.json');
  const municipalitiesData = await fs.readJson(municipalitiesPath);
  
  const fixedMunicipalities = [];
  const renameOperations = [];
  
  for (const municipality of municipalitiesData.municipalities) {
    // Fix IDs with forward slashes and other URL-incompatible characters
    let fixedId = municipality.id;
    let fixedType = municipality.type;
    
    // Handle Town/Village format
    if (municipality.type.includes('/')) {
      fixedType = municipality.type.replace('/', '-');
      fixedId = `NY-${municipality.name.replace(/\s+/g, '')}-${fixedType}`;
    }
    
    // Handle spaces in names
    if (municipality.name.includes(' ')) {
      const nameWithoutSpaces = municipality.name.replace(/\s+/g, '');
      fixedId = `NY-${nameWithoutSpaces}-${fixedType.replace(/\s+/g, '')}`;
    }
    
    // Handle special characters like hyphens in names
    const cleanName = municipality.name.replace(/[^a-zA-Z0-9]/g, '');
    const cleanType = fixedType.replace(/[^a-zA-Z0-9]/g, '');
    const standardId = `NY-${cleanName}-${cleanType}`;
    
    if (fixedId !== municipality.id) {
      renameOperations.push({
        oldId: municipality.id,
        newId: standardId,
        name: municipality.name,
        type: municipality.type
      });
    }
    
    fixedMunicipalities.push({
      ...municipality,
      id: standardId,
      type: fixedType,
      displayName: `${municipality.name} ${fixedType}`,
      singular: municipality.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
    });
  }
  
  console.log(`Found ${renameOperations.length} municipality IDs that need fixing`);
  
  // Rename directories in each domain
  const domains = ['trees', 'glb', 'wetland-protection', 'dark-sky'];
  
  for (const operation of renameOperations) {
    console.log(`Fixing: ${operation.oldId} -> ${operation.newId}`);
    
    for (const domain of domains) {
      const domainPath = path.join(process.cwd(), 'data', domain);
      const oldPath = path.join(domainPath, operation.oldId);
      const newPath = path.join(domainPath, operation.newId);
      
      if (await fs.pathExists(oldPath)) {
        await fs.move(oldPath, newPath);
        console.log(`  Moved ${domain}/${operation.oldId} -> ${domain}/${operation.newId}`);
      }
    }
  }
  
  // Update municipalities.json
  const updatedData = {
    ...municipalitiesData,
    municipalities: fixedMunicipalities,
    lastUpdated: new Date().toISOString()
  };
  
  await fs.writeJson(municipalitiesPath, updatedData, { spaces: 2 });
  console.log(`Updated municipalities.json with ${fixedMunicipalities.length} fixed municipalities`);
  
  // Create a mapping of which domains actually have data
  const domainMunicipalityMap: Record<string, string[]> = {};
  
  for (const domain of domains) {
    const domainPath = path.join(process.cwd(), 'data', domain);
    if (await fs.pathExists(domainPath)) {
      const municipalityDirs = await fs.readdir(domainPath);
      domainMunicipalityMap[domain] = municipalityDirs.filter(async (dir) => {
        const statutePath = path.join(domainPath, dir, 'statute.txt');
        return await fs.pathExists(statutePath);
      });
    }
  }
  
  console.log("\nDomain coverage:");
  for (const [domain, municipalityIds] of Object.entries(domainMunicipalityMap)) {
    console.log(`${domain}: ${municipalityIds.length} municipalities`);
  }
  
  console.log("\nMunicipality ID fixes completed!");
}

async function main() {
  try {
    await fixMunicipalityIds();
  } catch (error) {
    console.error('Error fixing municipality IDs:', error);
    process.exit(1);
  }
}

main();