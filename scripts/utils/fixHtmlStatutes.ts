#!/usr/bin/env tsx

import fs from "fs/promises";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface FixOptions {
  domain?: string;
  municipality?: string;
  dryRun?: boolean;
  verbose?: boolean;
}

// Global verbose flag
let VERBOSE = false;

// Verbose logging helper
function log(message: string, ...args: any[]) {
  if (VERBOSE) {
    console.log(`[VERBOSE] ${message}`, ...args);
  }
}

// Function to detect if content is HTML
function isHtmlContent(content: string): boolean {
  // Check for common HTML tags and patterns
  const htmlPatterns = [
    /<html[^>]*>/i,
    /<head[^>]*>/i,
    /<body[^>]*>/i,
    /<div[^>]*>/i,
    /<p[^>]*>/i,
    /<script[^>]*>/i,
    /<style[^>]*>/i,
    /<meta[^>]*>/i,
    /<title[^>]*>/i,
    /<link[^>]*>/i,
    /<!DOCTYPE\s+html/i,
    /<[a-z][a-z0-9]*[^<>]*>/i // Generic HTML tag pattern
  ];
  
  // Check if content starts with HTML-like structure
  const trimmedContent = content.trim();
  if (trimmedContent.startsWith('<!DOCTYPE') || 
      trimmedContent.startsWith('<html') ||
      trimmedContent.startsWith('<HTML')) {
    return true;
  }
  
  // Count HTML tag occurrences
  let htmlTagCount = 0;
  for (const pattern of htmlPatterns) {
    const matches = content.match(pattern);
    if (matches) {
      htmlTagCount += matches.length;
    }
  }
  
  // If we find more than 3 HTML tags, it's likely HTML content
  return htmlTagCount > 3;
}

// Check if file exists
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Check if directory exists
async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

