#!/usr/bin/env tsx

import fs from "fs-extra";
import path from "path";
import axios from "axios";

const DELAY_BETWEEN_DOWNLOADS = 2000; // 2 seconds

interface GLBRecord {
  municipalityId: string;
  municipalityName: string;
  municipalityType: string;
  noiseOrdinanceRef: string;
  extractedUrl?: string;
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function extractGLBFromWEN(): Promise<void> {
  const wenUrl = process.env.WEN_SPREADSHEET_URL;
  
  if (!wenUrl) {
    throw new Error("WEN_SPREADSHEET_URL environment variable not found");
  }
  
  console.log("Extracting GLB (Gas Leaf Blower) data from noise ordinances...");
  
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
  
  console.log("Fetching WEN data for GLB extraction...");
  
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
  
  console.log("Looking for GLB column...");
  
  // Find GLB column index
  const glbIndex = headers.findIndex(h => h === 'GLB');
  if (glbIndex === -1) {
    throw new Error('GLB column not found in WEN spreadsheet');
  }
  
  console.log(`Found GLB column at index ${glbIndex}`);
  
  // Process municipality data starting from line 2
  const glbRecords: GLBRecord[] = [];
  
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const columns = line.split(',').map(c => c.trim());
    const municipalityCol = columns[0];
    const glbCol = columns[glbIndex];
    
    if (!municipalityCol || !municipalityCol.includes('(') || !glbCol) continue;
    
    // Parse municipality name and type
    const match = municipalityCol.match(/^(.+?)\s*\((.+?)\)$/);
    if (!match) continue;
    
    const municipalityName = match[1].trim();
    const municipalityType = match[2].trim();
    const municipalityId = `NY-${municipalityName.replace(/\s+/g, '')}-${municipalityType.replace(/[\s\/]/g, '')}`;
    
    // Extract URL from GLB cell if it contains one
    const urlMatch = glbCol.match(/(https?:\/\/[^\s,]+)/);
    
    glbRecords.push({
      municipalityId,
      municipalityName,
      municipalityType,
      noiseOrdinanceRef: glbCol,
      extractedUrl: urlMatch ? urlMatch[1] : undefined
    });
    
    console.log(`Found GLB data for ${municipalityName} (${municipalityType}): ${glbCol}`);
  }
  
  console.log(`\nProcessed ${glbRecords.length} municipalities with GLB data`);
  
  // Create GLB domain directory
  const glbDir = path.join(process.cwd(), 'data', 'glb');
  await fs.ensureDir(glbDir);
  
  let downloadCount = 0;
  let noiseRefCount = 0;
  
  for (const record of glbRecords) {
    console.log(`\nProcessing ${record.municipalityId}...`);
    
    const dirPath = path.join(glbDir, record.municipalityId);
    await fs.ensureDir(dirPath);
    
    const filePath = path.join(dirPath, 'statute.txt');
    const metadataPath = path.join(dirPath, 'metadata.json');
    
    // Check if file already exists and is recent
    if (await fs.pathExists(filePath)) {
      const stats = await fs.stat(filePath);
      const daysSinceUpdate = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);
      
      if (daysSinceUpdate < 7) {
        console.log(`  GLB: File exists and is recent, skipping`);
        continue;
      }
    }
    
    let statuteContent = '';
    let sourceUrl = '';
    
    if (record.extractedUrl) {
      // Download from extracted URL
      try {
        console.log(`  GLB: Downloading from ${record.extractedUrl}`);
        
        if (downloadCount > 0) {
          console.log(`  Waiting ${DELAY_BETWEEN_DOWNLOADS/1000} seconds...`);
          await delay(DELAY_BETWEEN_DOWNLOADS);
        }
        
        const statuteResponse = await axios.get(record.extractedUrl, {
          timeout: 30000,
          maxRedirects: 5,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Ordinizer/1.0)'
          }
        });
        
        statuteContent = statuteResponse.data;
        sourceUrl = record.extractedUrl;
        downloadCount++;
        
        console.log(`  GLB: ✅ Downloaded statute (${statuteContent.length} characters)`);
        
      } catch (error) {
        console.error(`  GLB: ❌ Failed to download - ${error.message}`);
        statuteContent = `Noise Ordinance Reference: ${record.noiseOrdinanceRef}`;
        sourceUrl = 'noise-ordinance-reference';
        noiseRefCount++;
      }
    } else {
      // Create statute file with noise ordinance reference
      statuteContent = `Gas Leaf Blower Regulations - Noise Ordinance Reference: ${record.noiseOrdinanceRef}

This municipality regulates gas leaf blowers under their noise ordinance. The specific regulation is: ${record.noiseOrdinanceRef}

To view the full statute, please refer to the noise ordinance section of the municipal code.`;
      sourceUrl = 'noise-ordinance-reference';
      noiseRefCount++;
      console.log(`  GLB: Created reference file for noise ordinance`);
    }
    
    // Save statute content
    await fs.writeFile(filePath, statuteContent, 'utf-8');
    
    // Save metadata
    const metadata = {
      municipality: record.municipalityName,
      municipalityType: record.municipalityType,
      domain: 'GLB',
      domainId: 'glb',
      sourceUrl: sourceUrl,
      originalCellValue: record.noiseOrdinanceRef,
      contentType: record.extractedUrl ? 'downloaded-statute' : 'noise-ordinance-reference',
      downloadedAt: new Date().toISOString(),
      contentLength: statuteContent.length,
      source: 'WEN Ordinance Library - GLB/Noise Ordinance'
    };
    
    await fs.writeJson(metadataPath, metadata, { spaces: 2 });
  }
  
  console.log(`\n🎉 GLB extraction completed!`);
  console.log(`📊 Processed ${glbRecords.length} municipalities with GLB data`);
  console.log(`📄 Downloaded ${downloadCount} statute files`);
  console.log(`📋 Created ${noiseRefCount} noise ordinance references`);
  
  // Add GLB domain to domains.json
  const domainsPath = path.join(process.cwd(), 'data', 'domains.json');
  const domainsData = await fs.readJson(domainsPath);
  
  // Check if GLB domain already exists
  const existingGLB = domainsData.domains.find((d: any) => d.id === 'glb');
  
  if (!existingGLB) {
    domainsData.domains.push({
      id: 'glb',
      name: 'glb',
      displayName: 'Gas Leaf Blowers',
      description: 'Gas-powered leaf blower regulations and restrictions (typically found in noise ordinances)'
    });
    
    domainsData.lastUpdated = new Date().toISOString();
    
    await fs.writeJson(domainsPath, domainsData, { spaces: 2 });
    console.log(`Added GLB domain to domains.json`);
  }
}

async function main() {
  try {
    await extractGLBFromWEN();
  } catch (error) {
    console.error('Error extracting GLB data:', error);
    process.exit(1);
  }
}

main();