#!/usr/bin/env tsx

import { google } from 'googleapis';

async function testSpreadsheetExtraction() {
  console.log('🧪 Testing spreadsheet extraction for corrupted municipalities...');
  
  const apiKey = process.env.GOOGLE_SHEETS_API_KEY;
  const spreadsheetUrl = process.env.WEN_SPREADSHEET_URL;
  
  if (!apiKey || !spreadsheetUrl) {
    console.error('Missing GOOGLE_SHEETS_API_KEY or WEN_SPREADSHEET_URL');
    return;
  }
  
  const sheetIdMatch = spreadsheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!sheetIdMatch) {
    console.error('Could not extract sheet ID from URL');
    return;
  }
  
  const sheetId = sheetIdMatch[1];
  console.log(`Sheet ID: ${sheetId}`);
  
  try {
    const sheets = google.sheets({ version: 'v4', auth: apiKey });
    
    // Get all data from Ordinances tab
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Ordinances!A:E', // First 5 columns
    });
    
    const rows = response.data.values || [];
    console.log(`Found ${rows.length} rows`);
    
    // Look for corrupted municipalities and their Property Maintenance URLs
    const corruptedNames = [
      'Buchanan', 'Cortlandt', 'Hastings', 'Lewisboro', 
      'Mamaroneck', 'Mount Kisco', 'Pelham'
    ];
    
    for (let i = 2; i < rows.length; i++) { // Start from row 3 (index 2)
      const row = rows[i];
      const municipality = row[0] || '';
      const type = row[1] || '';
      const propertyMaintenanceCell = row[3] || ''; // Column D
      
      const fullName = `${municipality} ${type}`;
      
      if (corruptedNames.some(name => municipality.toLowerCase().includes(name.toLowerCase()))) {
        console.log(`\n🔍 ${fullName}:`);
        console.log(`  Cell content: "${propertyMaintenanceCell}"`);
        
        // Check for URL in cell content
        const cellUrlMatch = propertyMaintenanceCell.match(/https?:\/\/[^\s]*/);
        if (cellUrlMatch) {
          console.log(`  ✅ Found URL in cell: ${cellUrlMatch[0]}`);
        } else {
          console.log(`  ❌ No URL found in cell content`);
        }
      }
    }
    
    // Also check with hyperlinks API
    console.log('\n📋 Checking hyperlinks...');
    const hyperlinkResponse = await sheets.spreadsheets.get({
      spreadsheetId: sheetId,
      ranges: ['Ordinances!A:E'],
      includeGridData: true
    });
    
    const sheetData = hyperlinkResponse.data.sheets?.[0]?.data?.[0]?.rowData || [];
    
    for (let rowIndex = 2; rowIndex < Math.min(sheetData.length, rows.length); rowIndex++) {
      const rowData = sheetData[rowIndex];
      const municipality = rows[rowIndex]?.[0] || '';
      
      if (corruptedNames.some(name => municipality.toLowerCase().includes(name.toLowerCase()))) {
        const cellData = rowData.values?.[3]; // Column D (Property Maintenance)
        const hyperlink = cellData?.hyperlink;
        const cellValue = cellData?.formattedValue || cellData?.userEnteredValue?.stringValue;
        
        console.log(`\n🔗 ${municipality}:`);
        console.log(`  Hyperlink: ${hyperlink || 'none'}`);
        console.log(`  Cell value: ${cellValue || 'none'}`);
        
        if (hyperlink && cellValue) {
          const hyperlinkUrl = new URL(hyperlink);
          const isGenericHyperlink = hyperlinkUrl.pathname === '/';
          const cellUrlMatch = cellValue.match(/https?:\/\/[^\s]*/);
          
          console.log(`  Is generic hyperlink: ${isGenericHyperlink}`);
          console.log(`  Cell contains URL: ${cellUrlMatch ? cellUrlMatch[0] : 'no'}`);
          
          if (cellUrlMatch && isGenericHyperlink) {
            console.log(`  ✅ Should use cell URL: ${cellUrlMatch[0]}`);
          }
        }
      }
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

testSpreadsheetExtraction().catch(console.error);