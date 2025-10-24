#!/usr/bin/env tsx

import fs from "fs-extra";
import path from "path";
import axios from "axios";
import { parse } from "csv-parse/sync";

interface WetlandRecord {
  municipality: string;
  municipalityType: string;
  wetlandProtectionLink: string;
  hasWetlandProtection: boolean;
}

async function extractWetlandsFromWEN(csvData: string): Promise<void> {
  console.log("Processing WEN Ordinance Library data for Wetland Protection...");
  
  try {
    const records = parse(csvData, { 
      columns: true,
      skip_empty_lines: true,
      trim: true 
    }) as Record<string, any>[];
    
    console.log(`Parsed ${records.length} records from CSV`);
    
    const wetlandRecords: WetlandRecord[] = [];
    
    for (const record of records) {
      // Look for wetland protection column - it might be named differently
      const wetlandColumns = Object.keys(record).filter(key => 
        key.toLowerCase().includes('wetland') && 
        key.toLowerCase().includes('protection')
      );
      
      if (wetlandColumns.length === 0) {
        // Also check for just "wetland" column
        const wetlandOnlyColumns = Object.keys(record).filter(key => 
          key.toLowerCase().includes('wetland')
        );
        wetlandColumns.push(...wetlandOnlyColumns);
      }
      
      console.log(`Available columns: ${Object.keys(record).join(', ')}`);
      console.log(`Wetland columns found: ${wetlandColumns.join(', ')}`);
      
      for (const wetlandColumn of wetlandColumns) {
        const wetlandLink = record[wetlandColumn] as string;
        
        if (wetlandLink && wetlandLink.startsWith('http')) {
          // Extract municipality info from other columns
          let municipality = '';
          let municipalityType = '';
          
          // Look for municipality name column
          const municipalityColumns = Object.keys(record).filter(key => 
            key.toLowerCase().includes('municipality') || 
            key.toLowerCase().includes('muni') ||
            key.toLowerCase().includes('town') ||
            key.toLowerCase().includes('city') ||
            key.toLowerCase().includes('village')
          );
          
          if (municipalityColumns.length > 0) {
            const muniValue = record[municipalityColumns[0]] as string;
            if (muniValue) {
              // Parse "Town of Somers" format
              if (muniValue.includes(' of ')) {
                const parts = muniValue.split(' of ');
                municipalityType = parts[0].trim();
                municipality = parts[1].trim();
              } else {
                municipality = muniValue;
                municipalityType = 'Municipality';
              }
            }
          }
          
          if (municipality) {
            wetlandRecords.push({
              municipality,
              municipalityType,
              wetlandProtectionLink: wetlandLink,
              hasWetlandProtection: true
            });
          }
        }
      }
    }
    
    console.log(`Found ${wetlandRecords.length} municipalities with wetland protection`);
    
    if (wetlandRecords.length === 0) {
      console.log("No wetland records found. Printing first record structure:");
      console.log(JSON.stringify(records[0], null, 2));
      return;
    }
    
    // Create wetlands domain structure
    const wetlandsDir = path.join(process.cwd(), 'data', 'wetlands');
    await fs.ensureDir(wetlandsDir);
    
    // Process each wetland municipality
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    let downloadCount = 0;
    
    for (const record of wetlandRecords) {
      const municipalityDir = `NY-${record.municipality.replace(/\s+/g, '')}-${record.municipalityType.replace(/\s+/g, '')}`;
      const dirPath = path.join(wetlandsDir, municipalityDir);
      await fs.ensureDir(dirPath);
      
      const filePath = path.join(dirPath, 'statute.txt');
      const metadataPath = path.join(dirPath, 'metadata.json');
      
      // Check if file already exists
      if (await fs.pathExists(filePath)) {
        console.log(`Skipping ${municipalityDir} - file already exists`);
        continue;
      }
      
      try {
        console.log(`Downloading wetland statute for ${municipalityDir}...`);
        
        const response = await axios.get(record.wetlandProtectionLink, {
          timeout: 30000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Ordinizer/1.0)'
          }
        });
        
        await fs.writeFile(filePath, response.data);
        
        const metadata = {
          municipality: record.municipality,
          municipalityType: record.municipalityType,
          domain: 'Wetland Protection',
          sourceUrl: record.wetlandProtectionLink,
          downloadedAt: new Date().toISOString(),
          source: 'WEN Ordinance Library'
        };
        
        await fs.writeJson(metadataPath, metadata, { spaces: 2 });
        
        downloadCount++;
        console.log(`✓ Downloaded statute for ${municipalityDir}`);
        
        // Rate limiting
        await delay(1000);
        
      } catch (error) {
        console.error(`Failed to download statute for ${municipalityDir}:`, error);
      }
    }
    
    console.log(`\n✅ Wetland extraction completed!`);
    console.log(`📄 Downloaded ${downloadCount} wetland statutes`);
    console.log(`📊 Found ${wetlandRecords.length} municipalities with wetland protection`);
    
    // Save summary
    const summary = {
      domain: 'wetlands',
      extractedAt: new Date().toISOString(),
      totalMunicipalities: wetlandRecords.length,
      successfulDownloads: downloadCount,
      municipalities: wetlandRecords.map(r => ({
        id: `NY-${r.municipality.replace(/\s+/g, '')}-${r.municipalityType.replace(/\s+/g, '')}`,
        name: r.municipality,
        type: r.municipalityType,
        sourceUrl: r.wetlandProtectionLink
      }))
    };
    
    await fs.writeJson(path.join(wetlandsDir, 'extraction-summary.json'), summary, { spaces: 2 });
    
  } catch (error) {
    console.error('Error processing CSV:', error);
    throw error;
  }
}

async function main() {
  const csvPath = process.argv[2];
  
  if (!csvPath) {
    console.error("Please provide the WEN Ordinance Library CSV file path");
    console.error("Usage: tsx scripts/extractWetlandsFromWEN.ts <path-to-wen-csv>");
    console.error("Export the WEN spreadsheet as CSV first, ensuring it includes the 'Wetland Protection' column");
    process.exit(1);
  }
  
  if (!fs.existsSync(csvPath)) {
    console.error(`CSV file not found: ${csvPath}`);
    process.exit(1);
  }
  
  try {
    const csvData = await fs.readFile(csvPath, 'utf-8');
    await extractWetlandsFromWEN(csvData);
  } catch (error) {
    console.error('Error extracting wetlands data:', error);
    process.exit(1);
  }
}

main();