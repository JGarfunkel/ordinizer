#!/usr/bin/env tsx

import axios from "axios";

async function inspectWENSpreadsheet() {
  const wenUrl = process.env.WEN_SPREADSHEET_URL;
  
  if (!wenUrl) {
    console.error("WEN_SPREADSHEET_URL environment variable not found");
    return;
  }
  
  console.log("Inspecting WEN spreadsheet structure...");
  console.log("URL:", wenUrl);
  
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
  
  console.log("CSV URL:", csvUrl);
  
  try {
    const response = await axios.get(csvUrl, {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Ordinizer/1.0)'
      }
    });
    
    const csvData = response.data;
    const lines = csvData.split('\n').slice(0, 10); // First 10 lines
    
    console.log("\n=== First 10 lines of CSV data ===");
    lines.forEach((line, index) => {
      console.log(`Line ${index}: ${line}`);
    });
    
    console.log("\n=== Parsed column headers ===");
    const firstLine = lines[0];
    const headers = firstLine.split(',').map((h, i) => `Column ${i}: "${h.trim()}"`);
    headers.forEach(h => console.log(h));
    
    console.log("\n=== Sample data rows ===");
    for (let i = 1; i < Math.min(5, lines.length); i++) {
      const columns = lines[i].split(',');
      console.log(`Row ${i}:`);
      columns.forEach((col, j) => {
        console.log(`  Column ${j}: "${col.trim()}"`);
      });
    }
    
  } catch (error) {
    console.error("Error fetching WEN data:", error);
  }
}

inspectWENSpreadsheet();