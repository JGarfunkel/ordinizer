#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';
import { Command } from 'commander';

/**
 * Enhanced navigational content detection and cleanup utility
 * Focuses on cleaning statute.txt files by removing ecode360.com navigation
 */

interface CleanupResult {
  municipality: string;
  domain: string;
  statutePath: string;
  originalLines: number;
  cleanedLines: number;
  originalSize: number;
  cleanedSize: number;
  charactersRemoved: number;
  removedContent: string[];
  contentPreview: string;
}

/**
 * Improved detection for meaningful content start
 * Specifically targets ecode360.com navigation patterns
 */
function findMeaningfulContentStart(lines: string[]): number {
  let navLineCount = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Skip empty lines
    if (!line) continue;
    
    // FIRST: Look for municipality headers - these should ALWAYS be preserved
    if (/^(Village|Town|City) of .+, NY$/i.test(line)) {
      return i;
    }
    
    // Count navigational patterns at the start
    if (isNavigationalPattern(line)) {
      navLineCount++;
      continue;
    }
    
    // If we've seen navigation and now hit meaningful content, this is the start
    if (navLineCount >= 3) {
      // Look for actual statute section markers (these are definitely content)
      if (/^§\s*\d+[-\d]*\.?\s*[A-Z]/.test(line)) {
        return i;
      }
      
      // Look for "HISTORY:" or "[HISTORY:" - this usually marks start of real content
      if (/^\[?HISTORY:/i.test(line)) {
        return i;
      }
      
      // Look for substantial paragraphs that are clearly legal text
      if (line.length > 100 && 
          line.includes('.') && 
          line.split(' ').length > 15 &&
          !/^(Town|Village|City) of/.test(line)) {
        return i;
      }
      
      // Look for chapter/article headers that come after navigation
      if (/^(Chapter|Article) \d+/i.test(line)) {
        return i;
      }
      
      // Look for ordinance titles or legal text patterns
      if (line.length > 50 && 
          (/ordinance|code|regulation|shall|pursuant|violation/i.test(line) || 
           /^[A-Z]\.\s+/.test(line))) {
        return i;
      }
      
      // For ecode360, look for patterns after "Get Updates" or similar
      if (i > 0 && /Get Updates|arrow_forward|share/i.test(lines[i-1])) {
        return i;
      }
      
      // If we have substantial navigation (10+ lines) and hit any non-nav content
      if (navLineCount >= 10 && line.length > 30 && !isNavigationalPattern(line)) {
        // But make sure it's not just an article/section header in the table of contents
        if (/^(Article|Section|Chapter|Part) [IVX\d]+$/i.test(line) ||
            /^§\s*\d+[-\d]*$/i.test(line.trim()) ||
            line.length < 50) {
          // This might still be navigation/table of contents
          continue;
        }
        return i;
      }
    }
  }
  
  // If we detected significant navigation but no clear content boundary
  if (navLineCount >= 10) {
    // Find first substantial non-navigation line after the navigation section
    for (let i = 0; i < Math.min(lines.length, navLineCount + 100); i++) {
      const line = lines[i].trim();
      if (line && !isNavigationalPattern(line) && line.length > 50) {
        // Look for clear legal content patterns
        if (/shall|hereby|violation|penalty|ordinance|unlawful|prohibited/i.test(line) ||
            /^[A-Z]\.\s+[A-Z]/.test(line) ||
            /\. [A-Z]/.test(line)) {
          return i;
        }
      }
    }
  }
  
  return 0; // Default to start if no clear pattern found
}

/**
 * Enhanced navigational pattern detection
 */
