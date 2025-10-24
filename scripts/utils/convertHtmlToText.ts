#!/usr/bin/env tsx

import fs from "fs-extra";
import path from "path";
import axios from "axios";
import { JSDOM } from "jsdom";
// Dynamic import for pdf-parse to handle ES module issues

function convertHtmlToText(html: string, anchorId?: string): string {
  try {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    
    // Remove script and style elements
    const scripts = document.querySelectorAll('script, style');
    scripts.forEach(script => script.remove());
    
    let targetElement = document.body;
    
    // If we have an anchor ID, try to extract only the relevant section
    if (anchorId) {
      console.log(`  🎯 Looking for anchor section: ${anchorId}`);
      
      // Try to find the anchor element
      const anchorElement = document.getElementById(anchorId);
      if (anchorElement) {
        console.log(`  ✅ Found anchor element: ${anchorElement.tagName}`);
        
        // Strategy 1: Look for content div with pattern {anchorId}_content
        const contentElement = document.getElementById(`${anchorId}_content`);
        if (contentElement) {
          console.log(`  📍 Found content element: ${anchorId}_content`);
          // Create container with both title and content
          const sectionContainer = document.createElement('div');
          sectionContainer.appendChild(anchorElement.cloneNode(true));
          sectionContainer.appendChild(contentElement.cloneNode(true));
          targetElement = sectionContainer;
          console.log(`  📍 Extracted title + content elements`);
        } else {
          // Strategy 2: Extract all content from the anchor element and its following siblings until the next section
          const parent = anchorElement.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children);
            const anchorIndex = siblings.indexOf(anchorElement);
            
            // Start from the anchor element
            let endIndex = siblings.length - 1;
            
            // Look for the next section marker (starting from the element after the anchor)
            for (let i = anchorIndex + 1; i < siblings.length; i++) {
              const elem = siblings[i] as Element;
              const text = elem.textContent?.trim() || '';
              
              // Stop at the next section (§, Article, Chapter, or similar markers)
              if (
                text.match(/^§\s*\d+/) ||                    // Next statute section (§ 300-52, etc.)
                text.match(/^Article\s+[IVX\d]+/i) ||        // Next article
                text.match(/^Chapter\s+\d+/i) ||             // Next chapter
                text.match(/^\d+-\d+/) ||                    // Section number pattern (300-52, etc.)
                elem.tagName.toLowerCase() === 'h1' ||       // Major heading
                elem.tagName.toLowerCase() === 'h2' ||       // Section heading
                (elem.tagName.toLowerCase() === 'div' && elem.className.includes('section'))
              ) {
                endIndex = i - 1;
                console.log(`  📍 Found next section at sibling ${i}, stopping extraction`);
                break;
              }
            }
            
            // Create a container with the anchor and all content until the next section
            const sectionContainer = document.createElement('div');
            for (let i = anchorIndex; i <= endIndex; i++) {
              const elem = siblings[i] as Element;
              sectionContainer.appendChild(elem.cloneNode(true));
            }
            targetElement = sectionContainer;
            console.log(`  📍 Extracted content from anchor through sibling ${endIndex} (${endIndex - anchorIndex + 1} elements)`);
          } else {
            // Fallback: use the anchor element directly
            targetElement = anchorElement;
            console.log(`  📍 Using anchor element as target section (no parent found)`);
          }
        }
      } else {
        console.log(`  ⚠️  Anchor element #${anchorId} not found, using full page`);
      }
    }
    
    // Get text content and preserve structure  
    let text = targetElement.textContent || '';
    
    // Replace "chevron_right" with newlines for better navigation structure
    text = text.replace(/chevron_right/g, '\n');
    
    // Preserve paragraph structure by converting multiple whitespace to proper newlines
    text = text.replace(/\n\s*\n/g, '\n\n'); // Double newlines for paragraphs
    text = text.replace(/\t+/g, '\t'); // Preserve tabs
    text = text.replace(/[ ]+/g, ' '); // Collapse multiple spaces to single
    text = text.replace(/\n /g, '\n'); // Remove leading spaces after newlines
    
    // Better newline preservation - don't collapse all newlines
    text = text.replace(/\n{3,}/g, '\n\n'); // Maximum of 2 consecutive newlines
    text = text.trim();
    
    // If we extracted a specific section, add metadata
    if (anchorId && targetElement !== document.body) {
      const sectionInfo = `[Extracted from anchor #${anchorId}]\n\n`;
      text = sectionInfo + text;
      console.log(`  ✅ Successfully extracted ${text.length} characters from anchor section`);
    }
    
    // Improved validation: Check for meaningful content rather than just length ratio
    const hasSubstantialContent = text.length > 500; // At least 500 characters
    const hasStatuteKeywords = /\b(chapter|section|article|ordinance|code|§|subsection|violation|penalty)\b/i.test(text);
    
    // Only warn if we got almost nothing or it doesn't look like legal text
    if (text.length < 50) {
      console.log('  Warning: HTML conversion resulted in very short text (<50 chars), keeping conversion anyway');
    }
    
    return text;
  } catch (error) {
    console.error('  Error converting HTML to text:', error);
    throw error;
  }
}

async function downloadPdfFromUrl(url: string): Promise<Buffer> {
  console.log(`Downloading PDF from: ${url}`);
  
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Ordinizer/1.0)'
      },
      timeout: 30000 // 30 second timeout
    });
    
    console.log(`Downloaded PDF (${response.data.byteLength} bytes)`);
    return Buffer.from(response.data);
  } catch (error) {
    console.error(`Error downloading PDF: ${error}`);
    throw error;
  }
}

