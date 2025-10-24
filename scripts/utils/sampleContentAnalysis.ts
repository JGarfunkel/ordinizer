#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';

/**
 * Sample multiple files to understand content patterns and verify cleanup safety
 */
async function sampleContentAnalysis() {
  const sampleCases = [
    { municipality: 'NY-Ardsley-Village', domain: 'cluster-zoning', status: 'CLEANED' },
    { municipality: 'NY-Bedford-Town', domain: 'cluster-zoning', status: 'CLEANED' },
    { municipality: 'NY-NewCastle-Town', domain: 'trees', status: 'ORIGINAL' },
    { municipality: 'NY-Bronxville-Village', domain: 'glb', status: 'ORIGINAL' },
    { municipality: 'NY-Larchmont-Village', domain: 'glb', status: 'ORIGINAL' }
  ];

  console.log('📊 Content Pattern Analysis\n');

  for (const sample of sampleCases) {
    console.log(`🔍 ${sample.municipality} - ${sample.domain} [${sample.status}]`);
    
    const statutePath = path.join(process.cwd(), 'data', sample.domain, sample.municipality, 'statute.txt');
    
    if (!await fs.pathExists(statutePath)) {
      console.log('   ❌ File not found\n');
      continue;
    }

    const content = await fs.readFile(statutePath, 'utf-8');
    const lines = content.split('\n');
    
    console.log(`   Size: ${lines.length} lines, ${content.length.toLocaleString()} chars`);
    
    // Analyze first 15 lines for patterns
    console.log('   First 15 lines:');
    lines.slice(0, 15).forEach((line, i) => {
      const trimmed = line.trim();
      const isNav = isSimpleNavigationalPattern(trimmed);
      const marker = isNav ? '🔶 NAV' : '📄 CONTENT';
      console.log(`   ${String(i+1).padStart(2)}: ${marker} "${trimmed}"`);
    });

    // Look for legal content markers
    const legalMarkers = [
      /^§\s*\d+/,
      /^Chapter \d+/,
      /HISTORY:/,
      /shall be/,
      /pursuant to/,
      /violation/,
      /penalty/,
      /^[A-Z]\.\s+/
    ];

    const firstLegalLine = lines.findIndex(line => 
      legalMarkers.some(pattern => pattern.test(line.trim()))
    );
    
    if (firstLegalLine !== -1) {
      console.log(`   📍 First legal content at line ${firstLegalLine + 1}: "${lines[firstLegalLine].trim()}"`);
    }
    
    console.log('');
  }
  
  function isSimpleNavigationalPattern(line: string): boolean {
    if (!line || line.length > 60) return false;
    
    const navPatterns = [
      /^(home|code|law|help|search|login|print|email|download|share|info)$/i,
      /^\d{4}-\d{2}-\d{2}$/,
      /^arrow_/i,
      /^Laws \(\d+\)$/,
      /^Get Updates$/i
    ];
    
    return navPatterns.some(p => p.test(line)) || (line.length < 30 && !line.includes('.'));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  sampleContentAnalysis().catch(console.error);
}