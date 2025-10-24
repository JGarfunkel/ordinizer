#!/usr/bin/env tsx

import fs from "fs-extra";
import path from "path";

async function alignMunicipalityData() {
  console.log("Aligning municipality data with existing directories...");
  
  // Get all unique municipality directories across all domains
  const domains = ['trees', 'glb', 'wetland-protection', 'dark-sky'];
  const allMunicipalityIds = new Set<string>();
  
  for (const domain of domains) {
    const domainPath = path.join(process.cwd(), 'data', domain);
    if (await fs.pathExists(domainPath)) {
      const dirs = await fs.readdir(domainPath);
      for (const dir of dirs) {
        const dirPath = path.join(domainPath, dir);
        const stat = await fs.stat(dirPath);
        if (stat.isDirectory()) {
          allMunicipalityIds.add(dir);
        }
      }
    }
  }
  
  console.log(`Found ${allMunicipalityIds.size} unique municipality directories`);
  
  // Create municipality data based on actual directories
  const municipalities = Array.from(allMunicipalityIds).map(id => {
    // Parse municipality ID: NY-{Name}-{Type}
    const parts = id.split('-');
    if (parts.length < 3) return null;
    
    const state = parts[0]; // NY
    const name = parts[1];
    let type = parts.slice(2).join('-');
    
    // Handle special cases
    let displayName = name;
    if (name === 'BriarcliffManor') displayName = 'Briarcliff Manor';
    if (name === 'CrotononHudson') displayName = 'Croton-on-Hudson';
    if (name === 'DobbsFerry') displayName = 'Dobbs Ferry';
    if (name === 'HastingsonHudson') displayName = 'Hastings-on-Hudson';
    if (name === 'MountKisco') displayName = 'Mount Kisco';
    if (name === 'MountPleasant') displayName = 'Mount Pleasant';
    if (name === 'MountVernon') displayName = 'Mount Vernon';
    if (name === 'NewCastle') displayName = 'New Castle';
    if (name === 'NewRochelle') displayName = 'New Rochelle';
    if (name === 'NorthCastle') displayName = 'North Castle';
    if (name === 'NorthSalem') displayName = 'North Salem';
    if (name === 'PelhamManor') displayName = 'Pelham Manor';
    if (name === 'PortChester') displayName = 'Port Chester';
    if (name === 'PoundRidge') displayName = 'Pound Ridge';
    if (name === 'RyeBrook') displayName = 'Rye Brook';
    if (name === 'SleepyHollow') displayName = 'Sleepy Hollow';
    if (name === 'WhitePlains') displayName = 'White Plains';
    
    // Handle type variations
    if (type === 'TownVillage') type = 'Town/Village';
    
    return {
      id,
      name: displayName,
      type,
      state,
      displayName: `${displayName} ${type}`,
      singular: displayName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
    };
  }).filter(m => m !== null);
  
  // Update municipalities.json
  const municipalitiesData = {
    municipalities,
    lastUpdated: new Date().toISOString()
  };
  
  await fs.writeJson("data/municipalities.json", municipalitiesData, { spaces: 2 });
  console.log(`Updated municipalities.json with ${municipalities.length} municipalities`);
  
  // Create domain coverage report
  const domainCoverage: Record<string, string[]> = {};
  
  for (const domain of domains) {
    const domainPath = path.join(process.cwd(), 'data', domain);
    domainCoverage[domain] = [];
    
    if (await fs.pathExists(domainPath)) {
      const dirs = await fs.readdir(domainPath);
      for (const dir of dirs) {
        const statutePath = path.join(domainPath, dir, 'statute.txt');
        if (await fs.pathExists(statutePath)) {
          domainCoverage[domain].push(dir);
        }
      }
    }
  }
  
  console.log("\nDomain coverage report:");
  for (const [domain, municipalityIds] of Object.entries(domainCoverage)) {
    console.log(`${domain}: ${municipalityIds.length} municipalities with statute data`);
  }
  
  // Update domains.json to only include domains with data
  const activeDomains = [];
  const domainDisplayNames = {
    'trees': 'Trees & Urban Forestry',
    'glb': 'Gas Leaf Blowers',
    'wetland-protection': 'Wetland Protection',
    'dark-sky': 'Dark Sky Protection'
  };
  
  const domainDescriptions = {
    'trees': 'Tree removal, planting, and maintenance regulations',
    'glb': 'Gas-powered leaf blower regulations and restrictions',
    'wetland-protection': 'Wetland conservation and protection ordinances',
    'dark-sky': 'Light pollution control and dark sky protection'
  };
  
  for (const [domainId, municipalityIds] of Object.entries(domainCoverage)) {
    if (municipalityIds.length > 0) {
      activeDomains.push({
        id: domainId,
        name: domainId,
        displayName: domainDisplayNames[domainId] || domainId,
        description: domainDescriptions[domainId] || `Municipal regulations related to ${domainId}`
      });
    }
  }
  
  const domainsData = {
    domains: activeDomains,
    lastUpdated: new Date().toISOString()
  };
  
  await fs.writeJson("data/domains.json", domainsData, { spaces: 2 });
  console.log(`Updated domains.json with ${activeDomains.length} active domains`);
  
  console.log("\nAlignment completed successfully!");
}

async function main() {
  try {
    await alignMunicipalityData();
  } catch (error) {
    console.error('Error aligning municipality data:', error);
    process.exit(1);
  }
}

main();