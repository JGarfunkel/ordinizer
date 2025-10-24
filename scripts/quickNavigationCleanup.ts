#!/usr/bin/env tsx

import fs from 'fs-extra';

async function cleanRemainingFiles() {
  const filesToClean = [
    'data/flood-damage-protection/NY-Yorktown-Town/statute.txt',
    'data/glb/NY-Lewisboro-Town/statute.txt',
    'data/glb/NY-Ossining-Town/statute.txt',
    'data/glb/NY-Somers-Town/statute.txt',
    'data/property-maintenance/NY-Ardsley-Village/statute.txt',
    'data/slopes/NY-Croton-on-Hudson-Village/statute.txt',
    'data/solar-1/NY-Bedford-Town/statute.txt',
    'data/wetland-protection/NY-Bedford-Town/statute.txt',
    'data/wetland-protection/NY-Buchanan-Village/statute.txt',
    'data/wetland-protection/NY-NewCastle-Town/statute.txt'
  ];

  for (const file of filesToClean) {
    try {
      if (await fs.pathExists(file)) {
        const content = await fs.readFile(file, 'utf-8');
        
        // Apply navigation cleanup patterns
        const lines = content.split('\n');
        const cleanedLines = lines.filter(line => {
          const trimmed = line.trim().toLowerCase();
          
          // Remove navigation patterns
          const navPatterns = [
            /^home$/,
            /^print$/,
            /^email$/,
            /^share$/,
            /^get updates$/,
            /^add alert$/,
            /^arrow_/,
            /^\[home\]$/,
            /^\[print\]$/
          ];
          
          return !navPatterns.some(pattern => pattern.test(trimmed));
        });
        
        const cleanedContent = cleanedLines.join('\n').trim();
        
        if (cleanedContent !== content.trim()) {
          await fs.writeFile(file, cleanedContent);
          console.log(`✅ Cleaned ${file}`);
        }
      }
    } catch (error) {
      console.error(`❌ Error cleaning ${file}:`, error.message);
    }
  }

  console.log('🎉 Navigation cleanup complete for remaining files');
}

cleanRemainingFiles().catch(console.error);