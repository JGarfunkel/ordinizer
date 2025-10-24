#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';
import axios from 'axios';

const CORRUPTED_MUNICIPALITIES = [
  'NY-Buchanan-Village',
  'NY-Cortlandt-Town', 
  'NY-Hastings-on-Hudson-Village',
  'NY-Lewisboro-Town',
  'NY-Mamaroneck-Town',
  'NY-MountKisco-Town',
  'NY-Pelham-Town'
];

// Correct URLs from WEN spreadsheet (cell content, not generic hyperlinks)
const MUNICIPALITY_URLS = {
  'NY-Buchanan-Village': 'https://ecode360.com/15780159',
  'NY-Cortlandt-Town': 'https://ecode360.com/37655053#37664851', 
  'NY-Hastings-on-Hudson-Village': 'https://ecode360.com/10990161#10990168',
  'NY-Lewisboro-Town': '', // Uses NY state code - no specific URL
  'NY-Mamaroneck-Town': 'https://ecode360.com/9159479#9159504',
  'NY-MountKisco-Town': 'https://ecode360.com/10861570#10861600',
  'NY-Pelham-Town': '' // Uses NY state code - no specific URL
};

async function redownloadCorruptedStatutes() {
  console.log('🔄 Re-downloading corrupted statute files...');
  
  const domain = 'property-maintenance';
  
  for (const municipalityId of CORRUPTED_MUNICIPALITIES) {
    const url = MUNICIPALITY_URLS[municipalityId];
    if (!url || url === '') {
      console.log(`⚠️ ${municipalityId}: Uses NY state code - creating state reference file`);
      
      // Create a state reference file for municipalities that use NY state code
      const municipalityPath = path.join(process.cwd(), '..', 'data', domain, municipalityId);
      const txtPath = path.join(municipalityPath, 'statute.txt');
      const stateReference = `This municipality uses the New York State Property Maintenance Code.

For specific regulations, refer to:
- NY State Property Maintenance Code
- Local amendments and modifications may apply
- Contact municipal offices for local interpretations and enforcement

This municipality does not maintain separate local property maintenance regulations.`;
      
      await fs.writeFile(txtPath, stateReference);
      console.log(`✅ ${municipalityId}: Created state reference file`);
      
      // Remove corruption flag
      const flagPath = path.join(municipalityPath, 'CORRUPTED_STATUTE.flag');
      if (await fs.pathExists(flagPath)) {
        await fs.remove(flagPath);
      }
      
      continue;
    }
    
    console.log(`\n📥 ${municipalityId}: Downloading from ${url}...`);
    
    try {
      const response = await axios.get(url, {
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });
      
      // Check if we got a login page
      if (response.data.includes('eCode360® Login') || response.data.includes('login')) {
        console.log(`❌ ${municipalityId}: Still getting login page - URL may require authentication`);
        continue;
      }
      
      // Save the HTML file
      const municipalityPath = path.join(process.cwd(), '..', 'data', domain, municipalityId);
      const htmlPath = path.join(municipalityPath, 'statute.html');
      const txtPath = path.join(municipalityPath, 'statute.txt');
      
      await fs.writeFile(htmlPath, response.data);
      console.log(`✅ ${municipalityId}: Downloaded ${response.data.length} characters`);
      
      // Convert to text (basic HTML stripping)
      let textContent = response.data;
      textContent = textContent.replace(/<script[^>]*>.*?<\/script>/gs, '');
      textContent = textContent.replace(/<style[^>]*>.*?<\/style>/gs, '');
      textContent = textContent.replace(/<[^>]*>/g, ' ');
      textContent = textContent.replace(/\s+/g, ' ').trim();
      
      if (textContent.length > 1000) {
        await fs.writeFile(txtPath, textContent);
        console.log(`✅ ${municipalityId}: Converted to text (${textContent.length} characters)`);
        
        // Remove corruption flag
        const flagPath = path.join(municipalityPath, 'CORRUPTED_STATUTE.flag');
        if (await fs.pathExists(flagPath)) {
          await fs.remove(flagPath);
          console.log(`✅ ${municipalityId}: Removed corruption flag`);
        }
      } else {
        console.log(`⚠️ ${municipalityId}: Text conversion resulted in short content (${textContent.length} chars)`);
      }
      
    } catch (error) {
      console.log(`❌ ${municipalityId}: Download failed - ${error.message}`);
    }
    
    // Delay between requests to be respectful
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  console.log('\n🎉 Re-download attempt complete!');
}

redownloadCorruptedStatutes().catch(console.error);