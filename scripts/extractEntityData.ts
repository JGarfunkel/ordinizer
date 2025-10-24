#!/usr/bin/env tsx

import fs from "fs-extra";
import path from "path";
import axios from "axios";
import { parse } from "csv-parse/sync";
import { google } from "googleapis";
import { JSDOM, VirtualConsole } from "jsdom";
import { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFButton } from "pdf-lib";
import { convertHtmlToText } from "../server/lib/simpleHtmlToText.js";

interface MunicipalityRow {
  Municipality: string;
  Type: string;
  [key: string]: string; // Domain columns (Trees, Zoning, etc.)
}

interface CellData {
  value: string;
  hyperlink?: string;
}

const DOMAINS = [
  "Trees",
  "GLB",
  "Wetland Protection",
  "Dark Sky",
  "Weeds",
  "Cluster Zoning",
  "Flood Damage Protection",
  "Solar 1",
  "Slopes",
];

// Domain name mapping for renamed domains
// Maps display domain name to spreadsheet column name
const DOMAIN_MAPPING: Record<string, string> = {
  "Weeds": "Property Maintenance" // "Weeds" domain reads from "Property Maintenance" column
};

const DELAY_BETWEEN_DOWNLOADS = 5000; // 5 seconds

interface StatuteLibrary {
  id: string;
  name: string;
  baseUrl: string;
  urlPatterns: string[];
  download: boolean;
  extractionSupported: boolean;
  anchorSupported: boolean;
  notes: string;
}

interface StatuteLibraryConfig {
  libraries: StatuteLibrary[];
  defaultLibrary: string;
  lastUpdated: string;
}

interface Realm {
  id: string;
  name: string;
  displayName: string;
  description: string;
  type: string;
  datapath: string;
  entityType: string;
  entityFile: string;
  mapBoundaries: string;
  dataSource: {
    type: 'google-sheets' | 'json-file';
    url?: string;
    path?: string;
  };
  domains: string[];
  isDefault?: boolean;
}

interface RealmsConfig {
  realms: Realm[];
  lastUpdated: string;
}

interface Source {
  downloadedAt?: string;
  contentLength?: number;
  sourceUrl: string;
  title?: string;
  type: "statute" | "policy" | "form" | "guidance";
  referencesStateCode?: boolean;
  filePaths?: {
    html?: string;
    pdf?: string;
    txt: string;
  };
}

interface Metadata {
  municipality?: string;
  municipalityType?: string;
  districtName?: string;
  entityId?: string;
  domain: string;
  domainId?: string;
  sources: Source[];
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

// Helper functions for new metadata format
function isLegacyMetadata(metadata: any): boolean {
  // If sources array exists and is valid, treat as new format even if legacy fields present
  return !Array.isArray(metadata.sources);
}

function migrateLegacyMetadata(legacyMetadata: any): Metadata {
  const newMetadata: Metadata = {
    ...legacyMetadata,
    sources: []
  };
  
  // Remove legacy fields
  delete newMetadata.sourceUrl;
  delete newMetadata.downloadedAt;
  delete newMetadata.contentLength;
  delete newMetadata.statuteTitle;
  delete newMetadata.policyTitle;
  delete newMetadata.sourceType;
  
  // Create sources array from legacy data
  if (legacyMetadata.sourceUrl) {
    const sourceType = determineSourceType(legacyMetadata);
    const title = legacyMetadata.statuteTitle || legacyMetadata.policyTitle || legacyMetadata.domain || "Unknown Document";
    
    // Use existing downloadedAt or fallback to metadataCreated or current time
    const downloadedAt = legacyMetadata.downloadedAt || 
                        legacyMetadata.metadataCreated || 
                        new Date().toISOString();
    
    newMetadata.sources.push({
      downloadedAt,
      contentLength: legacyMetadata.contentLength || 0,
      sourceUrl: legacyMetadata.sourceUrl,
      title: title,
      type: sourceType
    });
  }
  
  // Add additional sources from sourceUrls if they exist
  if (legacyMetadata.sourceUrls && Array.isArray(legacyMetadata.sourceUrls)) {
    for (const sourceUrlObj of legacyMetadata.sourceUrls) {
      if (sourceUrlObj.url) {
        // Use consistent fallback chain for additional sources
        const downloadedAt = legacyMetadata.downloadedAt || 
                            legacyMetadata.metadataCreated || 
                            new Date().toISOString();
                            
        newMetadata.sources.push({
          downloadedAt,
          contentLength: 0,
          sourceUrl: sourceUrlObj.url,
          title: sourceUrlObj.title || sourceUrlObj.text || "Article",
          type: determineSourceType(legacyMetadata)
        });
      }
    }
  }
  
  // Deduplicate sources by URL (keep first occurrence) - same as batch migration
  const seen = new Set<string>();
  newMetadata.sources = newMetadata.sources.filter(source => {
    if (seen.has(source.sourceUrl)) {
      return false;
    }
    seen.add(source.sourceUrl);
    return true;
  });
  
  // Remove sourceUrls to prevent duplication
  delete newMetadata.sourceUrls;
  
  return newMetadata;
}

function determineSourceType(metadata: any): "statute" | "policy" {
  // Check if it's a school district (has districtName or entityId pattern)
  if (metadata.districtName || (metadata.entityId && metadata.entityId.includes("-CSD")) || 
      (metadata.entityId && metadata.entityId.includes("-UFSD")) || metadata.realm === "westchester-schools-sustainability") {
    return "policy";
  }
  return "statute";
}

function getPrimarySource(metadata: Metadata): Source | null {
  return metadata.sources && metadata.sources.length > 0 ? metadata.sources[0] : null;
}

function getSourceUrl(metadata: Metadata): string | null {
  const primarySource = getPrimarySource(metadata);
  return primarySource?.sourceUrl || null;
}

function getDownloadedAt(metadata: Metadata): string | null {
  const primarySource = getPrimarySource(metadata);
  return primarySource?.downloadedAt || null;
}

function getContentLength(metadata: Metadata): number {
  const primarySource = getPrimarySource(metadata);
  return primarySource?.contentLength || 0;
}

function getSourceTitle(metadata: Metadata): string {
  const primarySource = getPrimarySource(metadata);
  if (primarySource && primarySource.title) {
    return primarySource.title;
  }
  return metadata.statuteTitle || metadata.policyTitle || metadata.domain || "Document";
}

function addOrUpdateSource(metadata: Metadata, source: Source): void {
  // Ensure metadata has sources array
  if (!metadata.sources) {
    metadata.sources = [];
  }
  
  // Find existing source by URL or create new one
  const existingIndex = metadata.sources.findIndex(s => s.sourceUrl === source.sourceUrl);
  
  if (existingIndex >= 0) {
    metadata.sources[existingIndex] = source;
  } else {
    metadata.sources.unshift(source); // Add to beginning as primary source
  }
}

async function readMetadata(metadataPath: string): Promise<Metadata | null> {
  if (!(await fs.pathExists(metadataPath))) {
    return null;
  }
  
  try {
    const rawMetadata = await fs.readJson(metadataPath);
    
    // Migrate legacy format if needed
    if (isLegacyMetadata(rawMetadata)) {
      return migrateLegacyMetadata(rawMetadata);
    }
    
    // Clean up any remaining legacy fields from migrated metadata
    const cleanMetadata = { ...rawMetadata };
    delete cleanMetadata.sourceUrl;
    delete cleanMetadata.downloadedAt;
    delete cleanMetadata.contentLength;
    delete cleanMetadata.statuteTitle;
    delete cleanMetadata.policyTitle;
    delete cleanMetadata.sourceType;
    delete cleanMetadata.sourceUrls;
    
    return cleanMetadata as Metadata;
  } catch (error) {
    console.warn(`Warning: Could not read metadata from ${metadataPath}: ${error.message}`);
    return null;
  }
}

async function writeMetadata(metadataPath: string, metadata: Metadata): Promise<void> {
  await fs.writeJson(metadataPath, metadata, { spaces: 2 });
}

/**
 * Convert PDF form to descriptive text with dependency-safe fallback
 * Creates meaningful content for forms even when PDF libraries fail
 */
async function pdfFormToText(pdfBuffer: Buffer, formTitle: string = "PDF Form"): Promise<string> {
  try {
    // First ensure pdf-parse can work by creating missing test directory
    await ensurePdfParseCompatibility();
    
    console.log("    📋 Extracting text from PDF form...");
    const pdfParse = await import('pdf-parse');
    const pdfData = await pdfParse.default(pdfBuffer);
    const extractedText = pdfData.text.trim();
    
    if (extractedText && extractedText.length > 50) {
      console.log(`    ✅ Successfully extracted ${extractedText.length} characters from PDF`);
      
      // For source.type === "form", always interpret the text as a form
      return interpretTextAsForm(extractedText, formTitle);
    }
    
    // If extraction fails, provide meaningful fallback content
    console.log("    📋 PDF text extraction failed, providing structured fallback");
    return createPdfFormFallback(formTitle, pdfBuffer.length);
    
  } catch (error) {
    console.log(`    ⚠️  PDF processing error (${error.message}), using fallback`);
    return createPdfFormFallback(formTitle, pdfBuffer.length);
  }
}

/**
 * Ensure pdf-parse library can work by creating the missing test file it expects
 */
async function ensurePdfParseCompatibility(): Promise<void> {
  try {
    const testDir = './test/data';
    const dummyFile = './test/data/05-versions-space.pdf';
    
    if (!await fs.pathExists(dummyFile)) {
      await fs.ensureDir(testDir);
      // Create a minimal valid PDF as dummy content
      const minimalPdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n178\n%%EOF');
      await fs.writeFile(dummyFile, minimalPdf);
    }
  } catch (error) {
    // If this fails, pdf-parse import will still fail, but we'll catch that later
  }
}

/**
 * Interpret extracted text as a form document, identifying fields and structure
 */
function interpretTextAsForm(extractedText: string, formTitle: string): string {
  const lines = extractedText.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  
  let formDescription = `${formTitle}\n\n`;
  const formFields: string[] = [];
  const feeInfo: string[] = [];
  const instructions: string[] = [];
  const requirements: string[] = [];
  
  for (const line of lines) {
    const lineLC = line.toLowerCase();
    
    // Detect form fields (lines with underscores for filling in)
    if (line.includes('_____') || line.includes('___')) {
      // Extract the field label (everything before the underscores)
      const fieldMatch = line.match(/^([^_]+?)_+/);
      if (fieldMatch) {
        const fieldLabel = fieldMatch[1].trim().replace(/[:\s]+$/, '');
        if (fieldLabel.length > 0) {
          formFields.push(`${fieldLabel}`);
        }
      }
    }
    
    // Detect fee information
    if (lineLC.includes('fee') || lineLC.includes('bond') || line.includes('$') || lineLC.includes('cost')) {
      feeInfo.push(line);
    }
    
    // Detect instructions and requirements
    if (lineLC.includes('submit') || lineLC.includes('provide') || lineLC.includes('attach') || 
        lineLC.includes('required') || lineLC.includes('must') || lineLC.includes('please')) {
      instructions.push(line);
    }
    
    // Detect department/contact information
    if (lineLC.includes('department') || lineLC.includes('phone') || lineLC.includes('www.') || 
        lineLC.includes('email') || lineLC.includes('contact')) {
      requirements.push(line);
    }
  }
  
  // Build structured form description
  if (formFields.length > 0) {
    formDescription += "FORM FIELDS:\n";
    formFields.forEach(field => {
      formDescription += `• ${field}\n`;
    });
    formDescription += "\n";
  }
  
  if (feeInfo.length > 0) {
    formDescription += "FEES AND PAYMENTS:\n";
    feeInfo.forEach(fee => {
      formDescription += `• ${fee}\n`;
    });
    formDescription += "\n";
  }
  
  if (instructions.length > 0) {
    formDescription += "INSTRUCTIONS AND REQUIREMENTS:\n";
    instructions.forEach(instruction => {
      formDescription += `• ${instruction}\n`;
    });
    formDescription += "\n";
  }
  
  if (requirements.length > 0) {
    formDescription += "DEPARTMENT INFORMATION:\n";
    requirements.forEach(req => {
      formDescription += `• ${req}\n`;
    });
    formDescription += "\n";
  }
  
  // Add raw text at the end for reference
  formDescription += "RAW FORM CONTENT:\n";
  formDescription += extractedText;
  
  return formDescription.trim();
}

/**
 * Create meaningful fallback content for PDF forms when extraction fails
 */
function createPdfFormFallback(formTitle: string, fileSize: number): string {
  const sizeInKB = Math.round(fileSize / 1024);
  
  return `${formTitle}

PDF Form Document (${sizeInKB} KB)

This document contains a PDF form related to municipal regulations. The form may include:
- Application fields for permits or approvals
- Required documentation checklists  
- Fee schedules and payment information
- Contact information for relevant departments
- Instructions for submission and processing
- Regulatory requirements and compliance guidelines

Note: The PDF file has been saved and is available for direct review. Automated text extraction was not available, but the form structure and content can be accessed by opening the PDF file directly.

For specific details about requirements, fees, and procedures, please refer to the original PDF document.`;
}

async function processUndownloadedSources(
  entityDir: string, 
  metadata: Metadata,
  entityName: string,
  realmType?: string
): Promise<boolean> {
  // Try to restore sources from legacy fields if sources array is empty
  if (!metadata.sources || metadata.sources.length === 0) {
    console.log(`  🔄 Attempting to restore sources from legacy fields for ${entityName}`);
    
    // Try to extract URLs from originalCellValue or sourceUrls
    const urlsToRestore: string[] = [];
    
    if (metadata.originalCellValue && typeof metadata.originalCellValue === 'string') {
      // Extract URLs from originalCellValue - look for http/https patterns
      const urlMatches = metadata.originalCellValue.match(/https?:\/\/[^\s\],;"]+/g);
      if (urlMatches) {
        urlsToRestore.push(...urlMatches);
      }
    }
    
    if (metadata.sourceUrls && Array.isArray(metadata.sourceUrls)) {
      urlsToRestore.push(...metadata.sourceUrls.filter(url => typeof url === 'string' && url.startsWith('http')));
    }
    
    if (urlsToRestore.length > 0) {
      console.log(`  🔗 Found ${urlsToRestore.length} URLs to restore: ${urlsToRestore.join(', ')}`);
      
      // Create sources from discovered URLs
      metadata.sources = urlsToRestore.map((url, index) => ({
        sourceUrl: url,
        type: realmType === "policy" ? "policy" : "statute", // Use actual realm type
        title: `${entityName} ${metadata.domain} Document${urlsToRestore.length > 1 ? ` ${index + 1}` : ''}`,
      }));
      
      console.log(`  ✅ Restored ${metadata.sources.length} sources for processing`);
    } else {
      console.log(`  ⏭️  No sources or legacy URLs found for ${entityName}`);
      return false;
    }
  }

  let downloadedAny = false;

  for (let i = 0; i < metadata.sources.length; i++) {
    const source = metadata.sources[i];
    
    // Skip sources that have already been downloaded
    if (source.downloadedAt) {
      continue;
    }

    console.log(`  📥 Downloading unprocessed source ${i + 1}/${metadata.sources.length}: ${source.sourceUrl}`);
    
    try {
      // Get content type to determine if PDF or HTML with safe fallback
      let contentType = "text/html";
      try {
        contentType = await getContentTypeFromUrl(source.sourceUrl);
      } catch (error) {
        console.log(`    ⚠️  Content type detection failed, using URL-based detection: ${error.message}`);
        contentType = source.sourceUrl.toLowerCase().endsWith('.pdf') ? "application/pdf" : "text/html";
      }
      
      // Download the content with size limits
      const response = await axios.get(source.sourceUrl, {
        timeout: 30000,
        maxContentLength: 10 * 1024 * 1024, // 10MB limit
        responseType: 'arraybuffer', // Always use arraybuffer to handle both PDF and HTML safely
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Ordinizer/1.0; +http://ordinizer.example.com)",
        },
      });

      // Enhanced PDF detection after content is downloaded
      const isPdf = isContentPdf(response.data, contentType, source.sourceUrl, source.type);

      let textContent = "";
      
      // Create unique filenames based on source type to prevent overwrites
      const baseFileName = source.type || "statute";
      
      // Count how many sources of this type we've seen so far
      const sameTypeCount = metadata.sources.slice(0, i).filter(s => s.type === source.type).length;
      const sourceIndex = sameTypeCount === 0 ? "" : `_${sameTypeCount + 1}`;
      const fileName = `${baseFileName}${sourceIndex}`;
      
      if (isPdf) {
        // Save PDF file with unique name
        const pdfPath = path.join(entityDir, `${fileName}.pdf`);
        await fs.writeFile(pdfPath, response.data);
        console.log(`    💾 Saved PDF: ${fileName}.pdf`);
        
        // Extract text from PDF - use specialized form processing for forms
        try {
          if (source.type === "form") {
            console.log(`    📋 Processing as PDF form...`);
            textContent = await pdfFormToText(response.data, source.title || `${entityName} Form`);
          } else {
            // Regular PDF text extraction
            const pdfParse = await import('pdf-parse');
            const pdfData = await pdfParse.default(response.data);
            textContent = pdfData.text.trim();
          }
        } catch (pdfError) {
          console.warn(`    ⚠️  Failed to parse PDF, using empty content: ${pdfError.message}`);
          textContent = '';
        }
      } else {
        // Handle HTML content
        const htmlContent = Buffer.from(response.data).toString('utf-8');
        
        // Clean HTML by removing STYLE and SCRIPT elements
        const virtualConsole = new VirtualConsole();
        virtualConsole.sendTo(console, { omitJSDOMErrors: true });
        const dom = new JSDOM(htmlContent, { virtualConsole });
        const document = dom.window.document;
        const elementsToRemove = document.querySelectorAll("script, style");
        elementsToRemove.forEach((element) => element.remove());
        const cleanedHtml = dom.serialize();
        
        // Save HTML file with unique name
        const htmlPath = path.join(entityDir, `${fileName}.html`);
        await fs.writeFile(htmlPath, cleanedHtml, 'utf-8');
        console.log(`    💾 Saved HTML: ${fileName}.html`);
        
        // Convert HTML to text using cleaned HTML
        textContent = convertHtmlToText(cleanedHtml);
        
        // Extract title if not already set
        if (!source.title || source.title === "Unknown Document" || source.title === "Document") {
          const titleElement = document.title || 
                              document.querySelector('h1')?.textContent?.trim() ||
                              document.querySelector('h2')?.textContent?.trim();
          if (titleElement) {
            source.title = titleElement.substring(0, 100);
          }
        }
      }
      
      // Save text file with unique name
      const txtPath = path.join(entityDir, `${fileName}.txt`);
      await fs.writeFile(txtPath, textContent, 'utf-8');
      console.log(`    📝 Saved text: ${fileName}.txt (${textContent.length} characters)`);
      
      // Extract title if not already set
      let title = source.title;
      if (!title || title === "Unknown Document" || title === "Document") {
        if (isPdf) {
          title = `${entityName} ${source.type === "policy" ? "Policy" : "Ordinance"} (PDF)`;
        } else {
          // Fallback title for HTML if not extracted during processing
          title = `${entityName} ${source.type === "policy" ? "Policy" : "Ordinance"}`;
        }
      }
      
      // Update source with download information and file paths
      source.downloadedAt = new Date().toISOString();
      source.contentLength = textContent.length; // Character count for consistency
      source.title = title;
      source.filePaths = {
        html: isPdf ? undefined : `${fileName}.html`,
        pdf: isPdf ? `${fileName}.pdf` : undefined,
        txt: `${fileName}.txt`
      };
      
      console.log(`    ✅ Updated source: ${title} (${textContent.length} chars)`);
      downloadedAny = true;
      
      // Add delay between downloads to be respectful
      await delay(DELAY_BETWEEN_DOWNLOADS);
      
    } catch (error) {
      console.error(`    ❌ Failed to download ${source.sourceUrl}: ${error.message}`);
      
      // Add delay even after failures to avoid hammering hosts
      await delay(1000);
      
      // Don't mark failed downloads as downloaded - skip this source
      console.log(`    ⏭️  Skipping failed source, will retry on next run`);
    }
  }
  
  // If we downloaded any sources, persist the updated metadata
  if (downloadedAny) {
    const metadataPath = path.join(entityDir, "metadata.json");
    await writeMetadata(metadataPath, metadata);
    console.log(`  💾 Updated metadata with ${metadata.sources.filter(s => s.downloadedAt).length} processed sources`);
  }
  
  return downloadedAny;
}

// Load statute library configuration
let statuteLibraryConfig: StatuteLibraryConfig | null = null;

// Load realms configuration
let realmsConfig: RealmsConfig | null = null;

// Helper function to get project root directory consistently
function getProjectDataDir(): string {
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  return path.join(scriptDir, "..", "data");
}

function getProjectRootDir(): string {
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  return path.join(scriptDir, "..");
}

// Convert school district JSON to CSV format for processing
function convertSchoolDistrictJsonToCsv(jsonData: any[]): string {
  const headers = ['District Name', 'Website', 'overall', 'building', 'curriculum', 'food', 'gardens', 'stormwater'];
  const rows: string[][] = [headers];
  
  for (const district of jsonData) {
    const row = [
      district.name || '',
      district.url || '',
      '', '', '', '', '', '' // Initialize empty policy columns
    ];
    
    // Group policies by category and create URLs string for each
    const policiesByCategory: Record<string, string[]> = {};
    for (const policy of district.policies || []) {
      const category = policy.category || 'overall';
      if (!policiesByCategory[category]) {
        policiesByCategory[category] = [];
      }
      if (policy.policy_url) {
        policiesByCategory[category].push(policy.policy_url);
      }
    }
    
    // Map categories to their header positions
    const categoryMap: Record<string, number> = {
      'overall': 2,
      'building': 3, 
      'curriculum': 4,
      'food': 5,
      'gardens': 6,
      'stormwater': 7
    };
    
    // Fill in policy URLs for each category
    for (const [category, urls] of Object.entries(policiesByCategory)) {
      const headerIndex = categoryMap[category];
      if (headerIndex !== undefined) {
        row[headerIndex] = urls.join('; ');
      }
    }
    
    rows.push(row);
  }
  
  // Convert to CSV format
  return rows.map(row => 
    row.map(cell => `"${cell.replace(/"/g, '""')}"`)  // Escape quotes
       .join(',')
  ).join('\n');
}

async function loadStatuteLibraryConfig(): Promise<StatuteLibraryConfig> {
  if (statuteLibraryConfig) {
    return statuteLibraryConfig;
  }

  try {
    // Use consistent path resolution relative to script directory
    const scriptDir = path.dirname(new URL(import.meta.url).pathname);
    const configPath = path.join(
      scriptDir,
      "..",
      "data",
      "statute-libraries.json",
    );
    statuteLibraryConfig = await fs.readJson(configPath);
    return statuteLibraryConfig!;
  } catch (error) {
    console.warn(
      `Warning: Could not load statute library config: ${error.message}`,
    );
    // Return default configuration
    return {
      libraries: [
        {
          id: "ecode360",
          name: "eCode360",
          baseUrl: "https://ecode360.com",
          urlPatterns: ["ecode360.com"],
          download: true,
          extractionSupported: true,
          anchorSupported: true,
          notes: "Supports direct downloads and anchor-based extraction",
        },
      ],
      defaultLibrary: "ecode360",
      lastUpdated: new Date().toISOString(),
    };
  }
}

async function loadRealmsConfig(): Promise<RealmsConfig> {
  if (realmsConfig) {
    return realmsConfig;
  }

  try {
    // Use __dirname to get the script's directory, then navigate to data/realms.json
    const scriptDir = path.dirname(new URL(import.meta.url).pathname);
    const configPath = path.join(
      scriptDir,
      "..",
      "data",
      "realms.json",
    );
    realmsConfig = await fs.readJson(configPath);
    return realmsConfig!;
  } catch (error) {
    console.warn(
      `Warning: Could not load realms config: ${error.message}`,
    );
    // Return default configuration with westchester-municipal-environmental as default
    return {
      realms: [
        {
          id: "westchester-municipal-environmental",
          name: "Westchester Municipality Environmental Statutes",
          displayName: "Westchester Municipality Environmental Statutes",
          description: "Environmental statute analysis for Westchester County municipalities",
          type: "statute",
          datapath: "environmental-municipal",
          entityType: "municipalities",
          entityFile: "municipalities.json",
          mapBoundaries: "westchester-boundaries",
          dataSource: {
            type: 'google-sheets' as const,
            url: 'https://docs.google.com/spreadsheets/d/1Nc5xZZ9OrRgI2pnGjlBmo7yvpiQELYSEp19e73Gl_UE'
          },
          domains: ["trees", "weeds", "glb", "wetland-protection", "dark-sky", "cluster-zoning", "solar-1", "slopes"],
          isDefault: true
        }
      ],
      lastUpdated: new Date().toISOString(),
    };
  }
}

function getRealmById(realmId: string, config: RealmsConfig): Realm | null {
  return config.realms.find((realm) => realm.id === realmId) || null;
}

function getDefaultRealm(config: RealmsConfig): Realm | null {
  return config.realms.find((realm) => realm.isDefault) || config.realms[0] || null;
}

function getLibraryForUrl(
  url: string,
  config: StatuteLibraryConfig,
): StatuteLibrary | null {
  return (
    config.libraries.find((library) =>
      library.urlPatterns.some((pattern) => url.includes(pattern)),
    ) || null
  );
}

// Logging functionality
let logFile: string;
let logStream: fs.WriteStream | null = null;

function initializeLogging() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  logFile = path.join(getProjectRootDir(), "logs", `extract-${timestamp}.log`);

