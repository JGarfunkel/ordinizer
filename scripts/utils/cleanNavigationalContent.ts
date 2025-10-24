#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';
import { Command } from 'commander';
import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';

// Initialize services
const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY!,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

interface NavigationalDetection {
  municipality: string;
  domain: string;
  statutePath: string;
  originalLength: number;
  navigationalLines: string[];
  cleanedLength: number;
  contentStart: string;
  vectorChunksToRemove: string[];
}

interface CleanupSummary {
  totalMunicipalities: number;
  municipalitiesWithNavContent: number;
  totalNavigationalLines: number;
  totalCharactersSaved: number;
  vectorChunksRemoved: number;
  detections: NavigationalDetection[];
}

/**
 * Detects if a line is navigational content based on patterns:
 * - Short lines (<50 characters) 
 * - No periods (not proper sentences)
 * - Common navigational patterns
 * - Before meaningful content starts
 */
function isNavigationalLine(line: string): boolean {
  const trimmed = line.trim();
  
  // Empty lines are not navigational
  if (!trimmed) return false;
  
  // Long lines with periods are likely content
  if (trimmed.length > 80 && trimmed.includes('.')) return false;
  
  // Short lines without periods are likely navigational
  if (trimmed.length < 50 && !trimmed.includes('.')) return true;
  
  // Common navigational patterns
  const navPatterns = [
    /^Chapter \d+/i,
    /^Article [IVX\d]+/i,
    /^Section \d/i,
    /^§\s*\d/,
    /^Home$/i,
    /^Print$/i,
    /^Download$/i,
    /^Search$/i,
    /^Table of Contents/i,
    /^Municipal Code/i,
    /^Code of Ordinances/i,
    /^\d+\/\d+\/\d+$/, // Dates
    /^Last updated/i,
    /^Adopted/i,
    /^Effective/i,
  ];
  
  return navPatterns.some(pattern => pattern.test(trimmed));
}

/**
 * Finds where meaningful content starts (e.g., "[Town|Village|City] of [Name]")
 */
function findContentStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Look for municipality name patterns - these are clear content start indicators
    const municipalityPatterns = [
      /^(Town|Village|City) of \w+/i,
      /^VILLAGE OF [A-Z]/i,
      /^TOWN OF [A-Z]/i,
      /^CITY OF [A-Z]/i,
    ];
    
    if (municipalityPatterns.some(pattern => pattern.test(line))) {
      return i;
    }
    
    // Look for chapter headings that appear after navigation
    const chapterPatterns = [
      /^Chapter \d+\s+[A-Z][a-zA-Z\s]+$/,
      /^CHAPTER \d+$/,
      /^Part [IVX]+[:.]?\s+[A-Z]/,
    ];
    
    if (chapterPatterns.some(pattern => pattern.test(line))) {
      // Check if previous lines are mostly navigational
      const previousLines = lines.slice(Math.max(0, i-10), i);
      const navCount = previousLines.filter(prevLine => isNavigationalLine(prevLine)).length;
      
      if (navCount > previousLines.length * 0.6) {
        return i;
      }
    }
    
    // Look for substantial content after a series of short navigational lines
    if (line.length > 100 && line.includes('.') && line.split(' ').length > 15) {
      // Check if most previous lines were navigational
      const recentLines = lines.slice(Math.max(0, i-5), i);
      const navCount = recentLines.filter(prevLine => isNavigationalLine(prevLine)).length;
      
      if (navCount > recentLines.length * 0.7) {
        return i;
      }
    }
  }
  
  return 0; // Default to start if no clear pattern found
}

/**
 * Analyzes a statute.txt file for navigational content
 */
async function analyzeStatuteFile(statutePath: string, municipality: string, domain: string): Promise<NavigationalDetection | null> {
  if (!await fs.pathExists(statutePath)) {
    return null;
  }
  
  const content = await fs.readFile(statutePath, 'utf-8');
  const lines = content.split('\n');
  const originalLength = content.length;
  
  // Find where content starts
  const contentStartIndex = findContentStart(lines);
  const navigationalLines = lines.slice(0, contentStartIndex);
  
  // Only consider it navigational content if there are multiple short lines
  if (navigationalLines.length < 3 || navigationalLines.join('').length < 100) {
    return null;
  }
  
  const cleanedContent = lines.slice(contentStartIndex).join('\n');
  const contentStart = cleanedContent.substring(0, 200) + (cleanedContent.length > 200 ? '...' : '');
  
  return {
    municipality,
    domain,
    statutePath,
    originalLength,
    navigationalLines: navigationalLines.filter(line => line.trim()),
    cleanedLength: cleanedContent.length,
    contentStart,
    vectorChunksToRemove: [], // Will populate when checking vector DB
  };
}

