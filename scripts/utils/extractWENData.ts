#!/usr/bin/env tsx

import fs from "fs-extra";
import path from "path";
import axios from "axios";
import { parse } from "csv-parse/sync";

const TARGET_DOMAINS = ["Trees", "GLB", "Wetland Protection", "Dark Sky"];
const DELAY_BETWEEN_DOWNLOADS = 2000; // 2 seconds

interface MunicipalityData {
  name: string;
  type: string;
  domains: Record<string, string>;
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function extractWENData(): Promise<void> {
  const wenUrl = process.env.WEN_SPREADSHEET_URL;
  
  if (!wenUrl) {
    throw new Error("WEN_SPREADSHEET_URL environment variable not found");
  }
  
  console.log("Extracting authentic WEN data...");
  
  // Convert to CSV export URL
  let csvUrl = wenUrl;
  if (wenUrl.includes('/edit')) {
    const match = wenUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (match) {
      const sheetId = match[1];
      csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
      
      const gidMatch = wenUrl.match(/gid=(\d+)/);
      if (gidMatch) {
        csvUrl += `&gid=${gidMatch[1]}`;
      }
    }
  }
  
  console.log("Fetching CSV data from:", csvUrl);
  
  const response = await axios.get(csvUrl, {
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Ordinizer/1.0)'
    }
  });
  
  const csvData = response.data;
  const lines = csvData.split('\n');
  
  // Find the header row (should be line 1)
  const headerLine = lines[1];
  const headers = headerLine.split(',').map(h => h.trim());
  
  console.log("Column headers found:", headers.join(' | '));
  
  // Find column indices for our target domains
  const domainIndices: Record<string, number> = {};
  for (const domain of TARGET_DOMAINS) {
    const index = headers.findIndex(h => h === domain);
    if (index !== -1) {
      domainIndices[domain] = index;
      console.log(`Found ${domain} at column ${index}`);
    } else {
      console.warn(`Domain ${domain} not found in headers`);
    }
  }
  
  // Process municipality data starting from line 2
  const municipalities: MunicipalityData[] = [];
  
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const columns = line.split(',').map(c => c.trim());
    const municipalityCol = columns[0];
    
    if (!municipalityCol || !municipalityCol.includes('(')) continue;
    
    // Parse municipality name and type
    const match = municipalityCol.match(/^(.+?)\s*\((.+?)\)$/);
    if (!match) continue;
    
    const municipalityName = match[1].trim();
    const municipalityType = match[2].trim();
    
    // Extract domain data
    const domainData: Record<string, string> = {};
    for (const [domain, columnIndex] of Object.entries(domainIndices)) {
      const cellValue = columns[columnIndex] || '';
      if (cellValue && cellValue !== '') {
        domainData[domain] = cellValue;
      }
    }
    
    // Only include municipalities that have at least one target domain
    if (Object.keys(domainData).length > 0) {
      municipalities.push({
        name: municipalityName,
        type: municipalityType,
        domains: domainData
      });
      
      console.log(`Found ${municipalityName} (${municipalityType}) with ${Object.keys(domainData).length} domains`);
    }
  }
  
  console.log(`\nProcessed ${municipalities.length} municipalities with target domain data`);
  
  // Update municipalities.json
  const municipalitiesData = {
    municipalities: municipalities.map(m => ({
      id: `NY-${m.name.replace(/\s+/g, '')}-${m.type.replace(/\s+/g, '')}`,
      name: m.name,
      type: m.type,
      state: "NY",
      displayName: `${m.name} ${m.type}`,
      singular: m.name.replace(/\s+/g, '').toLowerCase()
    })),
    lastUpdated: new Date().toISOString()
  };
  
  await fs.writeJson("data/municipalities.json", municipalitiesData, { spaces: 2 });
  console.log(`Updated municipalities.json with ${municipalitiesData.municipalities.length} municipalities`);
  
  // Process statute downloads
  let downloadCount = 0;
  
  for (const municipality of municipalities) {
    const municipalityId = `NY-${municipality.name.replace(/\s+/g, '')}-${municipality.type.replace(/\s+/g, '')}`;
    console.log(`\nProcessing ${municipalityId}...`);
    
    for (const [domainName, cellValue] of Object.entries(municipality.domains)) {
      // Extract URL from cell value (format: "G-https://...")
      const urlMatch = cellValue.match(/(https?:\/\/[^\s,]+)/);
      if (!urlMatch) {
        console.log(`  ${domainName}: No valid URL found in "${cellValue}"`);
        continue;
      }
      
      const statuteUrl = urlMatch[1];
      const domainId = domainName.toLowerCase().replace(/\s+/g, '-');
      
      // Create directory structure
      const dirPath = path.join(process.cwd(), 'data', domainId, municipalityId);
      await fs.ensureDir(dirPath);
      
      const filePath = path.join(dirPath, 'statute.txt');
      const metadataPath = path.join(dirPath, 'metadata.json');
      
      // Check if file already exists and is recent
      if (await fs.pathExists(filePath)) {
        const stats = await fs.stat(filePath);
        const daysSinceUpdate = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);
        
        if (daysSinceUpdate < 7) { // Refresh weekly
          console.log(`  ${domainName}: File exists and is recent, skipping`);
          continue;
        }
      }
      
      try {
        console.log(`  ${domainName}: Downloading from ${statuteUrl}`);
        
        if (downloadCount > 0) {
          console.log(`  Waiting ${DELAY_BETWEEN_DOWNLOADS/1000} seconds...`);
          await delay(DELAY_BETWEEN_DOWNLOADS);
        }
        
        const statuteResponse = await axios.get(statuteUrl, {
          timeout: 30000,
          maxRedirects: 5,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Ordinizer/1.0)'
          }
        });
        
        await fs.writeFile(filePath, statuteResponse.data, 'utf-8');
        
        // Save metadata
        const metadata = {
          municipality: municipality.name,
          municipalityType: municipality.type,
          domain: domainName,
          domainId: domainId,
          sourceUrl: statuteUrl,
          originalCellValue: cellValue,
          downloadedAt: new Date().toISOString(),
          contentLength: statuteResponse.data.length,
          source: 'WEN Ordinance Library'
        };
        
        await fs.writeJson(metadataPath, metadata, { spaces: 2 });
        
        console.log(`  ${domainName}: ✅ Downloaded (${statuteResponse.data.length} characters)`);
        downloadCount++;
        
      } catch (error) {
        console.error(`  ${domainName}: ❌ Failed to download - ${error.message}`);
      }
    }
  }
  
  console.log(`\n🎉 WEN extraction completed!`);
  console.log(`📊 Processed ${municipalities.length} municipalities`);
  console.log(`📄 Downloaded ${downloadCount} statute files`);
  console.log(`🏛️ Domains: ${TARGET_DOMAINS.join(', ')}`);
}

async function main() {
  try {
    await extractWENData();
  } catch (error) {
    console.error('Error extracting WEN data:', error);
    process.exit(1);
  }
}

main();