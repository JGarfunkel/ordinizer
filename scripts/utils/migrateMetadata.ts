#!/usr/bin/env tsx

import fs from "fs-extra";
import path from "path";

interface OldMetadata {
  municipality?: string;
  municipalityType?: string;
  districtName?: string;
  entityId?: string;
  domain: string;
  domainId?: string;
  sourceUrl?: string;
  downloadedAt?: string;
  contentLength?: number;
  statuteTitle?: string;
  policyTitle?: string;
  sourceType?: string;
  originalCellValue?: string;
  stateCodeApplies?: boolean;
  referencesStateCode?: boolean;
  metadataCreated?: string;
  note?: string;
  lastCleanup?: string;
  originalHtmlLength?: number;
  sourceUrls?: any[];
  isArticleBased?: boolean;
  statuteNumber?: string;
  policyNumber?: string | null;
  lastConverted?: string;
  realm?: string;
  stateCodePath?: string;
  [key: string]: any;
}

interface Source {
  downloadedAt: string;
  contentLength: number;
  sourceUrl: string;
  title: string;
  type: "statute" | "policy";
}

interface NewMetadata {
  municipality?: string;
  municipalityType?: string;
  districtName?: string;
  entityId?: string;
  domain: string;
  domainId?: string;
  sources: Source[];
  // Preserve other fields that don't go into sources
  originalCellValue?: string;
  stateCodeApplies?: boolean;
  referencesStateCode?: boolean;
  metadataCreated?: string;
  note?: string;
  lastCleanup?: string;
  originalHtmlLength?: number;
  sourceUrls?: any[];
  isArticleBased?: boolean;
  statuteNumber?: string;
  policyNumber?: string | null;
  lastConverted?: string;
  realm?: string;
  stateCodePath?: string;
  [key: string]: any;
}

function getProjectDataDir(): string {
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  return path.join(scriptDir, "..", "..", "data");
}

async function findAllMetadataFiles(): Promise<string[]> {
  const dataDir = getProjectDataDir();
  const metadataFiles: string[] = [];
  
  async function searchRecursively(dir: string) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          await searchRecursively(fullPath);
        } else if (entry.name === "metadata.json") {
          metadataFiles.push(fullPath);
        }
      }
    } catch (error) {
      console.warn(`Warning: Could not read directory ${dir}: ${error.message}`);
    }
  }
  
  await searchRecursively(dataDir);
  return metadataFiles;
}

function determineType(metadata: OldMetadata): "statute" | "policy" {
  // Check if it's a school district (has districtName or entityId pattern)
  if (metadata.districtName || (metadata.entityId && metadata.entityId.includes("-CSD")) || 
      (metadata.entityId && metadata.entityId.includes("-UFSD")) || metadata.realm === "westchester-schools-sustainability") {
    return "policy";
  }
  
  // Check if it's municipal (has municipality field or municipality pattern)
  if (metadata.municipality || metadata.municipalityType) {
    return "statute";
  }
  
  // Default based on domain path structure
  return "statute";
}

function getTitle(metadata: OldMetadata): string {
  return metadata.statuteTitle || metadata.policyTitle || metadata.domain || "Unknown Document";
}

