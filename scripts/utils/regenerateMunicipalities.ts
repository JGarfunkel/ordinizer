#!/usr/bin/env tsx
/**
 * Emergency utility to regenerate municipalities.json from existing data directories
 * 
 * This reconstructs the municipality list by scanning all domain directories
 * and extracting municipality information from directory names.
 */

import fs from 'fs-extra';
import path from 'path';

interface Municipality {
  id: string;
  name: string;
  type: string;
  state: string;
  displayName: string;
  singular: string;
}

function parseMunicipalityFromId(id: string): Municipality | null {
  // Expected format: NY-{MunicipalityName}-{Type}
  const match = id.match(/^NY-([^-]+)-(.+)$/);
  if (!match) return null;

  const [, namepart, type] = match;
  
  // Handle special cases for municipality names
  const nameMap: Record<string, string> = {
    'HastingsonHudson': 'Hastings-on-Hudson',
    'CrotononHudson': 'Croton-on-Hudson',
    'Croton-on-Hudson': 'Croton-on-Hudson',
    'MountKisco': 'Mount Kisco',
    'MountPleasant': 'Mount Pleasant',
    'MountVernon': 'Mount Vernon',
    'NewCastle': 'New Castle',
    'NewRochelle': 'New Rochelle',
    'NorthCastle': 'North Castle',
    'NorthSalem': 'North Salem',
    'PelhamManor': 'Pelham Manor',
    'PortChester': 'Port Chester',
    'PoundRidge': 'Pound Ridge',
    'RyeBrook': 'Rye Brook',
    'SleepyHollow': 'Sleepy Hollow',
    'WhitePlains': 'White Plains',
    'BriarcliffManor': 'Briarcliff Manor'
  };

  // Create duplicate detection map to prefer certain formats
  const duplicatePreference: Record<string, string> = {
    'Hastings-on-Hudson': 'NY-Hastings-on-Hudson-Village', // Prefer hyphenated version
    'Croton-on-Hudson': 'NY-Croton-on-Hudson-Village'      // Prefer hyphenated version
  };

  const name = nameMap[namepart] || namepart;
  const displayName = `${name} - ${type}`;
  const singular = name.toLowerCase().replace(/[^a-z0-9]/g, '');

  return {
    id,
    name,
    type,
    state: 'NY',
    displayName,
    singular
  };
}

async function regenerateMunicipalities(): Promise<void> {
  const dataDir = path.join(process.cwd(), '..', 'data');
  const municipalitySet = new Set<string>();
  
  console.log('🔍 Scanning data directories for municipalities...');
  
  // Get all domain directories
  const entries = await fs.readdir(dataDir);
  
  for (const entry of entries) {
    const entryPath = path.join(dataDir, entry);
    const stat = await fs.stat(entryPath);
    
    if (!stat.isDirectory()) continue;
    if (entry === 'westchester-boundaries.json' || entry.endsWith('.json') || entry.endsWith('.csv')) continue;
    
    console.log(`  Checking domain: ${entry}`);
    
    try {
      const domainEntries = await fs.readdir(entryPath);
      
      for (const municipalityDir of domainEntries) {
        if (municipalityDir.startsWith('NY-') && municipalityDir !== 'NY-State') {
          municipalitySet.add(municipalityDir);
        }
      }
    } catch (error) {
      console.log(`    Warning: Could not read ${entry}:`, error.message);
    }
  }
  
  // Remove specific true duplicates (same municipality with different directory names)
  const trueDuplicates = new Set([
    'NY-HastingsonHudson-Village',  // Remove in favor of NY-Hastings-on-Hudson-Village
    'NY-CrotononHudson-Village'     // Remove in favor of NY-Croton-on-Hudson-Village
  ]);
  
  const filteredIds = Array.from(municipalitySet)
    .filter(id => !trueDuplicates.has(id))
    .sort();
  
  console.log(`\n📋 Found ${municipalitySet.size} municipality directories, filtered to ${filteredIds.length} (removed ${municipalitySet.size - filteredIds.length} true duplicates):`);
  
  const municipalities: Municipality[] = [];
  
  for (const id of filteredIds) {
    const municipality = parseMunicipalityFromId(id);
    if (municipality) {
      municipalities.push(municipality);
      console.log(`  ✅ ${municipality.displayName}`);
    } else {
      console.log(`  ❌ Failed to parse: ${id}`);
    }
  }
  
  // Create the municipalities.json structure
  const municipalitiesData = {
    municipalities,
    lastUpdated: new Date().toISOString()
  };
  
  // Backup existing file if it exists
  const municipalitiesPath = path.join(dataDir, 'municipalities.json');
  if (await fs.pathExists(municipalitiesPath)) {
    const backupPath = path.join(dataDir, `municipalities.json.backup.${Date.now()}`);
    await fs.copy(municipalitiesPath, backupPath);
    console.log(`\n💾 Backed up existing file to: municipalities.json.backup.${Date.now()}`);
  }
  
  // Write the new file
  await fs.writeJson(municipalitiesPath, municipalitiesData, { spaces: 2 });
  
  console.log(`\n✅ Regenerated municipalities.json with ${municipalities.length} municipalities`);
  console.log(`📍 File saved to: ${municipalitiesPath}`);
  
  // Show a few examples
  if (municipalities.length > 0) {
    console.log('\n📋 Sample entries:');
    municipalities.slice(0, 3).forEach(m => {
      console.log(`  ${m.id} -> ${m.displayName} (${m.singular})`);
    });
  }
}

async function main(): Promise<void> {
  try {
    await regenerateMunicipalities();
  } catch (error) {
    console.error('❌ Failed to regenerate municipalities:', error);
    process.exit(1);
  }
}

main();