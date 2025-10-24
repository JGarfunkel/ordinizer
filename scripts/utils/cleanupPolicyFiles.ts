#!/usr/bin/env tsx

import fs from "fs-extra";
import path from "path";
import { glob } from "glob";

interface CleanupStats {
  directoriesProcessed: number;
  policyFilesDeleted: number;
  policiesJsonDeleted: number;
  binaryHtmlDeleted: number;
  binaryTxtDeleted: number;
}

/**
 * Check if a file contains binary PDF data
 */
async function isBinaryPdfFile(filePath: string): Promise<boolean> {
  try {
    // Read first 4 bytes to check for PDF signature
    const buffer = Buffer.alloc(4);
    const fileStats = await fs.stat(filePath);
    
    if (fileStats.size < 4) {
      return false; // File too small to be a PDF
    }
    
    // Read first 4 bytes of the file
    const fileData = await fs.readFile(filePath, { encoding: null });
    const pdfSignature = fileData.subarray(0, 4).toString('ascii');
    
    // Check for PDF signature "%PDF"
    return pdfSignature === '%PDF';
  } catch (error) {
    console.warn(`  ⚠️  Could not check file ${filePath}: ${error.message}`);
    return false;
  }
}

/**
 * Clean up policy files in a single directory
 */
async function cleanupDirectory(dirPath: string): Promise<Partial<CleanupStats>> {
  const stats: Partial<CleanupStats> = {
    policyFilesDeleted: 0,
    policiesJsonDeleted: 0,
    binaryHtmlDeleted: 0,
    binaryTxtDeleted: 0,
  };

  console.log(`  🧹 Cleaning: ${dirPath}`);

  try {
    const files = await fs.readdir(dirPath);
    
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const fileStats = await fs.stat(filePath);
      
      // Skip subdirectories
      if (fileStats.isDirectory()) continue;
      
      // Delete policy-* files
      if (file.startsWith('policy-')) {
        await fs.remove(filePath);
        stats.policyFilesDeleted!++;
        console.log(`    🗑️  Deleted: ${file}`);
      }
      
      // Delete policies.json
      if (file === 'policies.json') {
        await fs.remove(filePath);
        stats.policiesJsonDeleted!++;
        console.log(`    🗑️  Deleted: ${file}`);
      }
      
      // Check policy.html for binary PDF content
      if (file === 'policy.html') {
        if (await isBinaryPdfFile(filePath)) {
          await fs.remove(filePath);
          stats.binaryHtmlDeleted!++;
          console.log(`    🗑️  Deleted binary PDF content: ${file}`);
        }
      }
      
      // Check policy.txt for binary PDF content
      if (file === 'policy.txt') {
        if (await isBinaryPdfFile(filePath)) {
          await fs.remove(filePath);
          stats.binaryTxtDeleted!++;
          console.log(`    🗑️  Deleted binary PDF content: ${file}`);
        }
      }
    }
    
  } catch (error) {
    console.warn(`  ⚠️  Error processing directory ${dirPath}: ${error.message}`);
  }

  return stats;
}

/**
 * Find all policy directories and clean them up
 */
async function cleanupPolicyDirectories(basePath: string): Promise<CleanupStats> {
  console.log(`🔍 Searching for policy directories in: ${basePath}`);
  
  const stats: CleanupStats = {
    directoriesProcessed: 0,
    policyFilesDeleted: 0,
    policiesJsonDeleted: 0,
    binaryHtmlDeleted: 0,
    binaryTxtDeleted: 0,
  };

  try {
    // Find all directories that contain policy files or metadata.json (indicating entity directories)
    const pattern = path.join(basePath, '**/metadata.json').replace(/\\/g, '/');
    const metadataFiles = await glob(pattern, { ignore: ['**/node_modules/**'] });
    
    for (const metadataFile of metadataFiles) {
      const dirPath = path.dirname(metadataFile);
      
      const dirStats = await cleanupDirectory(dirPath);
      
      // Aggregate stats
      stats.directoriesProcessed++;
      stats.policyFilesDeleted += dirStats.policyFilesDeleted || 0;
      stats.policiesJsonDeleted += dirStats.policiesJsonDeleted || 0;
      stats.binaryHtmlDeleted += dirStats.binaryHtmlDeleted || 0;
      stats.binaryTxtDeleted += dirStats.binaryTxtDeleted || 0;
    }
    
  } catch (error) {
    console.error(`❌ Error searching for directories: ${error.message}`);
  }

  return stats;
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log('Policy Files Cleanup Utility');
    console.log('');
    console.log('Usage:');
    console.log('  tsx scripts/utils/cleanupPolicyFiles.ts [path]');
    console.log('');
    console.log('Parameters:');
    console.log('  path    Base path to search for policy directories (default: ./data)');
    console.log('');
    console.log('This utility will:');
    console.log('  • Delete all files matching pattern "policy-*"');
    console.log('  • Delete "policies.json" files');
    console.log('  • Delete "policy.html" and "policy.txt" files that contain binary PDF data');
    console.log('');
    console.log('Examples:');
    console.log('  tsx scripts/utils/cleanupPolicyFiles.ts');
    console.log('  tsx scripts/utils/cleanupPolicyFiles.ts ./data/environmental-schools');
    return;
  }

  const basePath = args[0] || './data';
  
  console.log('🧹 Policy Files Cleanup Utility');
  console.log('================================');
  console.log();

  // Check if base path exists
  try {
    const pathStats = await fs.stat(basePath);
    if (!pathStats.isDirectory()) {
      console.error(`❌ Error: ${basePath} is not a directory`);
      process.exit(1);
    }
  } catch {
    console.error(`❌ Error: ${basePath} does not exist`);
    process.exit(1);
  }

  console.log(`Starting cleanup in: ${path.resolve(basePath)}`);
  console.log();

  const startTime = Date.now();
  const stats = await cleanupPolicyDirectories(basePath);
  const duration = Date.now() - startTime;

  console.log();
  console.log('📊 Cleanup Summary');
  console.log('==================');
  console.log(`Directories processed: ${stats.directoriesProcessed}`);
  console.log(`Policy-* files deleted: ${stats.policyFilesDeleted}`);
  console.log(`policies.json files deleted: ${stats.policiesJsonDeleted}`);
  console.log(`Binary policy.html files deleted: ${stats.binaryHtmlDeleted}`);
  console.log(`Binary policy.txt files deleted: ${stats.binaryTxtDeleted}`);
  console.log(`Total files deleted: ${stats.policyFilesDeleted + stats.policiesJsonDeleted + stats.binaryHtmlDeleted + stats.binaryTxtDeleted}`);
  console.log(`Duration: ${duration}ms`);
  
  if (stats.directoriesProcessed === 0) {
    console.log();
    console.log('⚠️  No policy directories found. Make sure the path contains entity directories with metadata.json files.');
  } else {
    console.log();
    console.log('✅ Cleanup completed successfully!');
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}