async function migrateMetadataFile(filePath: string, dryRun: boolean = false): Promise<boolean> {
  try {
    const oldMetadata: OldMetadata = await fs.readJson(filePath);
    
    // Check if already migrated (has sources array)
    if (oldMetadata.sources && Array.isArray(oldMetadata.sources)) {
      return false; // Already migrated
    }
    
    // Create new metadata with sources array
    const newMetadata: NewMetadata = { ...oldMetadata, sources: [] };
    
    // Remove fields that will go into sources
    delete newMetadata.sourceUrl;
    delete newMetadata.downloadedAt;
    delete newMetadata.contentLength;
    delete newMetadata.statuteTitle;
    delete newMetadata.policyTitle;
    delete newMetadata.sourceType;
    delete newMetadata.sourceUrls; // Remove to prevent duplication
    
    // Add primary source if it exists
    if (oldMetadata.sourceUrl) {
      // Use existing downloadedAt or fallback to metadataCreated or current time
      const downloadedAt = oldMetadata.downloadedAt || 
                          oldMetadata.metadataCreated || 
                          new Date().toISOString();
                          
      const source: Source = {
        downloadedAt,
        contentLength: oldMetadata.contentLength || 0,
        sourceUrl: oldMetadata.sourceUrl,
        title: getTitle(oldMetadata),
        type: determineType(oldMetadata)
      };
      newMetadata.sources.push(source);
    }
    
    // Add additional sources from sourceUrls if they exist
    if (oldMetadata.sourceUrls && Array.isArray(oldMetadata.sourceUrls)) {
      for (const sourceUrlObj of oldMetadata.sourceUrls) {
        if (sourceUrlObj.url) {
          // Use consistent fallback chain with runtime migration
          const downloadedAt = oldMetadata.downloadedAt || 
                              oldMetadata.metadataCreated || 
                              new Date().toISOString();
          
          const additionalSource: Source = {
            downloadedAt,
            contentLength: 0, // Unknown for article URLs
            sourceUrl: sourceUrlObj.url,
            title: sourceUrlObj.title || sourceUrlObj.text || "Article",
            type: determineType(oldMetadata)
          };
          newMetadata.sources.push(additionalSource);
        }
      }
    }
    
    // Deduplicate sources by URL (keep first occurrence)
    const seen = new Set<string>();
    newMetadata.sources = newMetadata.sources.filter(source => {
      if (seen.has(source.sourceUrl)) {
        return false;
      }
      seen.add(source.sourceUrl);
      return true;
    });
    
    if (!dryRun) {
      // Backup original file
      const backupPath = `${filePath}.backup.${Date.now()}`;
      await fs.copy(filePath, backupPath);
      
      // Write new metadata
      await fs.writeJson(filePath, newMetadata, { spaces: 2 });
    }
    
    return true; // Successfully migrated
  } catch (error) {
    console.error(`Error migrating ${filePath}: ${error.message}`);
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const verbose = args.includes("--verbose");
  
  console.log("🔄 Migrating metadata.json files to new sources format...");
  if (dryRun) {
    console.log("🔍 DRY RUN MODE - No files will be modified");
  }
  
  const metadataFiles = await findAllMetadataFiles();
  console.log(`📁 Found ${metadataFiles.length} metadata.json files`);
  
  let migratedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  
  for (const filePath of metadataFiles) {
    const relativePath = path.relative(getProjectDataDir(), filePath);
    
    try {
      const migrated = await migrateMetadataFile(filePath, dryRun);
      
      if (migrated) {
        migratedCount++;
        if (verbose || dryRun) {
          console.log(`✅ ${dryRun ? 'Would migrate' : 'Migrated'}: ${relativePath}`);
        }
      } else {
        skippedCount++;
        if (verbose) {
          console.log(`⏭️  Skipped (already migrated): ${relativePath}`);
        }
      }
    } catch (error) {
      errorCount++;
      console.error(`❌ Error processing ${relativePath}: ${error.message}`);
    }
  }
  
  console.log("\n📊 Migration Summary:");
  console.log(`  ✅ ${dryRun ? 'Would migrate' : 'Migrated'}: ${migratedCount} files`);
  console.log(`  ⏭️  Skipped: ${skippedCount} files`);
  console.log(`  ❌ Errors: ${errorCount} files`);
  
  if (!dryRun && migratedCount > 0) {
    console.log(`\n💾 Original files backed up with .backup.{timestamp} extension`);
  }
  
  if (dryRun && migratedCount > 0) {
    console.log(`\n🚀 Run without --dry-run to perform the actual migration`);
  }
}

// Run if this script is executed directly
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch(console.error);
}