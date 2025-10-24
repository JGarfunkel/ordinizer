#!/usr/bin/env tsx

import fs from "fs-extra";
import path from "path";
import { google } from "googleapis";
import axios from "axios";

interface MunicipalityData {
  name: string;
  type: string;
  domains: Record<string, string>; // domain -> URL mapping
}

const DELAY_BETWEEN_DOWNLOADS = 3000; // 3 seconds

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadFromUrl(url: string): Promise<string> {
  try {
    console.log(`    Downloading statute content...`);
    const response = await axios.get(url, {
      timeout: 30000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Ordinizer/1.0)'
      }
    });
    return response.data;
  } catch (error) {
    console.error(`    Failed to download ${url}:`, error);
    return "";
  }
}

function htmlToText(html: string): string {
  // Simple HTML to text conversion
  let text = html
    // Remove script and style tags and their content
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    // Remove comments
    .replace(/<!--[\s\S]*?-->/g, '')
    // Replace common HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '...')
    // Replace headers with content and double newline
    .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, '\n\n$1\n\n')
    // Replace paragraph and div tags with double newlines
    .replace(/<\/?(p|div)[^>]*>/gi, '\n\n')
    // Replace br tags with newlines
    .replace(/<br\s*\/?>/gi, '\n')
    // Handle lists better
    .replace(/<ol[^>]*>/gi, '\n')
    .replace(/<\/ol>/gi, '\n')
    .replace(/<ul[^>]*>/gi, '\n')
    .replace(/<\/ul>/gi, '\n')
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '\n• $1')
    // Replace table cells with tab separation
    .replace(/<\/?(table|tbody|thead|tr)[^>]*>/gi, '\n')
    .replace(/<\/?(td|th)[^>]*>/gi, '\t')
    // Remove all other HTML tags
    .replace(/<[^>]*>/g, '')
    // Clean up whitespace
    .replace(/\n\s*\n\s*\n/g, '\n\n') // Replace multiple newlines with double newline
    .replace(/^[ \t]+/gm, '') // Remove leading spaces from lines
    .replace(/[ \t]+$/gm, '') // Remove trailing spaces from lines
    .replace(/[ \t]+/g, ' ') // Replace multiple spaces/tabs with single space
    .replace(/^\n+/, '') // Remove leading newlines
    .replace(/\n+$/, '') // Remove trailing newlines
    .trim();
  
  // Wrap text at 80 characters
  const lines = text.split('\n');
  const wrappedLines: string[] = [];
  
  for (const line of lines) {
    if (line.length <= 80) {
      wrappedLines.push(line);
    } else {
      // Word wrap at 80 characters
      const words = line.split(' ');
      let currentLine = '';
      
      for (const word of words) {
        if (currentLine.length + word.length + 1 <= 80) {
          currentLine += (currentLine ? ' ' : '') + word;
        } else {
          if (currentLine) {
            wrappedLines.push(currentLine);
          }
          currentLine = word;
        }
      }
      
      if (currentLine) {
        wrappedLines.push(currentLine);
      }
    }
  }
  
  return wrappedLines.join('\n');
}

