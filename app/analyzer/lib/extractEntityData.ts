#!/usr/bin/env tsx

import fs from "fs-extra";
import path from "path";

// ─── Re-exports for backward compatibility ───────────────────────────────────
// These 7 symbols were previously exported from this file.

import {
  verboseLog,
  setVerboseMode,
  getProjectDataDir,
  getProjectRootDir,
  getSpreadsheetUrl,
  loadRealmsConfig,
  getRealmById,
  getDefaultRealm,
  findSimilarFlags,
} from "./extractionConfig.js";

import {
  initializeLogging,
  logToFile,
  closeLogging,
  validateEntityRelevance,
  cleanupInvalidStatute,
  pdfFormToText,
} from "./extractionUtils.js";

import {
  extractGoogleSheetsAsCsv,
  extractGoogleSheetsWithHyperlinks,
  convertSchoolDistrictJsonToCsv,
  parseAndWriteEntities,
} from "./sheetExtractor.js";

import {
  downloadEntitySources,
  createMissingMetadataFiles,
  createDirectoryStructureFromJSON,
  runCleanupMode,
} from "./sourceDownloader.js";

export {
  extractGoogleSheetsAsCsv,
  extractGoogleSheetsWithHyperlinks,
  processSpreadsheetData,
  verboseLog,
  validateEntityRelevance,
  cleanupInvalidStatute,
  runCleanupMode,
};

// ─── processSpreadsheetData (orchestrator) ───────────────────────────────────

async function processSpreadsheetData(
  csvData: string,
  hyperlinkData: Record<string, Record<string, string>> = {},
  realm: any,
  targetDomain?: string,
  municipalityFilter?: string,
  forceMode: boolean = false,
  noDownloadMode: boolean = false,
  noDeleteMode: boolean = false,
  verbose: boolean = false,
  entitiesToInclude?: Set<string>,
  reloadMode: boolean = false,
): Promise<void> {
  // Phase 1: Parse CSV/API data, create entity files and domains.json
  const { rows, headers, columnMap, domainsToProcess } =
    await parseAndWriteEntities(csvData, realm, targetDomain, entitiesToInclude, verbose);

  if (domainsToProcess.length === 0) return;

  // Phase 2: Per-entity download loop
  await downloadEntitySources(rows, realm, hyperlinkData, headers, columnMap, domainsToProcess, {
    targetDomain,
    municipalityFilter,
    forceMode,
    noDownloadMode,
    noDeleteMode,
    verbose,
    entitiesToInclude,
    reloadMode,
  });
}

