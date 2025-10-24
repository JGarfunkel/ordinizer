#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';

/**
 * Remove scattered navigation lines that appear throughout statute files
 * Specifically targets: print, email, share, get updates, add alert, arrow_*
 */
async function removeScatteredNavigation() {
  const dataDir = path.join(process.cwd(), 'data');
  const domains = await fs.readdir(dataDir, { withFileTypes: true });
  let totalCleaned = 0;
  let totalLinesRemoved = 0;
  
  console.log('🧹 Removing scattered navigation patterns from statute files...\n');
  
  for (const domain of domains.filter(d => d.isDirectory())) {
    const domainPath = path.join(dataDir, domain.name);
    const municipalities = await fs.readdir(domainPath, { withFileTypes: true });
    
    for (const municipality of municipalities.filter(m => m.isDirectory())) {
      const statutePath = path.join(domainPath, municipality.name, 'statute.txt');
      
      if (!await fs.pathExists(statutePath)) continue;
      
      const content = await fs.readFile(statutePath, 'utf-8');
      const lines = content.split('\n');
      
      // Filter out scattered navigation lines
      const cleanedLines = lines.filter(line => {
        const trimmed = line.trim();
        
        // Skip empty lines
        if (!trimmed) return true;
        
        // Remove specific navigation patterns (case insensitive)
        const navPatterns = [
          /^print$/i,
          /^email$/i,
          /^share$/i,
          /^get updates$/i,
          /^add alert$/i,
          /^add_alert$/i,
          /^arrow_back$/i,
          /^arrow_forward$/i,
          /^download$/i,
          /^Print$/,
          /^Email$/,
          /^Share$/,
          /^Download$/,
        ];
        
        // Return false (remove line) if it matches any navigation pattern
        if (navPatterns.some(pattern => pattern.test(trimmed))) {
          return false;
        }
        
        return true; // Keep the line
      });
      
      // Check if we removed any lines
      const linesRemoved = lines.length - cleanedLines.length;
      if (linesRemoved > 0) {
        // Create backup
        const backupPath = `${statutePath}.backup-scattered-${Date.now()}`;
        await fs.copy(statutePath, backupPath);
        
        // Write cleaned content
        const cleanedContent = cleanedLines.join('\n');
        await fs.writeFile(statutePath, cleanedContent);
        
        console.log(`✅ ${municipality.name}/${domain.name}: Removed ${linesRemoved} navigation lines`);
        totalCleaned++;
        totalLinesRemoved += linesRemoved;
      }
    }
  }
  
  console.log(`\n🎉 Scattered navigation cleanup complete!`);
  console.log(`• Files cleaned: ${totalCleaned}`);
  console.log(`• Total navigation lines removed: ${totalLinesRemoved}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  removeScatteredNavigation().catch(console.error);
}