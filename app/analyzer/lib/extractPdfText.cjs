#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');

async function extractPdfToText(domain, municipality) {
  const domainDir = domain.toLowerCase().replace(/\s+/g, '-');
  const statuteDir = path.join(process.cwd(), '..', 'data', domainDir, municipality);
  const pdfPath = path.join(statuteDir, 'statute.pdf');
  const txtPath = path.join(statuteDir, 'statute.txt');
  const metadataPath = path.join(statuteDir, 'metadata.json');
  
  console.log(`Extracting PDF text for ${municipality} in ${domain}...`);
  console.log(`PDF file: ${pdfPath}`);
  console.log(`Text file: ${txtPath}`);
  
  if (!fs.existsSync(pdfPath)) {
    console.error(`Error: PDF file not found at ${pdfPath}`);
    return;
  }
  
  try {
    // Read PDF content
    const pdfBuffer = fs.readFileSync(pdfPath);
    console.log(`Read PDF file (${pdfBuffer.length} bytes)`);
    
    // Extract text from PDF
    const data = await pdf(pdfBuffer);
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
    
    // Write text file
    fs.writeFileSync(txtPath, text, 'utf-8');
    console.log(`Successfully wrote text file: ${txtPath}`);
    
    // Update metadata if it exists
    if (fs.existsSync(metadataPath)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
        metadata.contentLength = text.length;
        metadata.lastConverted = new Date().toISOString();
        metadata.sourceType = 'PDF';
        metadata.pdfPages = data.numpages;
        metadata.originalHtmlLength = undefined; // Clear since we're using PDF now
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
        console.log(`Updated metadata.json with new content length: ${text.length} and ${data.numpages} pages`);
      } catch (error) {
        console.warn(`Could not update metadata: ${error.message}`);
      }
    }
    
    console.log('PDF text extraction completed successfully!');
    
  } catch (error) {
    console.error(`Error during PDF extraction: ${error.message}`);
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.log(`
Usage: node extractPdfText.js <domain> <municipality>

Examples:
  node extractPdfText.js "Property Maintenance" "NY-State"
    `);
    return;
  }
  
  const domain = args[0];
  const municipality = args[1];
  
  extractPdfToText(domain, municipality);
}

if (require.main === module) {
  main();
}