// ─── CLI entry point ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Spreadsheet URL from domainConf.json
  const spreadsheetUrl = getSpreadsheetUrl();

  // Define valid flags for validation
  const validFlags = [
    "--domain",
    "--municipality-filter",
    "--realm",
    "--verbose",
    "-v",
    "--force",
    "--nodownload",
    "--nodelete",
    "--cleanup",
    "--reload",
    "--help",
    "-h",
  ];

  // Check for unknown flags starting with --
  const unknownFlags = args.filter(
    (arg) =>
      arg.startsWith("--") &&
      !validFlags.some(
        (validFlag) => arg === validFlag || arg.startsWith(validFlag + "="),
      ),
  );

  if (unknownFlags.length > 0) {
    console.error(
      `Error: Unknown parameter flag(s): ${unknownFlags.join(", ")}`,
    );
    console.error("");

    unknownFlags.forEach((unknownFlag) => {
      const flagName = unknownFlag.split("=")[0];
      const suggestions = findSimilarFlags(flagName, validFlags);

      if (suggestions.length > 0) {
        console.error(`Did you mean one of these?`);
        suggestions.forEach((suggestion) => {
          console.error(`  ${suggestion}`);
        });
      }
    });

    console.error("");
    console.error("Use --help or -h to see all available options.");
    process.exit(1);
  }

  // Parse arguments
  let targetDomain: string | undefined;
  let municipalityFilter: string | undefined;
  let forceMode = false;
  let noDownloadMode = false;
  let noDeleteMode = false;
  let cleanupMode = false;
  let entitiesToInclude: Set<string> | undefined;

  const VERBOSE_MODE = args.includes("--verbose") || args.includes("-v");
  setVerboseMode(VERBOSE_MODE);
  if (VERBOSE_MODE) {
    console.log(
      "Verbose mode enabled - HTTP requests and responses will be logged",
    );
  }

  forceMode = args.includes("--force");
  if (forceMode) {
    console.log(
      "Force mode enabled - will redownload files even if they exist and are recent",
    );
  }

  noDownloadMode = args.includes("--nodownload");
  if (noDownloadMode) {
    console.log(
      "No download mode enabled - will validate existing files without downloading new ones",
    );
  }

  noDeleteMode = args.includes("--nodelete");
  if (noDeleteMode) {
    console.log(
      "No delete mode enabled - will report validation issues but not delete files",
    );
  }

  const reloadMode = args.includes("--reload");
  if (reloadMode) {
    console.log(
      "Reload mode enabled - will reload entity data from source instead of reusing existing metadata.json",
    );
  }

  cleanupMode = args.includes("--cleanup");
  if (cleanupMode) {
    console.log(
      "Cleanup mode enabled - will regenerate statute.txt files and remove backups",
    );
    if (forceMode) {
      console.log(
        "Force cleanup mode - will regenerate from existing HTML without re-downloading",
      );
    }
  }

  const domainArg = args.find((arg) => arg.startsWith("--domain="));
  if (domainArg) {
    targetDomain = domainArg.split("=")[1];
  }

  const municipalityFilterArg = args.find((arg) =>
    arg.startsWith("--municipality-filter="),
  );
  if (municipalityFilterArg) {
    municipalityFilter = municipalityFilterArg.split("=")[1];
    if (VERBOSE_MODE) {
      console.log(`Entity filter enabled: ${municipalityFilter}`);
    }
  }

  // Check for realm parameter - first check environment variable, then command line
  let targetRealm: string | null = null;
  
  if (process.env.CURRENT_REALM) {
    targetRealm = process.env.CURRENT_REALM;
    console.log(`📖 Read CURRENT_REALM environment variable: ${targetRealm}`);
  }
  
  const realmArg = args.find((arg) => arg.startsWith("--realm="));
  if (realmArg) {
    targetRealm = realmArg.split("=")[1];
    process.env.CURRENT_REALM = targetRealm;
    console.log(`💾 Set CURRENT_REALM environment variable from --realm parameter: ${targetRealm}`);
    if (VERBOSE_MODE) {
      console.log(`Target realm: ${targetRealm}`);
    }
  } else {
    const realmIndex = args.findIndex((arg) => arg === "--realm");
    if (realmIndex !== -1 && realmIndex + 1 < args.length) {
      targetRealm = args[realmIndex + 1];
      process.env.CURRENT_REALM = targetRealm;
      console.log(`💾 Set CURRENT_REALM environment variable from --realm parameter: ${targetRealm}`);
      if (VERBOSE_MODE) {
        console.log(`Target realm: ${targetRealm}`);
      }
    }
  }

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage:
  tsx scripts/extractEntityData.ts [google-sheets-url|csv-file-path] [options]

Parameters:
  google-sheets-url    Google Sheets URL to extract from
  csv-file-path        Local CSV file path

Options:
  --realm=<realm-id>             Target realm (use realm IDs from realms.json)
  --domain=<domain>              Extract only specified domain (Trees, GLB, 'Wetland Protection', 'Dark Sky')
  --municipality-filter=<names>  Filter by entity names (comma-separated)
  --verbose, -v                  Enable verbose logging (shows HTTP requests and responses)
  --force                        Force redownload files even if they exist and are recent
  --nodownload                   Skip downloads, only validate existing statute files
  --nodelete                     Skip deleting invalid files, only report validation issues
  --cleanup                      Cleanup mode: regenerate statute.txt files, remove backups, detect binary data
  --cleanup --force              Force cleanup: regenerate statute.txt from existing HTML without re-downloading
  --reload                       Reload entity data from source instead of reusing existing metadata.json
  --help, -h                     Show this help message

If no URL is provided, the script uses the URL configured in spreadsheetExtractionProperties.json.
The script automatically checks for and creates missing metadata.json files for existing statute files.

Examples:
  tsx scripts/extractEntityData.ts '${spreadsheetUrl}' --verbose
  tsx scripts/extractEntityData.ts --domain=Trees -v
  tsx scripts/extractEntityData.ts --domain=GLB
  tsx scripts/extractEntityData.ts --realm=<realm-id> --domain=overall -v
  tsx scripts/extractEntityData.ts '${spreadsheetUrl}' --domain='Wetland Protection' --verbose
  tsx scripts/extractEntityData.ts --domain='Property Maintenance' --municipality-filter='<name1>,<name2>' -v
  tsx scripts/extractEntityData.ts ./data/source/municipalities.csv --domain=Trees -v
  tsx scripts/extractEntityData.ts --force --domain=Trees
  tsx scripts/extractEntityData.ts --nodownload --domain=Trees
  tsx scripts/extractEntityData.ts --nodelete --domain=Trees
  tsx scripts/extractEntityData.ts --cleanup --domain=Trees
  tsx scripts/extractEntityData.ts --cleanup --force --domain=Trees
  tsx scripts/extractEntityData.ts --reload --domain=Trees
  tsx scripts/extractEntityData.ts                                  # Uses configured spreadsheet
