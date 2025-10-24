#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';
import { cleanStatuteFile } from './cleanupNavigationContent.js';

/**
 * Test cleanup on specific high-impact files
 */
async function testFocusedCleanup() {
  const testCases = [
    {
      municipality: 'NY-MountVernon-City',
      domain: 'property-maintenance',
      description: 'Mount Vernon property-maintenance (missed in cleanup)'
    }
  ];
  
  console.log('🧪 Testing focused cleanup on high-impact files...\n');
  
  for (const testCase of testCases) {
    console.log(`📋 Testing: ${testCase.description}`);
    
    const result = await cleanStatuteFile(
      path.join(process.cwd(), 'data', testCase.domain, testCase.municipality, 'statute.txt'),
      testCase.municipality,
      testCase.domain,
      false // Execute actual cleanup
    );
    
    if (result) {
      const pct = ((result.charactersRemoved / result.originalSize) * 100).toFixed(1);
      console.log(`✅ Cleanup complete:`);
      console.log(`   • Original: ${result.originalLines} lines, ${result.originalSize.toLocaleString()} characters`);
      console.log(`   • Cleaned: ${result.cleanedLines} lines, ${result.cleanedSize.toLocaleString()} characters`);
      console.log(`   • Removed: ${result.removedContent.length} navigation lines`);
      console.log(`   • Savings: ${result.charactersRemoved.toLocaleString()} characters (${pct}%)`);
      
      console.log(`\n📝 Sample removed navigation lines:`);
      result.removedContent.slice(0, 8).forEach(line => {
        console.log(`   - "${line}"`);
      });
      
      console.log(`\n📄 Content now starts with:`);
      console.log(`   "${result.contentPreview}"`);
      
    } else {
      console.log('❌ No cleanup needed or file not found');
    }
    
    console.log('\n' + '='.repeat(80) + '\n');
  }
  
  console.log('🎉 Focused cleanup test complete!');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  testFocusedCleanup().catch(console.error);
}