#!/usr/bin/env tsx

import fs from "fs-extra";
import path from "path";

function enhanceWithUnicode(text: string): string {
  return text
    // Replace navigation symbols with Unicode arrows
    .replace(/chevron_right/g, '→')
    .replace(/chevron_left/g, '←') 
    .replace(/arrow_right/g, '→')
    .replace(/arrow_left/g, '←')
    .replace(/arrow_forward/g, '→')
    .replace(/arrow_back/g, '←')
    
    // Enhance section markers
    .replace(/§ (\d+)/g, '§ $1')  // Ensure proper spacing
    
    // Replace bullet patterns with proper Unicode bullets
    .replace(/^\s*\*\s+/gm, '  • ')
    .replace(/^\s*-\s+/gm, '  • ')
    
    // Enhance common legal formatting
    .replace(/\[HISTORY:/g, '📜 [HISTORY:')
    .replace(/GENERAL REFERENCES/g, '🔗 GENERAL REFERENCES')
    
    // Clean up excessive whitespace while preserving structure
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

async function enhanceAllStatuteFiles(): Promise<void> {
  const dataDir = path.join(process.cwd(), 'data');
  if (!(await fs.pathExists(dataDir))) {
    console.log('No data directory found');
    return;
  }
  
  let enhancedCount = 0;
  
  // Walk through all domain directories
  const domains = await fs.readdir(dataDir);
  
  for (const domain of domains) {
    const domainPath = path.join(dataDir, domain);
    const stat = await fs.stat(domainPath);
    
    if (!stat.isDirectory() || domain.endsWith('.json')) {
      continue;
    }
    
    console.log(`\nEnhancing domain: ${domain}`);
    
    // Walk through municipality directories
    const municipalities = await fs.readdir(domainPath);
    
    for (const municipality of municipalities) {
      const municipalityPath = path.join(domainPath, municipality);
      const municipalityStat = await fs.stat(municipalityPath);
      
      if (!municipalityStat.isDirectory()) {
        continue;
      }
      
      const statuteTxtPath = path.join(municipalityPath, 'statute.txt');
      
      if (await fs.pathExists(statuteTxtPath)) {
        console.log(`  ${municipality}: Adding Unicode enhancements`);
        
        const currentText = await fs.readFile(statuteTxtPath, 'utf-8');
        const enhancedText = enhanceWithUnicode(currentText);
        
        await fs.writeFile(statuteTxtPath, enhancedText, 'utf-8');
        
        // Update metadata
        const metadataPath = path.join(municipalityPath, 'metadata.json');
        if (await fs.pathExists(metadataPath)) {
          const metadata = await fs.readJson(metadataPath);
          metadata.textContentLength = enhancedText.length;
          metadata.unicodeEnhancedAt = new Date().toISOString();
          await fs.writeJson(metadataPath, metadata, { spaces: 2 });
        }
        
        enhancedCount++;
      }
    }
  }
  
  console.log(`\n✅ Unicode enhancement complete!`);
  console.log(`- ${enhancedCount} files enhanced with Unicode characters`);
  console.log(`- Added arrows (→ ←), bullets (•), and document icons (📜 🔗)`);
}

async function main(): Promise<void> {
  try {
    await enhanceAllStatuteFiles();
  } catch (error) {
    console.error('❌ Unicode enhancement failed:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { enhanceWithUnicode };