/**
 * Checks vector database for navigational content chunks
 */
async function findNavigationalChunksInVector(detection: NavigationalDetection): Promise<string[]> {
  try {
    const index = pinecone.index('ordinizer-statutes');
    
    // Create a dummy vector for querying (we only care about metadata filtering)
    const dummyVector = new Array(1536).fill(0);
    
    // Query for chunks from this municipality/domain
    const queryResponse = await index.query({
      vector: dummyVector,
      filter: {
        municipality: detection.municipality,
        domainId: detection.domain // Use domainId to match the indexing format
      },
      topK: 100,
      includeMetadata: true,
      includeValues: false,
    });
    
    const navigationalChunks: string[] = [];
    
    for (const match of queryResponse.matches) {
      const chunkText = match.metadata?.text as string;
      if (chunkText) {
        const lines = chunkText.split('\n');
        const navLineCount = lines.filter(line => isNavigationalLine(line)).length;
        
        // If more than 50% of lines are navigational, mark chunk for removal
        if (navLineCount > lines.length * 0.5 && navLineCount > 2) {
          navigationalChunks.push(match.id);
        }
      }
    }
    
    return navigationalChunks;
  } catch (error) {
    console.warn(`Warning: Could not check vector DB for ${detection.municipality}/${detection.domain}:`, error.message);
    return [];
  }
}

/**
 * Scans all municipalities and domains for navigational content
 */
async function detectNavigationalContent(): Promise<CleanupSummary> {
  const dataDir = path.join(process.cwd(), 'data');
  const domains = await fs.readdir(dataDir, { withFileTypes: true });
  
  const detections: NavigationalDetection[] = [];
  let totalNavigationalLines = 0;
  let totalCharactersSaved = 0;
  let vectorChunksRemoved = 0;
  
  console.log('🔍 Scanning for navigational content...');
  
  for (const domain of domains.filter(d => d.isDirectory())) {
    const domainPath = path.join(dataDir, domain.name);
    const municipalities = await fs.readdir(domainPath, { withFileTypes: true });
    
    console.log(`\n📁 Checking domain: ${domain.name}`);
    
    for (const municipality of municipalities.filter(m => m.isDirectory())) {
      const statutePath = path.join(domainPath, municipality.name, 'statute.txt');
      
      process.stdout.write(`  • ${municipality.name}... `);
      
      const detection = await analyzeStatuteFile(statutePath, municipality.name, domain.name);
      
      if (detection) {
        // Check vector database for navigational chunks
        detection.vectorChunksToRemove = await findNavigationalChunksInVector(detection);
        
        detections.push(detection);
        totalNavigationalLines += detection.navigationalLines.length;
        totalCharactersSaved += (detection.originalLength - detection.cleanedLength);
        vectorChunksRemoved += detection.vectorChunksToRemove.length;
        
        console.log(`Found ${detection.navigationalLines.length} nav lines, ${detection.vectorChunksToRemove.length} vector chunks`);
      } else {
        console.log('Clean');
      }
    }
  }
  
  return {
    totalMunicipalities: detections.length + (await countTotalMunicipalities()),
    municipalitiesWithNavContent: detections.length,
    totalNavigationalLines,
    totalCharactersSaved,
    vectorChunksRemoved,
    detections,
  };
}

async function countTotalMunicipalities(): Promise<number> {
  const dataDir = path.join(process.cwd(), 'data');
  const domains = await fs.readdir(dataDir, { withFileTypes: true });
  
  let total = 0;
  for (const domain of domains.filter(d => d.isDirectory())) {
    const domainPath = path.join(dataDir, domain.name);
    const municipalities = await fs.readdir(domainPath, { withFileTypes: true });
    total += municipalities.filter(m => m.isDirectory()).length;
  }
  
  return total;
}

/**
 * Executes the cleanup by removing navigational content from files and vector DB
 */
