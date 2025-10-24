#!/usr/bin/env tsx

import fs from "fs-extra";
import path from "path";
import axios from "axios";
import { parse } from "csv-parse/sync";

interface OrdinanceRecord {
  topic: string;
  municipality: string;
  municipalityType: string;
  ordinanceLink: string;
}

async function extractWENLibraryData(csvData: string): Promise<void> {
  console.log("Processing WEN Ordinance Library data...");
  
  const lines = csvData.split('\n');
  const records: OrdinanceRecord[] = [];
  
  let currentTopic = "";
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    
    // Try to parse as CSV
    try {
      const parsed = parse(trimmed, { 
        columns: false,
        skip_empty_lines: true 
      })[0];
      
      if (!parsed || parsed.length < 2) continue;
      
      const col1 = String(parsed[0] || '').trim();
      const col2 = String(parsed[1] || '').trim();
      
      // Skip header rows
      if (col1.includes('MUNICIPAL ENVIRONMENTAL') || 
          col1.includes('Muni Type') || 
          col2.includes('Ordinance Link')) {
        continue;
      }
      
      // Check if this is a topic header (no municipality type in col1)
      if (col1 && !col1.includes(' of ') && !col1.includes('City') && 
          !col1.includes('Town') && !col1.includes('Village') &&
          col2 === '') {
        currentTopic = col1;
        console.log(`Found topic: ${currentTopic}`);
        continue;
      }
      
      // Parse municipality records
      if (col1 && (col1.includes('Town of') || col1.includes('City of') || 
                   col1.includes('Village of') || col1.includes('Town/Village of'))) {
        
        const municipalityType = col1.split(' of ')[0].trim();
        const municipalityName = col1.split(' of ')[1]?.trim();
        
        if (municipalityName && col2 && col2.startsWith('http')) {
          records.push({
            topic: currentTopic,
            municipality: municipalityName,
            municipalityType: municipalityType,
            ordinanceLink: col2
          });
        }
      }
    } catch (error) {
      // Skip lines that can't be parsed
      continue;
    }
  }
  
  console.log(`Extracted ${records.length} ordinance records`);
  
  // Group by municipality
  const municipalityGroups = new Map<string, OrdinanceRecord[]>();
  
  for (const record of records) {
    const key = `${record.municipality}-${record.municipalityType}`;
    if (!municipalityGroups.has(key)) {
      municipalityGroups.set(key, []);
    }
    municipalityGroups.get(key)!.push(record);
  }
  
  console.log(`Found ${municipalityGroups.size} unique municipalities`);
  
  // Create municipalities.json
  const municipalities = Array.from(municipalityGroups.keys()).map(key => {
    const [name, type] = key.split('-');
    return {
      id: key.toLowerCase().replace(/\s+/g, '-'),
      name: name,
      type: type.replace(/^(Town|City|Village)$/, '$1'),
      state: "NY",
      displayName: `${name} - ${type}`
    };
  });
  
  await fs.ensureDir("data");
  await fs.writeJson("data/municipalities.json", {
    municipalities,
    lastUpdated: new Date().toISOString()
  }, { spaces: 2 });
  
  console.log(`Created municipalities.json with ${municipalities.length} municipalities`);
  
  // Create topic-based domains
  const topics = [...new Set(records.map(r => r.topic).filter(t => t))];
  const domains = topics.map(topic => ({
    id: topic.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-'),
    name: topic.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-'),
    displayName: topic,
    description: `Municipal regulations related to ${topic.toLowerCase()}`
  }));
  
  await fs.writeJson("data/domains.json", {
    domains,
    lastUpdated: new Date().toISOString()
  }, { spaces: 2 });
  
  console.log(`Created domains.json with ${domains.length} domains based on topics`);
  
  // Create directory structure and download statutes
  let downloadCount = 0;
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  
  for (const record of records) {
    if (!record.ordinanceLink.startsWith('http')) continue;
    
    const domainName = record.topic.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
    const municipalityDir = `NY-${record.municipality.replace(/\s+/g, '')}-${record.municipalityType.replace(/\s+/g, '')}`;
    
    const dirPath = path.join(process.cwd(), 'data', domainName, municipalityDir);
    await fs.ensureDir(dirPath);
    
    const filePath = path.join(dirPath, 'statute.txt');
    const metadataPath = path.join(dirPath, 'metadata.json');
    
    // Check if file already exists
    if (await fs.pathExists(filePath)) {
      console.log(`  ${record.topic}/${record.municipality}: Already exists, skipping`);
      continue;
    }
    
    // Add delay between downloads
    if (downloadCount > 0) {
      console.log(`  Waiting 3 seconds...`);
      await delay(3000);
    }
    
    try {
      console.log(`Downloading: ${record.municipality} - ${record.topic}`);
      const response = await axios.get(record.ordinanceLink, {
        timeout: 30000,
        maxRedirects: 5,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Ordinizer/1.0)'
        }
      });
      
      if (response.data) {
        await fs.writeFile(filePath, response.data, 'utf-8');
        
        await fs.writeJson(metadataPath, {
          municipality: record.municipality,
          municipalityType: record.municipalityType,
          topic: record.topic,
          sourceUrl: record.ordinanceLink,
          downloadedAt: new Date().toISOString(),
          contentLength: response.data.length
        }, { spaces: 2 });
        
        console.log(`  Downloaded successfully (${response.data.length} characters)`);
        downloadCount++;
      }
    } catch (error) {
      console.error(`  Failed to download ${record.ordinanceLink}:`, error);
    }
  }
  
  console.log(`\nExtraction complete!`);
  console.log(`- ${municipalities.length} municipalities`);
  console.log(`- ${domains.length} domains`);
  console.log(`- ${downloadCount} statute files downloaded`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.error("Usage: tsx scripts/extractWENLibrary.ts <csv-file-path>");
    console.error("");
    console.error("Steps:");
    console.error("1. Open your Google Sheets");
    console.error("2. Go to File > Download > Comma-separated values (.csv)");
    console.error("3. Save the CSV file locally");
    console.error("4. Run this script with the CSV file path");
    process.exit(1);
  }

  const csvFile = args[0];
  
  try {
    if (!await fs.pathExists(csvFile)) {
      throw new Error(`File not found: ${csvFile}`);
    }
    
    const csvData = await fs.readFile(csvFile, 'utf-8');
    await extractWENLibraryData(csvData);
    
    console.log("\n✅ WEN Library extraction completed successfully!");
    console.log("\nNext steps:");
    console.log("1. Run: tsx scripts/civicdiff-cli.ts status");
    console.log("2. Generate questions: tsx scripts/civicdiff-cli.ts generate <domain-name>");
    console.log("3. Analyze statutes: tsx scripts/civicdiff-cli.ts analyze <domain-name>");
  } catch (error) {
    console.error("❌ Extraction failed:", error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { extractWENLibraryData };