async function extractFromGoogleSheetsAPI(spreadsheetId: string, sheetName: string = "Ordinances"): Promise<void> {
  try {
    console.log(`Extracting data from Google Sheets API...`);
    console.log(`Spreadsheet ID: ${spreadsheetId}`);
    console.log(`Sheet: ${sheetName}`);
    
    // Initialize Google Sheets API (read-only, no auth required for public sheets)
    const sheets = google.sheets('v4');
    
    // Get sheet data
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: `${sheetName}!A:Z`, // Get all columns A through Z
      key: process.env.GOOGLE_SHEETS_API_KEY, // We'll need this
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      throw new Error('No data found in the sheet');
    }

    console.log(`Found ${rows.length} rows in the sheet`);
    
    // Skip first row (title/key row), use second row as headers  
    const headers = rows[1] as string[];
    console.log('Headers:', headers);
    
    const municipalityColIndex = 0; // First column is "Town"
    
    // Identify domain columns (skip first column which is municipalities)
    const domainColumns: { index: number; name: string }[] = [];
    for (let i = 1; i < headers.length; i++) {
      const header = headers[i];
      if (header && header.trim()) {
        // Check if this column contains URLs in data rows
        const sampleValues = rows.slice(2, Math.min(7, rows.length)).map(row => row[i]);
        const hasUrls = sampleValues.some(val => val && typeof val === 'string' && val.includes('http'));
        
        if (hasUrls) {
          domainColumns.push({ index: i, name: header.trim() });
        }
      }
    }
    
    console.log(`Found ${domainColumns.length} domain columns:`, domainColumns.map(d => d.name));
    
    // Parse municipality data (start from row 3, index 2)
    const municipalities: MunicipalityData[] = [];
    
    for (let rowIndex = 2; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      const municipalityCell = row[municipalityColIndex];
      
      if (!municipalityCell || typeof municipalityCell !== 'string') {
        continue;
      }
      
      // Parse municipality name and type
      const match = municipalityCell.match(/^(.+?)\s*\((.+?)\)$/);
      if (!match) {
        console.log(`Skipping unparseable municipality: ${municipalityCell}`);
        continue;
      }
      
      const [, name, type] = match;
      const domains: Record<string, string> = {};
      
      // Extract domain URLs (handle format like "G- https://..." or "GG-https://...")
      for (const domain of domainColumns) {
        const cellValue = row[domain.index];
        if (cellValue && typeof cellValue === 'string') {
          // Extract URL from various formats: "G- https://...", "GG-https://...", or just "https://..."
          const urlMatch = cellValue.match(/(https?:\/\/[^\s,]+)/);
          if (urlMatch) {
            domains[domain.name] = urlMatch[1];
          }
        }
      }
      
      if (Object.keys(domains).length > 0) {
        municipalities.push({
          name: name.trim(),
          type: type.trim(),
          domains
        });
      }
    }
    
    console.log(`Parsed ${municipalities.length} municipalities with ordinance data`);
    
    // Create municipalities.json
    const municipalitiesData = municipalities.map(m => ({
      id: `NY-${m.name.replace(/[^a-zA-Z0-9]/g, '')}-${m.type.replace(/[^a-zA-Z0-9]/g, '')}`,
      name: m.name,
      type: m.type,
      state: "NY",
      displayName: `${m.name} - ${m.type}`
    }));
    
    await fs.ensureDir("data");
    await fs.writeJson("data/municipalities.json", {
      municipalities: municipalitiesData,
      lastUpdated: new Date().toISOString()
    }, { spaces: 2 });
    
    console.log(`Created municipalities.json with ${municipalitiesData.length} municipalities`);
    
    // Create domains.json
    const allDomains = new Set<string>();
    municipalities.forEach(m => {
      Object.keys(m.domains).forEach(domain => allDomains.add(domain));
    });
    
    const domainsData = Array.from(allDomains).map(domainName => ({
      id: domainName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-'),
      name: domainName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-'),
      displayName: domainName,
      description: `Municipal regulations related to ${domainName.toLowerCase()}`
    }));
    
    await fs.writeJson("data/domains.json", {
      domains: domainsData,
      lastUpdated: new Date().toISOString()
    }, { spaces: 2 });
    
    console.log(`Created domains.json with ${domainsData.length} domains`);
    
    // Download statute content
    let downloadCount = 0;
    
    for (const municipality of municipalities) {
      console.log(`\nProcessing ${municipality.name} (${municipality.type}):`);
      
      for (const [domainName, url] of Object.entries(municipality.domains)) {
        if (!url.startsWith('http')) continue;
        
        const domainId = domainName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
        const municipalityDir = `NY-${municipality.name.replace(/[^a-zA-Z0-9]/g, '')}-${municipality.type.replace(/[^a-zA-Z0-9]/g, '')}`;
        
        const dirPath = path.join(process.cwd(), 'data', domainId, municipalityDir);
        await fs.ensureDir(dirPath);
        
        const htmlPath = path.join(dirPath, 'statute.html');
        const txtPath = path.join(dirPath, 'statute.txt');
        const metadataPath = path.join(dirPath, 'metadata.json');
        
        // Check if files already exist
        if (await fs.pathExists(txtPath)) {
          console.log(`  ${domainName}: Already exists, skipping`);
          continue;
        }
        
        // Add delay between downloads
        if (downloadCount > 0) {
          console.log(`  Waiting 3 seconds...`);
          await delay(DELAY_BETWEEN_DOWNLOADS);
        }
        
        console.log(`  ${domainName}: Downloading from ${url}`);
        const htmlContent = await downloadFromUrl(url);
        
        if (htmlContent) {
          // Save HTML content (optional)
          await fs.writeFile(htmlPath, htmlContent, 'utf-8');
          
          // Convert to plaintext with 80-character wrapping and Unicode symbols
          let textContent = htmlToText(htmlContent);
          
          // Replace navigation symbols with Unicode characters
          textContent = textContent
            .replace(/chevron_right/g, '→')
            .replace(/chevron_left/g, '←') 
            .replace(/arrow_right/g, '→')
            .replace(/arrow_left/g, '←')
            .replace(/arrow_forward/g, '→')
            .replace(/arrow_back/g, '←');
            
          await fs.writeFile(txtPath, textContent, 'utf-8');
          
          await fs.writeJson(metadataPath, {
            municipality: municipality.name,
            municipalityType: municipality.type,
            domain: domainName,
            sourceUrl: url,
            downloadedAt: new Date().toISOString(),
            htmlContentLength: htmlContent.length,
            textContentLength: textContent.length
          }, { spaces: 2 });
          
          console.log(`  ${domainName}: Downloaded successfully (${htmlContent.length} chars HTML, ${textContent.length} chars text)`);
          downloadCount++;
        } else {
          console.log(`  ${domainName}: Download failed`);
        }
      }
    }
    
    console.log(`\n✅ Extraction complete!`);
    console.log(`- ${municipalitiesData.length} municipalities`);
    console.log(`- ${domainsData.length} domains`);
    console.log(`- ${downloadCount} statute files downloaded`);
    
  } catch (error) {
    console.error('Error extracting from Google Sheets API:', error);
    throw error;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.error("Usage: tsx scripts/extractGoogleSheetsAPI.ts <spreadsheet-id> [sheet-name]");
    console.error("");
    console.error("Examples:");
    console.error("  tsx scripts/extractGoogleSheetsAPI.ts 1Nc5xZZ9OrRgI2pnGjlBmo7yvpiQELYSEp19e73Gl_UE");
    console.error("  tsx scripts/extractGoogleSheetsAPI.ts 1Nc5xZZ9OrRgI2pnGjlBmo7yvpiQELYSEp19e73Gl_UE Ordinances");
    console.error("");
    console.error("Note: For public sheets, no API key is required.");
    console.error("For private sheets, set GOOGLE_SHEETS_API_KEY environment variable.");
    process.exit(1);
  }

  const spreadsheetId = args[0];
  const sheetName = args[1] || "Ordinances";
  
  try {
    await extractFromGoogleSheetsAPI(spreadsheetId, sheetName);
    console.log("\n✅ Google Sheets API extraction completed successfully!");
  } catch (error) {
    console.error("❌ Extraction failed:", error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { extractFromGoogleSheetsAPI };