#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';
import { JSDOM } from 'jsdom';

function convertHtmlToText(html: string): string {
  try {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    
    // Remove script, style, nav, header, footer, and other non-content elements
    const elementsToRemove = document.querySelectorAll('script, style, nav, header, footer, .nav, .header, .footer, .sidebar, .breadcrumb, .menu');
    elementsToRemove.forEach(element => element.remove());
    
    // Add proper line breaks before block elements
    const blockElements = document.querySelectorAll('p, div, section, article, h1, h2, h3, h4, h5, h6, li, br');
    blockElements.forEach(element => {
      if (element.tagName === 'BR') {
        element.replaceWith('\n');
      } else {
        // Add newlines before and after block elements
        element.insertAdjacentText('beforebegin', '\n');
        element.insertAdjacentText('afterend', '\n');
      }
    });
    
    // Handle list items with proper indentation
    const listItems = document.querySelectorAll('li');
    listItems.forEach(item => {
      item.insertAdjacentText('beforebegin', '\n\t');
    });
    
    // Get text content with preserved structure
    let text = document.body?.textContent || document.textContent || '';
    
    // Add proper formatting for statutory sections
    text = text.replace(/§\s*(\d+)-(\d+)/g, '\n\n§ $1-$2'); // Section headers with double newline
    text = text.replace(/\b([A-Z])\.\s+/g, '\n\t$1. '); // Subsection letters with tab indent
    text = text.replace(/\bCHAPTER\s+\d+/gi, '\n\nCHAPTER'); // Chapter headers
    text = text.replace(/\[HISTORY:/g, '\n\n[HISTORY:'); // History sections
    text = text.replace(/\[Amended\s/g, '\n[Amended '); // Amendment notes
    
    // Clean up formatting while preserving structure
    text = text.replace(/\n\s*\n\s*\n+/g, '\n\n'); // Collapse multiple newlines to double
    text = text.replace(/\t+/g, '\t'); // Preserve single tabs
    text = text.replace(/[ ]{2,}/g, ' '); // Collapse multiple spaces to single
    text = text.replace(/\n /g, '\n'); // Remove leading spaces after newlines
    text = text.replace(/^\s+|\s+$/g, ''); // Trim start/end whitespace
    
    // More lenient threshold - if we get at least 5% of original length, it's probably valid
    if (text.length < html.length * 0.05) {
      console.log('  Warning: HTML conversion resulted in very short text, using original content');
      return html;
    }
    
    // Additional check - if the text is too short in absolute terms, it might be a navigation-heavy page
    if (text.length < 1000) {
      console.log('  Warning: Converted text is very short (<1000 chars), using original content');
      return html;
    }
    
    return text;
  } catch (error) {
    console.log('  Warning: Failed to parse HTML, using original content:', error.message);
    return html;
  }
}

async function convertHtmlStatutes(domain: string = 'property-maintenance') {
  console.log(`🔄 Converting HTML statute files to plain text for ${domain}...`);
  
  const domainDir = path.join(process.cwd(), '..', 'data', domain);
  if (!await fs.pathExists(domainDir)) {
    console.log(`❌ Domain directory ${domain} not found`);
    return;
  }
  
  const municipalities = await fs.readdir(domainDir);
  let convertedCount = 0;
  
  for (const municDir of municipalities) {
    if (municDir === 'questions.json' || !municDir.startsWith('NY-')) continue;
    
    const statutePath = path.join(domainDir, municDir, 'statute.txt');
    if (!await fs.pathExists(statutePath)) {
      console.log(`⚠️  ${municDir}: No statute.txt found`);
      continue;
    }
    
    try {
      const content = await fs.readFile(statutePath, 'utf-8');
      
      // Check if it looks like HTML
      if (content.includes('<!DOCTYPE') || content.includes('<html') || content.includes('<head>')) {
        console.log(`🔧 ${municDir}: Converting HTML to plain text...`);
        
        // Backup original HTML
        const backupPath = path.join(domainDir, municDir, 'statute.html');
        await fs.writeFile(backupPath, content, 'utf-8');
        
        // Convert to plain text
        const plainText = convertHtmlToText(content);
        
        // Save converted text
        await fs.writeFile(statutePath, plainText, 'utf-8');
        
        console.log(`  ✅ Converted ${municDir}: ${content.length} → ${plainText.length} characters`);
        convertedCount++;
      } else {
        console.log(`✅ ${municDir}: Already plain text (${content.length} characters)`);
      }
      
    } catch (error) {
      console.log(`❌ Failed to process ${municDir}:`, error.message);
    }
  }
  
  console.log(`\n📊 Conversion Summary:`);
  console.log(`  Municipalities checked: ${municipalities.length}`);
  console.log(`  HTML files converted: ${convertedCount}`);
  
  return { checked: municipalities.length, converted: convertedCount };
}

// Run the script
const domain = process.argv[2] || 'property-maintenance';
convertHtmlStatutes(domain)
  .then(result => {
    console.log(`\n🎉 Conversion complete! ${result?.converted || 0} files converted.`);
    process.exit(0);
  })
  .catch(error => {
    console.error('❌ Conversion failed:', error);
    process.exit(1);
  });

export { convertHtmlStatutes };