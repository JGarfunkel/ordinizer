#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';
import { findMeaningfulContentStart, isNavigationalPattern } from './cleanupNavigationContent.js';

/**
 * Debug why Mount Vernon property-maintenance wasn't cleaned
 */
async function debugMountVernon() {
  const statutePath = path.join(process.cwd(), 'data', 'glb', 'NY-DobbsFerry-Village', 'statute.txt');
  
  console.log('🔍 Debugging Dobbs Ferry GLB cleanup issue\n');
  
  const content = await fs.readFile(statutePath, 'utf-8');
  const lines = content.split('\n');
  
  console.log(`📊 File stats:`);
  console.log(`   • Total lines: ${lines.length}`);
  console.log(`   • Total characters: ${content.length.toLocaleString()}`);
  
  // Test our detection algorithm
  const contentStart = findMeaningfulContentStart(lines);
  console.log(`   • Detected content start at line: ${contentStart + 1}`);
  
  // Show first 30 lines with navigation detection
  console.log(`\n📝 First 30 lines with navigation analysis:`);
  lines.slice(0, 30).forEach((line, i) => {
    const trimmed = line.trim();
    const isNav = isNavigationalPattern(trimmed);
    const marker = isNav ? '🔶 NAV' : '📄 CONTENT';
    console.log(`   ${String(i+1).padStart(3)}: ${marker} "${trimmed}"`);
  });
  
  // Check if we would clean anything
  if (contentStart > 2) {
    const navLines = lines.slice(0, contentStart).filter(line => line.trim());
    const cleanedLines = lines.slice(contentStart);
    const cleanedContent = cleanedLines.join('\n');
    const reduction = ((content.length - cleanedContent.length) / content.length * 100).toFixed(1);
    
    console.log(`\n🔧 Proposed cleanup:`);
    console.log(`   • Navigation lines to remove: ${navLines.length}`);
    console.log(`   • Content lines to preserve: ${cleanedLines.length}`);
    console.log(`   • Size reduction: ${reduction}%`);
    
    console.log(`\n🔶 Navigation lines that would be removed (first 10):`);
    navLines.slice(0, 10).forEach(line => {
      console.log(`      "${line}"`);
    });
    
    console.log(`\n✅ Content would start with:`);
    cleanedLines.slice(0, 5).forEach((line, i) => {
      const displayLine = line.length > 100 ? line.substring(0, 100) + '...' : line;
      console.log(`      ${String(contentStart + i + 1).padStart(3)}: "${displayLine}"`);
    });
    
    // Execute the cleanup
    console.log(`\n🚀 Executing cleanup...`);
    const backupPath = `${statutePath}.backup-debug-${Date.now()}`;
    await fs.copy(statutePath, backupPath);
    await fs.writeFile(statutePath, cleanedContent);
    
    console.log(`✅ Cleanup complete!`);
    console.log(`   • Backup created: ${path.basename(backupPath)}`);
    console.log(`   • Original size: ${content.length.toLocaleString()} characters`);
    console.log(`   • New size: ${cleanedContent.length.toLocaleString()} characters`);
    console.log(`   • Reduction: ${(content.length - cleanedContent.length).toLocaleString()} characters (${reduction}%)`);
    
  } else {
    console.log(`\n❌ No cleanup would be performed (content starts at line ${contentStart + 1})`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  debugMountVernon().catch(console.error);
}