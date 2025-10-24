#!/usr/bin/env tsx
/**
 * Remove duplicate municipality directories with incorrect naming
 * 
 * Removes HastingsonHudson-Village and CrotononHudson-Village directories
 * since the correct versions are Hastings-on-Hudson-Village and Croton-on-Hudson-Village
 */

import fs from 'fs-extra';
import path from 'path';

interface CleanupStats {
  directoriesFound: number;
  directoriesRemoved: number;
  errors: string[];
}

async function cleanupDuplicateDirectories(dryRun: boolean = false): Promise<CleanupStats> {
  const stats: CleanupStats = {
    directoriesFound: 0,
    directoriesRemoved: 0,
    errors: []
  };

  const dataDir = path.join(process.cwd(), '..', 'data');
  
  console.log('🔍 Scanning for duplicate municipality directories...');
  console.log(`${dryRun ? '🔧 DRY RUN MODE - No directories will be removed' : '🗑️  REMOVAL MODE - Directories will be deleted'}`);
  console.log();

  // Get all domain directories
  const domains = await fs.readdir(dataDir);
  
  for (const domain of domains) {
    const domainPath = path.join(dataDir, domain);
    const stat = await fs.stat(domainPath);
    
    if (!stat.isDirectory()) continue;
    if (domain.endsWith('.json') || domain.endsWith('.csv')) continue;

    console.log(`📂 Checking domain: ${domain}`);
    
    try {
      const municipalities = await fs.readdir(domainPath);
      
      for (const municipality of municipalities) {
        // Check for the incorrect directory names
        if (municipality === 'NY-HastingsonHudson-Village' || municipality === 'NY-CrotononHudson-Village') {
          const municipalityPath = path.join(domainPath, municipality);
          stats.directoriesFound++;
          
          console.log(`  🎯 Found duplicate: ${municipality}`);
          
          // Check if the correct version exists
          const correctName = municipality === 'NY-HastingsonHudson-Village' 
            ? 'NY-Hastings-on-Hudson-Village'
            : 'NY-Croton-on-Hudson-Village';
          const correctPath = path.join(domainPath, correctName);
          const correctExists = await fs.pathExists(correctPath);
          
          console.log(`    ✓ Correct version (${correctName}) exists: ${correctExists}`);
          
          if (correctExists) {
            // List contents of the duplicate directory
            try {
              const contents = await fs.readdir(municipalityPath);
              console.log(`    📄 Contents: ${contents.join(', ')}`);
              
              if (!dryRun) {
                await fs.remove(municipalityPath);
                console.log(`    ✅ Removed duplicate directory`);
                stats.directoriesRemoved++;
              } else {
                console.log(`    💡 Would remove this directory (dry run)`);
              }
            } catch (error) {
              const errorMsg = `Failed to process ${municipality}: ${error}`;
              console.error(`    ❌ ${errorMsg}`);
              stats.errors.push(errorMsg);
            }
          } else {
            console.log(`    ⚠️  Keeping ${municipality} since correct version doesn't exist`);
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
  console.log(`Duplicate directories found: ${stats.directoriesFound}`);
  console.log(`Directories ${dryRun ? 'to be removed' : 'removed'}: ${stats.directoriesRemoved}`);
  console.log(`Errors encountered: ${stats.errors.length}`);
  
  if (stats.errors.length > 0) {
    console.log('\n❌ ERRORS:');
    stats.errors.forEach(error => console.log(`  • ${error}`));
  }

  if (dryRun && stats.directoriesFound > 0) {
    console.log('\n💡 To actually remove the directories, run without --dry-run flag');
  }
}

function showHelp(): void {
  console.log(`
🗑️  Duplicate Municipality Directory Cleanup

This script removes incorrectly named municipality directories that are duplicates
of the properly named versions with dashes.

Target directories:
  - NY-HastingsonHudson-Village  → Remove (keep NY-Hastings-on-Hudson-Village)
  - NY-CrotononHudson-Village    → Remove (keep NY-Croton-on-Hudson-Village)

Usage:
  tsx scripts/cleanupDuplicateDirectories.ts [options]

Options:
  --dry-run, -d    Preview what would be removed (recommended first)
  --help, -h       Show this help message

Examples:
  tsx scripts/cleanupDuplicateDirectories.ts --dry-run
  tsx scripts/cleanupDuplicateDirectories.ts

Safety:
  - Only removes directories if the correct version exists
  - Shows directory contents before removal
  - Comprehensive error handling and reporting
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  let dryRun = false;

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      showHelp();
      return;
    } else if (arg === '--dry-run' || arg === '-d') {
      dryRun = true;
    } else {
      console.error(`Unknown argument: ${arg}`);
      showHelp();
      process.exit(1);
    }
  }

  try {
    const stats = await cleanupDuplicateDirectories(dryRun);
    printStats(stats, dryRun);
    
    if (!dryRun && stats.directoriesRemoved > 0) {
      console.log('\n✅ Cleanup completed successfully!');
    }
  } catch (error) {
    console.error('❌ Failed to run cleanup:', error);
    process.exit(1);
  }
}

main();