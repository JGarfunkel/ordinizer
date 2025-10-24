#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';

/**
 * Verify high-impact cleanup cases to ensure no meaningful content is removed
 */
async function verifyHighImpactCases() {
  const highImpactCases = [
    {
      municipality: 'NY-State',
      domain: 'property-maintenance',
      description: 'Highest absolute reduction: 136,352 chars (56.7%)',
      expectedContent: 'CHAPTER 6 MECHANICAL AND ELECTRICAL REQUIREMENTS'
    },
    {
      municipality: 'NY-DobbsFerry-Village', 
      domain: 'glb',
      description: 'Highest percentage reduction: 94.2%',
      expectedContent: 'Any person violating § 234-26I(1)'
    },
    {
      municipality: 'NY-Mamaroneck-Village',
      domain: 'trees', 
      description: 'High reduction with complex content: 55.9%',
      expectedContent: 'property owner fails to satisfy'
    }
  ];

  console.log('🔍 Verifying High-Impact Cases for Content Safety\n');

  for (const testCase of highImpactCases) {
    console.log(`📋 Case: ${testCase.description}`);
    console.log(`   Municipality: ${testCase.municipality}`);
    console.log(`   Domain: ${testCase.domain}`);
    
    const statutePath = path.join(process.cwd(), 'data', testCase.domain, testCase.municipality, 'statute.txt');
    
    if (!await fs.pathExists(statutePath)) {
      console.log(`   ❌ File not found: ${statutePath}\n`);
      continue;
    }

    const content = await fs.readFile(statutePath, 'utf-8');
    const lines = content.split('\n');
    
    console.log(`   📊 Current state:`);
    console.log(`      • Total lines: ${lines.length}`);
    console.log(`      • Total characters: ${content.length.toLocaleString()}`);
    
    // Show first 20 lines to understand current structure
    console.log(`   📝 First 20 lines (current state):`);
    lines.slice(0, 20).forEach((line, i) => {
      const lineNum = String(i + 1).padStart(2);
      const displayLine = line.length > 80 ? line.substring(0, 80) + '...' : line;
      console.log(`      ${lineNum}: "${displayLine}"`);
    });

    // Analyze what would be removed vs preserved
    const { findMeaningfulContentStart, isNavigationalPattern } = await import('./cleanupNavigationContent.js');
    const contentStart = findMeaningfulContentStart(lines);
    
    if (contentStart > 0) {
      const navigationalLines = lines.slice(0, contentStart).filter(line => line.trim());
      const preservedLines = lines.slice(contentStart);
      const preservedContent = preservedLines.join('\n');
      
      console.log(`   🔧 Proposed cleanup analysis:`);
      console.log(`      • Navigation lines to remove: ${navigationalLines.length}`);
      console.log(`      • Content lines to preserve: ${preservedLines.length}`);
      console.log(`      • Reduction: ${((content.length - preservedContent.length) / content.length * 100).toFixed(1)}%`);
      
      // Show sample of what would be removed
      console.log(`   🗑️  Sample navigation to remove (first 8):`);
      navigationalLines.slice(0, 8).forEach(line => {
        const isNav = isNavigationalPattern(line);
        console.log(`      ${isNav ? '❌' : '⚠️ '} "${line}"`);
      });
      
      // Show what would be preserved
      console.log(`   ✅ Content to preserve starts with:`);
      preservedLines.slice(0, 5).forEach((line, i) => {
        const lineNum = String(contentStart + i + 1).padStart(2);
        const displayLine = line.length > 100 ? line.substring(0, 100) + '...' : line;
        console.log(`      ${lineNum}: "${displayLine}"`);
      });
      
      // Verify expected content is preserved
      if (preservedContent.toLowerCase().includes(testCase.expectedContent.toLowerCase())) {
        console.log(`   ✅ VERIFICATION PASSED: Expected content "${testCase.expectedContent}" found in preserved text`);
      } else {
        console.log(`   ⚠️  VERIFICATION WARNING: Expected content "${testCase.expectedContent}" not immediately found`);
        console.log(`      First 200 chars of preserved: "${preservedContent.substring(0, 200)}..."`);
      }
      
    } else {
      console.log(`   ✅ No cleanup needed - file appears clean`);
    }
    
    console.log('\n' + '='.repeat(100) + '\n');
  }
  
  console.log('🎯 High-impact verification complete!');
  console.log('   Review any WARNING cases before executing full cleanup.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  verifyHighImpactCases().catch(console.error);
}