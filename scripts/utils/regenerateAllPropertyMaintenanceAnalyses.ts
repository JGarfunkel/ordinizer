#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';
import { execSync } from 'child_process';

async function regenerateAllAnalyses() {
  console.log('🔄 Regenerating ALL Property Maintenance analyses...');
  
  const domainDir = path.join(process.cwd(), '..', 'data', 'property-maintenance');
  const municipalities = await fs.readdir(domainDir);
  
  let processedCount = 0;
  let successCount = 0;
  
  for (const municipality of municipalities) {
    if (!municipality.startsWith('NY-') || municipality === 'questions.json') continue;
    
    const analysisPath = path.join(domainDir, municipality, 'analysis.json');
    
    // Delete existing analysis to force regeneration
    if (await fs.pathExists(analysisPath)) {
      await fs.remove(analysisPath);
    }
    
    processedCount++;
    console.log(`\n[${processedCount}/${municipalities.length}] Processing ${municipality}...`);
    
    try {
      // Run analysis for this specific municipality 
      const result = execSync(`tsx analyzeStatutes.ts --domain="Property Maintenance" --municipality="${municipality}" --force`, {
        cwd: path.join(process.cwd()),
        encoding: 'utf-8',
        timeout: 120000, // 2 minute timeout per municipality
        stdio: 'pipe'
      });
      
      successCount++;
      console.log(`✅ ${municipality}: Successfully regenerated`);
    } catch (error) {
      console.error(`❌ ${municipality}: Failed -`, error.message?.slice(0, 100) || 'Unknown error');
    }
  }
  
  console.log(`\n🎉 Analysis regeneration complete!`);
  console.log(`📊 Results: ${successCount}/${processedCount} municipalities processed successfully`);
}

regenerateAllAnalyses().catch(console.error);