function isNavigationalPattern(line: string): boolean {
  const trimmed = line.trim();
  
  if (!trimmed) return false;
  
  // Enhanced single-line navigation patterns (case insensitive)
  const singleLinePatterns = [
    /^print$/i,
    /^email$/i,
    /^share$/i,
    /^get updates$/i,
    /^add alert$/i,
    /^arrow_/i, // Matches arrow_back, arrow_forward, etc.
  ];
  
  // Check single line patterns first
  if (singleLinePatterns.some(pattern => pattern.test(trimmed))) {
    return true;
  }
  
  // ecode360.com specific patterns
  const eCodePatterns = [
    /^(home|code|law|pubdocs|help|search|login|info|download)$/i,
    /^(Home|Code|Law|Public Documents|Help|Search|Login|Info|Download)$/i,
    /^add_alert$/i,
    /^Laws \(\d+\)$/i,
    /^New Laws \(\d+\)$/i,
    /^Minutes \(\d+\)$/i,
    /^Resolutions \(\d+\)$/i,
    /^Agendas \(\d+\)$/i,
    /^Budgets \(\d+\)$/i,
    /^Notes \(\d+\)$/i,
    /^Misc\. Documents \(\d+\)$/i,
    /^\d{4}-\d{2}-\d{2}$/, // Dates like 2025-02-25
  ];
  
  // General navigation patterns
  const generalPatterns = [
    /^Chapter \d+$/i,
    /^Article [IVX\d]+$/i,
    /^Section \d+$/i,
    /^Part [IVX]+$/i,
    /^📜/,
    /^🔗/,
    /^Table of Contents/i,
    /^Municipal Code/i,
    /^Code of Ordinances/i,
    /^Index$/i,
    /^help_center$/i,
    /^note$/i,
    /^ecode$/i,
  ];
  
  // Check against all patterns
  const allPatterns = [...eCodePatterns, ...generalPatterns];
  if (allPatterns.some(pattern => pattern.test(trimmed))) {
    return true;
  }
  
  // Short lines without periods (likely navigation)
  if (trimmed.length < 50 && !trimmed.includes('.') && !/^§/.test(trimmed)) {
    return true;
  }
  
  // Lines that are just numbers or simple words
  if (/^\d+$/.test(trimmed) || /^[A-Za-z]{1,15}$/.test(trimmed)) {
    return true;
  }
  
  return false;
}

/**
 * Clean a single statute file
 */
async function cleanStatuteFile(statutePath: string, municipality: string, domain: string, dryRun: boolean = true): Promise<CleanupResult | null> {
  if (!await fs.pathExists(statutePath)) {
    return null;
  }
  
  const content = await fs.readFile(statutePath, 'utf-8');
  const lines = content.split('\n');
  
  const contentStart = findMeaningfulContentStart(lines);
  
  // Only proceed if we're removing significant navigation content
  if (contentStart < 3) {
    return null; // Not enough navigation to clean
  }
  
  const removedLines = lines.slice(0, contentStart);
  const cleanedLines = lines.slice(contentStart);
  const cleanedContent = cleanedLines.join('\n');
  
  const result: CleanupResult = {
    municipality,
    domain,
    statutePath,
    originalLines: lines.length,
    cleanedLines: cleanedLines.length,
    originalSize: content.length,
    cleanedSize: cleanedContent.length,
    charactersRemoved: content.length - cleanedContent.length,
    removedContent: removedLines.filter(line => line.trim()),
    contentPreview: cleanedContent.substring(0, 200) + (cleanedContent.length > 200 ? '...' : ''),
  };
  
  // Actually clean the file if not in dry run mode
  if (!dryRun) {
    // Create backup first
    const backupPath = `${statutePath}.backup-${Date.now()}`;
    await fs.copy(statutePath, backupPath);
    
    // Write cleaned content
    await fs.writeFile(statutePath, cleanedContent);
    console.log(`✅ Cleaned ${municipality}/${domain} - backup: ${path.basename(backupPath)}`);
  }
  
  return result;
}

/**
 * Process all statute files
 */
async function processAllStatutes(dryRun: boolean = true): Promise<CleanupResult[]> {
  const dataDir = path.join(process.cwd(), 'data');
  const domains = await fs.readdir(dataDir, { withFileTypes: true });
  const results: CleanupResult[] = [];
  
  console.log(`🔍 Processing statute files ${dryRun ? '(DRY RUN)' : '(LIVE CLEANUP)'}...`);
  
  for (const domain of domains.filter(d => d.isDirectory())) {
    const domainPath = path.join(dataDir, domain.name);
    const municipalities = await fs.readdir(domainPath, { withFileTypes: true });
    
    console.log(`\n📁 Domain: ${domain.name}`);
    
    for (const municipality of municipalities.filter(m => m.isDirectory())) {
      const statutePath = path.join(domainPath, municipality.name, 'statute.txt');
      
      process.stdout.write(`  • ${municipality.name}... `);
      
      const result = await cleanStatuteFile(statutePath, municipality.name, domain.name, dryRun);
      
      if (result) {
        results.push(result);
        const pct = ((result.charactersRemoved / result.originalSize) * 100).toFixed(1);
        console.log(`${result.removedContent.length} nav lines (${pct}% reduction)`);
      } else {
        console.log('Clean');
      }
    }
  }
  
  return results;
}

