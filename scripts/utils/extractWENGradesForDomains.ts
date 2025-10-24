#!/usr/bin/env tsx
import fs from 'fs-extra';
import path from 'path';
import { google } from 'googleapis';

const SPREADSHEET_URL = process.env.WEN_SPREADSHEET_URL;
const API_KEY = process.env.GOOGLE_SHEETS_API_KEY;

interface WENGradeMapping {
  [municipalityId: string]: {
    grade: string;
    gradeColor: string;
  };
}

// WEN grade prefix to display name and color mapping
const GRADE_MAPPING = {
  'GG': { grade: 'Very Good', gradeColor: '#059669' }, // Dark green
  'G': { grade: 'Good', gradeColor: '#84cc16' },        // Light green  
  'Y': { grade: 'Yellow', gradeColor: '#eab308' },      // Yellow
  'R': { grade: 'Red', gradeColor: '#ef4444' },         // Red
  'X': { grade: 'Not Available', gradeColor: '#6b7280' } // Gray
};

function extractSpreadsheetId(url: string): string {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) {
    throw new Error('Invalid Google Sheets URL');
  }
  return match[1];
}

function parseGradeFromText(text: string): { grade: string; gradeColor: string } | null {
  if (!text) return null;
  
  // Trim leading and trailing whitespace
  const cleanText = text.trim();
  if (!cleanText) return null;
  
  // Check for grade prefixes at the start of URLs or text
  const prefixMatch = cleanText.match(/^(GG|G|Y|R|X)-/);
  if (prefixMatch) {
    const prefix = prefixMatch[1];
    return GRADE_MAPPING[prefix] || null;
  }
  
  return null;
}

async function fetchDomainGrades(domainName: string, columnName: string): Promise<WENGradeMapping> {
  try {
    if (!SPREADSHEET_URL || !API_KEY) {
      throw new Error('Missing SPREADSHEET_URL or GOOGLE_SHEETS_API_KEY environment variables');
    }

    const spreadsheetId = extractSpreadsheetId(SPREADSHEET_URL);
    const sheets = google.sheets({ version: 'v4', auth: API_KEY });

    console.log(`📊 Fetching ${domainName} grades from WEN spreadsheet...`);

    // Load our municipalities data to get correct mapping
    const municipalitiesData = await fs.readJson('data/municipalities.json');
    const municipalityLookup = new Map();
    
    // Create lookup by simplified name for matching
    for (const muni of municipalitiesData.municipalities) {
      const simpleName = muni.name.toLowerCase().replace(/[^a-z]/g, '');
      municipalityLookup.set(simpleName, muni.id);
      
      // Also add alternative formats
      municipalityLookup.set(muni.name.toLowerCase(), muni.id);
      municipalityLookup.set(`${muni.name.toLowerCase()} ${muni.type.toLowerCase()}`, muni.id);
    }

    // Fetch the Ordinances sheet data  
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Ordinances!A:Z', // Get all columns to find the right one
    });

    const rows = response.data.values;
    if (!rows || rows.length < 2) {
      throw new Error('No data found in spreadsheet');
    }

    // Find the column index for the domain
    const headerRow = rows[1]; // Row 2 contains headers
    const columnIndex = headerRow.findIndex(header => 
      header && header.toLowerCase().includes(columnName.toLowerCase())
    );

    if (columnIndex === -1) {
      console.log(`⚠️ Column "${columnName}" not found in spreadsheet`);
      return {};
    }

    console.log(`📍 Found ${domainName} data in column ${String.fromCharCode(65 + columnIndex)} (index ${columnIndex})`);

    const gradeMapping: WENGradeMapping = {};
    let gradesFound = 0;

    // Process data rows (starting from row 3, index 2)
    for (let i = 2; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length <= columnIndex) continue;

      const municipalityName = row[0]?.trim(); // Column A has municipality names
      const domainData = row[columnIndex]?.trim(); // Domain column

      if (!municipalityName || !domainData) continue;

      const gradeInfo = parseGradeFromText(domainData);
      if (!gradeInfo) continue;

      // Try multiple matching strategies
      let municipalityId = null;
      
      // Strategy 1: Parse WEN format "Name (Type)" or "Name (Town/Village)"
      let parsedName = '';
      let parsedType = '';
      
      const parenMatch = municipalityName.match(/^(.+)\s*\((.+)\)$/);
      if (parenMatch) {
        parsedName = parenMatch[1].trim();
        const typeText = parenMatch[2].trim();
        
        // Handle combined types like "Town/Village"
        if (typeText.includes('/')) {
          // For combined types, try both
          const types = typeText.split('/');
          for (const type of types) {
            const testId = municipalityLookup.get(`${parsedName.toLowerCase()} ${type.trim().toLowerCase()}`);
            if (testId) {
              municipalityId = testId;
              parsedType = type.trim();
              break;
            }
          }
        } else {
          parsedType = typeText;
          municipalityId = municipalityLookup.get(`${parsedName.toLowerCase()} ${parsedType.toLowerCase()}`);
        }
      }
      
      // Strategy 2: Direct name lookup (fallback)
      if (!municipalityId) {
        municipalityId = municipalityLookup.get(municipalityName.toLowerCase());
      }
      
      // Strategy 3: Simplified name lookup (remove spaces/punctuation)
      if (!municipalityId && parsedName) {
        const simpleName = parsedName.toLowerCase().replace(/[^a-z]/g, '');
        municipalityId = municipalityLookup.get(simpleName);
      }

      if (municipalityId) {
        gradeMapping[municipalityId] = gradeInfo;
        gradesFound++;
        console.log(`✅ ${municipalityId}: ${gradeInfo.grade} (${gradeInfo.gradeColor})`);
      } else {
        console.log(`⚠️ Could not match "${municipalityName}" to any municipality ID`);
      }
    }

    console.log(`📊 Extracted ${gradesFound} grades for ${domainName}\n`);
    return gradeMapping;

  } catch (error) {
    console.error(`❌ Failed to fetch ${domainName} grades:`, error);
    return {};
  }
}

