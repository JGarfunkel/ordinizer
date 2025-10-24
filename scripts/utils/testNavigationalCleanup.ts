#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';
import { detectNavigationalContent, executeCleanup } from './cleanNavigationalContent.js';

/**
 * Test the navigational content cleanup on specific municipalities
 */
async function testCleanup() {
  console.log('🧪 Testing navigational content cleanup on sample municipalities...');
  
  // Test cases with known navigational content issues
  const testCases = [
    {
      municipality: 'NY-NewCastle-Town',
      domain: 'trees',
      description: 'New Castle Trees - has extensive navigational content (home, print, email, etc.)'
    },
    {
      municipality: 'NY-Ardsley-Village', 
      domain: 'cac-cb-etc',
      description: 'Ardsley CAC - has chapter/history navigation'
    }
  ];
  
  for (const testCase of testCases) {
    console.log(`\n📋 Testing: ${testCase.description}`);
    
    const statutePath = path.join(process.cwd(), 'data', testCase.domain, testCase.municipality, 'statute.txt');
    
    if (!await fs.pathExists(statutePath)) {
      console.log(`❌ Statute file not found: ${statutePath}`);
      continue;
    }
    
    // Show before
    const beforeContent = await fs.readFile(statutePath, 'utf-8');
    const beforeLines = beforeContent.split('\n');
    
    console.log(`📊 Before cleanup:`);
    console.log(`   • Total lines: ${beforeLines.length}`);
    console.log(`   • Total characters: ${beforeContent.length}`);
    console.log(`   • First 5 lines:`);
    beforeLines.slice(0, 5).forEach((line, i) => {
      console.log(`     ${i+1}: "${line.trim()}"`);
    });
    
    // Create backup
    const backupPath = `${statutePath}.backup-${Date.now()}`;
    await fs.copy(statutePath, backupPath);
    console.log(`📁 Backup created: ${backupPath}`);
    
    // Run detection on just this file
    const detection = await import('./cleanNavigationalContent.js');
    const summary = await detection.detectNavigationalContent();
    
    const thisDetection = summary.detections.find(d => 
      d.municipality === testCase.municipality && d.domain === testCase.domain
    );
    
    if (thisDetection) {
      console.log(`\n🔍 Detection results:`);
      console.log(`   • Navigational lines: ${thisDetection.navigationalLines.length}`);
      console.log(`   • Original size: ${thisDetection.originalLength} chars`);
      console.log(`   • Cleaned size: ${thisDetection.cleanedLength} chars`);
      console.log(`   • Characters saved: ${thisDetection.originalLength - thisDetection.cleanedLength}`);
      
      console.log(`\n📝 Sample navigational lines:`);
      thisDetection.navigationalLines.slice(0, 8).forEach((line, i) => {
        console.log(`     "${line}"`);
      });
      
      console.log(`\n📄 Content starts with:`);
      console.log(`     "${thisDetection.contentStart}"`);
      
      // Execute cleanup for just this detection
      await detection.executeCleanup([thisDetection]);
      
      // Show after
      const afterContent = await fs.readFile(statutePath, 'utf-8');
      const afterLines = afterContent.split('\n');
      
      console.log(`\n✅ After cleanup:`);
      console.log(`   • Total lines: ${afterLines.length}`);
      console.log(`   • Total characters: ${afterContent.length}`);
      console.log(`   • First 5 lines of cleaned content:`);
      afterLines.slice(0, 5).forEach((line, i) => {
        console.log(`     ${i+1}: "${line.trim()}"`);
      });
      
    } else {
      console.log(`✅ No navigational content detected (already clean)`);
    }
    
    console.log(`\n🔄 Original backed up to: ${path.basename(backupPath)}`);
  }
  
  console.log(`\n🎉 Test cleanup complete!`);
}

// Run the test
if (import.meta.url === `file://${process.argv[1]}`) {
  testCleanup().catch(console.error);
}

export { testCleanup };