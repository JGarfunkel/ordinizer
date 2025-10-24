#!/usr/bin/env tsx
/**
 * Utility to re-convert existing statute.html files to proper plain text
 * using the improved convertHtmlToText function
 * 
 * Usage:
 *   tsx scripts/reconvertHtmlToText.ts [--dry-run] [--verbose] [--municipality-filter=name]
 */

import fs from 'fs-extra';
import path from 'path';
import { JSDOM } from "jsdom";

interface ConversionStats {
  municipalitiesScanned: number;
  filesConverted: number;
  filesSkipped: number;
  errors: string[];
}

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
    const hasSubstantialContent = text.length > 500;
    const hasStatuteKeywords = /\b(chapter|section|article|ordinance|code|§|subsection|violation|penalty)\b/i.test(text);
    const seemsLikeStatute = hasSubstantialContent && hasStatuteKeywords;
    
    return text;
  } catch (error) {
    console.log('  Warning: Failed to parse HTML, using basic HTML stripping:', error.message);
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

async function reconvertFiles(dryRun: boolean = false, verbose: boolean = false, municipalityFilter?: string): Promise<ConversionStats> {
  const stats: ConversionStats = {
    municipalitiesScanned: 0,
    filesConverted: 0,
    filesSkipped: 0,
    errors: []
  };

  const propertyMaintenanceDir = path.join(process.cwd(), '..', 'data', 'property-maintenance');
  
  if (!await fs.pathExists(propertyMaintenanceDir)) {
    throw new Error(`Property maintenance directory not found: ${propertyMaintenanceDir}`);
  }

  console.log(`🔄 Reconverting HTML to text files: ${propertyMaintenanceDir}`);
  console.log(`${dryRun ? '🔧 DRY RUN MODE - No files will be modified' : '✏️  CONVERSION MODE - Files will be updated'}`);
  console.log();

  const municipalities = await fs.readdir(propertyMaintenanceDir);
  
  for (const municipality of municipalities) {
    if (municipality === 'questions.json' || municipality === 'NY-State') {
      continue;
    }

    if (municipalityFilter && !municipality.toLowerCase().includes(municipalityFilter.toLowerCase())) {
      continue;
    }

    const municipalityPath = path.join(propertyMaintenanceDir, municipality);
    const municipalityStat = await fs.stat(municipalityPath);
    
    if (!municipalityStat.isDirectory()) {
      continue;
    }

    stats.municipalitiesScanned++;
    console.log(`📂 Checking: ${municipality}`);

    const htmlPath = path.join(municipalityPath, 'statute.html');
    const txtPath = path.join(municipalityPath, 'statute.txt');

    try {
      if (!await fs.pathExists(htmlPath)) {
        if (verbose) console.log(`  ⚪ No HTML file found`);
        stats.filesSkipped++;
        continue;
      }

      const htmlContent = await fs.readFile(htmlPath, 'utf8');
      
      // Check if txt file exists and appears to be raw HTML (indicating failed conversion)
      let needsConversion = false;
      
      if (await fs.pathExists(txtPath)) {
        const txtContent = await fs.readFile(txtPath, 'utf8');
        
        // Check if txt file is actually HTML (failed conversion)
        const isHtmlInTxt = txtContent.trim().startsWith('<!DOCTYPE') || 
                           txtContent.trim().startsWith('<html') ||
                           txtContent.includes('<body>') ||
                           txtContent.length === htmlContent.length; // Exact match indicates no conversion
                           
        if (isHtmlInTxt) {
          console.log(`  🔄 TXT file contains HTML - needs reconversion`);
          needsConversion = true;
        } else {
          // Check if the conversion ratio suggests it might be unconverted
          const ratio = htmlContent.length > 0 ? (txtContent.length / htmlContent.length) : 0;
          if (ratio > 0.8) { // If txt is more than 80% of HTML size, likely unconverted
            console.log(`  🔄 TXT file suspiciously large (${(ratio*100).toFixed(1)}% of HTML) - reconverting`);
            needsConversion = true;
          } else if (verbose) {
            console.log(`  ✅ TXT file appears properly converted (${(ratio*100).toFixed(1)}% of HTML)`);
            stats.filesSkipped++;
          }
        }
      } else {
        console.log(`  📝 No TXT file found - creating from HTML`);
        needsConversion = true;
      }

      if (needsConversion) {
        const convertedText = convertHtmlToText(htmlContent);
        const ratio = htmlContent.length > 0 ? (convertedText.length / htmlContent.length * 100).toFixed(1) : '0';
        
        console.log(`  📊 Converted: ${htmlContent.length.toLocaleString()} → ${convertedText.length.toLocaleString()} chars (${ratio}%)`);
        
        if (!dryRun) {
          await fs.writeFile(txtPath, convertedText, 'utf-8');
          
          // Update metadata if it exists
          const metadataPath = path.join(municipalityPath, 'metadata.json');
          if (await fs.pathExists(metadataPath)) {
            const metadata = await fs.readJson(metadataPath);
            metadata.contentLength = convertedText.length;
            metadata.reconvertedAt = new Date().toISOString();
            await fs.writeJson(metadataPath, metadata, { spaces: 2 });
          }
        }
        
        stats.filesConverted++;
      }

    } catch (error) {
      const errorMsg = `Error processing ${municipality}: ${error}`;
      console.error(`  ❌ ${errorMsg}`);
      stats.errors.push(errorMsg);
    }
  }

  return stats;
}

function printStats(stats: ConversionStats, dryRun: boolean): void {
  console.log('\n📊 RECONVERSION SUMMARY');
  console.log('═'.repeat(50));
  console.log(`Municipalities scanned: ${stats.municipalitiesScanned}`);
  console.log(`Files ${dryRun ? 'to be converted' : 'converted'}: ${stats.filesConverted}`);
  console.log(`Files skipped (already converted): ${stats.filesSkipped}`);
  console.log(`Errors encountered: ${stats.errors.length}`);
  
  if (stats.errors.length > 0) {
    console.log('\n❌ ERRORS:');
    stats.errors.forEach(error => console.log(`  • ${error}`));
  }

  if (dryRun && stats.filesConverted > 0) {
    console.log('\n💡 To actually convert the files, run without --dry-run flag');
  }
}

function showHelp(): void {
  console.log(`
🔄 HTML to Text Reconversion Utility

This script reconverts existing statute.html files to proper plain text using
the improved HTML conversion logic, fixing files that fell back to raw HTML.

Usage:
  tsx scripts/reconvertHtmlToText.ts [options]

Options:
  --dry-run, -d                     Preview what would be converted
  --verbose, -v                     Show detailed output for all files
  --municipality-filter=<name>      Filter by municipality name
  --help, -h                        Show this help message

Examples:
  tsx scripts/reconvertHtmlToText.ts --dry-run --verbose
  tsx scripts/reconvertHtmlToText.ts --municipality-filter=Bedford
  tsx scripts/reconvertHtmlToText.ts

Detection Logic:
  - Files where statute.txt starts with <!DOCTYPE or <html
  - Files where statute.txt is same size as statute.html
  - Files where statute.txt is >80% the size of statute.html
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  let dryRun = false;
  let verbose = false;
  let municipalityFilter: string | undefined;

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      showHelp();
      return;
    } else if (arg === '--dry-run' || arg === '-d') {
      dryRun = true;
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg.startsWith('--municipality-filter=')) {
      municipalityFilter = arg.split('=')[1];
    } else {
      console.error(`Unknown argument: ${arg}`);
      showHelp();
      process.exit(1);
    }
  }

  try {
    const stats = await reconvertFiles(dryRun, verbose, municipalityFilter);
    printStats(stats, dryRun);
    
    if (!dryRun && stats.filesConverted > 0) {
      console.log('\n✅ Reconversion completed successfully!');
    }
  } catch (error) {
    console.error('❌ Failed to run reconversion:', error);
    process.exit(1);
  }
}

main();