`.trimStart());
    process.exit(0);
  }

  // Load realms configuration
  const realmsConfig = await loadRealmsConfig();
  let selectedRealm = targetRealm
    ? getRealmById(targetRealm, realmsConfig)
    : getDefaultRealm(realmsConfig);

  if (!selectedRealm) {
    if (targetRealm) {
      console.error(`Error: Realm '${targetRealm}' not found.`);
      console.log('Available realms:');
      realmsConfig.realms.forEach((realm: any) => {
        console.log(`  • ${realm.id}: ${realm.displayName}`);
      });
    } else {
      console.error('Error: No default realm found and no realm specified.');
    }
    process.exit(1);
  }

  // Parse entity filter if provided
  if (municipalityFilter) {
    entitiesToInclude = new Set(
      municipalityFilter.split(",").map((m) => m.trim().toLowerCase()),
    );
    console.log(
      `${selectedRealm.entityType} filter active: ${Array.from(entitiesToInclude).join(", ")}`,
    );
  }

  console.log(`Using realm: ${selectedRealm.displayName} (${selectedRealm.id})`);
  console.log(`Data path: data/${selectedRealm.datapath}`);
  console.log(`File type: ${selectedRealm.type}`);

  // Initialize logging
  initializeLogging();

  try {
    if (cleanupMode) {
      await runCleanupMode(selectedRealm, targetDomain, municipalityFilter, forceMode);
    } else {
      let csvData: string;
      let hyperlinkData: Record<string, Record<string, string>> = {};

      if (selectedRealm.dataSource.type === 'google-sheets') {
        if (!selectedRealm.dataSource.url) {
          throw new Error(`Google Sheets URL not configured for realm ${selectedRealm.id}`);
        }
        if (reloadMode) {
          console.log("🔄 Reload mode: Fetching fresh spreadsheet data from source");
          const { csvData: extractedCsvData, hyperlinkData: extractedHyperlinks } =
            await extractGoogleSheetsWithHyperlinks(selectedRealm.dataSource.url, VERBOSE_MODE);
          csvData = extractedCsvData;
          hyperlinkData = extractedHyperlinks;
        } else {
          console.log("📂 Working with existing directories instead of downloading fresh spreadsheet data");
          csvData = "SKIP_SPREADSHEET_DOWNLOAD";
          hyperlinkData = {};
        }
      } else if (selectedRealm.dataSource.type === 'json-file') {
        if (!selectedRealm.dataSource.path) {
          throw new Error(`JSON file path not configured for realm ${selectedRealm.id}`);
        }
        const filePath = path.join(getProjectRootDir(), selectedRealm.dataSource.path);
        if (!(await fs.pathExists(filePath))) {
          throw new Error(`File not found: ${filePath}`);
        }
        const jsonData = await fs.readJson(filePath);
        csvData = convertSchoolDistrictJsonToCsv(jsonData);
      } else {
        throw new Error(`Unsupported data source type: ${selectedRealm.dataSource.type}`);
      }

      await processSpreadsheetData(
        csvData,
        hyperlinkData,
        selectedRealm,
        targetDomain,
        municipalityFilter,
        forceMode,
        noDownloadMode,
        noDeleteMode,
        VERBOSE_MODE,
        entitiesToInclude,
        reloadMode,
      );

      // Create missing metadata files for existing statute files
      await createMissingMetadataFiles(selectedRealm, reloadMode, entitiesToInclude);
      
      // For JSON-based realms, create directory structure and policy files
      if (selectedRealm.dataSource.type === 'json-file') {
        await createDirectoryStructureFromJSON(selectedRealm, targetDomain, entitiesToInclude);
      }
    }

    console.log("All tasks completed successfully!");
  } catch (error: any) {
    console.error("Error:", error);
    logToFile(`Error during extraction: ${error.message}`);
    process.exit(1);
  } finally {
    closeLogging();
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

// Command-line testing function for pdfFormToText
if (process.argv[2] === "test-pdf-form" && process.argv[3]) {
  const pdfPath = process.argv[3];
  const title = process.argv[4] || "Test PDF Form";
  
  (async () => {
    try {
      console.log(`🧪 Testing PDF form processing on: ${pdfPath}`);
      console.log(`📋 Form title: ${title}`);
      console.log(`${"=".repeat(50)}`);
      
      if (!await fs.pathExists(pdfPath)) {
        console.error(`❌ PDF file not found: ${pdfPath}`);
        process.exit(1);
      }
      
      const pdfBuffer = await fs.readFile(pdfPath);
      const result = await pdfFormToText(pdfBuffer, title);
      
      console.log("\n📋 FORM ANALYSIS RESULT:");
      console.log(`${"=".repeat(50)}`);
      console.log(result);
      console.log(`${"=".repeat(50)}`);
      console.log(`✅ Form processing completed successfully!`);
      
    } catch (error: any) {
      console.error(`❌ Error testing PDF form: ${error.message}`);
      process.exit(1);
    }
  })();
}
