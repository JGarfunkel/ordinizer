#!/usr/bin/env tsx

import fs from "fs-extra";
import path from "path";

// WEN domains structure based on the actual spreadsheet
const WEN_DOMAINS = [
  {
    id: "trees",
    name: "trees", 
    displayName: "Trees & Urban Forestry",
    description: "Tree removal, planting, and maintenance regulations"
  },
  {
    id: "glb",
    name: "glb",
    displayName: "Gas Leaf Blowers", 
    description: "Gas-powered leaf blower regulations and restrictions"
  },
  {
    id: "wetland-protection",
    name: "wetland-protection",
    displayName: "Wetland Protection",
    description: "Wetland conservation and protection ordinances"
  },
  {
    id: "dark-sky",
    name: "dark-sky", 
    displayName: "Dark Sky Protection",
    description: "Light pollution control and dark sky protection"
  }
];

async function regenerateDomains() {
  console.log("Regenerating domains.json with WEN structure...");
  
  const domainsData = {
    domains: WEN_DOMAINS,
    lastUpdated: new Date().toISOString()
  };
  
  const domainsPath = path.join(process.cwd(), 'data', 'domains.json');
  await fs.writeJson(domainsPath, domainsData, { spaces: 2 });
  
  console.log(`✅ Updated domains.json with ${WEN_DOMAINS.length} WEN domains`);
  
  // Create directories for each domain
  for (const domain of WEN_DOMAINS) {
    const domainDir = path.join(process.cwd(), 'data', domain.id);
    await fs.ensureDir(domainDir);
    console.log(`✅ Created directory: data/${domain.id}`);
  }
  
  console.log("\nDomains regenerated successfully!");
  console.log("Next step: Run tsx scripts/extractFromGoogleSheets.ts to extract authentic WEN data");
}

async function main() {
  try {
    await regenerateDomains();
  } catch (error) {
    console.error('Error regenerating domains:', error);
    process.exit(1);
  }
}

main();