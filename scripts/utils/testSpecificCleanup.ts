#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';

/**
 * Test cleanup on New Castle Trees specifically
 */
async function testNewCastleTreesCleanup() {
  const municipality = 'NY-NewCastle-Town';
  const domain = 'trees';
  const statutePath = path.join(process.cwd(), 'data', domain, municipality, 'statute.txt');
  
  console.log('🧪 Testing New Castle Trees navigational cleanup...');
  
  if (!await fs.pathExists(statutePath)) {
    console.log(`❌ File not found: ${statutePath}`);
    return;
  }
  
  // Read current content
  const content = await fs.readFile(statutePath, 'utf-8');
  const lines = content.split('\n');
  
  console.log(`📊 Original content analysis:`);
  console.log(`   • Total lines: ${lines.length}`);
  console.log(`   • Total characters: ${content.length}`);
  
  console.log(`\n📝 First 20 lines:`);
  lines.slice(0, 20).forEach((line, i) => {
    console.log(`   ${String(i+1).padStart(2)}: "${line}"`);
  });
  
  console.log(`\n🔍 Looking for content start patterns...`);
  
  // Find where "Town of New Castle" appears
  const townLineIndex = lines.findIndex(line => line.trim() === 'Town of New Castle, NY');
  console.log(`   • "Town of New Castle, NY" found at line: ${townLineIndex + 1}`);
  
  // Find where "Chapter 121" appears  
  const chapterLineIndex = lines.findIndex(line => line.trim() === 'Chapter 121');
  console.log(`   • "Chapter 121" found at line: ${chapterLineIndex + 1}`);
  
  // Find where "Tree Preservation" appears
  const treePertLineIndex = lines.findIndex(line => line.trim() === 'Tree Preservation');
  console.log(`   • "Tree Preservation" found at line: ${treePertLineIndex + 1}`);
  
  // Manual content start detection for testing
  function findContentStart(lines: string[]): number {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Look for municipality name patterns
      if (/^(Town|Village|City) of \w+/i.test(line)) {
        return i;
      }
      
      // Look for chapter headings after navigation
      if (/^Chapter \d+\s+[A-Z][a-zA-Z\s]+$/.test(line)) {
        // Check if previous lines are mostly navigational
        const previousLines = lines.slice(Math.max(0, i-10), i);
        const navCount = previousLines.filter(prevLine => isNavigationalLine(prevLine)).length;
        
        if (navCount > previousLines.length * 0.6) {
          return i;
        }
      }
      
      // Look for substantial content after navigational lines
      if (line.length > 100 && line.includes('.') && line.split(' ').length > 15) {
        const recentLines = lines.slice(Math.max(0, i-5), i);
        const navCount = recentLines.filter(prevLine => isNavigationalLine(prevLine)).length;
        
        if (navCount > recentLines.length * 0.7) {
          return i;
        }
      }
    }
    
    return 0;
  }
  
  function isNavigationalLine(line: string): boolean {
    const trimmed = line.trim();
    
    if (!trimmed) return false;
    if (trimmed.length > 80 && trimmed.includes('.')) return false;
    if (trimmed.length < 50 && !trimmed.includes('.')) return true;
    
    const navPatterns = [
      /^Chapter \d+/i, /^Article [IVX\d]+/i, /^Section \d/i, /^§\s*\d/,
      /^Home$/i, /^Print$/i, /^Download$/i, /^Search$/i, /^Login$/i,
      /^arrow_/i, /^email$/i, /^share$/i, /^info$/i, /^help/i,
      /^\d+\/\d+\/\d+$/, /^Last updated/i, /^Adopted/i, /^Effective/i,
    ];
    
    return navPatterns.some(pattern => pattern.test(trimmed));
  }
  
  const detectedStart = findContentStart(lines);
  
  console.log(`\n🤖 Algorithm detected content start at line: ${detectedStart + 1}`);
  console.log(`   Content would start with: "${lines[detectedStart]?.trim()}"`);
  
  if (detectedStart > 0) {
    console.log(`\n📋 Lines that would be removed (first 10):`);
    lines.slice(0, Math.min(detectedStart, 10)).forEach((line, i) => {
      const isNav = isNavigationalLine(line);
      console.log(`   ${String(i+1).padStart(2)}: ${isNav ? '❌' : '✅'} "${line}"`);
    });
    
    console.log(`\n📄 Clean content would start with:`);
    lines.slice(detectedStart, detectedStart + 5).forEach((line, i) => {
      console.log(`   ${String(detectedStart + i + 1).padStart(2)}: "${line}"`);
    });
    
    // Calculate savings
    const navContent = lines.slice(0, detectedStart).join('\n');
    const cleanContent = lines.slice(detectedStart).join('\n');
    
    console.log(`\n💰 Cleanup would save:`);
    console.log(`   • Lines removed: ${detectedStart}`);
    console.log(`   • Characters removed: ${navContent.length}`);
    console.log(`   • Original size: ${content.length} chars`);
    console.log(`   • Clean size: ${cleanContent.length} chars`);
    console.log(`   • Savings: ${((navContent.length / content.length) * 100).toFixed(1)}%`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  testNewCastleTreesCleanup().catch(console.error);
}