  try {
    fs.ensureDirSync(path.dirname(logFile));
    logStream = fs.createWriteStream(logFile, { flags: "w" });
    logToFile(`=== Extraction Log Started at ${new Date().toISOString()} ===`);
    console.log(`📝 Logging to: ${path.relative(getProjectRootDir(), logFile)}`);
  } catch (error) {
    console.warn(`Warning: Could not initialize log file: ${error.message}`);
  }
}

function logToFile(message: string) {
  if (logStream) {
    logStream.write(`${new Date().toISOString()}: ${message}\n`);
  }
}

function closeLogging() {
  if (logStream) {
    logToFile(`=== Extraction Log Ended at ${new Date().toISOString()} ===`);
    logStream.end();
    logStream = null;
  }
}

// Municipality validation function
async function validateMunicipalityRelevance(
  statutePath: string,
  municipalityName: string,
  municipalityType: string,
  domain: string,
): Promise<{ isValid: boolean; reason?: string }> {
  try {
    if (!(await fs.pathExists(statutePath))) {
      return { isValid: false, reason: "Statute file does not exist" };
    }

    const content = await fs.readFile(statutePath, "utf-8");
    const cleanContent = content.toLowerCase();

    // Look for the expected municipality name in various formats
    const municipalityPatterns = [
      // Exact matches with type
      `${municipalityType.toLowerCase()} of ${municipalityName.toLowerCase()}`,
      `${municipalityName.toLowerCase()} ${municipalityType.toLowerCase()}`,
      // Without type
      municipalityName.toLowerCase(),
      // With common variations
      municipalityName.replace(/[-\s]/g, "").toLowerCase(),
      // With "city of", "town of", "village of" patterns
      `city of ${municipalityName.toLowerCase()}`,
      `town of ${municipalityName.toLowerCase()}`,
      `village of ${municipalityName.toLowerCase()}`,
    ];

    // Check if any expected patterns exist
    const foundExpected = municipalityPatterns.some((pattern) =>
      cleanContent.includes(pattern),
    );

    if (foundExpected) {
      logToFile(
        `✅ Validation passed: Found "${municipalityName}" references in statute for ${domain}`,
      );
      return { isValid: true };
    }

    // Look for specific other municipality names that would clearly indicate wrong content
    // Focus on actual municipality names, not generic patterns that could match navigation elements
    const otherMunicipalitySuggested = ["town of", "city of", "village of"];

    // Remove current municipality from problem list
    const currentMunicipalityVariants = [
      municipalityName.toLowerCase(),
      municipalityName.replace(/[-\s]/g, "").toLowerCase(),
      municipalityName.replace(/\s/g, "-").toLowerCase(),
    ];

    const filteredProblemMunicipalities = otherMunicipalitySuggested.filter(
      (problem) =>
        !currentMunicipalityVariants.some(
          (variant) => problem.includes(variant) || variant.includes(problem),
        ),
    );

    // Check for references to other specific municipalities
    const foundOtherMunicipalities: string[] = [];

    filteredProblemMunicipalities.forEach((municipality) => {
      if (cleanContent.includes(municipality)) {
        // Double-check it's not just part of our expected municipality name
        if (
          !currentMunicipalityVariants.some((variant) =>
            municipality.includes(variant),
          )
        ) {
          foundOtherMunicipalities.push(municipality);
        }
      }
    });

    if (foundOtherMunicipalities.length > 0) {
      const reason = `Found references to other municipalities: ${foundOtherMunicipalities.slice(0, 3).join(", ")}`;
      logToFile(
        `❌ Validation failed: ${reason} (expected: ${municipalityName})`,
      );
      return { isValid: false, reason };
    }

    // If no municipality references found at all, assume it's valid (could be generic content or state code)
    logToFile(
      `⚠️ Validation uncertain: No clear municipality references found, assuming valid for ${municipalityName}`,
    );
    return { isValid: true };
  } catch (error) {
    const reason = `Error validating statute: ${error.message}`;
    logToFile(`❌ Validation error: ${reason}`);
    return { isValid: false, reason };
  }
}

// Function to clean up invalid statute files
async function cleanupInvalidStatute(
  municipalityDir: string,
  municipalityName: string,
  domain: string,
  reason: string,
): Promise<void> {
  const statutePath = path.join(municipalityDir, "statute.txt");
  const statuteHtmlPath = path.join(municipalityDir, "statute.html");
  const statutePdfPath = path.join(municipalityDir, "statute.pdf");
  const metadataPath = path.join(municipalityDir, "metadata.json");

  console.log(
    `🗑️  Cleaning up invalid statute files for ${municipalityName} (${domain}): ${reason}`,
  );
  logToFile(
    `Cleaning up invalid statute files: ${municipalityName}/${domain} - ${reason}`,
  );

  // Delete statute files
  if (await fs.pathExists(statutePath)) {
    await fs.remove(statutePath);
    logToFile(`Deleted: ${statutePath}`);
  }

  if (await fs.pathExists(statuteHtmlPath)) {
    await fs.remove(statuteHtmlPath);
    logToFile(`Deleted: ${statuteHtmlPath}`);
  }

  if (await fs.pathExists(statutePdfPath)) {
    await fs.remove(statutePdfPath);
    logToFile(`Deleted: ${statutePdfPath}`);
  }

  // Update metadata.json to remove all source information
  if (await fs.pathExists(metadataPath)) {
    console.log(`  🗑️  Cleaning up metadata.json (removing source information)`);
    try {
      const metadata = await readMetadata(metadataPath);
      if (metadata) {
        // Clear sources array for new format
        metadata.sources = [];
        
        // Also remove legacy fields if they exist for backward compatibility
        delete metadata.sourceUrl;
        delete metadata.originalCellValue;
        delete metadata.downloadedAt;
        delete metadata.contentLength;
        delete metadata.sourceType;
        delete metadata.lastConverted;
        delete metadata.sourceUrls; // Remove duplicated sourceUrls array

        await writeMetadata(metadataPath, metadata);
        logToFile(
          `Updated metadata.json: removed all source information (sources array and legacy fields)`,
        );
        console.log(`  ✅ Updated metadata.json: removed all source information`);
      }
    } catch (error) {
      logToFile(`Error updating metadata.json: ${error.message}`);
      console.log(`  ⚠️  Could not update metadata.json: ${error.message}`);
    }
  }
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


interface ArticleLink {
  title: string;
  url: string;
}

function detectArticleBasedPage(
  html: string,
  currentUrl: string,
): { isArticleBased: boolean; articles: ArticleLink[] } {
  try {
    const dom = new JSDOM(html);
    const document = dom.window.document;

    // Extract the path from current URL for comparison
    const currentPath = new URL(currentUrl).pathname;

    // Look for all titleLink elements that point to different paths
    const articles: ArticleLink[] = [];
    const titleLinks = document.querySelectorAll("a.titleLink");
    
    // Check if articles are actually in the current HTML content
    const currentHtmlContent = document.body.textContent || "";
    const articleRefs: string[] = [];

    titleLinks.forEach((link) => {
      const href = link.getAttribute("href");
      if (href) {
        // Only process links that have "Article" in the titleNumber
        const titleNumber = link.querySelector(".titleNumber");
        const titleText = titleNumber?.textContent?.trim() || "";

        if (titleText.includes("Article")) {
          // Convert relative URLs to absolute URLs
          let absoluteUrl: string;
          if (href.startsWith("http")) {
            absoluteUrl = href;
          } else if (href.startsWith("#")) {
            // For anchor links, append to the current URL
            absoluteUrl = `${currentUrl}${href}`;
          } else {
            // For relative paths, prepend the base domain
            absoluteUrl = `https://ecode360.com${href}`;
          }

          try {
            const linkPath = new URL(absoluteUrl).pathname;

            // Check if this appears to be a TOC structure (ecode360 specific patterns)
            const tocPattern = `subSectionOf-${link.querySelector('span[data-guid]')?.getAttribute('data-guid') || ''}`;
            const isTocStructure = currentHtmlContent.includes(tocPattern) || 
                                   currentHtmlContent.includes(`${titleText}\\nchevron_right`) ||
                                   currentHtmlContent.includes('class="subChild"') ||
                                   currentHtmlContent.includes('Navigate to '); // ecode360 TOC navigation pattern
            
            // For TOC pages, we should download all linked articles regardless of what content appears to be present
            const isDefinitelyToc = currentHtmlContent.includes('<div id="toc">') || 
                                    currentHtmlContent.includes('class="subChild"') ||
                                    (titleLinks.length > 3 && currentHtmlContent.includes('chevron_right')); // Multiple articles with navigation

            // If this page is definitely a TOC, or this link points to a different path, download it
            if (linkPath !== currentPath && (isDefinitelyToc || isTocStructure)) {
              articles.push({
                title: titleText,
                url: absoluteUrl,
              });
              console.log(`    📋 ${titleText} detected in TOC structure - treating as separate article`);
            } else if (linkPath === currentPath) {
              console.log(`    🔗 ${titleText} points to current page - skipping`);
            } else {
              console.log(`    📍 ${titleText} may have content in current page - skipping separate download`);
            }
          } catch (urlError) {
            // Skip invalid URLs
          }
        }
      }
    });

    const isArticleBased = articles.length > 0;

    if (isArticleBased) {
      console.log(
        `  🔍 Detected article-based page with ${articles.length} separate sections/articles:`,
      );
      articles.forEach((article) => {
        console.log(`    - ${article.title}: ${article.url}`);
      });
    } else if (titleLinks.length > 0) {
      console.log(`  📄 Found ${titleLinks.length} article references, but all appear to be in current page`);
    }

    return { isArticleBased, articles };
  } catch (error) {
    console.log(
      "  Warning: Error detecting article-based page:",
      error.message,
    );
    return { isArticleBased: false, articles: [] };
  }
}

async function downloadAndStitchArticles(
  articles: ArticleLink[],
): Promise<{ content: string; sourceUrls: ArticleLink[] }> {
  console.log(`  📚 Downloading and stitching ${articles.length} articles...`);

  const articleContents: string[] = [];
  const processedArticles: ArticleLink[] = [];

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    console.log(
      `  📄 Downloading article ${i + 1}/${articles.length}: ${article.title}`,
    );

    try {
      const html = await downloadFromUrl(article.url);
      if (html) {
        const text = convertHtmlToText(html);
        if (text && text.length > 50) {
          articleContents.push(`\n\n=== ${article.title} ===\n\n${text}`);
          processedArticles.push(article);
          console.log(`    ✅ Downloaded ${text.length} characters`);
        } else {
          console.log(`    ⚠️  Article content too short, skipping`);
        }
      }

      // Add delay between downloads to be respectful
      if (i < articles.length - 1) {
        await delay(3000); // 3 second delay between article downloads
      }
    } catch (error) {
      console.log(
        `    ❌ Failed to download ${article.title}: ${error.message}`,
      );
    }
  }

  const stitchedContent = articleContents.join("\n\n");
  console.log(
    `  🔗 Stitched ${processedArticles.length} articles into ${stitchedContent.length} characters`,
  );

  return {
    content: stitchedContent,
    sourceUrls: processedArticles,
  };
}

