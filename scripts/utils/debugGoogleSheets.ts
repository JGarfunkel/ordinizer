#!/usr/bin/env tsx

import { google } from "googleapis";

async function debugGoogleSheet(spreadsheetId: string, sheetName: string = "Ordinances"): Promise<void> {
  try {
    console.log(`Debugging Google Sheet...`);
    console.log(`Spreadsheet ID: ${spreadsheetId}`);
    console.log(`Sheet: ${sheetName}`);
    
    const sheets = google.sheets('v4');
    
    // First, get the sheet metadata to see available sheets
    const sheetInfo = await sheets.spreadsheets.get({
      spreadsheetId: spreadsheetId,
      key: process.env.GOOGLE_SHEETS_API_KEY,
    });
    
    console.log('\nAvailable sheets:');
    sheetInfo.data.sheets?.forEach((sheet, index) => {
      console.log(`  ${index + 1}. "${sheet.properties?.title}" (sheetId: ${sheet.properties?.sheetId})`);
    });
    
    // Get data from the specified sheet
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: `${sheetName}!A1:Z10`, // First 10 rows, all columns
      key: process.env.GOOGLE_SHEETS_API_KEY,
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      console.log('No data found in the sheet');
      return;
    }

    console.log(`\nFirst 10 rows from "${sheetName}" sheet:`);
    rows.forEach((row, index) => {
      console.log(`Row ${index + 1}:`, row);
    });
    
  } catch (error) {
    console.error('Error:', error);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const spreadsheetId = args[0] || "1Nc5xZZ9OrRgI2pnGjlBmo7yvpiQELYSEp19e73Gl_UE";
  const sheetName = args[1] || "Ordinances";
  
  await debugGoogleSheet(spreadsheetId, sheetName);
}

main().catch(console.error);