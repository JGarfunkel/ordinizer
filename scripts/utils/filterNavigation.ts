#!/usr/bin/env tsx

import fs from "fs-extra";
import path from "path";

function filterNavigationElements(text: string): string {
  const lines = text.split('\n');
  const filteredLines: string[] = [];
  
  const navigationPatterns = [
    /^arrow_back$/,
    /^arrow_forward$/,
    /^chevron_right$/,
    /^chevron_left$/,
    /^print$/,
    /^Print$/,
    /^email$/,
    /^Email$/,
    /^download$/,
    /^Download$/,
    /^share$/,
    /^Share$/,
    /^add_alert$/,
    /^Get Updates$/,
    /^home$/,
    /^Home$/,
    /^\s*\.\s*$/,  // Lines with just dots
    /material-symbols/,
    /material-icons/
  ];
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    
    // Skip navigation elements
    if (navigationPatterns.some(pattern => pattern.test(trimmedLine))) {
      continue;
    }
    
    // Skip very short indented lines that are likely UI elements
    if (trimmedLine.length < 3 && line.match(/^\s+/)) {
      continue;
    }
    
    filteredLines.push(line);
  }
  
  return filteredLines.join('\n')
    .replace(/\n{3,}/g, '\n\n') // Limit consecutive newlines
    // Convert remaining chevron/arrow references to Unicode
    .replace(/chevron_right/g, '→')
    .replace(/chevron_left/g, '←')
    .replace(/arrow_right/g, '→')
    .replace(/arrow_left/g, '←')
    .replace(/arrow_forward/g, '→')
    .replace(/arrow_back/g, '←')
    .trim();
}

async function filterAllStatuteFiles(): Promise<void> {
  const dataDir = path.join(process.cwd(), 'data');
  if (!(await fs.pathExists(dataDir))) {
    console.log('No data directory found');
    return;
  }
  
  let filteredCount = 0;
  
  // Walk through all domain directories
  const domains = await fs.readdir(dataDir);
  
  for (const domain of domains) {
    const domainPath = path.join(dataDir, domain);
    const stat = await fs.stat(domainPath);
    
    if (!stat.isDirectory() || domain.endsWith('.json')) {
      continue;
    }
    
    console.log(`\nFiltering domain: ${domain}`);
    
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
        console.log(`  ${municipality}: Filtering navigation elements`);
        
        const currentText = await fs.readFile(statuteTxtPath, 'utf-8');
        const filteredText = filterNavigationElements(currentText);
        
        if (filteredText.length > 100) {
          await fs.writeFile(statuteTxtPath, filteredText, 'utf-8');
          
          // Update metadata
          const metadataPath = path.join(municipalityPath, 'metadata.json');
          if (await fs.pathExists(metadataPath)) {
            const metadata = await fs.readJson(metadataPath);
            metadata.textContentLength = filteredText.length;
            metadata.filteredAt = new Date().toISOString();
            await fs.writeJson(metadataPath, metadata, { spaces: 2 });
          }
          
          filteredCount++;
        }
      }
    }
  }
  
  console.log(`\n✅ Filtering complete!`);
  console.log(`- ${filteredCount} files filtered to remove navigation elements`);
}

async function main(): Promise<void> {
  try {
    await filterAllStatuteFiles();
  } catch (error) {
    console.error('❌ Filtering failed:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { filterNavigationElements };