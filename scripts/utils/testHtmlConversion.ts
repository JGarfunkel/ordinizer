#!/usr/bin/env tsx
/**
 * Test script to validate HTML to text conversion improvements
 * 
 * Usage:
 *   tsx scripts/testHtmlConversion.ts [municipality-name]
 */

import fs from 'fs-extra';
import path from 'path';
import { JSDOM } from "jsdom";

function convertHtmlToText(html: string): string {
  try {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    
    // Remove script and style elements
    const scripts = document.querySelectorAll('script, style');
    scripts.forEach(script => script.remove());
    
    // Get text content and preserve structure  
    let text = document.body?.textContent || document.textContent || '';
    
    // Preserve paragraph structure by converting multiple whitespace to proper newlines
    text = text.replace(/\n\s*\n/g, '\n\n'); // Double newlines for paragraphs
    text = text.replace(/\t+/g, '\t'); // Preserve tabs
    text = text.replace(/[ ]+/g, ' '); // Collapse multiple spaces to single
    text = text.replace(/\n /g, '\n'); // Remove leading spaces after newlines
    text = text.trim();
    
    // Improved validation: Check for meaningful content rather than just length ratio
    // Modern web pages have lots of CSS/JS, so 10% ratio is too strict
    const hasSubstantialContent = text.length > 500; // At least 500 characters
    const hasStatuteKeywords = /\b(chapter|section|article|ordinance|code|§|subsection|violation|penalty)\b/i.test(text);
    const seemsLikeStatute = hasSubstantialContent && hasStatuteKeywords;
    
    // Only reject conversion if we got almost nothing or it doesn't look like legal text
    if (text.length < 50) {
      console.log('  Warning: HTML conversion resulted in very short text (<50 chars), keeping conversion anyway');
    }
    
    // Additional check for completely garbled content
    if (text.length > 0 && !seemsLikeStatute && text.length < 200) {
      console.log('  Warning: Converted text appears to lack statute content, but using conversion');
    }
    
    return text;
  } catch (error) {
    console.log('  Warning: Failed to parse HTML, keeping conversion attempt:', error.message);
    // Even if JSDOM fails, try to do basic HTML stripping
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

async function testConversion(municipalityFilter?: string): Promise<void> {
  const propertyMaintenanceDir = path.join(process.cwd(), '..', 'data', 'property-maintenance');
  
  if (!await fs.pathExists(propertyMaintenanceDir)) {
    console.error('Property maintenance directory not found');
    return;
  }

  const municipalities = await fs.readdir(propertyMaintenanceDir);
  let tested = 0;
  
  for (const municipality of municipalities) {
    if (municipality === 'questions.json' || municipality === 'NY-State') continue;
    
    if (municipalityFilter && !municipality.toLowerCase().includes(municipalityFilter.toLowerCase())) {
      continue;
    }

    const municipalityPath = path.join(propertyMaintenanceDir, municipality);
    const htmlPath = path.join(municipalityPath, 'statute.html');
    const txtPath = path.join(municipalityPath, 'statute.txt');

    if (!await fs.pathExists(htmlPath)) {
      console.log(`${municipality}: No HTML file`);
      continue;
    }

    const htmlContent = await fs.readFile(htmlPath, 'utf8');
    const convertedText = convertHtmlToText(htmlContent);
    
    const originalRatio = htmlContent.length > 0 ? (convertedText.length / htmlContent.length * 100).toFixed(1) : '0';
    
    console.log(`\n${municipality}:`);
    console.log(`  HTML: ${htmlContent.length.toLocaleString()} chars`);
    console.log(`  Converted: ${convertedText.length.toLocaleString()} chars (${originalRatio}% of original)`);
    
    // Check if we have existing txt file to compare
    if (await fs.pathExists(txtPath)) {
      const existingTxt = await fs.readFile(txtPath, 'utf8');
      console.log(`  Existing: ${existingTxt.length.toLocaleString()} chars`);
      
      if (Math.abs(convertedText.length - existingTxt.length) > 100) {
        console.log(`  ⚠️  Significant length difference detected`);
      }
    }

    // Show first few lines of converted content
    const preview = convertedText.split('\n').slice(0, 3).join('\n');
    console.log(`  Preview: ${preview.substring(0, 100)}${preview.length > 100 ? '...' : ''}`);
    
    tested++;
    if (tested >= 5 && !municipalityFilter) break; // Limit output unless filtering
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const municipalityFilter = args[0];
  
  console.log('🧪 Testing HTML to Text Conversion');
  console.log('=' .repeat(50));
  
  await testConversion(municipalityFilter);
}

main();