/**
 * Generate cleanup report
 */
async function generateReport(results: CleanupResult[]): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(process.cwd(), `navigation-cleanup-report-${timestamp}.md`);
  
  const totalOriginalSize = results.reduce((sum, r) => sum + r.originalSize, 0);
  const totalCleanedSize = results.reduce((sum, r) => sum + r.cleanedSize, 0);
  const totalCharactersRemoved = totalOriginalSize - totalCleanedSize;
  
  const report = `# Navigation Content Cleanup Report

Generated: ${new Date().toISOString()}

## Summary
- **Files with Navigation Content**: ${results.length}
- **Total Characters Removed**: ${totalCharactersRemoved.toLocaleString()}
- **Total Size Reduction**: ${((totalCharactersRemoved / totalOriginalSize) * 100).toFixed(2)}%
- **Average Reduction per File**: ${(totalCharactersRemoved / results.length).toFixed(0)} characters

## Top 10 Largest Reductions

${results
  .sort((a, b) => b.charactersRemoved - a.charactersRemoved)
  .slice(0, 10)
  .map((r, i) => `${i+1}. **${r.municipality} - ${r.domain}**
   - Removed: ${r.charactersRemoved.toLocaleString()} chars (${((r.charactersRemoved / r.originalSize) * 100).toFixed(1)}%)
   - Lines removed: ${r.removedContent.length}
   - Content starts: "${r.contentPreview.substring(0, 80)}..."`)
  .join('\n\n')}

## All Cleanup Results

${results.map(r => `### ${r.municipality} - ${r.domain}
- **Original**: ${r.originalLines} lines, ${r.originalSize.toLocaleString()} chars
- **Cleaned**: ${r.cleanedLines} lines, ${r.cleanedSize.toLocaleString()} chars  
- **Removed**: ${r.removedContent.length} navigation lines
- **Reduction**: ${r.charactersRemoved.toLocaleString()} chars (${((r.charactersRemoved / r.originalSize) * 100).toFixed(1)}%)

**Sample Removed Content:**
${r.removedContent.slice(0, 5).map(line => `- "${line}"`).join('\n')}

**Content Now Starts With:**
\`\`\`
${r.contentPreview}
\`\`\`
`).join('\n\n')}
`;

  await fs.writeFile(reportPath, report);
  return reportPath;
}

// CLI Setup
const program = new Command();

program
  .name('cleanupNavigationContent')
  .description('Clean navigational content from statute.txt files')
  .version('1.0.0');

program
  .command('analyze')
  .description('Analyze statute files for navigational content (dry run)')
  .action(async () => {
    try {
      const results = await processAllStatutes(true);
      
      if (results.length === 0) {
        console.log('\n✅ No navigational content found to clean');
        return;
      }
      
      const reportPath = await generateReport(results);
      
      const totalRemoved = results.reduce((sum, r) => sum + r.charactersRemoved, 0);
      const avgRemoved = totalRemoved / results.length;
      
      console.log('\n📊 Analysis Summary:');
      console.log(`• Files with navigation: ${results.length}`);
      console.log(`• Total characters to remove: ${totalRemoved.toLocaleString()}`);
      console.log(`• Average per file: ${avgRemoved.toFixed(0)} characters`);
      console.log(`• Report saved: ${reportPath}`);
      
    } catch (error) {
      console.error('❌ Analysis failed:', error.message);
      process.exit(1);
    }
  });

program
  .command('execute')
  .description('Execute the cleanup (DESTRUCTIVE - creates backups)')
  .action(async () => {
    try {
      console.log('⚠️  This will modify statute.txt files and create backups');
      
      const results = await processAllStatutes(false);
      
      if (results.length === 0) {
        console.log('\n✅ No files needed cleaning');
        return;
      }
      
      const reportPath = await generateReport(results);
      const totalRemoved = results.reduce((sum, r) => sum + r.charactersRemoved, 0);
      
      console.log('\n🎉 Cleanup Complete!');
      console.log(`• Files cleaned: ${results.length}`);
      console.log(`• Characters removed: ${totalRemoved.toLocaleString()}`);
      console.log(`• Report: ${reportPath}`);
      
    } catch (error) {
      console.error('❌ Cleanup failed:', error.message);
      process.exit(1);
    }
  });

// Export for testing
export { cleanStatuteFile, findMeaningfulContentStart, isNavigationalPattern };

if (import.meta.url === `file://${process.argv[1]}`) {
  program.parse();
}