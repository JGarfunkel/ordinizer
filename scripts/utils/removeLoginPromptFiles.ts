#!/usr/bin/env tsx
/**
 * Remove statute files that contain "Request a Municipal Login" text
 * 
 * Scans all municipality directories across all domains and removes
 * statute.html and statute.txt files that contain login prompts
 * instead of actual statute content.
 */

import fs from 'fs-extra';
import path from 'path';

interface CleanupStats {
  directoriesScanned: number;
  filesScanned: number;
  filesRemoved: number;
  loginFilesFound: number;
  errors: string[];
}

async function removeLoginPromptFiles(dryRun: boolean = false, verbose: boolean = false): Promise<CleanupStats> {
  const stats: CleanupStats = {
    directoriesScanned: 0,
    filesScanned: 0,
    filesRemoved: 0,
    loginFilesFound: 0,
    errors: []
  };

  const dataDir = path.join(process.cwd(), '..', 'data');
  
  console.log('🔍 Scanning for files containing "Request a Municipal Login"...');
  console.log(`${dryRun ? '🔧 DRY RUN MODE - No files will be removed' : '🗑️  REMOVAL MODE - Files will be deleted'}`);
  console.log();

  // Get all domain directories
  const domains = await fs.readdir(dataDir);
  
  for (const domain of domains) {
    const domainPath = path.join(dataDir, domain);
    const stat = await fs.stat(domainPath);
    
    if (!stat.isDirectory()) continue;
    if (domain.endsWith('.json') || domain.endsWith('.csv')) continue;

    if (verbose) console.log(`📂 Checking domain: ${domain}`);
    
    try {
      const municipalities = await fs.readdir(domainPath);
      
      for (const municipality of municipalities) {
        if (!municipality.startsWith('NY-') || municipality === 'NY-State') continue;
        
        const municipalityPath = path.join(domainPath, municipality);
        const municipalityStat = await fs.stat(municipalityPath);
        
        if (!municipalityStat.isDirectory()) continue;
        
        stats.directoriesScanned++;
        if (verbose) console.log(`  📁 Checking: ${municipality}`);
        
        // Check both statute.html and statute.txt files
        const filesToCheck = ['statute.html', 'statute.txt'];
        
        for (const filename of filesToCheck) {
          const filePath = path.join(municipalityPath, filename);
          
          if (await fs.pathExists(filePath)) {
            stats.filesScanned++;
            
            try {
              const content = await fs.readFile(filePath, 'utf-8');
              
              // Check for login prompt text (case insensitive)
              const hasLoginPrompt = content.toLowerCase().includes('request a municipal login');
              
              if (hasLoginPrompt) {
                stats.loginFilesFound++;
                console.log(`    🎯 Found login prompt in ${municipality}/${filename}`);
                
                // Show some context around the login prompt
                const loginIndex = content.toLowerCase().indexOf('request a municipal login');
                const contextStart = Math.max(0, loginIndex - 50);
                const contextEnd = Math.min(content.length, loginIndex + 100);
                const context = content.substring(contextStart, contextEnd).replace(/\s+/g, ' ');
                console.log(`    📄 Context: ...${context}...`);
                
                if (!dryRun) {
                  await fs.remove(filePath);
                  console.log(`    ✅ Removed ${filename} (${content.length} bytes)`);
                  stats.filesRemoved++;
                } else {
                  console.log(`    💡 Would remove ${filename} (${content.length} bytes, dry run)`);
                }
              } else if (verbose) {
                console.log(`    ✓ ${filename} is clean (${content.length} bytes)`);
              }
            } catch (error) {
              const errorMsg = `Failed to read ${municipality}/${filename}: ${error}`;
              console.error(`    ❌ ${errorMsg}`);
              stats.errors.push(errorMsg);
            }
          } else if (verbose) {
            console.log(`    - ${filename} not found`);
          }
        }
      }
    } catch (error) {
      const errorMsg = `Failed to read domain ${domain}: ${error}`;
      console.error(`  ❌ ${errorMsg}`);
      stats.errors.push(errorMsg);
    }
  }

  return stats;
}

function printStats(stats: CleanupStats, dryRun: boolean): void {
  console.log('\n📊 CLEANUP SUMMARY');
  console.log('═'.repeat(50));
  console.log(`Municipality directories scanned: ${stats.directoriesScanned}`);
  console.log(`Total files scanned: ${stats.filesScanned}`);
  console.log(`Files with login prompts found: ${stats.loginFilesFound}`);
  console.log(`Files ${dryRun ? 'to be removed' : 'removed'}: ${stats.filesRemoved}`);
  console.log(`Errors encountered: ${stats.errors.length}`);
  
  if (stats.errors.length > 0) {
    console.log('\n❌ ERRORS:');
    stats.errors.forEach(error => console.log(`  • ${error}`));
  }

  if (dryRun && stats.loginFilesFound > 0) {
    console.log('\n💡 To actually remove the files, run without --dry-run flag');
  }
  
  if (stats.filesRemoved > 0) {
    console.log('\n⚠️  Note: You may want to re-download statutes for affected municipalities');
  }
}

function showHelp(): void {
  console.log(`
🗑️  Municipal Login Prompt File Cleanup

This script removes statute.html and statute.txt files that contain
"Request a Municipal Login" text instead of actual statute content.

These files typically indicate that the municipality website requires
authentication to access the statute content, resulting in login pages
being downloaded instead of the actual legal text.

Usage:
  tsx scripts/removeLoginPromptFiles.ts [options]

Options:
  --dry-run, -d    Preview what would be removed (recommended first)
  --verbose, -v    Show detailed output for all files checked
  --help, -h       Show this help message

Examples:
  # Preview what would be removed with detailed output
  tsx scripts/removeLoginPromptFiles.ts --dry-run --verbose

  # Actually remove the login prompt files
  tsx scripts/removeLoginPromptFiles.ts

  # Quick scan without verbose output
  tsx scripts/removeLoginPromptFiles.ts --dry-run

Target Pattern:
  - Searches for "Request a Municipal Login" (case insensitive)
  - Removes both statute.html and statute.txt files containing this text
  - Preserves all other files in the municipality directories

Safety Features:
  - Shows file context around login prompt before removal
  - Comprehensive error handling and reporting
  - Dry-run mode for safe preview
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  let dryRun = false;
  let verbose = false;

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      showHelp();
      return;
    } else if (arg === '--dry-run' || arg === '-d') {
      dryRun = true;
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else {
      console.error(`Unknown argument: ${arg}`);
      showHelp();
      process.exit(1);
    }
  }

  try {
    const stats = await removeLoginPromptFiles(dryRun, verbose);
    printStats(stats, dryRun);
    
    if (!dryRun && stats.filesRemoved > 0) {
      console.log('\n✅ Cleanup completed successfully!');
      console.log('💡 Consider re-running extractFromGoogleSheets.ts for affected municipalities');
    }
  } catch (error) {
    console.error('❌ Failed to run cleanup:', error);
    process.exit(1);
  }
}

main();