async function extractTextFromPdf(pdfBuffer: Buffer): Promise<string> {
  try {
    console.log(`Extracting text from PDF (${pdfBuffer.length} bytes)...`);
    
    // Dynamic import for pdf-parse to handle ES module issues
    const pdf = await import('pdf-parse');
    const pdfParser = pdf.default || pdf;
    
    const data = await pdfParser(pdfBuffer);
    
    console.log(`Extracted text from PDF (${data.text.length} characters)`);
    console.log(`PDF has ${data.numpages} pages`);
    
    // Clean up the extracted text
    let text = data.text;
    
    // Remove excessive whitespace while preserving structure
    text = text.replace(/\r\n/g, '\n'); // Normalize line endings
    text = text.replace(/\n{3,}/g, '\n\n'); // Maximum of 2 consecutive newlines
    text = text.replace(/[ \t]{2,}/g, ' '); // Collapse multiple spaces/tabs
    text = text.replace(/\n /g, '\n'); // Remove leading spaces after newlines
    text = text.trim();
    
    return text;
  } catch (error) {
    console.error(`Error extracting text from PDF: ${error}`);
    throw error;
  }
}

async function convertSingleFile(domain: string, municipality: string) {
  const domainDir = domain.toLowerCase().replace(/\s+/g, '-');
  const statuteDir = path.join(process.cwd(), '..', 'data', domainDir, municipality);
  const htmlPath = path.join(statuteDir, 'statute.html');
  const pdfPath = path.join(statuteDir, 'statute.pdf');
  const txtPath = path.join(statuteDir, 'statute.txt');
  const metadataPath = path.join(statuteDir, 'metadata.json');
  
  console.log(`Converting statute to text for ${municipality} in ${domain}...`);
  console.log(`Statute directory: ${statuteDir}`);
  
  let textContent: string | undefined;
  let sourceFile: string | undefined;
  let sourceType: string | undefined;
  
  // Check if we need to download from a PDF URL
  if (await fs.pathExists(metadataPath)) {
    try {
      const metadata = await fs.readJson(metadataPath);
      if (metadata.sourceUrl && metadata.sourceUrl.toLowerCase().endsWith('.pdf')) {
        console.log(`PDF source detected: ${metadata.sourceUrl}`);
        
        // Download and convert PDF
        const pdfBuffer = await downloadPdfFromUrl(metadata.sourceUrl);
        
        // Save PDF file
        await fs.writeFile(pdfPath, pdfBuffer);
        console.log(`Saved PDF file: ${pdfPath}`);
        
        // Extract text from PDF
        textContent = await extractTextFromPdf(pdfBuffer);
        sourceFile = pdfPath;
        sourceType = 'PDF';
      }
    } catch (error) {
      console.warn(`Could not process PDF from metadata: ${error}`);
    }
  }
  
  // Fall back to HTML conversion if no PDF was processed
  if (!textContent) {
    if (await fs.pathExists(htmlPath)) {
      console.log(`HTML file found: ${htmlPath}`);
      
      // Read HTML content
      const htmlContent = await fs.readFile(htmlPath, 'utf-8');
      console.log(`Read HTML file (${htmlContent.length} characters)`);
      
      // Convert to text
      textContent = convertHtmlToText(htmlContent);
      sourceFile = htmlPath;
      sourceType = 'HTML';
    } else {
      console.error(`Error: No source file found. Looked for PDF URL in metadata and HTML file at ${htmlPath}`);
      return;
    }
  }
  
  console.log(`Converted ${sourceType} to text (${textContent.length} characters)`);
  
  // Write text file
  await fs.writeFile(txtPath, textContent, 'utf-8');
  console.log(`Successfully wrote text file: ${txtPath}`);
  
  // Update metadata
  if (await fs.pathExists(metadataPath)) {
    try {
      const metadata = await fs.readJson(metadataPath);
      metadata.contentLength = textContent.length;
      metadata.lastConverted = new Date().toISOString();
      metadata.sourceType = sourceType;
      if (sourceType === 'PDF') {
        const pdf = await import('pdf-parse');
        const pdfParser = pdf.default || pdf;
        metadata.pdfPages = (await pdfParser(await fs.readFile(pdfPath))).numpages;
      }
      await fs.writeJson(metadataPath, metadata, { spaces: 2 });
      console.log(`Updated metadata.json with new content length: ${textContent.length}`);
    } catch (error) {
      console.warn(`Could not update metadata: ${error}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.log(`
Usage: tsx convertHtmlToText.ts <domain> <municipality>

Supports both HTML and PDF conversion:
- If metadata.json contains a PDF URL, downloads and converts the PDF
- Otherwise converts existing statute.html file
- Always outputs to statute.txt

Examples:
  tsx convertHtmlToText.ts "Property Maintenance" "NY-State"    # Converts PDF from metadata URL
  tsx convertHtmlToText.ts "Trees" "NY-Ardsley-Village"         # Converts HTML file
    `);
    return;
  }
  
  const domain = args[0];
  const municipality = args[1];
  
  try {
    await convertSingleFile(domain, municipality);
    console.log('Conversion completed successfully!');
  } catch (error) {
    console.error('Conversion failed:', error);
    process.exit(1);
  }
}

// Export the functions for use in other modules
export { convertHtmlToText, convertSingleFile };

// Run main function if this is the entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}