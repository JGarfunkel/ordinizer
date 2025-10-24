#!/usr/bin/env tsx
/**
 * Utility to clean up incorrectly downloaded NY State Property Maintenance Code files
 * 
 * This script removes statute files that contain the generic NY State Property Maintenance Code
 * instead of municipality-specific property maintenance ordinances.
 * 
 * Target pattern:
 * - Files starting with: <!DOCTYPE html><html><head><meta charSet="UTF-8"/><title>New York State Property Maintenance Code 2020 based on the International Property Maintenance Code 2018
 * 
 * Usage:
 *   tsx scripts/cleanupNYStateFiles.ts [--dry-run] [--verbose]
 */

import fs from 'fs-extra';
import path from 'path';

interface CleanupStats {
  municipalitiesScanned: number;
  htmlFilesDeleted: number;
  txtFilesDeleted: number;
  filesSkipped: number;
  errors: string[];
}

const TARGET_STRING = '<!DOCTYPE html><html><head><meta charSet="UTF-8"/><title>New York State Property Maintenance Code 2020 based on the International Property Maintenance Code 2018';

async function cleanupNYStateFiles(dryRun: boolean = false, verbose: boolean = false): Promise<CleanupStats> {
  const stats: CleanupStats = {
    municipalitiesScanned: 0,
    htmlFilesDeleted: 0,
    txtFilesDeleted: 0,
    filesSkipped: 0,
    errors: []
  };

  const propertyMaintenanceDir = path.join(process.cwd(), '..', 'data', 'property-maintenance');
  
  if (!await fs.pathExists(propertyMaintenanceDir)) {
    throw new Error(`Property maintenance directory not found: ${propertyMaintenanceDir}`);
  }

  console.log(`🔍 Scanning property-maintenance directory: ${propertyMaintenanceDir}`);
  console.log(`${dryRun ? '🔧 DRY RUN MODE - No files will be deleted' : '⚠️  DELETION MODE - Files will be permanently removed'}`);
  console.log();

  const municipalities = await fs.readdir(propertyMaintenanceDir);
  
  for (const municipality of municipalities) {
    // Skip non-directory entries and NY-State directory
    if (municipality === 'NY-State' || municipality === 'questions.json') {
      if (verbose) console.log(`⏭️  Skipping: ${municipality}`);
      continue;
    }

    const municipalityPath = path.join(propertyMaintenanceDir, municipality);
    const municipalityStat = await fs.stat(municipalityPath);
    
    if (!municipalityStat.isDirectory()) {
      if (verbose) console.log(`⏭️  Skipping non-directory: ${municipality}`);
      continue;
    }

    stats.municipalitiesScanned++;
    console.log(`📂 Checking: ${municipality}`);

    const htmlPath = path.join(municipalityPath, 'statute.html');
    const txtPath = path.join(municipalityPath, 'statute.txt');

    try {
      // Check statute.html
      if (await fs.pathExists(htmlPath)) {
        const htmlContent = await fs.readFile(htmlPath, 'utf8');
        if (htmlContent.startsWith(TARGET_STRING)) {
          console.log(`  🗑️  statute.html contains NY State code - ${dryRun ? 'WOULD DELETE' : 'DELETING'}`);
          if (!dryRun) {
            await fs.remove(htmlPath);
          }
          stats.htmlFilesDeleted++;
        } else {
          if (verbose) console.log(`  ✅ statute.html appears to be municipality-specific`);
          stats.filesSkipped++;
        }
      } else {
        if (verbose) console.log(`  ⚪ No statute.html found`);
      }

      // Check statute.txt
      if (await fs.pathExists(txtPath)) {
        const txtContent = await fs.readFile(txtPath, 'utf8');
        if (txtContent.startsWith(TARGET_STRING)) {
          console.log(`  🗑️  statute.txt contains NY State code - ${dryRun ? 'WOULD DELETE' : 'DELETING'}`);
          if (!dryRun) {
            await fs.remove(txtPath);
          }
          stats.txtFilesDeleted++;
        } else {
          if (verbose) console.log(`  ✅ statute.txt appears to be municipality-specific`);
          stats.filesSkipped++;
        }
      } else {
        if (verbose) console.log(`  ⚪ No statute.txt found`);
      }

    } catch (error) {
      const errorMsg = `Error processing ${municipality}: ${error}`;
      console.error(`  ❌ ${errorMsg}`);
      stats.errors.push(errorMsg);
    }
  }

  return stats;
}

function printStats(stats: CleanupStats, dryRun: boolean): void {
  console.log('\n📊 CLEANUP SUMMARY');
  console.log('═'.repeat(50));
  console.log(`Municipalities scanned: ${stats.municipalitiesScanned}`);
  console.log(`HTML files ${dryRun ? 'to be deleted' : 'deleted'}: ${stats.htmlFilesDeleted}`);
  console.log(`TXT files ${dryRun ? 'to be deleted' : 'deleted'}: ${stats.txtFilesDeleted}`);
  console.log(`Files skipped (municipality-specific): ${stats.filesSkipped}`);
  console.log(`Errors encountered: ${stats.errors.length}`);
  
  if (stats.errors.length > 0) {
    console.log('\n❌ ERRORS:');
    stats.errors.forEach(error => console.log(`  • ${error}`));
  }

  if (dryRun && (stats.htmlFilesDeleted > 0 || stats.txtFilesDeleted > 0)) {
    console.log('\n💡 To actually delete the files, run without --dry-run flag');
  }
}

function showHelp(): void {
  console.log(`
🧹 NY State Property Maintenance Code Cleanup Utility

This script removes statute files that contain the generic NY State Property 
Maintenance Code instead of municipality-specific ordinances.

Usage:
  tsx scripts/cleanupNYStateFiles.ts [options]

Options:
  --dry-run, -d     Preview what would be deleted without actually removing files
  --verbose, -v     Show detailed output for all files checked
  --help, -h        Show this help message

Examples:
  tsx scripts/cleanupNYStateFiles.ts --dry-run --verbose
  tsx scripts/cleanupNYStateFiles.ts --dry-run
  tsx scripts/cleanupNYStateFiles.ts

Target Pattern:
  Files starting with: <!DOCTYPE html><html><head><meta charSet="UTF-8"/><title>New York State Property Maintenance Code 2020 based on the International Property Maintenance Code 2018
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
    const stats = await cleanupNYStateFiles(dryRun, verbose);
    printStats(stats, dryRun);
    
    if (!dryRun && (stats.htmlFilesDeleted > 0 || stats.txtFilesDeleted > 0)) {
      console.log('\n✅ Cleanup completed successfully!');
    }
  } catch (error) {
    console.error('❌ Failed to run cleanup:', error);
    process.exit(1);
  }
}

// Run main function if this file is executed directly
main();