async function updateAnalysisFiles(domainPath: string, gradeMapping: WENGradeMapping): Promise<void> {
  console.log(`🔄 Updating analysis files in ${domainPath}...`);

  if (!await fs.pathExists(domainPath)) {
    console.log(`⚠️ Domain path ${domainPath} does not exist`);
    return;
  }

  const municipalityDirs = await fs.readdir(domainPath);
  let updated = 0;
  let notFound = 0;

  for (const dir of municipalityDirs) {
    if (!dir.startsWith('NY-')) continue;

    const analysisFile = path.join(domainPath, dir, 'analysis.json');
    
    if (!await fs.pathExists(analysisFile)) {
      console.log(`⚠️ No analysis file for ${dir}`);
      continue;
    }

    try {
      const analysis = await fs.readJson(analysisFile);
      
      if (gradeMapping[dir]) {
        analysis.grade = gradeMapping[dir].grade;
        analysis.gradeColor = gradeMapping[dir].gradeColor;
        analysis.lastUpdated = new Date().toISOString();
        
        await fs.writeJson(analysisFile, analysis, { spaces: 2 });
        console.log(`✅ Updated ${dir}: ${gradeMapping[dir].grade}`);
        updated++;
      } else {
        console.log(`⚠️ No grade found for ${dir}`);
        notFound++;
      }
      
    } catch (error) {
      console.error(`❌ Failed to update ${dir}:`, error);
    }
  }

  console.log(`📊 Updated: ${updated}, Not found: ${notFound}\n`);
}

async function main(): Promise<void> {
  console.log('\n🌳 WEN Grade Extraction for Trees, Wetland Protection, and GLB 🌳\n');

  try {
    // Define domains to extract
    const domainsToExtract = [
      { name: 'Trees', columnName: 'tree', path: 'data/trees' },
      { name: 'Wetland Protection', columnName: 'wetland', path: 'data/wetland-protection' },
      { name: 'GLB', columnName: 'glb', path: 'data/glb' }
    ];

    for (const domain of domainsToExtract) {
      console.log(`\n=== Processing ${domain.name} ===`);
      
      const gradeMapping = await fetchDomainGrades(domain.name, domain.columnName);
      
      if (Object.keys(gradeMapping).length > 0) {
        await updateAnalysisFiles(domain.path, gradeMapping);
      } else {
        console.log(`⚠️ No grades found for ${domain.name}`);
      }
    }

    console.log('\n🎉 WEN grade extraction complete! 🎉');

  } catch (error) {
    console.error('❌ Script failed:', error);
    process.exit(1);
  }
}

main().catch(console.error);