async function executeCleanup(detections: NavigationalDetection[]): Promise<void> {
  console.log('\n🧹 Executing cleanup...');
  
  const index = pinecone.index('ordinizer-statutes');
  let filesProcessed = 0;
  let vectorChunksDeleted = 0;
  
  for (const detection of detections) {
    process.stdout.write(`  • Cleaning ${detection.municipality}/${detection.domain}... `);
    
    try {
      // Clean statute.txt file
      const content = await fs.readFile(detection.statutePath, 'utf-8');
      const lines = content.split('\n');
      const contentStartIndex = findContentStart(lines);
      const cleanedContent = lines.slice(contentStartIndex).join('\n');
      
      await fs.writeFile(detection.statutePath, cleanedContent);
      
      // Remove navigational chunks from vector database
      if (detection.vectorChunksToRemove.length > 0) {
        await index.deleteMany(detection.vectorChunksToRemove);
        vectorChunksDeleted += detection.vectorChunksToRemove.length;
      }
      
      filesProcessed++;
      console.log(`File cleaned, ${detection.vectorChunksToRemove.length} vector chunks removed`);
      
    } catch (error) {
      console.log(`Error: ${error.message}`);
    }
  }
  
  console.log(`\n✅ Cleanup complete: ${filesProcessed} files processed, ${vectorChunksDeleted} vector chunks deleted`);
}

/**
 * Saves detection summary to file
 */
async function saveSummary(summary: CleanupSummary): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const summaryPath = path.join(process.cwd(), `navigational-content-analysis-${timestamp}.json`);
  
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  
  // Also create a human-readable report
  const reportPath = path.join(process.cwd(), `navigational-content-report-${timestamp}.md`);
  const report = `# Navigational Content Analysis Report

Generated: ${new Date().toISOString()}

## Summary
- **Total Municipalities Scanned**: ${summary.totalMunicipalities}
- **Municipalities with Navigational Content**: ${summary.municipalitiesWithNavContent}
- **Total Navigational Lines Found**: ${summary.totalNavigationalLines}
- **Total Characters that would be saved**: ${summary.totalCharactersSaved.toLocaleString()}
- **Vector Chunks to Remove**: ${summary.vectorChunksRemoved}

## Detected Issues

${summary.detections.map(detection => `
### ${detection.municipality} - ${detection.domain}
- **File**: ${detection.statutePath}
- **Original Size**: ${detection.originalLength.toLocaleString()} characters
- **Cleaned Size**: ${detection.cleanedLength.toLocaleString()} characters
- **Navigational Lines**: ${detection.navigationalLines.length}
- **Vector Chunks to Remove**: ${detection.vectorChunksToRemove.length}

**Sample Navigational Lines**:
${detection.navigationalLines.slice(0, 5).map(line => `- "${line}"`).join('\n')}

**Content Starts With**:
\`\`\`
${detection.contentStart}
\`\`\`
`).join('\n')}
`;

  await fs.writeFile(reportPath, report);
  
  return reportPath;
}

// CLI Setup
const program = new Command();

program
  .name('cleanNavigationalContent')
  .description('Detect and remove navigational content from statute files and vector database')
  .version('1.0.0');

program
  .command('detect')
  .description('Analyze all statute files for navigational content (detection mode)')
  .action(async () => {
    try {
      console.log('🔍 Starting navigational content detection...');
      
      const summary = await detectNavigationalContent();
      const reportPath = await saveSummary(summary);
      
      console.log('\n📊 Detection Summary:');
      console.log(`• Municipalities scanned: ${summary.totalMunicipalities}`);
      console.log(`• With navigational content: ${summary.municipalitiesWithNavContent}`);
      console.log(`• Total navigational lines: ${summary.totalNavigationalLines}`);
      console.log(`• Characters to be saved: ${summary.totalCharactersSaved.toLocaleString()}`);
      console.log(`• Vector chunks to remove: ${summary.vectorChunksRemoved}`);
      console.log(`\n📄 Report saved to: ${reportPath}`);
      
    } catch (error) {
      console.error('❌ Detection failed:', error.message);
      process.exit(1);
    }
  });

program
  .command('execute')
  .description('Execute cleanup based on previous detection results')
  .requiredOption('-f, --file <path>', 'Path to detection summary JSON file')
  .action(async (options) => {
    try {
      console.log(`🧹 Loading detection results from: ${options.file}`);
      
      if (!await fs.pathExists(options.file)) {
        throw new Error(`Detection file not found: ${options.file}`);
      }
      
      const summary: CleanupSummary = await fs.readJson(options.file);
      
      console.log(`📊 Found ${summary.detections.length} municipalities with navigational content`);
      console.log('⚠️  This will permanently modify statute.txt files and remove vector database entries');
      console.log('   Make sure you have backups if needed!');
      
      // Add a confirmation prompt in production
      await executeCleanup(summary.detections);
      
    } catch (error) {
      console.error('❌ Cleanup failed:', error.message);
      process.exit(1);
    }
  });

// If run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  program.parse();
}

export { detectNavigationalContent, executeCleanup };