async function downloadFromUrl(url: string): Promise<string> {
  try {
    // Check library configuration first
    const config = await loadStatuteLibraryConfig();
    const library = getLibraryForUrl(url, config);

    if (library && !library.download) {
      console.log(
        `⚠️  Download not supported for ${library.name}: ${library.notes}`,
      );
      logToFile(
        `Skipped download from ${library.name}: ${url} - ${library.notes}`,
      );
      return "";
    }

    console.log(`Downloading: ${url}${library ? ` (${library.name})` : ""}`);

    verboseLog(`HTTP GET Request:`, {
      url: url,
      timeout: 30000,
      library: library?.name || "Unknown",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    const response = await axios.get(url, {
      timeout: 30000,
      maxRedirects: 5,
      responseType: 'arraybuffer', // Get binary data to handle PDFs properly
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; Ordinizer/1.0; +http://ordinizer.example.com)",
      },
    });

    const contentType = response.headers["content-type"] || '';
    // Enhanced PDF detection with byte sniffing
    const isPdf = isContentPdf(response.data, contentType, url);

    verboseLog(`HTTP Response:`, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      dataLength: response.data?.byteLength || 0,
      dataType: typeof response.data,
      contentType: contentType,
      isPdf: isPdf
    });

    // Convert binary data to appropriate format
    if (isPdf) {
      // For PDFs, keep as binary buffer but convert to base64 for storage
      return Buffer.from(response.data).toString('base64');
    } else {
      // For HTML/text, convert to string
      return Buffer.from(response.data).toString('utf-8');
    }
  } catch (error) {
    verboseLog(`HTTP Request Failed:`, {
      url: url,
      error: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText,
    });
    console.error(`Failed to download ${url}:`, error);
    return "";
  }
}

async function getContentTypeFromUrl(url: string): Promise<string> {
  try {
    const response = await axios.head(url, {
      timeout: 10000,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Ordinizer/1.0; +http://ordinizer.example.com)",
      },
    });
    return response.headers["content-type"] || "text/html";
  } catch (error) {
    // Fallback to URL-based detection if HEAD request fails
    if (url.toLowerCase().endsWith('.pdf')) {
      return "application/pdf";
    }
    return "text/html";
  }
}

function detectPdfFromBytes(content: string | Buffer): boolean {
  try {
    let bytes: Buffer;
    if (typeof content === 'string') {
      // If it's base64 string, decode it first
      if (content.startsWith('data:application/pdf')) {
        bytes = Buffer.from(content.split(',')[1], 'base64');
      } else {
        // Try decoding as base64, fallback to UTF-8
        try {
          bytes = Buffer.from(content, 'base64');
        } catch {
          bytes = Buffer.from(content, 'utf-8');
        }
      }
    } else {
      bytes = content;
    }
    
    // Check for PDF signature in first 8 bytes
    const header = bytes.subarray(0, 8).toString('ascii');
    return header.startsWith('%PDF-');
  } catch {
    return false;
  }
}

function isContentPdf(content: string | Buffer, contentType: string, url: string, sourceType?: string): boolean {
  // Force PDF detection for form sources
  if (sourceType === 'form') {
    return detectPdfFromBytes(content) || contentType.includes('application/pdf') || url.toLowerCase().endsWith('.pdf');
  }
  
  // Standard detection with byte sniffing fallback
  if (contentType.includes('application/pdf') || url.toLowerCase().endsWith('.pdf')) {
    return true;
  }
  
  // Byte sniffing as fallback
  return detectPdfFromBytes(content);
}

async function analyzeSpreadsheetStructure(
  spreadsheetId: string,
  verbose: boolean = false,
): Promise<void> {
  const apiKey = process.env.GOOGLE_SHEETS_API_KEY;

  if (!apiKey) {
    console.log(
      "GOOGLE_SHEETS_API_KEY not found, skipping spreadsheet analysis",
    );
    return;
  }

  try {
    console.log("\n=== SPREADSHEET STRUCTURE ANALYSIS ===");

    // Get spreadsheet metadata to list all sheets
    const metadataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?key=${apiKey}`;
    verboseLog(`Google Sheets API Request:`, {
      url: metadataUrl,
      method: "GET",
    });

    const metadataResponse = await axios.get(metadataUrl);

    verboseLog(`Google Sheets API Response:`, {
      status: metadataResponse.status,
      sheetsCount: metadataResponse.data.sheets?.length || 0,
    });

    const sheets = metadataResponse.data.sheets;
    if (verbose) {
      console.log(`Found ${sheets.length} tabs in spreadsheet:`);
    }

    for (const sheet of sheets) {
      const sheetName = sheet.properties.title;
      const sheetId = sheet.properties.sheetId;
      const rowCount = sheet.properties.gridProperties.rowCount;
      const colCount = sheet.properties.gridProperties.columnCount;

      if (verbose) {
        console.log(`\n📊 Tab: "${sheetName}" (ID: ${sheetId})`);
        console.log(`   Dimensions: ${rowCount} rows × ${colCount} columns`);
      }

      try {
        // Get Row 2 (headers) for this sheet
        const headerRange = `'${sheetName}'!2:2`;
        const headerUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${headerRange}?key=${apiKey}`;
        verboseLog(`Google Sheets Values API Request:`, {
          url: headerUrl,
          range: headerRange,
        });

        const headerResponse = await axios.get(headerUrl);

        verboseLog(`Google Sheets Values API Response:`, {
          status: headerResponse.status,
          valuesCount: headerResponse.data.values?.[0]?.length || 0,
        });

        const headerRow = headerResponse.data.values?.[0] || [];
        if (verbose) {
          console.log(`   Headers in Row 2 (${headerRow.length} columns):`);

          headerRow.forEach((header: string, index: number) => {
            let columnLetter = "";
            if (index < 26) {
              columnLetter = String.fromCharCode(65 + index);
            } else {
              columnLetter =
                String.fromCharCode(65 + Math.floor(index / 26) - 1) +
                String.fromCharCode(65 + (index % 26));
            }
            const displayHeader = header ? `"${header}"` : "(empty)";
            console.log(`     Column ${columnLetter}: ${displayHeader}`);
          });
        }

        // Look for potential domain-related headers
        const potentialDomains = headerRow.filter(
          (header: string) =>
            header &&
            (header.toLowerCase().includes("tree") ||
              header.toLowerCase().includes("wetland") ||
              header.toLowerCase().includes("dark") ||
              header.toLowerCase().includes("sky") ||
              header.toLowerCase().includes("leaf") ||
              header.toLowerCase().includes("blower") ||
              header.toLowerCase().includes("property") ||
              header.toLowerCase().includes("maintenance") ||
              header.toLowerCase().includes("zoning") ||
              header.toLowerCase().includes("noise") ||
              header.toLowerCase().includes("environmental")),
        );

        if (potentialDomains.length > 0 && verbose) {
          console.log(`   🎯 Potential domain columns found:`);
          potentialDomains.forEach((domain) => {
            console.log(`     • "${domain}"`);
          });
        }
      } catch (sheetError) {
        if (verbose) {
          console.log(`   ❌ Could not read headers: ${sheetError.message}`);
        }
      }
    }

    if (verbose) {
      console.log("\n=== END ANALYSIS ===\n");
    }
  } catch (error) {
    console.error("Failed to analyze spreadsheet structure:", error);
  }
}

async function extractGoogleSheetsWithHyperlinks(
  sheetUrl: string,
  verbose: boolean = false,
): Promise<{
  csvData: string;
  hyperlinkData: Record<string, Record<string, string>>;
}> {
  try {
    // Extract sheet ID and gid from URL
    const sheetIdMatch = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    const gidMatch = sheetUrl.match(/gid=(\d+)/);

    if (!sheetIdMatch) {
      throw new Error("Could not extract sheet ID from URL");
    }

    const sheetId = sheetIdMatch[1];
    const gid = gidMatch ? gidMatch[1] : "0";

    // Analyze spreadsheet structure before extracting data
    await analyzeSpreadsheetStructure(sheetId, verbose);

    // First, get CSV data for basic parsing
    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
    console.log(`Extracting CSV data from: ${csvUrl}`);

    verboseLog(`Google Sheets CSV Export Request:`, {
      url: csvUrl,
      method: "GET",
      sheetId: sheetId,
      gid: gid,
    });

    const csvResponse = await axios.get(csvUrl, {
      timeout: 30000,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Ordinizer/1.0)",
      },
    });

    verboseLog(`Google Sheets CSV Export Response:`, {
      status: csvResponse.status,
      dataLength: csvResponse.data?.length || 0,
      contentType: csvResponse.headers["content-type"],
    });

    const csvData = csvResponse.data;

    // Now try to get hyperlink data using Google Sheets API (if API key is available)
    let hyperlinkData: Record<string, Record<string, string>> = {};

    const apiKey = process.env.GOOGLE_SHEETS_API_KEY;
    if (apiKey) {
      try {
        console.log("Using Google Sheets API to extract hyperlinks...");
        const sheets = google.sheets({ version: "v4", auth: apiKey });

        // Get sheet information first to find the correct sheet name
        verboseLog(`Google Sheets API - Getting sheet info:`, {
          spreadsheetId: sheetId,
        });

        const sheetInfo = await sheets.spreadsheets.get({
          spreadsheetId: sheetId,
        });

        verboseLog(`Google Sheets API - Sheet info response:`, {
          sheetsCount: sheetInfo.data.sheets?.length || 0,
          sheetNames: sheetInfo.data.sheets?.map((s) => s.properties?.title),
        });

        // Find the sheet by gid or use the first sheet
        let targetSheet = sheetInfo.data.sheets?.[0];
        if (gid !== "0") {
          targetSheet =
            sheetInfo.data.sheets?.find(
              (sheet) => sheet.properties?.sheetId?.toString() === gid,
            ) || targetSheet;
        }

        const sheetName = targetSheet?.properties?.title || "Sheet1";
        if (verbose) {
          console.log(`Using sheet: ${sheetName} (gid: ${gid})`);
        }

        // Get all data including formatting and hyperlinks
        verboseLog(`Google Sheets API - Getting grid data:`, {
          spreadsheetId: sheetId,
          ranges: [sheetName],
          includeGridData: true,
        });

        const result = await sheets.spreadsheets.get({
          spreadsheetId: sheetId,
          includeGridData: true,
          ranges: [sheetName],
        });

        verboseLog(`Google Sheets API - Grid data response:`, {
          hasData: !!result.data.sheets?.[0]?.data?.[0],
          rowCount: result.data.sheets?.[0]?.data?.[0]?.rowData?.length || 0,
        });

        const sheetData = result.data.sheets?.[0]?.data?.[0];
        if (sheetData && sheetData.rowData) {
          sheetData.rowData.forEach((row, rowIndex) => {
            if (row.values) {
              row.values.forEach((cell, colIndex) => {
                const cellValue =
                  cell.userEnteredValue?.stringValue ||
                  cell.userEnteredValue?.numberValue?.toString() ||
                  cell.formattedValue ||
                  "";

                // Try multiple ways to extract hyperlinks
                let hyperlink =
                  cell.userEnteredValue?.formulaValue?.match(
                    /=HYPERLINK\("([^"]+)"/,
                  )?.[1] ||
                  cell.hyperlink;

                // Check ALL textFormatRuns for hyperlinks, not just the first one
                if (!hyperlink && cell.textFormatRuns) {
                  for (const run of cell.textFormatRuns) {
                    if (run.format?.link?.uri) {
                      hyperlink = run.format.link.uri;
                      break;
                    }
                  }
                }

                if (hyperlink && cellValue) {
                  const rowKey = `row_${rowIndex}`;
                  const colKey = `col_${colIndex}`;

                  if (!hyperlinkData[rowKey]) {
                    hyperlinkData[rowKey] = {};
                  }
                  hyperlinkData[rowKey][colKey] = hyperlink;

                  if (verbose) {
                    console.log(
                      `Found hyperlink at ${rowKey}_${colKey}: ${cellValue} -> ${hyperlink}`,
                    );
                  }
                }
              });
            }
          });
        }

        if (verbose) {
          console.log(
            `Extracted ${Object.keys(hyperlinkData).length} rows with hyperlinks`,
          );
        }
      } catch (apiError) {
        console.warn(
          "Could not extract hyperlinks via API, falling back to CSV values only:",
          apiError,
        );
      }
    } else {
      console.log(
        "GOOGLE_SHEETS_API_KEY not found, skipping hyperlink extraction",
      );
    }

    return { csvData, hyperlinkData };
  } catch (error) {
    console.error("Failed to extract Google Sheets data:", error);
    throw new Error(
      `Could not access Google Sheets. Make sure the sheet is publicly accessible or shared with a link.`,
    );
  }
}

async function extractGoogleSheetsAsCsv(sheetUrl: string): Promise<string> {
  const { csvData } = await extractGoogleSheetsWithHyperlinks(sheetUrl);
  return csvData;
}

async function getExistingMunicipalitiesFromFilesystem(realm: Realm, targetDomain?: string, entitiesToInclude?: Set<string>, verbose: boolean = false): Promise<any[][]> {
  const rows: any[][] = [];
  const realmDir = path.join(getProjectDataDir(), realm.datapath);
  
  console.log(`📂 Scanning filesystem for existing entities in: ${realmDir}`);
  if (targetDomain) {
    console.log(`🎯 Filtering by domain: ${targetDomain}`);
  }
  
  if (!(await fs.pathExists(realmDir))) {
    console.log(`  ❌ No realm directory found: ${realmDir}`);
    return rows;
  }
  
  const domains = await fs.readdir(realmDir);
  console.log(`📁 Found ${domains.length} domain directories: ${domains.join(', ')}`);
  
  for (const domain of domains) {
    // Skip if we're filtering by domain and this isn't it (case-insensitive)
    if (targetDomain && domain.toLowerCase() !== targetDomain.toLowerCase()) {
      console.log(`⏭️  Skipping domain ${domain} (filtering for ${targetDomain})`);
      continue;
    }
    
    const domainPath = path.join(realmDir, domain);
    const stat = await fs.stat(domainPath);
    
    if (!stat.isDirectory() || domain.endsWith(".json") || domain.endsWith(".csv")) {
      console.log(`⏭️  Skipping ${domain} (not a domain directory)`);
      continue;
    }
    
    console.log(`🔍 Processing domain: ${domain}`);
    const municipalities = await fs.readdir(domainPath);
    console.log(`  📁 Found ${municipalities.length} municipality directories`);
    
    let processedInDomain = 0;
    for (const municipality of municipalities) {
      if (!municipality.startsWith("NY-")) {
        if (verbose) console.log(`  ⏭️  Skipping ${municipality} (doesn't start with NY-)`);
        continue;
      }
      
      const municipalityPath = path.join(domainPath, municipality);
      const municipalityStat = await fs.stat(municipalityPath);
      
      if (!municipalityStat.isDirectory()) {
        if (verbose) console.log(`  ⏭️  Skipping ${municipality} (not a directory)`);
        continue;
      }
      
      console.log(`  🔍 Checking ${municipality}...`);
      
      // Check if this directory has any useful files
      const metadataPath = path.join(municipalityPath, "metadata.json");
      const statutePath = path.join(municipalityPath, "statute.txt");
      const hasMetadata = await fs.pathExists(metadataPath);
      const hasStatute = await fs.pathExists(statutePath);
      
      console.log(`    📄 Files found: metadata.json=${hasMetadata}, statute.txt=${hasStatute}`);
      
      if (hasMetadata || hasStatute) {
        // Parse municipality info from directory name
        const match = municipality.match(/^NY-(.+)-(.+)$/);
        if (match) {
          const municipalityName = match[1].replace(/([A-Z])/g, " $1").trim();
          const municipalityType = match[2];
          
          // Apply municipality filter if specified
          if (entitiesToInclude) {
            const shouldProcess = entitiesToInclude.has(municipalityName.toLowerCase());
            if (!shouldProcess) {
              if (verbose) console.log(`    ⏭️  Skipping ${municipalityName} - ${municipalityType} (not in filter: ${Array.from(entitiesToInclude).join(', ')})`);
              continue;
            } else {
              console.log(`    🎯 ${municipalityName} - ${municipalityType} matches filter - adding to processing list`);
            }
          } else {
            console.log(`    ✅ Adding ${municipalityName} - ${municipalityType} to processing list`);
          }
          
          // Create a row that matches the spreadsheet format
          // We'll use placeholder values for missing data
          const row = [
            `${municipalityName} (${municipalityType})`,      // Town with proper format
            "",                    // CAC/CB/Etc  
            "",                    // Wetland Protection
            "",                    // Property Maintenance
            "",                    // Trees
            "",                    // GLB
            "",                    // Invasives
            "",                    // Cluster Zoning
            "",                    // Dark Sky
            "",                    // Grade
            "",                    // Notes
            "",                    // Additional columns...
            "",
            "",
            "",
            "",
            ""
          ];
          
          // Try to read existing metadata to populate source URL if available
          if (hasMetadata) {
            try {
              const metadata = await readMetadata(metadataPath);
              const domainIndex = getDomainColumnIndex(domain);
              const sourceUrl = metadata ? getSourceUrl(metadata) : null;
              if (domainIndex !== -1 && sourceUrl) {
                row[domainIndex] = sourceUrl;
                console.log(`    🔗 Found source URL: ${sourceUrl}`);
              }
            } catch (error) {
              console.log(`    ⚠️  Could not read metadata: ${error.message}`);
            }
          }
          
          rows.push(row);
          processedInDomain++;
        } else {
          console.log(`    ⚠️  Could not parse municipality name from: ${municipality}`);
        }
      } else {
        console.log(`    ⏭️  No useful files found in ${municipality}`);
      }
    }
    
    console.log(`  📊 Processed ${processedInDomain} municipalities from ${domain} domain`);
  }
  
  console.log(`📊 Total entities found: ${rows.length}`);
  return rows;
}

function getDomainColumnIndex(domain: string): number {
  // Map domain directories to spreadsheet column indices
  const domainMapping: { [key: string]: number } = {
    'cac-cb-etc': 1,
    'wetland-protection': 2,
    'property-maintenance': 3,
    'weeds': 3,  // weeds replaces property-maintenance
    'trees': 4,
    'glb': 5,
    'invasives': 6,
    'cluster-zoning': 7,
    'dark-sky': 8
  };
  
  return domainMapping[domain] ?? -1;
}

