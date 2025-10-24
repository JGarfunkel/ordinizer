#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';

/**
 * Final targeted cleanup for remaining navigation content
 */
async function finalNavigationCleanup() {
  console.log('🎯 Final Navigation Cleanup - Targeting Remaining Files\n');
  
  const dataDir = path.join(process.cwd(), 'data');
  const domains = await fs.readdir(dataDir, { withFileTypes: true });
  let totalCleaned = 0;
  let totalLinesRemoved = 0;
  
  for (const domain of domains.filter(d => d.isDirectory())) {
    const domainPath = path.join(dataDir, domain.name);
    const municipalities = await fs.readdir(domainPath, { withFileTypes: true });
    
    for (const municipality of municipalities.filter(m => m.isDirectory())) {
      const statutePath = path.join(domainPath, municipality.name, 'statute.txt');
      
      if (!await fs.pathExists(statutePath)) continue;
      
      const content = await fs.readFile(statutePath, 'utf-8');
      const lines = content.split('\n');
      
      // Check if file has navigation content
      const hasNavigation = lines.some(line => {
        const trimmed = line.trim();
        return /^home$/i.test(trimmed) || 
               /^code$/i.test(trimmed) ||
               /^print$/i.test(trimmed) ||
               /^email$/i.test(trimmed) ||
               /^share$/i.test(trimmed) ||
               /^arrow_/i.test(trimmed) ||
               /^download$/i.test(trimmed) ||
               /^get updates$/i.test(trimmed);
      });
      
      if (hasNavigation) {
        console.log(`🔧 Cleaning ${municipality.name}/${domain.name}...`);
        
        // Create backup
        const backupPath = `${statutePath}.backup-final-${Date.now()}`;
        await fs.copy(statutePath, backupPath);
        
        // Apply comprehensive cleanup
        const cleanedLines = lines.filter(line => {
          const trimmed = line.trim();
          
          // Remove all known navigation patterns
          const navPatterns = [
            /^home$/i,
            /^code$/i,
            /^law$/i,
            /^pubdocs$/i,
            /^help$/i,
            /^search$/i,
            /^login$/i,
            /^info$/i,
            /^print$/i,
            /^email$/i,
            /^download$/i,
            /^share$/i,
            /^arrow_back$/i,
            /^arrow_forward$/i,
            /^add_alert$/i,
            /^get updates$/i,
            /^Home$/,
            /^Code$/,
            /^Law$/,
            /^Public Documents$/,
            /^Help$/,
            /^Search$/,
            /^Login$/,
            /^Info$/,
            /^Print$/,
            /^Email$/,
            /^Download$/,
            /^Share$/,
            /^Index$/i,
            /^Laws \(\d+\)$/,
            /^Minutes \(\d+\)$/,
            /^Agendas \(\d+\)$/,
            /^Budgets \(\d+\)$/,
            /^Resolutions \(\d+\)$/,
            /^help_center$/i,
            /^ecode$/i,
            /^\d{4}-\d{2}-\d{2}$/,
          ];
          
          // Keep line if it doesn't match navigation patterns
          if (navPatterns.some(pattern => pattern.test(trimmed))) {
            return false;
          }
          
          return true;
        });
        
        const linesRemoved = lines.length - cleanedLines.length;
        
        if (linesRemoved > 0) {
          const cleanedContent = cleanedLines.join('\n');
          await fs.writeFile(statutePath, cleanedContent);
          
          console.log(`✅ ${municipality.name}/${domain.name}: Removed ${linesRemoved} navigation lines`);
          totalCleaned++;
          totalLinesRemoved += linesRemoved;
        }
      }
    }
  }
  
  console.log(`\n🎉 Final cleanup complete!`);
  console.log(`• Files cleaned: ${totalCleaned}`);
  console.log(`• Total navigation lines removed: ${totalLinesRemoved}`);
  
  // Final verification
  console.log('\n🔍 Final verification - checking for remaining navigation...');
  const remainingFiles = [];
  
  for (const domain of domains.filter(d => d.isDirectory())) {
    const domainPath = path.join(dataDir, domain.name);
    const municipalities = await fs.readdir(domainPath, { withFileTypes: true });
    
    for (const municipality of municipalities.filter(m => m.isDirectory())) {
      const statutePath = path.join(domainPath, municipality.name, 'statute.txt');
      
      if (await fs.pathExists(statutePath)) {
        const content = await fs.readFile(statutePath, 'utf-8');
        if (/^home$/im.test(content) || /^print$/im.test(content) || /arrow_/im.test(content)) {
          remainingFiles.push(`${municipality.name}/${domain.name}`);
        }
      }
    }
  }
  
  if (remainingFiles.length > 0) {
    console.log(`⚠️  ${remainingFiles.length} files still contain navigation patterns:`);
    remainingFiles.slice(0, 10).forEach(file => console.log(`   • ${file}`));
  } else {
    console.log('✅ All navigation content successfully removed!');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  finalNavigationCleanup().catch(console.error);
}