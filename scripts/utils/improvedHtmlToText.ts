#!/usr/bin/env tsx

import fs from "fs-extra";
import path from "path";
import { JSDOM } from "jsdom";

function extractMainContent(html: string): string {
  try {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    
    // Try to find the main content area - common patterns for eCode360
    const contentSelectors = [
      '#contentContainer',
      '#pageContent', 
      '.content',
      '#main-content',
      '[id*="content"]',
      'main',
      'article'
    ];
    
    let contentElement = null;
    for (const selector of contentSelectors) {
      contentElement = document.querySelector(selector);
      if (contentElement) break;
    }
    
    // If no specific content area found, use body but skip header/nav/footer
    if (!contentElement) {
      contentElement = document.body;
      // Remove common non-content elements including eCode360 specific navigation
      const elementsToRemove = [
        'header', 'nav', 'footer', 
        '.header', '.nav', '.footer', '.navigation', '.sidebar',
        '#header', '#nav', '#footer', '#navigation', '#sidebar',
        '.toolbar', '.breadcrumb', '.action-bar',
        '[class*="nav"]', '[class*="menu"]', '[class*="toolbar"]',
        'script', 'style', 'link', 'meta'
      ];
      
      elementsToRemove.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => el.remove());
      });
      
      // Remove elements with navigation text patterns
      const navigationPatterns = [
        /arrow_back|arrow_forward|chevron_right|chevron_left/i,
        /print|email|download|share|get updates/i,
        /back to top|skip to|main menu/i
      ];
      
      const allElements = document.querySelectorAll('*');
      allElements.forEach(element => {
        const text = element.textContent?.trim() || '';
        if (navigationPatterns.some(pattern => pattern.test(text)) && text.length < 50) {
          element.remove();
        }
      });
    }
    
    if (!contentElement) return '';
    
    // Better text extraction that preserves structure
    return extractTextWithStructure(contentElement);
    
  } catch (error) {
    console.error('Error parsing HTML:', error);
    return '';
  }
}

function extractTextWithStructure(element: Element): string {
  const result: string[] = [];
  
  function processNode(node: Node, depth = 0): void {
    const indent = '  '.repeat(depth); // 2 spaces per indent level
    
    if (node.nodeType === node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text && text.length > 0) {
        // Preserve meaningful whitespace but clean up excessive spacing
        const cleanText = text.replace(/\s+/g, ' ');
        result.push(indent + cleanText);
      }
    } else if (node.nodeType === node.ELEMENT_NODE) {
      const element = node as Element;
      const tagName = element.tagName.toLowerCase();
      
      // Handle different HTML elements with appropriate formatting
      switch (tagName) {
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6':
          const headerText = element.textContent?.trim();
          if (headerText) {
            result.push(''); // Add blank line before header
            result.push(indent + headerText.toUpperCase());
            result.push(indent + '='.repeat(Math.min(headerText.length, 60)));
            result.push(''); // Add blank line after header
          }
          return; // Don't process children separately
          
        case 'p':
          const pText = element.textContent?.trim();
          if (pText) {
            result.push(''); // Paragraph spacing
            result.push(indent + pText.replace(/\s+/g, ' '));
          }
          return; // Don't process children separately
          
        case 'li':
          const liText = element.textContent?.trim();
          if (liText) {
            result.push(indent + '• ' + liText.replace(/\s+/g, ' '));
          }
          return; // Don't process children separately
          
        case 'div':
        case 'section':
        case 'article':
          // Process children with increased indent for structure
          for (const child of Array.from(element.childNodes)) {
            processNode(child, depth + 1);
          }
          return;
          
        case 'br':
          result.push(''); // Line break
          return;
          
        case 'table':
        case 'tr':
        case 'td':
        case 'th':
          // For tables, just extract text with some spacing
          const tableText = element.textContent?.trim();
          if (tableText) {
            result.push(indent + tableText.replace(/\s+/g, ' '));
          }
          return;
          
        default:
          // For other elements, process children normally
          for (const child of Array.from(element.childNodes)) {
            processNode(child, depth);
          }
      }
    }
  }
  
  processNode(element);
  
  // Clean up the result
  return result
    .filter(line => line.trim().length > 0) // Remove empty lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n') // Limit consecutive newlines to 2
    .trim();
}

function wrapTextAt80Chars(text: string): string {
  const lines = text.split('\n');
  const wrappedLines: string[] = [];
  
  for (const line of lines) {
    if (line.length <= 80) {
      wrappedLines.push(line);
    } else {
      // Preserve indentation when wrapping
      const leadingWhitespace = line.match(/^(\s*)/)?.[1] || '';
      const content = line.slice(leadingWhitespace.length);
      
      if (content.length === 0) {
        wrappedLines.push(line);
        continue;
      }
      
      // Word wrap at 80 characters, preserving indent
      const words = content.split(' ');
      let currentLine = leadingWhitespace;
      
      for (const word of words) {
        const testLine = currentLine + (currentLine === leadingWhitespace ? '' : ' ') + word;
        
        if (testLine.length <= 80) {
          currentLine = testLine;
        } else {
          if (currentLine.length > leadingWhitespace.length) {
            wrappedLines.push(currentLine);
          }
          // Start new line with same indentation
          if (word.length + leadingWhitespace.length <= 80) {
            currentLine = leadingWhitespace + word;
          } else {
            // Word is too long, just add it
            wrappedLines.push(leadingWhitespace + word);
            currentLine = leadingWhitespace;
          }
        }
      }
      
      if (currentLine.length > leadingWhitespace.length) {
        wrappedLines.push(currentLine);
      }
    }
  }
  
  return wrappedLines.join('\n');
}

async function improvedConvertExistingFiles(): Promise<void> {
  const dataDir = path.join(process.cwd(), 'data');
  if (!(await fs.pathExists(dataDir))) {
    console.log('No data directory found');
    return;
  }
  
  let convertedCount = 0;
  
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
      
      // Convert HTML to improved text format
      if (await fs.pathExists(statuteHtmlPath)) {
        console.log(`  ${municipality}: Converting HTML to text (improved)`);
        
        const htmlContent = await fs.readFile(statuteHtmlPath, 'utf-8');
        const mainContent = extractMainContent(htmlContent);
        
        if (mainContent && mainContent.length > 100) { // Only if we found substantial content
          let textContent = wrapTextAt80Chars(mainContent);
          
          // Replace navigation symbols with Unicode characters
          textContent = textContent
            .replace(/chevron_right/g, '→')
            .replace(/chevron_left/g, '←') 
            .replace(/arrow_right/g, '→')
            .replace(/arrow_left/g, '←')
            .replace(/arrow_forward/g, '→')
            .replace(/arrow_back/g, '←');
            
          await fs.writeFile(statuteTxtPath, textContent, 'utf-8');
          
          // Update metadata if it exists
          const metadataPath = path.join(municipalityPath, 'metadata.json');
          if (await fs.pathExists(metadataPath)) {
            const metadata = await fs.readJson(metadataPath);
            metadata.textContentLength = textContent.length;
            metadata.improvedConversionAt = new Date().toISOString();
            await fs.writeJson(metadataPath, metadata, { spaces: 2 });
          }
          
          convertedCount++;
        } else {
          console.log(`    ${municipality}: Could not extract meaningful content`);
        }
      }
    }
  }
  
  console.log(`\n✅ Improved conversion complete!`);
  console.log(`- ${convertedCount} files converted with improved text extraction`);
}

async function main(): Promise<void> {
  try {
    await improvedConvertExistingFiles();
  } catch (error) {
    console.error('❌ Improved conversion failed:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { extractMainContent, wrapTextAt80Chars };