async function createMissingMetadataFiles(realm: Realm, reloadMode: boolean = false, entitiesToInclude?: Set<string>): Promise<void> {
  if (reloadMode) {
    console.log("\n🔄 Reload mode: Regenerating metadata.json files from source data...");
  } else {
    console.log("\n🔍 Checking for missing metadata.json files...");
  }

  const realmDir = path.join(getProjectDataDir(), realm.datapath);
  if (!(await fs.pathExists(realmDir))) {
    console.log(`  No realm directory found: ${realmDir}`);
    return;
  }
  const domains = await fs.readdir(realmDir);
  let missingCount = 0;
  let createdCount = 0;

  for (const domain of domains) {
    const domainPath = path.join(realmDir, domain);
    const stat = await fs.stat(domainPath);

    if (
      !stat.isDirectory() ||
      domain.endsWith(".json") ||
      domain.endsWith(".csv")
    )
      continue;

    const municipalities = await fs.readdir(domainPath);

    for (const municipality of municipalities) {
      if (!municipality.startsWith("NY-")) continue;

      // Apply municipality filter if specified
      if (entitiesToInclude) {
        const match = municipality.match(/^NY-(.+)-(.+)$/);
        const municipalityName = match ? match[1].replace(/([A-Z])/g, " $1").trim() : municipality;
        const shouldProcess = entitiesToInclude.has(municipalityName.toLowerCase());
        if (!shouldProcess) {
          continue; // Skip this municipality
        }
      }

      const municipalityPath = path.join(domainPath, municipality);
      const municipalityStat = await fs.stat(municipalityPath);

      if (!municipalityStat.isDirectory()) continue;

      const statutePath = path.join(municipalityPath, "statute.txt");
      const metadataPath = path.join(municipalityPath, "metadata.json");

      if (
        (await fs.pathExists(statutePath)) &&
        (!(await fs.pathExists(metadataPath)) || reloadMode)
      ) {
        if (reloadMode && (await fs.pathExists(metadataPath))) {
          console.log(`  Reload mode: Regenerating metadata.json: ${domain}/${municipality}`);
        } else {
          missingCount++;
          console.log(`  Missing metadata.json: ${domain}/${municipality}`);
        }

        try {
          const statuteStats = await fs.stat(statutePath);
          const statuteContent = await fs.readFile(statutePath, "utf-8");

          // Parse municipality name and type from directory name
          const match = municipality.match(/^NY-(.+)-(.+)$/);
          const municipalityName = match
            ? match[1].replace(/([A-Z])/g, " $1").trim()
            : municipality;
          const municipalityType = match ? match[2] : "Unknown";

          // Check if metadata already exists and preserve existing data if present
          let existingMetadata: Metadata | null = null;
          let existingOriginalCellValue = "Not available";
          if (await fs.pathExists(metadataPath)) {
            try {
              existingMetadata = await readMetadata(metadataPath);
              if (existingMetadata?.originalCellValue) {
                existingOriginalCellValue = existingMetadata.originalCellValue;
              }
            } catch (error) {
              // Ignore errors reading existing metadata
            }
          }

          const downloadedAt = statuteStats.birthtime?.toISOString() || statuteStats.mtime.toISOString();
          
          // Extract statute number and title from HTML if available
          let statuteTitle = domain.charAt(0).toUpperCase() + domain.slice(1).replace(/-/g, " ");
          const htmlPath = path.join(municipalityPath, "statute.html");
          if (await fs.pathExists(htmlPath)) {
            const statuteInfo = await extractStatuteInfo(htmlPath);
            if (statuteInfo.title) {
              statuteTitle = statuteInfo.title;
              console.log(`    📋 Extracted statute info: ${statuteInfo.number || "N/A"} - ${statuteInfo.title || "N/A"}`);
            }
          }

          // Start with existing metadata if available, otherwise create base metadata
          const metadata: Metadata = existingMetadata || {
            municipality: municipalityName,
            municipalityType: municipalityType,
            domain: domain.charAt(0).toUpperCase() + domain.slice(1).replace(/-/g, " "),
            domainId: domain,
            sources: [],
            originalCellValue: existingOriginalCellValue,
            stateCodeApplies: false,
            metadataCreated: new Date().toISOString(),
            note: "Metadata created retroactively for existing statute file",
          };

          // Always update basic fields from current processing
          metadata.municipality = municipalityName;
          metadata.municipalityType = municipalityType;
          metadata.domain = domain.charAt(0).toUpperCase() + domain.slice(1).replace(/-/g, " ");
          metadata.domainId = domain;
          metadata.originalCellValue = existingOriginalCellValue;

          // Add or update the primary statute source using merge strategy
          if ((existingMetadata && getSourceUrl(existingMetadata)) || existingOriginalCellValue !== "Not available") {
            const sourceUrl = (existingMetadata && getSourceUrl(existingMetadata)) || existingOriginalCellValue;
            if (sourceUrl && sourceUrl !== "Not available" && sourceUrl !== "Unknown") {
              addOrUpdateSource(metadata, {
                downloadedAt: (existingMetadata && getDownloadedAt(existingMetadata)) || downloadedAt,
                contentLength: statuteContent.length,
                sourceUrl: sourceUrl,
                title: statuteTitle,
                type: "statute"
              });
            }
          } else {
            // Create placeholder source if no URL is available
            if (!metadata.sources || metadata.sources.length === 0) {
              metadata.sources = [{
                downloadedAt,
                contentLength: statuteContent.length,
                sourceUrl: "Unknown",
                title: statuteTitle,
                type: "statute"
              }];
            }
          }

          // Add statute number if extracted
          if (await fs.pathExists(htmlPath)) {
            const statuteInfo = await extractStatuteInfo(htmlPath);
            if (statuteInfo.number) metadata.statuteNumber = statuteInfo.number;
          }

          await writeMetadata(metadataPath, metadata);
          
          // Process any additional sources (form, guidance, etc.) after saving metadata
          try {
            const processedSources = await processUndownloadedSources(municipalityPath, metadata, `${municipalityName} - ${municipalityType}`, realm.type);
            if (processedSources) {
              console.log(`    🔄 Processed additional sources for ${municipalityName} - ${municipalityType}`);
            }
          } catch (error) {
            console.warn(`    ⚠️  Failed to process additional sources for ${municipalityName} - ${municipalityType}: ${error.message}`);
          }
          
          createdCount++;
          if (reloadMode) {
            console.log(
              `    ✅ Regenerated metadata.json for ${municipalityName} - ${municipalityType}`,
            );
          } else {
            console.log(
              `    ✅ Created metadata.json for ${municipalityName} - ${municipalityType}`,
            );
          }
        } catch (error) {
          console.error(
            `    ❌ Failed to create metadata for ${municipality}: ${error.message}`,
          );
        }
      }
    }
  }

  if (reloadMode) {
    console.log(
      `\n📊 Reload complete: ${createdCount} metadata files regenerated from source data`,
    );
  } else {
    console.log(
      `\n📊 Metadata check complete: ${missingCount} missing files found, ${createdCount} created`,
    );
  }
}

