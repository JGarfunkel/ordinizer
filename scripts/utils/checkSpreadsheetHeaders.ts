#!/usr/bin/env tsx

import { extractGoogleSheetsWithHyperlinks } from './extractFromGoogleSheets.js';
import { parse } from 'csv-parse/sync';

async function checkHeaders() {
  try {
    console.log("Checking spreadsheet headers...");
    const result = await extractGoogleSheetsWithHyperlinks('https://docs.google.com/spreadsheets/d/1Nc5xZZ9OrRgI2pnGjlBmo7yvpiQELYSEp19e73Gl_UE/edit?gid=2126758775#gid=2126758775');
    const records = parse(result.csvData, { columns: true, skip_empty_lines: true, trim: true });
    const headers = Object.keys(records[0] || {});
    
    console.log(`\nFound ${headers.length} column headers:`);
    headers.forEach((header, index) => {
      console.log(`Column ${index.toString().padStart(2)}: "${header}"`);
    });
    
    console.log(`\nLooking for potential domain columns containing property/maintenance:`);
    headers.forEach((header, index) => {
      if (header.toLowerCase().includes('property') || header.toLowerCase().includes('maintenance')) {
        console.log(`📋 Column ${index}: "${header}"`);
      }
    });
    
    console.log(`\nSample of first row data:`);
    const firstRow = records[0] || {};
    Object.entries(firstRow).slice(0, 10).forEach(([key, value]) => {
      console.log(`  "${key}": "${value}"`);
    });
    
  } catch (error) {
    console.error("Error:", error);
  }
}

checkHeaders();