// Get all domain directories
async function getDomainDirectories(dataDir: string): Promise<string[]> {
  const entries = await fs.readdir(dataDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
}

// Get all municipality directories in a domain
async function getMunicipalityDirectories(domainDir: string): Promise<string[]> {
  const entries = await fs.readdir(domainDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("NY-"))
    .map((entry) => entry.name);
}

// Process a single statute file
async function processStatuteFile(
  statutePath: string,
  municipalityDir: string,
  domain: string,
  options: FixOptions
): Promise<{ processed: boolean; error?: string }> {
  try {
    log(`Checking statute file: ${statutePath}`);
    
    if (!(await fileExists(statutePath))) {
      log(`Statute file does not exist: ${statutePath}`);
      return { processed: false };
    }

    const statute = await fs.readFile(statutePath, "utf-8");
    
    if (!isHtmlContent(statute)) {
      log(`File is already plain text: ${statutePath}`);
      return { processed: false };
    }

    console.log(`📄 Found HTML content in: ${domain}/${municipalityDir}`);
    
    if (options.dryRun) {
      console.log(`   [DRY RUN] Would backup to statute.html and convert to text`);
      return { processed: true };
    }

    // Create backup as statute.html
    const htmlBackupPath = path.join(path.dirname(statutePath), "statute.html");
    await fs.copyFile(statutePath, htmlBackupPath);
    console.log(`   ✅ Backed up to statute.html`);

    // Run convertHtmlToText.ts on the file
    // Extract domain and municipality from the path for proper conversion
    const pathParts = statutePath.split(path.sep);
    const municipalityName = pathParts[pathParts.length - 2]; // e.g., "NY-Buchanan-Village"
    const domainName = pathParts[pathParts.length - 3]; // e.g., "trees"
    
    const convertScript = path.join(__dirname, 'convertHtmlToText.ts');
    const convertCommand = `tsx "${convertScript}" "${domainName}" "${municipalityName}"`;
    log(`Running conversion command: ${convertCommand}`);
    
    try {
      execSync(convertCommand, { 
        cwd: __dirname,
        stdio: options.verbose ? 'inherit' : 'pipe',
        shell: true
      });
      console.log(`   ✅ Converted HTML to plain text`);
      return { processed: true };
    } catch (convertError) {
      console.error(`   ❌ Conversion failed: ${convertError.message}`);
      return { processed: false, error: convertError.message };
    }

  } catch (error) {
    console.error(`❌ Error processing ${statutePath}: ${error.message}`);
    return { processed: false, error: error.message };
  }
}

// Main processing function
async function fixHtmlStatutes(options: FixOptions) {
  const dataDir = path.join(process.cwd(), "..", "data");
  
  log(`Data directory: ${dataDir}`);
  log(`Processing options:`, options);

  if (!(await directoryExists(dataDir))) {
    throw new Error(`Data directory not found: ${dataDir}`);
  }

  const domains = options.domain 
    ? [options.domain]
    : await getDomainDirectories(dataDir);

  log(`Found domains:`, domains);

  let totalProcessed = 0;
  let totalErrors = 0;
  let totalChecked = 0;
  const processedFiles: string[] = [];
  const errorFiles: { file: string; error: string }[] = [];

  for (const domain of domains) {
    console.log(`\n📁 Processing domain: ${domain}`);
    const domainDir = path.join(dataDir, domain);
    
    if (!(await directoryExists(domainDir))) {
      console.log(`⚠️  Domain directory not found: ${domainDir}`);
      continue;
    }

    const allMunicipalityDirs = await getMunicipalityDirectories(domainDir);
    const municipalityDirs = options.municipality 
      ? allMunicipalityDirs.filter(dir => dir.toLowerCase().includes(options.municipality!.toLowerCase()))
      : allMunicipalityDirs;

    log(`Found municipalities in ${domain}:`, municipalityDirs);

    for (const municipalityDir of municipalityDirs) {
      const fullMunicipalityPath = path.join(domainDir, municipalityDir);
      const statutePath = path.join(fullMunicipalityPath, "statute.txt");
      
      totalChecked++;
      const result = await processStatuteFile(statutePath, municipalityDir, domain, options);
      
      if (result.processed) {
        totalProcessed++;
        processedFiles.push(`${domain}/${municipalityDir}`);
      }
      
      if (result.error) {
        totalErrors++;
        errorFiles.push({ file: `${domain}/${municipalityDir}`, error: result.error });
      }
    }
  }

  // Print summary
  console.log(`\n📊 Summary:`);
  console.log(`   Files checked: ${totalChecked}`);
  console.log(`   HTML files found and processed: ${totalProcessed}`);
  console.log(`   Errors: ${totalErrors}`);

  if (processedFiles.length > 0) {
    console.log(`\n✅ Successfully processed:`);
    processedFiles.forEach(file => console.log(`   - ${file}`));
  }

  if (errorFiles.length > 0) {
    console.log(`\n❌ Errors encountered:`);
    errorFiles.forEach(({ file, error }) => console.log(`   - ${file}: ${error}`));
  }

  if (options.dryRun) {
    console.log(`\n🔍 This was a dry run. Use --convert to actually process the files.`);
  }
}

// Parse command line arguments
function parseArgs(): FixOptions {
  const args = process.argv.slice(2);
  const options: FixOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    switch (arg) {
      case '--domain':
        options.domain = args[++i];
        break;
      case '--municipality':
        options.municipality = args[++i];
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--convert':
        options.dryRun = false;
        break;
      case '--verbose':
      case '-v':
        options.verbose = true;
        VERBOSE = true;
        break;
      case '--help':
      case '-h':
        showHelp();
        process.exit(0);
        break;
      default:
        if (arg.startsWith('--')) {
          console.error(`Unknown option: ${arg}`);
          showHelp();
          process.exit(1);
        }
    }
  }

  // Default to dry run if not specified
  if (options.dryRun === undefined) {
    options.dryRun = true;
  }

  return options;
}

// Show help message
function showHelp() {
  console.log(`
🔧 HTML Statute File Fixer

This script scans statute.txt files for HTML content, backs them up as statute.html,
and converts them to plain text using convertHtmlToText.ts.

Usage:
  tsx scripts/fixHtmlStatutes.ts [options]

Options:
  --domain <name>           Process specific domain only (e.g., "trees")
  --municipality <id>       Process specific municipality only (e.g., "NY-Bedford-Town")
  --dry-run                 Show what would be processed without making changes (default)
  --convert                 Actually convert the files (overrides --dry-run)
  --verbose, -v             Enable detailed logging
  --help, -h               Show this help message

Examples:
  tsx scripts/fixHtmlStatutes.ts                                    # Dry run on all files
  tsx scripts/fixHtmlStatutes.ts --convert                          # Convert all HTML statute files
  tsx scripts/fixHtmlStatutes.ts --domain trees --convert           # Convert only trees domain
  tsx scripts/fixHtmlStatutes.ts --municipality NewCastle --convert # Convert specific municipality
  tsx scripts/fixHtmlStatutes.ts --verbose --convert                # Convert with detailed logging

Safety:
  - Always runs in dry-run mode by default
  - Creates statute.html backup before converting
  - Uses existing convertHtmlToText.ts for reliable conversion
`);
}

// Main execution
async function main() {
  try {
    const options = parseArgs();
    await fixHtmlStatutes(options);
  } catch (error) {
    console.error(`❌ Error:`, error.message);
    process.exit(1);
  }
}

// ES module check
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}