async function processSpreadsheetData(
  csvData: string,
  hyperlinkData: Record<string, Record<string, string>> = {},
  realm: Realm,
  targetDomain?: string,
  municipalityFilter?: string,
  forceMode: boolean = false,
  noDownloadMode: boolean = false,
  noDeleteMode: boolean = false,
  verbose: boolean = false,
  entitiesToInclude?: Set<string>,
  reloadMode: boolean = false,
): Promise<void> {
  let rows: any[][];
  
  // Use different data source depending on realm configuration
  if (realm.dataSource.type === 'google-sheets') {
    // Only fetch from Google Sheets API if we don't already have CSV data
    if (!csvData || csvData.trim() === '' || csvData === 'SKIP_SPREADSHEET_DOWNLOAD') {
      // Check if we should skip spreadsheet download and work with existing directories
      if (csvData === 'SKIP_SPREADSHEET_DOWNLOAD') {
        console.log("📂 Processing existing directories without downloading spreadsheet");
        // Work with existing directories - get municipality list from filesystem
        rows = await getExistingMunicipalitiesFromFilesystem(realm, targetDomain, entitiesToInclude, verbose);
        console.log(`Found ${rows.length} existing entities to process`);
      } else {
      console.log("📥 Fetching fresh data from Google Sheets API");
      // Use Google Sheets API for more accurate data extraction
      const sheetUrl = process.env.WEN_SPREADSHEET_URL;
      if (!sheetUrl) {
        throw new Error("WEN_SPREADSHEET_URL environment variable is required");
      }

      const urlMatch = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      if (!urlMatch) {
        throw new Error("Invalid Google Sheets URL format");
      }

      const sheetId = urlMatch[1];
      const apiKey = process.env.GOOGLE_SHEETS_API_KEY;
      if (!apiKey) {
        throw new Error("GOOGLE_SHEETS_API_KEY environment variable is required");
      }

      // Get data from Ordinances tab starting from Row 2
      const range = "Ordinances!A2:Q50";
      const apiUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?key=${apiKey}`;

      const apiResponse = await axios.get(apiUrl);
      rows = apiResponse.data.values || [];
      
        console.log(`Found ${rows.length} municipalities in spreadsheet (via Google Sheets API)`);
      }
    } else {
      console.log("📋 Using provided CSV data from main function");
      // Use provided CSV data
      const csvLines = csvData.trim().split('\n');
      const headers = csvLines[0].split(',').map(h => h.replace(/"/g, ''));
      rows = csvLines.slice(1).map(line => {
        // Simple CSV parsing - split by comma but handle quoted fields
        const values: string[] = [];
        let currentValue = '';
        let inQuotes = false;
        
        for (let i = 0; i < line.length; i++) {
          const char = line[i];
          if (char === '"') {
            inQuotes = !inQuotes;
          } else if (char === ',' && !inQuotes) {
            values.push(currentValue.replace(/"/g, ''));
            currentValue = '';
          } else {
            currentValue += char;
          }
        }
        values.push(currentValue.replace(/"/g, ''));
        return values;
      });
      
      console.log(`Found ${rows.length} entities from provided CSV data`);
    }
  } else {
    // Use provided CSV data (from JSON file conversion)
    const csvLines = csvData.trim().split('\n');
    const headers = csvLines[0].split(',').map(h => h.replace(/"/g, ''));
    rows = csvLines.slice(1).map(line => {
      // Simple CSV parsing - split by comma but handle quoted fields
      const values: string[] = [];
      let currentValue = '';
      let inQuotes = false;
      
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          values.push(currentValue.replace(/"/g, ''));
          currentValue = '';
        } else {
          currentValue += char;
        }
      }
      values.push(currentValue.replace(/"/g, ''));
      return values;
    });
    
    console.log(`Found ${rows.length} entities in ${realm.dataSource.type} data`);
  }


  // Set headers based on data source type
  let headers: string[];
  let columnMap: Record<string, number> = {};
  let domainsToProcess: string[];

  if (realm.dataSource.type === 'google-sheets') {
    // Use Row 2 headers from Ordinances tab (as discovered in analysis)
    headers = [
      "Town",
      "CAC/CB/Etc",
      "Wetland Protection",
      "Property Maintenance",
      "Trees",
      "GLB",
      "Invasives",
      "Cluster Zoning",
      "Energy",
      "Energize",
      "Dark Sky",
      "Subdivision",
      "Flood Damage Protection",
      "Solar 1",
      "Slopes",
      "Wildliife Corridor",
      "Biodiversity",
    ];

    headers.forEach((header: string, index: number) => {
      columnMap[header] = index;
    });

    console.log(`Using Ordinances tab headers (Row 2):`, headers);
    console.log(
      `Domain column mapping:`,
      DOMAINS.map((d) => {
        const mappedDomain = DOMAIN_MAPPING[d] || d;
        return `${d} -> col ${columnMap[mappedDomain]}`;
      }),
    );

    // Filter domains if targetDomain is specified
    domainsToProcess = targetDomain
      ? DOMAINS.filter((d) => {
          const mappedDomain = DOMAIN_MAPPING[d] || d;
          return (
            d.toLowerCase() === targetDomain.toLowerCase() ||
            mappedDomain.toLowerCase() === targetDomain.toLowerCase()
          );
        })
      : DOMAINS;
  } else {
    // For JSON files, extract headers from the first row of CSV data
    const csvLines = csvData.trim().split('\n');
    headers = csvLines[0].split(',').map(h => h.replace(/"/g, ''));
    
    headers.forEach((header: string, index: number) => {
      columnMap[header] = index;
    });

    console.log(`Using JSON data headers:`, headers);
    
    // For schools realm, use the configured domains directly
    domainsToProcess = targetDomain
      ? realm.domains.filter((d) => d.toLowerCase() === targetDomain.toLowerCase())
      : realm.domains;

    console.log(`Available domains for this realm:`, realm.domains);
  }


  if (targetDomain && domainsToProcess.length === 0) {
    console.error(
      `Domain "${targetDomain}" not found. Available domains: ${realm.domains.join(", ")}`,
    );
    return;
  }

  if (targetDomain) {
    console.log(`Processing single domain: ${domainsToProcess[0]}`);
  } else {
    console.log(`Processing all domains: ${domainsToProcess.join(", ")}`);
  }

  // Create entity file from data
  const entityColumnName = headers[0]; // First column contains entity names
  console.log(`Processing ${realm.entityType} from Column: ${entityColumnName}`);

  // Entity filtering is now handled in main function

  // Process entities based on realm type
  let entities;
  
  if (realm.dataSource.type === 'google-sheets') {
    // Municipality processing with "Municipality (Type)" format parsing
    entities = rows
      .filter((row) => {
        const municipalityText = row[0]; // Column A
        const isValid =
          municipalityText &&
          municipalityText.includes("(") &&
          municipalityText.includes(")") &&
          !municipalityText.toLowerCase().includes("environmental") &&
          !municipalityText.toLowerCase().includes("key:");

        // Apply entity filter if specified
        if (isValid && entitiesToInclude) {
          const match = municipalityText.match(/^(.+?)\s*\((.+?)\)$/);
          if (match) {
            const [, name] = match;
            const cleanName = name.trim().toLowerCase();
            const shouldInclude = entitiesToInclude.has(cleanName);
            if (shouldInclude) {
              console.log(`Including filtered municipality: ${municipalityText}`);
            }
            return shouldInclude;
          }
          return false;
        }

        if (isValid) {
          console.log(`Including municipality: ${municipalityText}`);
        }
        return isValid;
      })
      .map((row) => {
        const municipalityText = row[0]; // Column A
        // Parse "Municipality (Type)" format
        const match = municipalityText.match(/^(.+?)\s*\((.+?)\)$/);
        if (!match) {
          console.warn(
            `Could not parse municipality format: ${municipalityText}`,
          );
          return null;
        }

        const [, name, type] = match;
        const cleanName = name.trim();
        // Translate "Town/Village" to "Town" as requested
        const cleanType = type.trim() === "Town/Village" ? "Town" : type.trim();

        return {
          id: `NY-${cleanName.replace(/[^a-zA-Z0-9]/g, "")}-${cleanType.replace(/[^a-zA-Z0-9]/g, "")}`,
          name: cleanName,
          type: cleanType,
          state: "NY",
          displayName: `${cleanName} - ${cleanType}`,
          singular: cleanName
            .replace(/[^a-zA-Z0-9]/g, "")
            .replace(/\s+/g, "")
            .toLowerCase(),
        };
      })
      .filter((m) => m !== null);
  } else {
    // Simple entity processing for JSON data (school districts)
    entities = rows
      .filter((row) => {
        const entityName = row[0]; // First column contains entity names
        const isValid = entityName && entityName.trim() !== "";

        // Apply entity filter if specified
        if (isValid && entitiesToInclude) {
          const shouldInclude = entitiesToInclude.has(entityName.toLowerCase());
          if (shouldInclude) {
            console.log(`Including filtered ${realm.entityType.slice(0, -1)}: ${entityName}`);
          }
          return shouldInclude;
        }

        if (isValid) {
          console.log(`Including ${realm.entityType.slice(0, -1)}: ${entityName}`);
        }
        return isValid;
      })
      .map((row) => {
        const entityName = row[0].trim();
        const cleanId = entityName.replace(/[^a-zA-Z0-9]/g, "");
        
        return {
          id: `NY-${cleanId}`,
          name: entityName,
          type: "School District", 
          state: "NY",
          displayName: entityName,
          singular: cleanId.toLowerCase(),
        };
      });
  }

  await fs.ensureDir("data");

  // Only update entity file if no entity filter was applied
  if (!entitiesToInclude) {
    const entityFilePath = path.join(getProjectDataDir(), realm.datapath, realm.entityFile);
    await fs.ensureDir(path.dirname(entityFilePath));
    
    await fs.writeJson(
      entityFilePath,
      {
        [realm.entityType]: entities,
        lastUpdated: new Date().toISOString(),
      },
      { spaces: 2 },
    );

    console.log(
      `Created ${realm.entityFile} with ${entities.length} ${realm.entityType}`,
    );
  } else {
    console.log(
      `📋 Skipping ${realm.entityFile} update due to entity filter (${entitiesToInclude.size} ${realm.entityType} filtered)`,
    );
    console.log(`🎯 Entity filter active for: ${Array.from(entitiesToInclude).join(', ')}`);
  }

  // Create domains.json (if not exists) in realm-specific directory
  const domainsFile = path.join(getProjectDataDir(), realm.datapath, "domains.json");
  if (!(await fs.pathExists(domainsFile))) {
    const domains = realm.domains.map((domain) => {
      return {
        id: domain.toLowerCase().replace(/\s+/g, "-"),
        name: domain.toLowerCase().replace(/\s+/g, "-"),
        displayName: getDomainDisplayName(domain),
        description: getDomainDescription(domain),
      };
    });

    await fs.writeJson(
      domainsFile,
      {
        domains,
        lastUpdated: new Date().toISOString(),
      },
      { spaces: 2 },
    );

    console.log(`Created domains.json with ${domains.length} domains`);
  }

  // Process statute URLs for each municipality/domain
  let downloadCount = 0;

  for (const row of rows) {
    // The municipality name is in Column A
    const municipalityText = row[0];

    if (!municipalityText || !municipalityText.includes("(")) {
      continue; // Skip invalid rows
    }

    // Parse "Municipality (Type)" format from first column
    const match = municipalityText.match(/^(.+?)\s*\((.+?)\)$/);
    if (!match) {
      console.warn(`Could not parse municipality format: ${municipalityText}`);
      continue;
    }

    const [, municipalityName, municipalityType] = match;
    const cleanName = municipalityName.trim();
    // Translate "Town/Village" to "Town" as requested
    const cleanType =
      municipalityType.trim() === "Town/Village"
        ? "Town"
        : municipalityType.trim();

    // Apply municipality filter for downloads
    if (entitiesToInclude) {
      const shouldProcess = entitiesToInclude.has(
        cleanName.toLowerCase(),
      );
      if (!shouldProcess) {
        if (verbose) console.log(`⏭️  Skipping ${cleanName} - ${cleanType} (not in filter: ${Array.from(entitiesToInclude).join(', ')})`);
        continue; // Skip this municipality if not in filter
      } else {
        console.log(`🎯 Processing filtered municipality: ${cleanName} - ${cleanType} (matches filter)`);
      }
    }

    console.log(`Processing: ${cleanName} - ${cleanType}`);
    logToFile(`Processing municipality: ${cleanName} - ${cleanType}`);

    for (const domain of domainsToProcess) {
      // Get domain data from the corresponding column using ordinance headers
      const mappedDomain = DOMAIN_MAPPING[domain] || domain;
      const columnIndex = columnMap[mappedDomain];
      const cellText = row[columnIndex]; // Direct access to cell text
      let url = "";
      let grade: string | null = null;

      // First check if we have hyperlink data for this cell
      // API data (A2:Q50): rows[0] = headers, rows[1+] = data rows
      // Hyperlink data appears to be off by 1, so adjust mapping
      const allRowIndex = rows.indexOf(row); // Index in full rows array
      const dataRowIndex = allRowIndex - 1; // Exclude header row at rows[0]
      const rowIndex = dataRowIndex + 2; // Adjusted mapping to fix off-by-one error
      const colIndex = columnMap[mappedDomain];

      if (
        colIndex !== undefined &&
        hyperlinkData[`row_${rowIndex}`]?.[`col_${colIndex}`]
      ) {
        const hyperlinkUrl =
          hyperlinkData[`row_${rowIndex}`][`col_${colIndex}`];

        // Check if cell text contains a URL
        const cellUrlMatch = cellText?.match(/https?:\/\/[^\s]*/);
        const isGenericHyperlink =
          hyperlinkUrl && new URL(hyperlinkUrl).pathname === "/";
        const cellUrlIsDifferent =
          cellUrlMatch && cellUrlMatch[0] !== hyperlinkUrl;

        if (cellUrlMatch && (isGenericHyperlink || cellUrlIsDifferent)) {
          // Use cell text URL if hyperlink is generic or different from cell text
          url = cellUrlMatch[0];
          const reason = isGenericHyperlink
            ? "generic hyperlink"
            : "different from cell text";
          console.log(
            `  Using cell text URL over hyperlink (${reason}) for ${domain}: ${cellText} -> ${url}`,
          );
        } else if (!cellUrlMatch && hyperlinkUrl) {
          // Use hyperlink URL when cell text contains no URL
          url = hyperlinkUrl;
          console.log(
            `  Using hyperlink URL (no URL in cell text) for ${domain}: ${cellText} -> ${hyperlinkUrl}`,
          );
        } else {
          // Use the hyperlink as usual when cell text matches hyperlink
          url = hyperlinkUrl;
          console.log(
            `  Found hyperlink for ${domain}: ${cellText} -> ${hyperlinkUrl}`,
          );
        }

        // Extract grade from cell text prefix
        const gradeMatch = cellText?.match(/^(GG|G|Y|R)-/);
        if (gradeMatch) {
          const gradeCode = gradeMatch[1];
          switch (gradeCode) {
            case "GG":
              grade = "Very Good";
              break;
            case "G":
              grade = "Good";
              break;
            case "Y":
              grade = "Yellow";
              break;
            case "R":
              grade = "Red";
              break;
          }
        }
      }

      // If no hyperlink, check for direct HTTP URLs in cell text
      if (!url && cellText) {
        const httpUrlMatch = cellText.match(/https?:\/\/[^\s]*/);
        if (httpUrlMatch) {
          url = httpUrlMatch[0];

          // Extract grade from prefix (GG, G, Y, R)
          const gradeMatch = cellText.match(/^(GG|G|Y|R)-/);
          if (gradeMatch) {
            const gradeCode = gradeMatch[1];
            switch (gradeCode) {
              case "GG":
                grade = "Very Good";
                break;
              case "G":
                grade = "Good";
                break;
              case "Y":
                grade = "Yellow";
                break;
              case "R":
                grade = "Red";
                break;
            }
            console.log(
              `  Found direct URL for ${domain}: ${url} (Grade: ${grade})`,
            );
          } else {
            console.log(`  Found direct URL for ${domain}: ${url}`);
          }
        }
      }

      // Check if this municipality uses state code
      const usesStateCode =
        cellText?.toLowerCase().includes("ny state") || false;

      // Convert domain name to kebab-case for directory naming
      // Use the original domain for directory naming, not the mapped spreadsheet column name
      const domainDir = domain.toLowerCase().replace(/\s+/g, "-");

      if (usesStateCode) {
        console.log(
          `  ${cleanName} - ${cleanType}: Uses NY State code, managing shared state reference`,
        );

        // Create municipality directory for metadata only
        const municipalityDirPath = path.join(
          getProjectDataDir(),
          realm.datapath,
          domainDir,
          `NY-${cleanName.replace(/\s+/g, "")}-${cleanType.replace(/\s+/g, "")}`,
        );
        await fs.ensureDir(municipalityDirPath);
        const municipalityMetadataPath = path.join(
          municipalityDirPath,
          "metadata.json",
        );

        // Save metadata in municipality folder (no statute files)
        await fs.writeJson(
          municipalityMetadataPath,
          {
            municipality: municipalityName,
            municipalityType: cleanType,
            domain: getDomainDisplayName(domain),
            domainId: domain
              .toLowerCase()
              .replace(/\s+/g, "-"),
            sourceUrl: url,
            originalCellValue: cellText || url,
            downloadedAt: new Date().toISOString(),
            stateCodeApplies: true,
            referencesStateCode: true,
            stateCodePath: `../NY-State/statute.txt`,
          },
          { spaces: 2 },
        );
        console.log(
          `  Created metadata reference for ${municipalityName} - ${municipalityType} (references state code)`,
        );

        // Check if we need to download the actual state statute to shared NY-State folder
        const stateDir = path.join(
          getProjectDataDir(),
          realm.datapath,
          domainDir,
          "NY-State",
        );
        const stateFilePath = path.join(stateDir, "statute.txt");
        const stateHtmlPath = path.join(stateDir, "statute.html");
        const stateMetadataPath = path.join(stateDir, "metadata.json");

        if (!(await fs.pathExists(stateFilePath))) {
          console.log(
            `  NY State statute not found, downloading to shared location: ${stateDir}`,
          );
          await fs.ensureDir(stateDir);

          // Add delay between downloads to be respectful
          if (downloadCount > 0) {
            console.log(
              `  Waiting ${DELAY_BETWEEN_DOWNLOADS / 1000} seconds...`,
            );
            await delay(DELAY_BETWEEN_DOWNLOADS);
          }

          const content = await downloadFromUrl(url);

          if (content) {
            // Always save original HTML source for potential later conversion
            await fs.writeFile(stateHtmlPath, content, "utf-8");
            console.log(`  Saved NY State HTML source: ${stateHtmlPath}`);

            // Check if this is an article-based page for state code too
            const { isArticleBased, articles } = detectArticleBasedPage(
              content,
              url,
            );
            let plainTextContent: string;
            let sourceUrls: ArticleLink[] | undefined;

            if (isArticleBased && articles.length > 0) {
              console.log(
                `  📚 Processing article-based NY State statute with ${articles.length} articles`,
              );
              const articleResult = await downloadAndStitchArticles(articles);
              plainTextContent = articleResult.content;
              sourceUrls = articleResult.sourceUrls;

              if (!plainTextContent || plainTextContent.length < 100) {
                console.log(
                  `  ⚠️  Article stitching resulted in insufficient content, falling back to main page`,
                );
                plainTextContent = convertHtmlToText(content);
                sourceUrls = undefined;
              } else {
                console.log(
                  `  ✅ Successfully stitched ${sourceUrls.length} articles into ${plainTextContent.length} characters`,
                );
              }
            } else {
              // Regular single-page processing
              plainTextContent = convertHtmlToText(content);
            }

            await fs.writeFile(stateFilePath, plainTextContent, "utf-8");

            // Save state metadata
            const stateMetadata: any = {
              municipality: "NY State",
              municipalityType: "State",
              domain: domain,
              domainId: domain.toLowerCase().replace(/\s+/g, "-"),
              sourceUrl: url,
              originalCellValue: cellText || url,
              downloadedAt: new Date().toISOString(),
              contentLength: plainTextContent.length,
              originalHtmlLength: content.length,
              stateCodeApplies: true,
              isStateCode: true,
            };

            // Add sourceUrls if this was an article-based page
            if (sourceUrls && sourceUrls.length > 0) {
              stateMetadata.sourceUrls = sourceUrls;
              stateMetadata.isArticleBased = true;
              console.log(
                `  📄 Added ${sourceUrls.length} article URLs to NY State metadata`,
              );
            }

            await fs.writeJson(stateMetadataPath, stateMetadata, { spaces: 2 });

            console.log(
              `  ${domain}: Downloaded NY State statute (${plainTextContent.length} characters plain text)`,
            );
            downloadCount++;
          } else {
            console.log(`  ${domain}: Failed to download NY State statute`);
          }
        } else {
          console.log(`  NY State statute already exists: ${stateFilePath}`);
        }

        continue; // Skip the regular download logic for state code municipalities
      }

      // Regular municipality - create full directory structure
      const dirPath = path.join(
        getProjectDataDir(),
        realm.datapath,
        domainDir,
        `NY-${cleanName.replace(/\s+/g, "")}-${cleanType.replace(/\s+/g, "")}`,
      );

      console.log(`  Creating directory: ${dirPath}`);
      await fs.ensureDir(dirPath);
      const filePath = path.join(dirPath, "statute.txt");
      const htmlPath = path.join(dirPath, "statute.html");
      const pdfPath = path.join(dirPath, "statute.pdf");
      const metadataPath = path.join(dirPath, "metadata.json");

      // Check if URL is from a supported library first
      if (url && url.trim() !== "" && url.toLowerCase() !== "n/a") {
        const config = await loadStatuteLibraryConfig();
        const library = getLibraryForUrl(url, config);
        if (library && !library.download) {
          console.log(
            `  ⚠️  Library not supported: ${library.name} - ${library.notes}`,
          );
          console.log(`      URL: ${url}`);
          logToFile(
            `Skipped ${municipalityName}/${domain}: ${library.name} library not supported - ${url}`,
          );
          continue;
        }
      }

      // Handle cases where no URL is determined (blank cell)
      if (!url || url.trim() === "" || url.toLowerCase() === "n/a") {
        console.log(
          `  📝 No URL determined for ${domain} - cell is blank or invalid`,
        );

        // Check if metadata.json exists and clear sourceUrl
        if (await fs.pathExists(metadataPath)) {
          try {
            const existingMetadata = await fs.readJson(metadataPath);
            if (existingMetadata.sourceUrl) {
              existingMetadata.sourceUrl = "";
              await fs.writeJson(metadataPath, existingMetadata, { spaces: 2 });
              console.log(
                `  📝 Cleared sourceUrl in metadata.json for ${municipalityName} (${domain})`,
              );
              logToFile(
                `Cleared sourceUrl in metadata.json for ${municipalityName} (${domain}) - no URL determined`,
              );
            }
          } catch (error) {
            console.warn(
              `  ⚠️  Could not update metadata.json: ${error.message}`,
            );
          }
        }

        // Remove statute files if they exist
        let filesRemoved = false;
        if (await fs.pathExists(filePath)) {
          if (noDeleteMode) {
            console.log(
              `  🚫 Would remove statute.txt (--nodelete mode: file preserved)`,
            );
          } else {
            await fs.remove(filePath);
            console.log(
              `  🗑️  Removed statute.txt for ${municipalityName} (${domain}) - no URL available`,
            );
            logToFile(
              `Removed statute.txt for ${municipalityName} (${domain}) - no URL available`,
            );
            filesRemoved = true;
          }
        }

        if (await fs.pathExists(htmlPath)) {
          if (noDeleteMode) {
            console.log(
              `  🚫 Would remove statute.html (--nodelete mode: file preserved)`,
            );
          } else {
            await fs.remove(htmlPath);
            console.log(
              `  🗑️  Removed statute.html for ${municipalityName} (${domain}) - no URL available`,
            );
            logToFile(
              `Removed statute.html for ${municipalityName} (${domain}) - no URL available`,
            );
            filesRemoved = true;
          }
        }

        if (
          !filesRemoved &&
          !(await fs.pathExists(filePath)) &&
          !(await fs.pathExists(htmlPath))
        ) {
          console.log(
            `  ✅ No statute files found to remove for ${municipalityName} (${domain})`,
          );
        }

        continue;
      }

      // Compare determined URL with existing metadata
      let shouldUpdateDueToUrlChange = false;
      if (await fs.pathExists(metadataPath)) {
        try {
          const existingMetadata = await readMetadata(metadataPath);
          const existingUrl = existingMetadata ? getSourceUrl(existingMetadata) || "" : "";

          if (reloadMode) {
            shouldUpdateDueToUrlChange = true;
            console.log(`  🔄 Reload mode enabled - will regenerate metadata for ${municipalityName} (${domain})`);
            logToFile(
              `Reload mode - regenerating metadata for ${municipalityName} (${domain})`,
            );
          } else if (existingUrl !== url) {
            shouldUpdateDueToUrlChange = true;
            console.log(`  🔄 URL changed for ${municipalityName} (${domain})`);
            console.log(`    Old URL: ${existingUrl || "(none)"}`);
            console.log(`    New URL: ${url}`);
            logToFile(
              `URL changed for ${municipalityName} (${domain}) from "${existingUrl}" to "${url}"`,
            );
          } else {
            console.log(
              `  ✅ URL unchanged for ${municipalityName} (${domain}): ${url}`,
            );
          }
        } catch (error) {
          console.warn(
            `  ⚠️  Could not read existing metadata, treating as new: ${error.message}`,
          );
          shouldUpdateDueToUrlChange = true;
        }
      } else {
        console.log(
          `  📝 No existing metadata found for ${municipalityName} (${domain}), will create new`,
        );
        shouldUpdateDueToUrlChange = true;
      }

      // Check if metadata.json is missing and create it if statute.txt exists
      console.log("checking for missing metadata.json");
      if (
        (await fs.pathExists(filePath)) &&
        !(await fs.pathExists(metadataPath))
      ) {
        console.log(
          `  ${domain}: Creating missing metadata.json for existing statute file`,
        );
        const statuteStats = await fs.stat(filePath);
        const statuteContent = await fs.readFile(filePath, "utf-8");

        // Create metadata based on available information
        const mappedDomainForMissingMetadata = DOMAIN_MAPPING[domain] || domain;
        const missingMetadata = {
          municipality: municipalityName,
          municipalityType: municipalityType,
          domain: getDomainDisplayName(domain),
          domainId: domain
            .toLowerCase()
            .replace(/\s+/g, "-"),
          sourceUrl: url,
          originalCellValue: cellText || url,
          downloadedAt:
            statuteStats.birthtime?.toISOString() ||
            statuteStats.mtime.toISOString(),
          contentLength: statuteContent.length,
          stateCodeApplies:
            cellText?.toLowerCase().includes("ny state") || false,
        };

        await fs.writeJson(metadataPath, missingMetadata, { spaces: 2 });
        console.log(
          `  Created missing metadata.json for ${municipalityName} - ${municipalityType} (${domain})`,
        );
      }

      // Check if file already exists and is recent, or if metadata indicates retroactive creation
      let shouldForceUpdate = false;

      if (await fs.pathExists(filePath)) {
        const stats = await fs.stat(filePath);
        const daysSinceUpdate =
          (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);

        // Check if metadata indicates retroactive creation (missing real source URL)
        if (await fs.pathExists(metadataPath)) {
          try {
            const existingMetadata = await fs.readJson(metadataPath);
            if (!existingMetadata.sourceUrl) {
              shouldForceUpdate = true;
              console.log(
                `  ${domain}: Forcing update - metadata was created retroactively without real source URL`,
              );
            }
          } catch (error) {
            console.warn(
              `  ${domain}: Could not read existing metadata, proceeding with normal checks`,
            );
          }
        }

        // Check all conditions for when to download/update
        if (
          !shouldForceUpdate &&
          !shouldUpdateDueToUrlChange &&
          !forceMode &&
          !reloadMode &&
          !noDownloadMode &&
          daysSinceUpdate < 30
        ) {
          console.log(
            `  ${domain}: File exists, is recent, and URL unchanged - skipping`,
          );
          continue;
        }

        if (shouldUpdateDueToUrlChange && reloadMode) {
          console.log(`  ${domain}: Updating due to reload mode - regenerating from source`);
        } else if (shouldUpdateDueToUrlChange) {
          console.log(`  ${domain}: Updating due to URL change`);
        } else if (shouldForceUpdate) {
          console.log(
            `  ${domain}: Updating statute with real source URL: ${url}`,
          );
        } else if (forceMode) {
          console.log(
            `  ${domain}: Force mode enabled, redownloading existing file`,
          );
        } else if (reloadMode) {
          console.log(`  ${domain}: Reload mode enabled, redownloading from source`);
        } else {
          console.log(`  ${domain}: File is older than 30 days, updating`);
        }
      } else if (shouldUpdateDueToUrlChange) {
        console.log(
          `  ${domain}: Creating new statute file with determined URL`,
        );
      }

      // Skip download if noDownloadMode is enabled
      if (noDownloadMode) {
        console.log(
          `  ${domain}: Skipping download (--nodownload mode), validating existing files`,
        );
        logToFile(
          `Skipping download for ${cleanName}/${domain} due to --nodownload mode`,
        );

        // Validate existing statute file if it exists
        if (await fs.pathExists(filePath)) {
          const validation = await validateMunicipalityRelevance(
            filePath,
            municipalityName,
            municipalityType,
            domain,
          );
          if (!validation.isValid) {
            if (noDeleteMode) {
              console.log(
                `🚫  Validation failed for ${municipalityName} (${domain}): ${validation.reason} [--nodelete mode: file preserved]`,
              );
              logToFile(
                `❌ Validation failed for ${municipalityName} (${domain}): ${validation.reason} [--nodelete mode: file preserved]`,
              );
            } else {
              await cleanupInvalidStatute(
                dirPath,
                municipalityName,
                domain,
                validation.reason || "Unknown validation error",
              );
            }
          }
        } else {
          console.log(`  ${domain}: No existing statute file to validate`);
          logToFile(
            `No existing statute file to validate for ${cleanName}/${domain}`,
          );
        }
        continue;
      }

      // Add delay between downloads to be respectful
      if (downloadCount > 0) {
        console.log(`  Waiting ${DELAY_BETWEEN_DOWNLOADS / 1000} seconds...`);
        await delay(DELAY_BETWEEN_DOWNLOADS);
      }

      const content = await downloadFromUrl(url);

      if (content) {
        // Detect content type and save with appropriate extension
        const contentType = await getContentTypeFromUrl(url);
        // Enhanced PDF detection with byte sniffing after content is downloaded
        const isPdf = isContentPdf(content, contentType, url);
        
        let originalFilePath: string;
        if (isPdf) {
          originalFilePath = path.join(dirPath, "statute.pdf");
          // For PDFs stored as base64, we need to decode and save as binary
          const buffer = Buffer.from(content, 'base64');
          await fs.writeFile(originalFilePath, buffer);
          console.log(`  Saved PDF source: ${originalFilePath}`);
        } else {
          originalFilePath = path.join(dirPath, "statute.html");
          await fs.writeFile(originalFilePath, content, "utf-8");
          console.log(`  Saved HTML source: ${originalFilePath}`);
        }

        let plainTextContent: string;
        let sourceUrls: ArticleLink[] | undefined;

        if (isPdf) {
          // For PDFs, use PDF parsing to extract text
          try {
            const pdfParse = await import('pdf-parse');
            const buffer = Buffer.from(content, 'base64');
            const pdfData = await pdfParse.default(buffer);
            plainTextContent = pdfData.text;
            console.log(`  📄 Extracted ${plainTextContent.length} characters from PDF`);
          } catch (error) {
            console.log(`  ⚠️  Failed to parse PDF, treating as empty: ${error.message}`);
            plainTextContent = "";
          }
        } else {
          // Check if this is an article-based page that needs special processing
          const { isArticleBased, articles } = detectArticleBasedPage(
            content,
            url,
          );

          if (isArticleBased && articles.length > 0) {
            console.log(
              `  📚 Processing article-based statute with ${articles.length} articles`,
            );
          const articleResult = await downloadAndStitchArticles(articles);
          plainTextContent = articleResult.content;
          sourceUrls = articleResult.sourceUrls;

          if (!plainTextContent || plainTextContent.length < 100) {
            console.log(
              `  ⚠️  Article stitching resulted in insufficient content, falling back to main page`,
            );
            plainTextContent = convertHtmlToText(content);
            sourceUrls = undefined;
          } else {
            console.log(
              `  ✅ Successfully stitched ${sourceUrls.length} articles into ${plainTextContent.length} characters`,
            );
          }
        } else {
          // Regular single-page processing - check for anchor in URL
          const anchorMatch = url.match(/#(.+)$/);
          const anchorId = anchorMatch ? anchorMatch[1] : undefined;

          if (anchorId) {
            console.log(`  🎯 Processing URL with anchor: ${anchorId}`);
          }

          plainTextContent = convertHtmlToText(content, anchorId);
        }
        }

        await fs.writeFile(filePath, plainTextContent, "utf-8");

        // Extract statute number and title from HTML
        const htmlPath = path.join(dirPath, "statute.html");
        let statuteTitle = getDomainDisplayName(domain);
        let statuteNumber: string | undefined;
        
        if (await fs.pathExists(htmlPath)) {
          const statuteInfo = await extractStatuteInfo(htmlPath);
          if (statuteInfo.number || statuteInfo.title) {
            console.log(`  📋 Extracted statute info: ${statuteInfo.number || "N/A"} - ${statuteInfo.title || "N/A"}`);
            if (statuteInfo.number) statuteNumber = statuteInfo.number;
            if (statuteInfo.title) statuteTitle = statuteInfo.title;
          }
        }

        // Read existing metadata first, then merge instead of overwriting
        let metadata: Metadata = await readMetadata(metadataPath) || {
          municipality: cleanName,
          municipalityType: cleanType,
          domain: getDomainDisplayName(domain),
          domainId: domain.toLowerCase().replace(/\s+/g, "-"),
          sources: [],
          originalCellValue: cellText || url,
          originalHtmlLength: content.length,
          stateCodeApplies: false,
        };

        // Update core fields from current processing
        metadata.municipality = cleanName;
        metadata.municipalityType = cleanType;
        metadata.domain = getDomainDisplayName(domain);
        metadata.domainId = domain.toLowerCase().replace(/\s+/g, "-");
        metadata.originalCellValue = cellText || url;
        metadata.originalHtmlLength = content.length;

        // Add or update primary source (preserves existing sources like form/guidance)
        addOrUpdateSource(metadata, {
          downloadedAt: new Date().toISOString(),
          contentLength: plainTextContent.length,
          sourceUrl: url,
          title: statuteTitle,
          type: "statute"
        });

        // Add additional sources if this was an article-based page
        if (sourceUrls && sourceUrls.length > 0) {
          for (const sourceUrlObj of sourceUrls) {
            if (sourceUrlObj.url && sourceUrlObj.url !== url) {
              addOrUpdateSource(metadata, {
                downloadedAt: new Date().toISOString(),
                contentLength: 0,
                sourceUrl: sourceUrlObj.url,
                title: sourceUrlObj.title || "Article",
                type: "statute"
              });
            }
          }
          metadata.isArticleBased = true;
          console.log(`  📄 Added ${sourceUrls.length} article URLs to sources`);
        }

        // Add statute number if extracted
        if (statuteNumber) {
          metadata.statuteNumber = statuteNumber;
        }

        await writeMetadata(metadataPath, metadata);

        // Process any undownloaded sources in the metadata
        await processUndownloadedSources(dirPath, metadata, cleanName, realm.type);

        // Create analysis.json with grade information only if it doesn't exist
        const analysisPath = path.join(dirPath, "analysis.json");
        
        if (!(await fs.pathExists(analysisPath))) {
          const analysisData = {
            municipality: `${cleanName} - ${cleanType}`,
            domain: getDomainDisplayName(domain),
            grade: grade,
            gradeColor: getGradeColor(grade),
            lastUpdated: new Date().toISOString(),
          };

          await fs.writeJson(analysisPath, analysisData, { spaces: 2 });
          console.log(`  Created analysis.json with grade: ${grade || "None"}`);
        } else {
          console.log(`  Preserved existing analysis.json (contains ${grade || "no"} grade)`);
        }

        console.log(
          `  ${domain}: Downloaded and saved (${plainTextContent.length} characters plain text)`,
        );
        logToFile(
          `Successfully downloaded ${cleanName}/${domain}: ${plainTextContent.length} characters`,
        );

        // Validate the downloaded content
        const validation = await validateMunicipalityRelevance(
          filePath,
          cleanName,
          cleanType,
          domain,
        );
        if (!validation.isValid) {
          await cleanupInvalidStatute(
            dirPath,
            cleanName,
            domain,
            validation.reason || "Unknown validation error",
          );
        }
      } else {
        console.log(`  ${domain}: Failed to download`);
        logToFile(`Failed to download ${cleanName}/${domain} from ${url}`);
      }

      downloadCount++;
    }
  }

  console.log(`Extraction complete! Downloaded ${downloadCount} statute files`);

  // Generate comprehensive summary file
  if (municipalityFilter === "") 
    await generateSummaryFile(realm);
}

async function generateSummaryFile(realm: Realm): Promise<void> {
  console.log(
    `\n📊 Generating ${realm.id}-summary.json summary...`,
  );

  const dataDir = path.join(getProjectDataDir(), realm.datapath);
  const summaryPath = path.join(
    dataDir,
    `${realm.id}-summary.json`,
  );

  // Read entity data (municipalities or school-districts)
  const entityPath = path.join(dataDir, realm.entityFile);
  let entityData: any = {};

  if (await fs.pathExists(entityPath)) {
    entityData = await fs.readJson(entityPath);
  }

  // Handle different possible data structures
  let entities: any[] = [];
  if (Array.isArray(entityData)) {
    entities = entityData;
  } else if (entityData[realm.entityType] && Array.isArray(entityData[realm.entityType])) {
    entities = entityData[realm.entityType];
  } else if (typeof entityData === 'object' && Object.keys(entityData).length > 0) {
    // If it's an object with entity IDs as keys, convert to array
    entities = Object.values(entityData);
  } else {
    console.warn(`Warning: No valid ${realm.entityType} data found, creating empty summary`);
    entities = [];
  }

  console.log(`Found ${entities.length} ${realm.entityType} to process`);
  const summary: any[] = [];

  for (const entity of entities) {
    // Ensure entity has required properties
    if (!entity || typeof entity !== 'object' || !entity.id) {
      console.warn(`Skipping invalid ${realm.entityType.slice(0, -1)} data:`, entity);
      continue;
    }

    const entityData: any = {
      id: entity.id,
      name: entity.name || entity.id,
      displayName: entity.displayName || entity.name || entity.id,
      domains: {},
    };

    // Check each domain for this entity
    for (const domain of realm.domains) {
      const domainDir = domain.toLowerCase().replace(/\s+/g, "-");
      const entityDir = path.join(dataDir, domainDir, entity.id);

      if (await fs.pathExists(entityDir)) {
        const statutePath = path.join(entityDir, `statute${realm.type}`);
        const metadataPath = path.join(entityDir, "metadata.json");

        if (
          (await fs.pathExists(statutePath)) ||
          (await fs.pathExists(metadataPath))
        ) {
          const domainData: any = {};

          // Read metadata if it exists
          if (await fs.pathExists(metadataPath)) {
            try {
              const metadata = await readMetadata(metadataPath);
              if (metadata) {
                domainData.sourceUrl = getSourceUrl(metadata);
                domainData.lastDownloadTime = getDownloadedAt(metadata);
                domainData.isArticleBased = metadata.isArticleBased || false;
                domainData.usesStateCode = metadata.stateCodeApplies || false;

                // Count sources for article count
                if (metadata.sources && metadata.sources.length > 1) {
                  domainData.articleCount = metadata.sources.length;
                  domainData.sourceUrls = metadata.sources.map(s => ({ url: s.sourceUrl, title: s.title }));
                }
              }
            } catch (error) {
              console.log(
                `  Warning: Could not read metadata for ${entity.id}/${domain}: ${error.message}`,
              );
            }
          }

          // Read statute file if it exists
          if (await fs.pathExists(statutePath)) {
            try {
              const statuteContent = await fs.readFile(statutePath, "utf-8");
              const wordCount = statuteContent
                .split(/\s+/)
                .filter((word) => word.length > 0).length;
              domainData.wordCount = wordCount;
              domainData.characterCount = statuteContent.length;
            } catch (error) {
              console.log(
                `  Warning: Could not read statute file for ${entity.id}/${domain}: ${error.message}`,
              );
              domainData.wordCount = 0;
              domainData.characterCount = 0;
            }
          } else if (domainData.usesStateCode) {
            // For state code municipalities, reference the shared NY-State file
            const stateStatutePath = path.join(
              dataDir,
              realm.datapath,
              domainDir,
              "NY-State",
              "statute.txt",
            );
            if (await fs.pathExists(stateStatutePath)) {
              try {
                const statuteContent = await fs.readFile(
                  stateStatutePath,
                  "utf-8",
                );
                const wordCount = statuteContent
                  .split(/\s+/)
                  .filter((word) => word.length > 0).length;
                domainData.wordCount = wordCount;
                domainData.characterCount = statuteContent.length;
                domainData.referencesStateFile = true;
              } catch (error) {
                domainData.wordCount = 0;
                domainData.characterCount = 0;
              }
            }
          } else {
            domainData.wordCount = 0;
            domainData.characterCount = 0;
          }

          entityData.domains[domain] = domainData;
        }
      }
    }

    // Only add entity if it has data for at least one domain
    if (Object.keys(entityData.domains).length > 0) {
      summary.push(entityData);
    }
  }

  // Sort entities by name for consistent output
  summary.sort((a, b) => a.name.localeCompare(b.name));

  // Add metadata about the summary
  const summaryWithMetadata = {
    generated: new Date().toISOString(),
    [`total${realm.entityType.charAt(0).toUpperCase()}${realm.entityType.slice(1)}`]: summary.length,
    availableDomains: realm.domains,
    summary: summary,
  };

  await fs.writeJson(summaryPath, summaryWithMetadata, { spaces: 2 });

  console.log(
    `✅ Generated summary file: ${path.relative(getProjectRootDir(), summaryPath)}`,
  );
  console.log(`   📍 Total ${realm.entityType} with data: ${summary.length}`);
  console.log(`   📂 Total domains checked: ${realm.domains.length}`);

  // Generate summary statistics
  const domainStats: { [domain: string]: number } = {};
  let totalStatutes = 0;
  let totalWords = 0;
  let articleBasedCount = 0;
  let stateCodeCount = 0;

  for (const municipality of summary) {
    for (const [domain, data] of Object.entries(municipality.domains)) {
      domainStats[domain] = (domainStats[domain] || 0) + 1;
      totalStatutes++;
      totalWords += (data as any).wordCount || 0;
      if ((data as any).isArticleBased) articleBasedCount++;
      if ((data as any).usesStateCode) stateCodeCount++;
    }
  }

  console.log(`   📊 Domain distribution:`);
  for (const [domain, count] of Object.entries(domainStats)) {
    console.log(`      ${domain}: ${count} municipalities`);
  }
  console.log(`   📝 Total statutes: ${totalStatutes}`);
  console.log(`   🔤 Total words: ${totalWords.toLocaleString()}`);
  console.log(`   📚 Article-based statutes: ${articleBasedCount}`);
  console.log(`   🏛️ State code references: ${stateCodeCount}`);
}

function getDomainDisplayName(domain: string): string {
  const displayNames: Record<string, string> = {
    Trees: "Trees & Urban Forestry",
    GLB: "Gas Leaf Blowers",
    "Wetland Protection": "Wetland Protection",
    "Dark Sky": "Dark Sky Protection",
    Weeds: "Weed Management", // Domain using weeds directory
    "Cluster Zoning": "Cluster Zoning",
    "Flood Damage Protection": "Flood Damage Protection",
    "Solar 1": "Solar Energy",
    Slopes: "Slope Protection",
  };
  return displayNames[domain] || domain;
}

function getDomainDescription(domain: string): string {
  const descriptions: Record<string, string> = {
    Trees: "Tree removal, planting, and maintenance regulations",
    GLB: "Gas-powered leaf blower regulations and restrictions",
    "Wetland Protection": "Wetland conservation and protection ordinances",
    "Dark Sky": "Light pollution control and dark sky protection",
    Weeds:
      "Weed control, noxious plant management, and vegetation regulations", // Updated description
    "Cluster Zoning": "Cluster development and conservation zoning regulations",
    "Flood Damage Protection": "Flood prevention and damage control ordinances",
    "Solar 1": "Solar installation and renewable energy regulations",
    Slopes: "Steep slope development and erosion control regulations",
  };
  return descriptions[domain] || `${domain} municipal regulations`;
}

// Global verbose flag
let VERBOSE_MODE = false;

function verboseLog(...args: any[]): void {
  if (VERBOSE_MODE) {
    console.log("[VERBOSE]", ...args);
  }
}

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1,
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

function findSimilarFlags(unknownFlag: string, validFlags: string[]): string[] {
  return validFlags
    .map((flag) => ({
      flag,
      distance: levenshteinDistance(unknownFlag, flag),
    }))
    .filter(({ distance }) => distance <= 3) // Allow up to 3 character differences
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3) // Show top 3 suggestions
    .map(({ flag }) => flag);
}

async function createDirectoryStructureFromJSON(
  realm: Realm, 
  targetDomain?: string,
  entitiesToInclude?: Set<string>
): Promise<void> {
  console.log("\n🏗️  Creating directory structure from JSON data...");
  
  if (!realm.dataSource.path) {
    throw new Error(`JSON file path not configured for realm ${realm.id}`);
  }
  
  const filePath = path.join(getProjectRootDir(), realm.dataSource.path);
  const jsonData = await fs.readJson(filePath);
  const dataDir = path.join(getProjectDataDir(), realm.datapath);
  
  let processedCount = 0;
  let directoryCount = 0;
  
  for (const districtData of jsonData) {
    const districtName = districtData.name;
    
    // Use the ID directly from the source JSON file
    const entityId = districtData.id;
    if (!entityId) {
      console.warn(`⚠️ No ID found for district: ${districtName}. Skipping...`);
      continue;
    }
    
    // Apply entity filter if specified
    if (entitiesToInclude) {
      const shouldProcess = entitiesToInclude.has(districtName.toLowerCase());
      if (!shouldProcess) {
        console.log(`  Skipping filtered district: ${districtName}`);
        continue;
      }
    }
    
    console.log(`  Processing district: ${districtName} (${entityId})`);
    
    // Group policies by category/domain - expecting only one policy per domain
    const policiesByDomain: { [domain: string]: any } = {};
    for (const policy of districtData.policies || []) {
      const domain = policy.category;
      if (policiesByDomain[domain]) {
        console.warn(`  ⚠️  Multiple policies found for domain ${domain} in ${districtName}, using the first one`);
        continue;
      }
      policiesByDomain[domain] = policy;
    }
    
    // Only process domains that have policies
    const availableDomains = Object.keys(policiesByDomain);
    for (const domain of availableDomains) {
      // Skip if targeting specific domain and this isn't it
      if (targetDomain && domain !== targetDomain) {
        continue;
      }
      
      // Create domain directory structure
      const domainDir = path.join(dataDir, domain, entityId);
      await fs.ensureDir(domainDir);
      directoryCount++;
      
      console.log(`    Created domain directory: ${domain}/${entityId}`);
      
      // Get the single policy for this domain
      const policy = policiesByDomain[domain];
      
      // Validate policy URL if present
      let sourceUrl = policy.policy_url || districtData.url;
      let isValidUrl = false;
      
      if (sourceUrl) {
        try {
          new URL(sourceUrl);
          isValidUrl = true;
        } catch {
          console.log(`    ⚠️  Invalid URL format: ${sourceUrl}`);
          isValidUrl = false;
        }
      }
      
      // Create metadata.json file with policy information
      const metadata: any = {
        districtName: districtName,
        entityId: entityId,
        domain: domain,
        sourceUrl: sourceUrl,
        policyNumber: policy.policy_number || null,
        policyTitle: policy.policy_title || null,
        downloadedAt: new Date().toISOString(),
        realm: realm.id
      };
      
      await fs.writeJson(path.join(domainDir, "metadata.json"), metadata, { spaces: 2 });
      
      // Download policy URL if valid
      if (isValidUrl && sourceUrl) {
        try {
          console.log(`      Downloading policy: ${policy.policy_title || 'Untitled'}`);
          
          // Download content with binary support for both HTML and PDF
          const response = await axios.get(sourceUrl, {
            timeout: 30000,
            responseType: 'arraybuffer', // Handle both HTML and PDF
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; MunicipalityCrawler/1.0)'
            }
          });
          
          // Detect content type with enhanced PDF detection
          const contentType = response.headers["content-type"] || '';
          const isPdf = isContentPdf(response.data, contentType, sourceUrl);
          
          let textContent: string;
          
          if (isPdf) {
            console.log(`        📄 Processing PDF policy document...`);
            
            // Save as policy.pdf
            const policyPdfPath = path.join(domainDir, 'policy.pdf');
            await fs.writeFile(policyPdfPath, response.data);
            console.log(`        💾 Saved PDF: ${policyPdfPath}`);
            
            // Extract text from PDF
            try {
              const pdfParse = await import('pdf-parse');
              const pdfData = await pdfParse.default(response.data);
              textContent = pdfData.text;
              console.log(`        📄 Extracted ${textContent.length} characters from PDF`);
              
              // Clean up PDF text similar to HTML cleaning
              textContent = textContent.replace(/\r\n/g, '\n');
              textContent = textContent.replace(/\n{3,}/g, '\n\n');
              textContent = textContent.replace(/[ \t]{2,}/g, ' ');
              textContent = textContent.replace(/\n /g, '\n');
              textContent = textContent.trim();
            } catch (pdfError) {
              console.warn(`        ⚠️  Failed to parse PDF, using empty content: ${pdfError.message}`);
              textContent = '';
            }
          } else {
            console.log(`        📄 Processing HTML policy document...`);
            
            // Convert response data to string for HTML processing
            const htmlContent = Buffer.from(response.data).toString('utf-8');
            
            // Clean HTML by removing STYLE and SCRIPT elements
            const virtualConsole = new VirtualConsole();
            virtualConsole.sendTo(console, { omitJSDOMErrors: true });
            const dom = new JSDOM(htmlContent, { virtualConsole });
            const document = dom.window.document;
            const elementsToRemove = document.querySelectorAll("script, style");
            elementsToRemove.forEach((element) => element.remove());
            const cleanedHtml = dom.serialize();
            
            // Save as policy.html
            const policyHtmlPath = path.join(domainDir, 'policy.html');
            await fs.writeFile(policyHtmlPath, cleanedHtml, 'utf-8');
            console.log(`        💾 Saved HTML: ${policyHtmlPath}`);
            
            // Convert HTML to text focusing on semantic content
            textContent = convertHtmlToText(htmlContent);
          }
          
          // Save as policy.txt (for both HTML and PDF)
          const policyTxtPath = path.join(domainDir, 'policy.txt');
          await fs.writeFile(policyTxtPath, textContent, 'utf-8');
          console.log(`        📝 Saved text content: ${policyTxtPath} (${textContent.length} characters)`);
          
          // Update metadata with content information through sources
          addOrUpdateSource(metadata, {
            downloadedAt: metadata.downloadedAt || new Date().toISOString(),
            contentLength: textContent.length,
            sourceUrl: sourceUrl,
            title: metadata.statuteTitle || metadata.policyTitle || metadata.domain || (isPdf ? "PDF Document" : "HTML Document"),
            type: "statute"
          });
          metadata.lastConverted = new Date().toISOString();
          
          // If PDF, add additional metadata
          if (isPdf && textContent.length > 0) {
            try {
              const pdfParse = await import('pdf-parse');
              const pdfData = await pdfParse.default(response.data);
              metadata.pdfPages = pdfData.numpages;
            } catch {
              // If PDF parsing failed for metadata, continue without page count
            }
          }
          
          // Save updated metadata
          await writeMetadata(path.join(domainDir, "metadata.json"), metadata);
          
          // Process any undownloaded sources in the metadata  
          await processUndownloadedSources(domainDir, metadata, districtName, realm.type);
          
          console.log(`        ✅ Downloaded and converted: ${policy.policy_title || 'Untitled'}`);
          
          // Add small delay between downloads to be respectful
          await delay(1000);
          
        } catch (error) {
          // Handle HTTP errors specially
          if (error.response && error.response.status) {
            const httpCode = error.response.status;
            const failedUrl = `FAILED HTTP ${httpCode} ${sourceUrl}`;
            console.warn(`        ⚠️ HTTP ${httpCode} error downloading ${sourceUrl}`);
            
            // Update metadata with failed URL through sources
            addOrUpdateSource(metadata, {
              downloadedAt: new Date().toISOString(),
              contentLength: 0,
              sourceUrl: failedUrl,
              title: "Failed Download",
              type: "statute"
            });
            await writeMetadata(path.join(domainDir, "metadata.json"), metadata);
            
            logToFile(`HTTP ${httpCode} error downloading ${sourceUrl}`);
          } else {
            console.warn(`        ⚠️ Failed to download policy URL ${sourceUrl}: ${error.message}`);
            logToFile(`Failed to download policy URL ${sourceUrl}: ${error.message}`);
          }
        }
      } else if (sourceUrl) {
        console.log(`      Skipping download - invalid URL format: ${sourceUrl}`);
      }
      
      console.log(`      Created policy metadata in ${domain}/${entityId}`);
    }
    
    processedCount++;
  }
  
  console.log(`✅ Created directories for ${processedCount} districts across ${directoryCount} domain/entity combinations`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Default WEN spreadsheet URL from environment or hardcoded fallback
  const defaultWenUrl =
    process.env.WEN_SPREADSHEET_URL ||
    "https://docs.google.com/spreadsheets/d/1Nc5xZZ9OrRgI2pnGjlBmo7yvpiQELYSEp19e73Gl_UE/edit?gid=2126758775#gid=2126758775";

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
      const flagName = unknownFlag.split("=")[0]; // Remove value part if present
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

  // Parse arguments: [--realm=<realm>] [--domain=<domain>] [--municipality-filter=<filter>] [--verbose/-v] [--force] [--nodownload] [--cleanup]
  let targetDomain: string | undefined;
  let municipalityFilter: string | undefined;
  let forceMode = false;
  let noDownloadMode = false;
  let noDeleteMode = false;
  let cleanupMode = false;
  let entitiesToInclude: Set<string> | undefined;

  // Check for verbose flag
  VERBOSE_MODE = args.includes("--verbose") || args.includes("-v");
  if (VERBOSE_MODE) {
    console.log(
      "Verbose mode enabled - HTTP requests and responses will be logged",
    );
  }

  // Check for force flag
  forceMode = args.includes("--force");
  if (forceMode) {
    console.log(
      "Force mode enabled - will redownload files even if they exist and are recent",
    );
  }

  // Check for nodownload flag
  noDownloadMode = args.includes("--nodownload");
  if (noDownloadMode) {
    console.log(
      "No download mode enabled - will validate existing files without downloading new ones",
    );
  }

  // Check for nodelete flag
  noDeleteMode = args.includes("--nodelete");
  if (noDeleteMode) {
    console.log(
      "No delete mode enabled - will report validation issues but not delete files",
    );
  }

  // Check for reload flag
  const reloadMode = args.includes("--reload");
  if (reloadMode) {
    console.log(
      "Reload mode enabled - will reload entity data from source instead of reusing existing metadata.json",
    );
  }

  // Check for cleanup flag
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

  // Check for domain parameter
  const domainArg = args.find((arg) => arg.startsWith("--domain="));
  if (domainArg) {
    targetDomain = domainArg.split("=")[1];
  }

  // Check for municipality filter parameter
  const municipalityFilterArg = args.find((arg) =>
    arg.startsWith("--municipality-filter="),
  );
  if (municipalityFilterArg) {
    municipalityFilter = municipalityFilterArg.split("=")[1];
    if (VERBOSE_MODE) {
      console.log(`Municipality filter enabled: ${municipalityFilter}`);
    }
  }

  // Check for realm parameter - first check environment variable, then command line
  let targetRealm: string | null = null;
  
  // First check CURRENT_REALM environment variable
  if (process.env.CURRENT_REALM) {
    targetRealm = process.env.CURRENT_REALM;
    console.log(`📖 Read CURRENT_REALM environment variable: ${targetRealm}`);
  }
  
  // Command line --realm parameter overrides environment variable
  const realmArg = args.find((arg) => arg.startsWith("--realm="));
  if (realmArg) {
    targetRealm = realmArg.split("=")[1];
    // Set environment variable when --realm is provided
    process.env.CURRENT_REALM = targetRealm;
    console.log(`💾 Set CURRENT_REALM environment variable from --realm parameter: ${targetRealm}`);
    if (VERBOSE_MODE) {
      console.log(`Target realm: ${targetRealm}`);
    }
  } else {
    // Handle --realm value format (without =)
    const realmIndex = args.findIndex((arg) => arg === "--realm");
    if (realmIndex !== -1 && realmIndex + 1 < args.length) {
      targetRealm = args[realmIndex + 1];
      // Set environment variable when --realm is provided
      process.env.CURRENT_REALM = targetRealm;
      console.log(`💾 Set CURRENT_REALM environment variable from --realm parameter: ${targetRealm}`);
      if (VERBOSE_MODE) {
        console.log(`Target realm: ${targetRealm}`);
      }
    }
  }

  // No input URL/file needed - using realm-based data sources

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage:");
    console.log(
      "  tsx scripts/extractFromGoogleSheets.ts [google-sheets-url|csv-file-path] [options]",
    );
    console.log("");
    console.log("Parameters:");
    console.log("  google-sheets-url    Google Sheets URL to extract from");
    console.log("  csv-file-path        Local CSV file path");
    console.log("");
    console.log("Options:");
    console.log(
      "  --realm=<realm-id>             Target realm (westchester-municipal-environmental, westchester-schools)",
    );
    console.log(
      "  --domain=<domain>              Extract only specified domain (Trees, GLB, 'Wetland Protection', 'Dark Sky')",
    );
    console.log(
      "  --municipality-filter=<names>  Filter by municipality names (comma-separated)",
    );
    console.log(
      "  --verbose, -v                  Enable verbose logging (shows HTTP requests and responses)",
    );
    console.log(
      "  --force                        Force redownload files even if they exist and are recent",
    );
    console.log(
      "  --nodownload                   Skip downloads, only validate existing statute files",
    );
    console.log(
      "  --nodelete                     Skip deleting invalid files, only report validation issues",
    );
    console.log(
      "  --cleanup                      Cleanup mode: regenerate statute.txt files, remove backups, detect binary data",
    );
    console.log(
      "  --cleanup --force              Force cleanup: regenerate statute.txt from existing HTML without re-downloading",
    );
    console.log(
      "  --reload                       Reload entity data from source instead of reusing existing metadata.json",
    );
    console.log("  --help, -h                     Show this help message");
    console.log("");
    console.log(
      "If no URL is provided, will use WEN_SPREADSHEET_URL environment variable or default WEN spreadsheet",
    );
    console.log(
      "The script automatically checks for and creates missing metadata.json files for existing statute files.",
    );
    console.log("");
    console.log("Examples:");
    console.log(
      `  tsx scripts/extractEntityData.ts '${defaultWenUrl}' --verbose`,
    );
    console.log("  tsx scripts/extractEntityData.ts --domain=Trees -v");
    console.log("  tsx scripts/extractEntityData.ts --domain=GLB");
    console.log(
      "  tsx scripts/extractEntityData.ts --realm=westchester-schools --domain=overall -v",
    );
    console.log(
      `  tsx scripts/extractEntityData.ts '${defaultWenUrl}' --domain='Wetland Protection' --verbose`,
    );
    console.log(
      "  tsx scripts/extractEntityData.ts --domain='Property Maintenance' --municipality-filter='Ardsley,Bedford' -v",
    );
    console.log(
      "  tsx scripts/extractEntityData.ts ./data/source/municipalities.csv --domain=Trees -v",
    );
    console.log(
      "  tsx scripts/extractEntityData.ts --force --domain=Trees  # Force redownload trees domain",
    );
    console.log(
      "  tsx scripts/extractEntityData.ts --nodownload --domain=Trees  # Validate existing trees files only",
    );
    console.log(
      "  tsx scripts/extractEntityData.ts --nodelete --domain=Trees  # Check files but don't delete any",
    );
    console.log(
      "  tsx scripts/extractEntityData.ts --cleanup --domain=Trees  # Cleanup mode for trees domain",
    );
    console.log(
      "  tsx scripts/extractEntityData.ts --cleanup --force --domain=Trees  # Force regenerate statute.txt from existing HTML",
    );
    console.log(
      "  tsx scripts/extractEntityData.ts --reload --domain=Trees  # Reload Trees domain from source data",
    );
    console.log(
      "  tsx scripts/extractEntityData.ts  # Uses default WEN spreadsheet for all domains",
    );
    process.exit(0);
  }


  // Load realms configuration
  const realmsConfig = await loadRealmsConfig();
  let selectedRealm: Realm | null = null;
  
  if (targetRealm) {
    selectedRealm = getRealmById(targetRealm, realmsConfig);
    if (!selectedRealm) {
      console.error(`Error: Realm '${targetRealm}' not found.`);
      console.log('Available realms:');
      realmsConfig.realms.forEach(realm => {
        console.log(`  • ${realm.id}: ${realm.displayName}`);
      });
      process.exit(1);
    }
  } else {
    selectedRealm = getDefaultRealm(realmsConfig);
    if (!selectedRealm) {
      console.error('Error: No default realm found and no realm specified.');
      process.exit(1);
    }
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
      // Run cleanup mode instead of normal extraction
      await runCleanupMode(selectedRealm, targetDomain, municipalityFilter, forceMode);
    } else {
      let csvData: string;
      let hyperlinkData: Record<string, Record<string, string>> = {};

      if (selectedRealm.dataSource.type === 'google-sheets') {
        if (!selectedRealm.dataSource.url) {
          throw new Error(`Google Sheets URL not configured for realm ${selectedRealm.id}`);
        }
        // Only download fresh spreadsheet data if reload mode is enabled
        // Otherwise, rely on existing data and processSpreadsheetData will fetch what it needs
        if (reloadMode) {
          console.log("🔄 Reload mode: Fetching fresh spreadsheet data from source");
          // Extract from Google Sheets URL with hyperlinks
          const { csvData: extractedCsvData, hyperlinkData: extractedHyperlinks } =
            await extractGoogleSheetsWithHyperlinks(selectedRealm.dataSource.url, VERBOSE_MODE);
          csvData = extractedCsvData;
          hyperlinkData = extractedHyperlinks;
        } else {
          console.log("📂 Working with existing directories instead of downloading fresh spreadsheet data");
          // Set placeholder data - processSpreadsheetData will work with existing directories
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
        // For JSON files, we'll convert to CSV format for processing
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
  } catch (error) {
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

function getGradeColor(grade: string | null): string {
  switch (grade) {
    case "Very Good":
      return "#22c55e"; // Dark green
    case "Good":
      return "#84cc16"; // Light green
    case "Yellow":
      return "#eab308"; // Yellow
    case "Red":
      return "#ef4444"; // Red
    default:
      return "#6b7280"; // Gray for no grade
  }
}

// Function to check for binary data in text content
function hasBinaryData(content: string): boolean {
  // Check for null bytes and other common binary indicators
  const binaryPatterns = [
    /\x00/, // null bytes
    /[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/, // control characters except tab, newline, carriage return
  ];

  return binaryPatterns.some((pattern) => pattern.test(content));
}

// Extract statute number and title from HTML content
async function extractStatuteInfo(
  htmlPath: string,
): Promise<{ number?: string; title?: string }> {
  try {
    const htmlContent = await fs.readFile(htmlPath, "utf-8");
    const dom = new JSDOM(htmlContent);
    const document = dom.window.document;

    let statuteNumber = "";
    let statuteTitle = "";

    // Method 1: Try to extract from meta og:description tag
    const ogDescription = document.querySelector(
      'meta[property="og:description"]',
    );
    if (ogDescription) {
      const description = ogDescription.getAttribute("content") || "";
      // Look for pattern like "§ 300-51  [Amended 4-26-2022 by L.L. No. 1-2022] Tree preservation; legislative intent."
      // Also handle patterns like "§ 300-51 Tree preservation." and "Ch 93 Property maintenance"
      const patterns = [
        /^(§\s*[\d-]+[A-Z]*)\s*(?:\[[^\]]+\])?\s*([^;.]+)(?:[;.]|$)/, // With optional amendments and semicolon
        /^(§\s*[\d-]+[A-Z]*)\s+([A-Z][a-z\s]+?)(?:[;.]|$)/, // Simple format with proper title case
        /^(§\s*[\d-]+[A-Z]*)\s*[-–—]\s*([^.;]+)(?:[;.]|$)/, // With dash separator
        /^(Ch\s*[\d-]+[A-Z]*)\s*(?:\[[^\]]+\])?\s*([A-Z][^;.]*?)(?:[;.]|$)/, // Chapter format with optional amendments
        /^(Ch\s*[\d-]+[A-Z]*)\s+([A-Z][a-z\s]+?)(?:[;.]|$)/, // Simple chapter format
        /^(Chapter\s*[\d-]+[A-Z]*)\s*(?:\[[^\]]+\])?\s*([A-Z][^;.]*?)(?:[;.]|$)/, // Full "Chapter" word
      ];
      
      for (const pattern of patterns) {
        const match = description.match(pattern);
        if (match) {
          statuteNumber = match[1].trim();
          statuteTitle = match[2].trim();
          console.log(`📝 Extracted from og:description using pattern: ${pattern.toString()}`);
          break;
        }
      }
    }

    // Method 2: Try to extract from content structure (more reliable)
    // Always try DOM extraction if we don't have good results from Method 1
    if (!statuteNumber || !statuteTitle || statuteTitle === "N/A" || statuteTitle.length < 3 || statuteTitle.length > 50) {
      // Look for titleNumber and titleTitle classes
      const titleNumberEl = document.querySelector(".titleNumber");
      const titleTitleEl = document.querySelector(".titleTitle");

      if (titleNumberEl) {
        const numberText = titleNumberEl.textContent?.trim();
        if (numberText && (numberText.includes("§") || numberText.includes("Chapter") || numberText.includes("Ch"))) {
          statuteNumber = numberText;
          console.log(`📝 Extracted from DOM titleNumber: ${numberText}`);
        }
      }

      if (titleTitleEl) {
        const titleText = titleTitleEl.textContent?.trim();
        if (titleText && titleText.length > 0) {
          // Clean up the title by removing extra whitespace, trailing dots, and common prefixes
          statuteTitle = titleText
            .replace(/\s+/g, " ")
            .replace(/\.$/, "")
            .replace(/^(Article\s+\d+\s*[-–—]?\s*)/i, "") // Remove "Article X -" prefix
            .replace(/^(Chapter\s+\d+\s*[-–—]?\s*)/i, "") // Remove "Chapter X -" prefix
            .replace(/^(Section\s+\d+\s*[-–—]?\s*)/i, "") // Remove "Section X -" prefix
            .trim();
          console.log(`📝 Extracted from DOM titleTitle: "${titleText}" -> cleaned: "${statuteTitle}"`);
        }
      }
    }

    // Method 3: Fallback to data-full-title attribute
    if (!statuteNumber || !statuteTitle) {
      const fullTitleEl = document.querySelector("[data-full-title]");
      if (fullTitleEl) {
        const fullTitle = fullTitleEl.getAttribute("data-full-title") || "";
        // Parse various patterns
        const patterns = [
          /^(§\s*[\d-]+[A-Z]*):?\s*(.+)/, // "§ 300-51: Tree preservation."
          /^([\d-]+[A-Z]*)\s*[-–—]\s*(.+)/, // "300-51 - Tree preservation"
          /^Section\s+([\d-]+[A-Z]*)\s*[-–—]?\s*(.+)/i, // "Section 300-51 Tree preservation"
        ];
        
        for (const pattern of patterns) {
          const match = fullTitle.match(pattern);
          if (match) {
            if (!statuteNumber) {
              statuteNumber = match[1].includes('§') ? match[1].trim() : `§ ${match[1].trim()}`;
            }
            if (!statuteTitle) {
              statuteTitle = match[2].trim().replace(/[.;]$/, "");
            }
            console.log(`📝 Extracted from data-full-title using pattern: ${pattern.toString()}`);
            break;
          }
        }
      }
    }

    // Clean up extracted values
    if (statuteNumber) {
      // Normalize section symbol and spacing
      statuteNumber = statuteNumber.replace(/§\s*/, "§ ").trim();
    }

    // Validate statute title (should be 8 words or less, typically 1-3 words)
    if (statuteTitle) {
      const wordCount = statuteTitle.split(/\s+/).length;
      const hasProperCapitalization = /^[A-Z]/.test(statuteTitle); // Starts with capital
      
      if (wordCount > 8) {
        console.warn(`⚠️  Statute title too long (${wordCount} words): "${statuteTitle}"`);
        console.warn(`   This may indicate extraction error - typical titles are 1-3 words`);
        // Still return it but log the warning
      }
      
      if (!hasProperCapitalization) {
        console.warn(`⚠️  Statute title capitalization issue: "${statuteTitle}"`);
        console.warn(`   Expected proper capitalization (first letter uppercase)`);
      }
      
      // Additional validation for common extraction errors
      if (statuteTitle.length > 100) {
        console.warn(`⚠️  Statute title suspiciously long (${statuteTitle.length} chars), likely extraction error`);
        statuteTitle = ""; // Clear invalid title
      } else if (statuteTitle.includes('\n') || statuteTitle.includes('\t')) {
        console.warn(`⚠️  Statute title contains line breaks, likely extraction error: "${statuteTitle.substring(0, 50)}..."`);
        statuteTitle = statuteTitle.replace(/[\n\t\r]+/g, ' ').trim(); // Clean up but keep
      }
    }

    const result = {
      number: statuteNumber || undefined,
      title: statuteTitle || undefined,
    };

    // Log successful extraction with validation notes
    if (result.number || result.title) {
      console.log(`✅ Statute info extracted: ${result.number || 'No number'} - "${result.title || 'No title'}"`);
      if (result.title) {
        const wordCount = result.title.split(/\s+/).length;
        console.log(`   Title validation: ${wordCount} words ${wordCount <= 3 ? '✅' : wordCount <= 8 ? '⚠️' : '❌'}`);
      }
    } else {
      console.warn(`⚠️  No statute number or title extracted from ${htmlPath}`);
    }

    return result;
  } catch (error) {
    console.warn(
      `Warning: Could not extract statute info from ${htmlPath}: ${error.message}`,
    );
    return {};
  }
}

// Cleanup mode function
async function runCleanupMode(
  realm: Realm,
  targetDomain?: string,
  municipalityFilter?: string,
  forceMode: boolean = false,
): Promise<void> {
  console.log("\n🧹 Starting cleanup mode...");
  logToFile("Starting cleanup mode");

  const realmDir = path.join(getProjectDataDir(), realm.datapath);
  if (!(await fs.pathExists(realmDir))) {
    console.log(`  No realm directory found: ${realmDir}`);
    return;
  }
  const domains = await fs.readdir(realmDir);

  let processedCount = 0;
  let updatedCount = 0;
  let binaryDetectedCount = 0;

  // Filter domains if specified
  const domainsToProcess = targetDomain
    ? domains.filter((d) => d.toLowerCase() === targetDomain.toLowerCase())
    : domains;

  if (targetDomain && domainsToProcess.length === 0) {
    console.error(
      `Domain "${targetDomain}" not found. Available domains: ${domains.join(", ")}`,
    );
    return;
  }

  for (const domain of domainsToProcess) {
    const domainPath = path.join(realmDir, domain);
    const stat = await fs.stat(domainPath);

    if (
      !stat.isDirectory() ||
      domain.endsWith(".json") ||
      domain.endsWith(".csv")
    )
      continue;

    console.log(`\n📁 Processing domain: ${domain}`);

    const municipalities = await fs.readdir(domainPath);

    for (const municipality of municipalities) {
      if (!municipality.startsWith("NY-")) continue;

      // Apply municipality filter if specified
      if (municipalityFilter) {
        const filters = municipalityFilter
          .split(",")
          .map((f) => f.trim().toLowerCase());
        const municipalityName = municipality.toLowerCase();
        const found = filters.some((filter) =>
          municipalityName.includes(filter),
        );
        if (!found) continue;
      }

      const municipalityPath = path.join(domainPath, municipality);
      const municipalityStat = await fs.stat(municipalityPath);

      if (!municipalityStat.isDirectory()) continue;

      const metadataPath = path.join(municipalityPath, "metadata.json");
      const statutePath = path.join(municipalityPath, "statute.txt");
      const statuteHtmlPath = path.join(municipalityPath, "statute.html");
      const statutePdfPath = path.join(municipalityPath, "statute.pdf");

      console.log(`  🔍 Checking ${municipality}...`);
      processedCount++;

      try {
        // Step 1: Check metadata.json
        if (!(await fs.pathExists(metadataPath))) {
          console.log(`    ⏭️  Skipping - no metadata.json`);
          continue;
        }

        const metadata = await fs.readJson(metadataPath);

        // Step 1: Handle referencesStateCode==true directories
        if (metadata.referencesStateCode === true) {
          console.log(`    🏛️  State code reference detected - cleaning up local files`);
          let removedFiles = 0;
          
          // Remove all statute.* files
          const statuteFiles = ['statute.txt', 'statute.html', 'statute.pdf'];
          for (const fileName of statuteFiles) {
            const filePath = path.join(municipalityPath, fileName);
            if (await fs.pathExists(filePath)) {
              await fs.remove(filePath);
              console.log(`    🗑️  Removed ${fileName}`);
              removedFiles++;
              logToFile(`Removed ${municipality}/${domain}: ${fileName} (referencesStateCode=true)`);
            }
          }
          
          // Remove analysis.json file
          const analysisPath = path.join(municipalityPath, 'analysis.json');
          if (await fs.pathExists(analysisPath)) {
            await fs.remove(analysisPath);
            console.log(`    🗑️  Removed analysis.json`);
            removedFiles++;
            logToFile(`Removed ${municipality}/${domain}: analysis.json (referencesStateCode=true)`);
          }
          
          // Remove backup files (statute.*.backup-*)
          const files = await fs.readdir(municipalityPath);
          const backupFiles = files.filter(file => file.includes('.backup-'));
          for (const backupFile of backupFiles) {
            const backupPath = path.join(municipalityPath, backupFile);
            await fs.remove(backupPath);
            console.log(`    🗑️  Removed ${backupFile}`);
            removedFiles++;
            logToFile(`Removed ${municipality}/${domain}: ${backupFile} (referencesStateCode=true)`);
          }
          
          if (removedFiles > 0) {
            console.log(`    ✅ Cleaned up ${removedFiles} files for state code reference`);
            updatedCount++;
          } else {
            console.log(`    ✅ Already clean (no statute/analysis files found)`);
          }
          continue;
        }

        // Step 2: Skip if no sourceUrl or points to state code
        const sourceUrl = getSourceUrl(metadata);
        if (!sourceUrl) {
          console.log(`    ⏭️  Skipping - no sourceUrl`);
          continue;
        }

        if (
          metadata.stateCodeApplies === true ||
          sourceUrl.toLowerCase().includes("state") ||
          sourceUrl.toLowerCase().includes("nys.gov")
        ) {
          console.log(`    ⏭️  Skipping - uses state code`);
          continue;
        }

        // Step 3: Re-download if original file doesn't exist (HTML or PDF)
        const hasHtml = await fs.pathExists(statuteHtmlPath);
        const hasPdf = await fs.pathExists(statutePdfPath);
        
        if (!hasHtml && !hasPdf) {
          console.log(`    📥 Re-downloading statute file...`);
          try {
            const contentType = await getContentTypeFromUrl(sourceUrl);
            // Initial detection - will be enhanced after download
            let isPdf = contentType.includes('application/pdf') || sourceUrl.toLowerCase().endsWith('.pdf');
            
            const response = await axios.get(sourceUrl, {
              timeout: 30000,
              responseType: isPdf ? 'arraybuffer' : 'text',
              headers: {
                "User-Agent": "Mozilla/5.0 (compatible; OrdinanceCrawler/1.0)",
              },
            });

            if (isPdf) {
              await fs.writeFile(statutePdfPath, Buffer.from(response.data));
              logToFile(`Re-downloaded ${municipality}/${domain}: statute.pdf`);
            } else {
              await fs.writeFile(statuteHtmlPath, response.data);
              logToFile(`Re-downloaded ${municipality}/${domain}: statute.html`);
            }
          } catch (downloadError) {
            console.log(
              `    ❌ Failed to re-download: ${downloadError.message}`,
            );
            logToFile(
              `Failed to re-download ${municipality}/${domain}: ${downloadError.message}`,
            );
            continue;
          }
        }

        // Step 4: Generate new statute.txt from original file (HTML or PDF)
        let newText: string = "";
        
        if (await fs.pathExists(statutePdfPath)) {
          // Handle PDF files
          try {
            const pdfParse = await import('pdf-parse');
            const buffer = await fs.readFile(statutePdfPath);
            const pdfData = await pdfParse.default(buffer);
            newText = pdfData.text;
            console.log(`    📄 Extracted ${newText.length} characters from PDF`);
          } catch (error) {
            console.log(`    ⚠️  Failed to parse PDF: ${error.message}`);
            newText = "";
          }
        } else if (await fs.pathExists(statuteHtmlPath)) {
          // Handle HTML files
          const htmlContent = await fs.readFile(statuteHtmlPath, "utf-8");

          // Extract anchor from source URL if present for targeted section extraction
          const primarySourceUrl = getSourceUrl(metadata) || "";
          const anchorMatch = primarySourceUrl.match(/#(.+)$/);
          const anchorId = anchorMatch ? anchorMatch[1] : undefined;

          // Use conversion with anchor support for targeted extraction
          newText = convertHtmlToText(htmlContent, anchorId);
        } else {
          console.log(`    ⚠️  No source file found (neither HTML nor PDF)`);
          continue;
        }

        if (newText) {
          // Extract anchor info for logging
          const primarySourceUrl = getSourceUrl(metadata) || "";
          const anchorMatch = primarySourceUrl.match(/#(.+)$/);
          const anchorId = anchorMatch ? anchorMatch[1] : undefined;

          if (forceMode) {
            // Force mode: just compare with existing and update if different
            const existingText = (await fs.pathExists(statutePath))
              ? await fs.readFile(statutePath, "utf-8")
              : "";

            if (newText !== existingText) {
              await fs.writeFile(statutePath, newText, "utf-8");
              console.log(
                `    🔄 Force update: statute.txt regenerated (${existingText.length} -> ${newText.length} chars)${anchorId ? ` [anchor: #${anchorId}]` : ""}`,
              );

              // Update timestamp and content length in metadata
              const primarySourceUrl = getSourceUrl(metadata) || "";
              metadata.lastCleanup = new Date().toISOString();
              addOrUpdateSource(metadata, {
                downloadedAt: getDownloadedAt(metadata) || new Date().toISOString(),
                contentLength: newText.length,
                sourceUrl: primarySourceUrl,
                title: getSourceTitle(metadata),
                type: "statute"
              });
              await writeMetadata(metadataPath, metadata);

              // Process any undownloaded sources in the metadata
              await processUndownloadedSources(municipalityPath, metadata, municipality, realm.type);

              updatedCount++;
              logToFile(
                `Force updated ${municipality}/${domain}: statute.txt regenerated from HTML`,
              );
            } else {
              console.log(`    ✅ No changes needed (force mode)`);
            }
          } else {
            // Normal cleanup mode: use temporary file and compare
            const newStatutePath = path.join(
              municipalityPath,
              "statute_new.txt",
            );
            await fs.writeFile(newStatutePath, newText);

            if (anchorId) {
              console.log(`    🎯 Using anchor-based extraction: #${anchorId}`);
            }

            // Step 5: Compare with existing statute.txt (normal cleanup mode)
            let shouldUpdate = false;
            let diffReason = "";

            if (!(await fs.pathExists(statutePath))) {
              shouldUpdate = true;
              diffReason = "no existing statute.txt";
            } else {
              const existingText = await fs.readFile(statutePath, "utf-8");
              if (newText !== existingText) {
                shouldUpdate = true;
                diffReason = `content differs (${existingText.length} -> ${newText.length} chars)`;
              }
            }

            if (shouldUpdate) {
              console.log(`    🔄 Updating statute.txt - ${diffReason}`);

              // Replace statute.txt
              await fs.move(newStatutePath, statutePath, { overwrite: true });

              // Update timestamps and content length through sources
              const currentTime = new Date().toISOString();
              const primarySourceUrl = getSourceUrl(metadata) || "";
              addOrUpdateSource(metadata, {
                downloadedAt: currentTime,
                contentLength: newText.length,
                sourceUrl: primarySourceUrl,
                title: getSourceTitle(metadata),
                type: "statute"
              });
              metadata.lastCleanup = currentTime;
              await writeMetadata(metadataPath, metadata);

              // Process any undownloaded sources in the metadata
              await processUndownloadedSources(municipalityPath, metadata, municipality, realm.type);

              updatedCount++;
              logToFile(
                `Updated ${municipality}/${domain}: statute.txt (${diffReason})`,
              );
            } else {
              console.log(`    ✅ No changes needed`);
              await fs.remove(newStatutePath);
            }
          }
        } else {
          console.log(`    ⚠️  No valid text content extracted`);
        }

        // Step 4: Delete statute.txt.backup* files
        const backupFiles = await fs.readdir(municipalityPath);
        const backupFilesToDelete = backupFiles.filter((file) =>
          file.startsWith("statute.txt.backup"),
        );

        if (backupFilesToDelete.length > 0) {
          console.log(
            `    🗑️  Removing ${backupFilesToDelete.length} backup files`,
          );
          for (const backupFile of backupFilesToDelete) {
            await fs.remove(path.join(municipalityPath, backupFile));
            logToFile(
              `Deleted backup: ${municipality}/${domain}/${backupFile}`,
            );
          }
        }

        // Step 5: Extract statute number and title
        if (await fs.pathExists(statuteHtmlPath)) {
          const statuteInfo = await extractStatuteInfo(statuteHtmlPath);
          if (statuteInfo.number || statuteInfo.title) {
            console.log(
              `    📋 Statute info: ${statuteInfo.number || "N/A"} - ${statuteInfo.title || "N/A"}`,
            );

            // Update metadata with statute info
            if (statuteInfo.number) metadata.statuteNumber = statuteInfo.number;
            if (statuteInfo.title) metadata.statuteTitle = statuteInfo.title;

            await fs.writeJson(metadataPath, metadata, { spaces: 2 });
            logToFile(
              `Extracted statute info for ${municipality}/${domain}: ${statuteInfo.number} - ${statuteInfo.title}`,
            );
          }
        }

        // Step 6: Analyze statute.txt for binary data
        if (await fs.pathExists(statutePath)) {
          const statuteContent = await fs.readFile(statutePath, "utf-8");
          if (hasBinaryData(statuteContent)) {
            console.log(`    ⚠️  BINARY DATA DETECTED in statute.txt!`);
            logToFile(
              `ERROR: Binary data detected in ${municipality}/${domain}/statute.txt`,
            );
            binaryDetectedCount++;
          }
        }
      } catch (error) {
        console.log(
          `    ❌ Error processing ${municipality}: ${error.message}`,
        );
        logToFile(
          `Error processing ${municipality}/${domain}: ${error.message}`,
        );
      }
    }
  }

  console.log(`\n✅ Cleanup completed!`);
  console.log(`   📊 Processed: ${processedCount} municipalities`);
  console.log(`   🔄 Updated: ${updatedCount} statute files`);
  if (binaryDetectedCount > 0) {
    console.log(
      `   ⚠️  Binary data detected: ${binaryDetectedCount} files (check logs)`,
    );
  }

  logToFile(
    `Cleanup completed - Processed: ${processedCount}, Updated: ${updatedCount}, Binary detected: ${binaryDetectedCount}`,
  );
}

export {
  extractGoogleSheetsAsCsv,
  extractGoogleSheetsWithHyperlinks,
  processSpreadsheetData,
  verboseLog,
  validateMunicipalityRelevance,
  cleanupInvalidStatute,
  runCleanupMode,
};

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
      
    } catch (error) {
      console.error(`❌ Error testing PDF form: ${error.message}`);
      process.exit(1);
    }
  })();
}
