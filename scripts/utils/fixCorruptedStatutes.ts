#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';

async function fixCorruptedStatutes() {
  console.log('🔍 Checking for corrupted statute files...');
  
  const domain = 'property-maintenance';
  const domainDir = path.join(process.cwd(), '..', 'data', domain);
  
  const municipalities = await fs.readdir(domainDir);
  let corruptedCount = 0;
  
  for (const municDir of municipalities) {
    if (municDir === 'questions.json' || !municDir.startsWith('NY-')) continue;
    
    const statutePath = path.join(domainDir, municDir, 'statute.txt');
    const statuteHtmlPath = path.join(domainDir, municDir, 'statute.html');
    
    if (await fs.pathExists(statutePath)) {
      try {
        const content = await fs.readFile(statutePath, 'utf-8');
        
        // Check if it contains login page content
        if (content.includes('<!DOCTYPE html>') && content.includes('eCode360® Login')) {
          console.log(`🚨 ${municDir}: statute.txt contains HTML login page`);
          corruptedCount++;
          
          // Check if HTML file exists and is also corrupted
          if (await fs.pathExists(statuteHtmlPath)) {
            const htmlContent = await fs.readFile(statuteHtmlPath, 'utf-8');
            if (htmlContent.includes('eCode360® Login')) {
              console.log(`  ❌ ${municDir}: statute.html also corrupted (login page)`);
              console.log(`  ⚠️  ${municDir}: Both files need to be re-downloaded from source`);
            }
          }
          
          // Mark the statute as corrupted by creating a flag file
          const flagPath = path.join(domainDir, municDir, 'CORRUPTED_STATUTE.flag');
          await fs.writeFile(flagPath, `This statute file contains HTML login page instead of statute content.\nNeeds to be re-downloaded from source.\nFound at: ${new Date().toISOString()}`);
        }
      } catch (error) {
        console.log(`❌ ${municDir}: Error reading statute file - ${error.message}`);
      }
    }
  }
  
  console.log(`\n📊 Found ${corruptedCount} corrupted statute files out of ${municipalities.length - 1} municipalities`);
  console.log('🔧 These files need to be re-downloaded from their original sources.');
}

fixCorruptedStatutes().catch(console.error);