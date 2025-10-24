#!/usr/bin/env tsx

import fs from "fs-extra";
import path from "path";
import { JSDOM } from "jsdom";

function cleanStatuteText(html: string): string {
  try {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    
    // Remove all unwanted elements first
    const elementsToRemove = [
      'script', 'style', 'link', 'meta', 'noscript',
      'header', 'nav', 'footer', '.nav', '.navigation', '.sidebar',
      '.toolbar', '.breadcrumb', '.action-bar', '.rail',
      '[class*="nav"]', '[class*="menu"]', '[class*="toolbar"]',
      '[class*="rail"]', '[class*="sidebar"]', '[class*="header"]',
      '[class*="footer"]', '[class*="modal"]', '[id*="modal"]'
    ];
    
    elementsToRemove.forEach(selector => {
      const elements = document.querySelectorAll(selector);
      elements.forEach(el => el.remove());
    });
    
    // Remove elements containing only navigation icons and text
    const navigationKeywords = [
      'arrow_back', 'arrow_forward', 'chevron_right', 'chevron_left',
      'print', 'email', 'download', 'share', 'get updates',
      'home', 'back to top', 'skip to', 'main menu'
    ];
    
    // Remove elements that are clearly UI/navigation
    const allElements = Array.from(document.querySelectorAll('*'));
    allElements.forEach(element => {
      const text = element.textContent?.trim().toLowerCase() || '';
      const className = element.className || '';
      const id = element.id || '';
      
      // Remove elements that are navigation or UI
      if (
        navigationKeywords.some(keyword => text.includes(keyword)) ||
        className.includes('material-') ||
        className.includes('icon') ||
        id.includes('rail') ||
        id.includes('nav') ||
        text === 'print' ||
        text === 'email' ||
        text === 'download' ||
        text === 'share' ||
        (text.length < 30 && navigationKeywords.some(keyword => text.includes(keyword)))
      ) {
        element.remove();
      }
    });
    
    // Now extract the actual content, focusing on statute text
    const contentText = extractLegalContent(document);
    
    return cleanAndFormatText(contentText);
    
  } catch (error) {
    console.error('Error cleaning HTML:', error);
    return '';
  }
}

function extractLegalContent(document: Document): string {
  // Get all text content from body
  const bodyText = document.body?.textContent?.trim() || '';
  
  // Split into sections and filter for legal content
  const sections = bodyText.split(/\n\s*\n/);
  const legalSections: string[] = [];
  
  for (const section of sections) {
    const text = section.trim();
    
    // Skip obvious navigation/UI elements
    if (
      text.length < 20 ||
      /^(print|email|download|share|home|back|arrow_|chevron_)$/i.test(text) ||
      text.includes('material-icons') ||
      text.includes('Click here') ||
      text.match(/^[A-Z\s]{1,20}$/) // All caps short text (likely UI)
    ) {
      continue;
    }
    
    // Include sections that look like legal content
    if (
      text.includes('§') || // Section symbol
      text.includes('Chapter') ||
      text.includes('HISTORY:') ||
      text.includes('Purpose') ||
      text.includes('Definitions') ||
      text.includes('Town Board') ||
      text.includes('shall') ||
      text.includes('ordinance') ||
      text.includes('regulation') ||
      text.includes('Board finds') ||
      text.includes('It is the purpose') ||
      /\b\d{1,3}-\d{1,3}\b/.test(text) || // Pattern like "112-1"
      text.length > 100 // Any substantial text
    ) {
      legalSections.push(text);
    }
  }
  
  return legalSections.join('\n\n');
}

function cleanAndFormatText(text: string): string {
  return text
    // Remove excessive whitespace
    .replace(/\s+/g, ' ')
    // Split into lines and clean each
    .split('\n')
    .map(line => line.trim())
    .filter(line => {
      // Filter out lines that are likely navigation or UI elements
      const cleanLine = line.toLowerCase();
      return (
        line.length > 10 && // Substantial content
        !cleanLine.includes('material-icons') &&
        !cleanLine.includes('arrow_') &&
        !cleanLine.includes('chevron_') &&
        !/^(print|email|download|share|home|back)$/i.test(line) &&
        !cleanLine.includes('click here') &&
        !cleanLine.includes('javascript')
      );
    })
    .join('\n')
    // Normalize paragraph breaks
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function wrapAt80Chars(text: string): string {
  const lines = text.split('\n');
  const wrappedLines: string[] = [];
  
  for (const line of lines) {
    if (line.length <= 80) {
      wrappedLines.push(line);
    } else {
      const words = line.split(' ');
      let currentLine = '';
      
      for (const word of words) {
        if ((currentLine + ' ' + word).length <= 80) {
          currentLine = currentLine ? currentLine + ' ' + word : word;
        } else {
          if (currentLine) {
            wrappedLines.push(currentLine);
          }
          currentLine = word;
        }
      }
      
      if (currentLine) {
        wrappedLines.push(currentLine);
      }
    }
  }
  
  return wrappedLines.join('\n');
}

async function cleanAllStatuteFiles(): Promise<void> {
  const dataDir = path.join(process.cwd(), 'data');
  if (!(await fs.pathExists(dataDir))) {
    console.log('No data directory found');
    return;
  }
  
  let cleanedCount = 0;
  
  // Walk through all domain directories
  const domains = await fs.readdir(dataDir);
  
  for (const domain of domains) {
    const domainPath = path.join(dataDir, domain);
    const stat = await fs.stat(domainPath);
    
    if (!stat.isDirectory() || domain.endsWith('.json')) {
      continue;
    }
    
    console.log(`\nProcessing domain: ${domain}`);
    
    // Walk through municipality directories
    const municipalities = await fs.readdir(domainPath);
    
    for (const municipality of municipalities) {
      const municipalityPath = path.join(domainPath, municipality);
      const municipalityStat = await fs.stat(municipalityPath);
      
      if (!municipalityStat.isDirectory()) {
        continue;
      }
      
      const statuteHtmlPath = path.join(municipalityPath, 'statute.html');
      const statuteTxtPath = path.join(municipalityPath, 'statute.txt');
      
      if (await fs.pathExists(statuteHtmlPath)) {
        console.log(`  ${municipality}: Cleaning statute text`);
        
        const htmlContent = await fs.readFile(statuteHtmlPath, 'utf-8');
        const cleanedText = cleanStatuteText(htmlContent);
        
        if (cleanedText && cleanedText.length > 100) {
          const wrappedText = wrapAt80Chars(cleanedText);
          await fs.writeFile(statuteTxtPath, wrappedText, 'utf-8');
          
          // Update metadata
          const metadataPath = path.join(municipalityPath, 'metadata.json');
          if (await fs.pathExists(metadataPath)) {
            const metadata = await fs.readJson(metadataPath);
            metadata.textContentLength = wrappedText.length;
            metadata.cleanedAt = new Date().toISOString();
            await fs.writeJson(metadataPath, metadata, { spaces: 2 });
          }
          
          cleanedCount++;
        } else {
          console.log(`    ${municipality}: Could not extract meaningful content`);
        }
      }
    }
  }
  
  console.log(`\n✅ Cleaning complete!`);
  console.log(`- ${cleanedCount} files cleaned with targeted legal content extraction`);
}

async function main(): Promise<void> {
  try {
    await cleanAllStatuteFiles();
  } catch (error) {
    console.error('❌ Cleaning failed:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { cleanStatuteText, wrapAt80Chars };