#!/usr/bin/env tsx

import fs from "fs-extra";
import path from "path";
import axios from "axios";
import { parse } from "csv-parse/sync";

interface MunicipalityRow {
  Municipality: string;
  Type: string;
  Trees?: string;
  Zoning?: string;
  Parking?: string;
  Noise?: string;
  Building?: string;
  Environmental?: string;
  Business?: string;
}

const DOMAINS = [
  "Trees",
  "Zoning", 
  "Parking",
  "Noise",
  "Building",
  "Environmental",
  "Business"
];

const DELAY_BETWEEN_DOWNLOADS = 5000; // 5 seconds

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadFromUrl(url: string): Promise<string> {
  try {
    console.log(`Downloading: ${url}`);
    const response = await axios.get(url, {
      timeout: 30000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Ordinizer/1.0; +http://ordinizer.example.com)'
      }
    });
    return response.data;
  } catch (error) {
    console.error(`Failed to download ${url}:`, error);
    return "";
  }
}

async function extractStatuteLinks(): Promise<void> {
  console.log("Starting data extraction from Google Sheets...");
  
  // For now, we'll work with a sample CSV export since we can't directly access the Google Sheet
  // In a real implementation, you would export the sheet as CSV and process it
  const csvPath = process.argv[2];
  
  if (!csvPath || !fs.existsSync(csvPath)) {
    console.error("Please provide a valid CSV file path as an argument");
    console.error("Usage: tsx scripts/extractData.ts <path-to-csv-export>");
    console.error("Export the Google Sheet as CSV first");
    process.exit(1);
  }

  const csvContent = await fs.readFile(csvPath, 'utf-8');
  const records: MunicipalityRow[] = parse(csvContent, {
    columns: true,
    skip_empty_lines: true
  });

  console.log(`Found ${records.length} municipalities`);

  let downloadCount = 0;
  
  for (const row of records) {
    const municipalityName = row.Municipality;
    const municipalityType = row.Type;
    
    if (!municipalityName || !municipalityType) {
      console.warn(`Skipping incomplete row: ${JSON.stringify(row)}`);
      continue;
    }

    console.log(`Processing: ${municipalityName} - ${municipalityType}`);
    
    for (const domain of DOMAINS) {
      const url = row[domain as keyof MunicipalityRow];
      
      if (!url || url.trim() === '') {
        console.log(`  No URL for domain ${domain}, skipping`);
        continue;
      }

      // Create directory structure: data/{Domain}/NY-{MunicipalityName}-{MunicipalityType}/
      const dirPath = path.join(
        process.cwd(),
        'data',
        domain,
        `NY-${municipalityName.replace(/\s+/g, '')}-${municipalityType.replace(/\s+/g, '')}`
      );
      
      await fs.ensureDir(dirPath);
      const filePath = path.join(dirPath, 'statute.txt');
      
      // Check if file already exists and is recent
      if (await fs.pathExists(filePath)) {
        const stats = await fs.stat(filePath);
        const daysSinceUpdate = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);
        
        if (daysSinceUpdate < 30) {
          console.log(`  ${domain}: File exists and is recent, skipping`);
          continue;
        }
      }

      // Add delay between downloads to be respectful
      if (downloadCount > 0) {
        console.log(`  Waiting ${DELAY_BETWEEN_DOWNLOADS/1000} seconds...`);
        await delay(DELAY_BETWEEN_DOWNLOADS);
      }

      const content = await downloadFromUrl(url);
      
      if (content) {
        await fs.writeFile(filePath, content, 'utf-8');
        console.log(`  ${domain}: Downloaded and saved`);
      } else {
        console.log(`  ${domain}: Failed to download`);
      }
      
      downloadCount++;
    }
  }
  
  console.log(`Extraction complete! Downloaded ${downloadCount} files`);
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  extractStatuteLinks().catch(console.error);
}

export { extractStatuteLinks };
