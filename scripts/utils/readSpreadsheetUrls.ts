#!/usr/bin/env tsx

import { google } from 'googleapis';

async function readSpreadsheetUrls() {
  console.log('📊 Reading WEN spreadsheet for Property Maintenance URLs...');
  
  if (!process.env.GOOGLE_SHEETS_API_KEY) {
    console.error('❌ GOOGLE_SHEETS_API_KEY not found');
    return;
  }
  
  if (!process.env.WEN_SPREADSHEET_URL) {
    console.error('❌ WEN_SPREADSHEET_URL not found');
    return;
  }
  
  const spreadsheetId = process.env.WEN_SPREADSHEET_URL.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1];
  if (!spreadsheetId) {
    console.error('❌ Could not extract spreadsheet ID');
    return;
  }
  
  const auth = new google.auth.GoogleAuth({
    credentials: {
      type: 'service_account',
      project_id: 'ordinizer',
      private_key_id: '1',
      private_key: process.env.GOOGLE_SHEETS_API_KEY.replace(/\\n/g, '\n'),
      client_email: 'service@ordinizer.iam.gserviceaccount.com',
      client_id: '1',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token'
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  
  const sheets = google.sheets({ version: 'v4', auth });
  
  try {
    console.log('🔍 Fetching Ordinances tab...');
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Ordinances!A:E',
    });
    
    const rows = response.data.values || [];
    console.log(`📋 Found ${rows.length} rows`);
    
    // Find municipalities with corrupted statutes
    const corruptedMunicipalities = [
      'Buchanan Village',
      'Cortlandt Town', 
      'Hastings-on-Hudson Village',
      'Lewisboro Town',
      'Mamaroneck Town',
      'Mount Kisco Town',
      'Pelham Town'
    ];
    
    console.log('\n🔍 Looking for corrupted municipalities:');
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const municipality = row[0] || '';
      const type = row[1] || '';
      const propertyMaintenanceUrl = row[3] || ''; // Column D
      
      const fullName = `${municipality} ${type}`;
      
      if (corruptedMunicipalities.some(corrupted => 
        fullName.toLowerCase().includes(corrupted.toLowerCase()) ||
        corrupted.toLowerCase().includes(municipality.toLowerCase())
      )) {
        console.log(`✅ ${fullName}: ${propertyMaintenanceUrl}`);
      }
    }
    
  } catch (error) {
    console.error('❌ Error reading spreadsheet:', error.message);
  }
}

readSpreadsheetUrls().catch(console.error);