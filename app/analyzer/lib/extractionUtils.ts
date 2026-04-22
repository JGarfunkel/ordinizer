import fs from "fs-extra";
import path from "path";
import axios from "axios";
import { PDFParse } from 'pdf-parse';
import { JSDOM, VirtualConsole } from "jsdom";
import { convertHtmlToText } from "./simpleHtmlToText.js";
import {
  type Metadata,
  type Source,
  type ArticleLink,
  type StatuteLibraryConfig,
  type Realm,
  DELAY_BETWEEN_DOWNLOADS,
  verboseLog,
  getProjectDataDir,
  getProjectRootDir,
  loadStatuteLibraryConfig,
  getLibraryForUrl,
} from "./extractionConfig.js";

// ─── Logging ─────────────────────────────────────────────────────────────────

let logFile: string;
let logStream: fs.WriteStream | null = null;

export function initializeLogging() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  logFile = path.join(getProjectRootDir(), "logs", `extract-${timestamp}.log`);

  try {
    fs.ensureDirSync(path.dirname(logFile));
    logStream = fs.createWriteStream(logFile, { flags: "w" });
    logToFile(`=== Extraction Log Started at ${new Date().toISOString()} ===`);
    console.log(`📝 Logging to: ${path.relative(getProjectRootDir(), logFile)}`);
  } catch (error: any) {
    console.warn(`Warning: Could not initialize log file: ${error.message}`);
  }
}

export function logToFile(message: string) {
  if (logStream) {
    logStream.write(`${new Date().toISOString()}: ${message}\n`);
  }
}

export function closeLogging() {
  if (logStream) {
    logToFile(`=== Extraction Log Ended at ${new Date().toISOString()} ===`);
    logStream.end();
    logStream = null;
  }
}

// ─── Delay ───────────────────────────────────────────────────────────────────

export async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Metadata helpers ────────────────────────────────────────────────────────

export function isLegacyMetadata(metadata: any): boolean {
  return !Array.isArray(metadata.sources);
}

export function migrateLegacyMetadata(legacyMetadata: any): Metadata {
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
  
  // Deduplicate sources by URL (keep first occurrence)
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

export function determineSourceType(metadata: any): "statute" | "policy" {
  if (metadata.realmType === "policy" ||
      metadata.districtName || (metadata.entityId && metadata.entityId.includes("-CSD")) || 
      (metadata.entityId && metadata.entityId.includes("-UFSD"))) {
    return "policy";
  }
  return "statute";
}

export function getPrimarySource(metadata: Metadata): Source | null {
  return metadata.sources && metadata.sources.length > 0 ? metadata.sources[0] : null;
}

export function getSourceUrl(metadata: Metadata): string | null {
  const primarySource = getPrimarySource(metadata);
  return primarySource?.sourceUrl || null;
}

export function getDownloadedAt(metadata: Metadata): string | null {
  const primarySource = getPrimarySource(metadata);
  return primarySource?.downloadedAt || null;
}

export function getContentLength(metadata: Metadata): number {
  const primarySource = getPrimarySource(metadata);
  return primarySource?.contentLength || 0;
}

export function getSourceTitle(metadata: Metadata): string {
  const primarySource = getPrimarySource(metadata);
  if (primarySource && primarySource.title) {
    return primarySource.title;
  }
  return metadata.statuteTitle || metadata.policyTitle || metadata.domain || "Document";
}

export function addOrUpdateSource(metadata: Metadata, source: Source): void {
  if (!metadata.sources) {
    metadata.sources = [];
  }
  
  const existingIndex = metadata.sources.findIndex(s => s.sourceUrl === source.sourceUrl);
  
  if (existingIndex >= 0) {
    metadata.sources[existingIndex] = source;
  } else {
    metadata.sources.unshift(source); // Add to beginning as primary source
  }
}

export async function readMetadata(metadataPath: string): Promise<Metadata | null> {
  if (!(await fs.pathExists(metadataPath))) {
    return null;
  }
  
  try {
    const rawMetadata = await fs.readJson(metadataPath);
    
    if (isLegacyMetadata(rawMetadata)) {
      return migrateLegacyMetadata(rawMetadata);
    }
    
    const cleanMetadata = { ...rawMetadata };
    delete cleanMetadata.sourceUrl;
    delete cleanMetadata.downloadedAt;
    delete cleanMetadata.contentLength;
    delete cleanMetadata.statuteTitle;
    delete cleanMetadata.policyTitle;
    delete cleanMetadata.sourceType;
    delete cleanMetadata.sourceUrls;
    
    return cleanMetadata as Metadata;
  } catch (error: any) {
    console.warn(`Warning: Could not read metadata from ${metadataPath}: ${error.message}`);
    return null;
  }
}

export async function writeMetadata(metadataPath: string, metadata: Metadata): Promise<void> {
  await fs.writeJson(metadataPath, metadata, { spaces: 2 });
}

// ─── PDF processing ──────────────────────────────────────────────────────────

export async function getTextFromPdfFile(pdfPath: string): Promise<string> {
  try {
    const pdfBuffer = await fs.readFile(pdfPath);
    return await pdfToText(pdfBuffer, path.basename(pdfPath), false);
  } catch (error: any) {
    console.warn(`Warning: Could not read PDF file ${pdfPath}: ${error.message}`);
    return "";
  }
}

export async function pdfFormToText(pdfBuffer: Buffer, formTitle: string): Promise<string> {
  return pdfToText(pdfBuffer, formTitle, true);
}

export async function pdfToText(pdfBuffer: Buffer, formTitle: string = "PDF Form", isForm: boolean = false): Promise<string> {
  let parser: PDFParse | null = null;
  try {
    await ensurePdfParseCompatibility();
    
    console.log("    📋 Extracting text from PDF form...");

    parser = new PDFParse({data: pdfBuffer});
    const pdfData = await parser.getText();
    const extractedText = pdfData.text.trim();
    
    if (extractedText && extractedText.length > 50) {
      console.log(`    ✅ Successfully extracted ${extractedText.length} characters from PDF`);
      return interpretTextAsForm(extractedText, formTitle);
    }
    
    console.log("    📋 PDF text extraction failed");
    return "";
    
  } catch (error: any) {
    console.log(`    ⚠️  PDF processing error (${error.message}), using fallback`);
    return "";
  }
}

export async function ensurePdfParseCompatibility(): Promise<void> {
  try {
    const testDir = './test/data';
    const dummyFile = './test/data/05-versions-space.pdf';
    
    if (!await fs.pathExists(dummyFile)) {
      await fs.ensureDir(testDir);
      const minimalPdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n178\n%%EOF');
      await fs.writeFile(dummyFile, minimalPdf);
    }
  } catch (error: any) {
    // If this fails, pdf-parse import will still fail, but we'll catch that later
  }
}

export function interpretTextAsForm(extractedText: string, formTitle: string): string {
  const lines = extractedText.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  
  let formDescription = `${formTitle}\n\n`;
  const formFields: string[] = [];
  const feeInfo: string[] = [];
  const instructions: string[] = [];
  const requirements: string[] = [];
  
  for (const line of lines) {
    const lineLC = line.toLowerCase();
    
    if (line.includes('_____') || line.includes('___')) {
      const fieldMatch = line.match(/^([^_]+?)_+/);
      if (fieldMatch) {
        const fieldLabel = fieldMatch[1].trim().replace(/[:\s]+$/, '');
        if (fieldLabel.length > 0) {
          formFields.push(`${fieldLabel}`);
        }
      }
    }
    
    if (lineLC.includes('fee') || lineLC.includes('bond') || line.includes('$') || lineLC.includes('cost')) {
      feeInfo.push(line);
    }
    
    if (lineLC.includes('submit') || lineLC.includes('provide') || lineLC.includes('attach') || 
        lineLC.includes('required') || lineLC.includes('must') || lineLC.includes('please')) {
      instructions.push(line);
    }
    
    if (lineLC.includes('department') || lineLC.includes('phone') || lineLC.includes('www.') || 
        lineLC.includes('email') || lineLC.includes('contact')) {
      requirements.push(line);
    }
  }
  
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
  
  formDescription += "RAW FORM CONTENT:\n";
  formDescription += extractedText;
  
  return formDescription.trim();
}

// ─── HTTP / content detection ────────────────────────────────────────────────

export async function downloadFromUrl(url: string): Promise<string> {
  try {
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
      responseType: 'arraybuffer',
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; Ordinizer/1.0; +http://ordinizer.example.com)",
      },
    });

    const contentType = response.headers["content-type"]?.toString() || '';
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

    if (isPdf) {
      return Buffer.from(response.data).toString('base64');
    } else {
      return Buffer.from(response.data).toString('utf-8');
    }
  } catch (error: any) {
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

export async function getContentTypeFromUrl(url: string): Promise<string> {
  try {
    const response = await axios.head(url, {
      timeout: 10000,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Ordinizer/1.0; +http://ordinizer.example.com)",
      },
    });
    return response.headers["content-type"]?.toString() || "text/html";
  } catch (error: any) {
    if (url.toLowerCase().endsWith('.pdf')) {
      return "application/pdf";
    }
    return "text/html";
  }
}

export function detectPdfFromBytes(content: string | Buffer): boolean {
  try {
    let bytes: Buffer;
    if (typeof content === 'string') {
      if (content.startsWith('data:application/pdf')) {
        bytes = Buffer.from(content.split(',')[1], 'base64');
      } else {
        try {
          bytes = Buffer.from(content, 'base64');
        } catch {
          bytes = Buffer.from(content, 'utf-8');
        }
      }
    } else {
      bytes = content;
    }
    
    const header = bytes.subarray(0, 8).toString('ascii');
    return header.startsWith('%PDF-');
  } catch {
    return false;
  }
}

export function isContentPdf(content: string | Buffer, contentType: string, url: string, sourceType?: string): boolean {
  if (sourceType === 'form') {
    return detectPdfFromBytes(content) || contentType.includes('application/pdf') || url.toLowerCase().endsWith('.pdf');
  }
  
  if (contentType.includes('application/pdf') || url.toLowerCase().endsWith('.pdf')) {
    return true;
  }
  
  return detectPdfFromBytes(content);
}

// ─── Article detection & stitching ───────────────────────────────────────────

export function detectArticleBasedPage(
  html: string,
  currentUrl: string,
): { isArticleBased: boolean; articles: ArticleLink[] } {
  try {
    const dom = new JSDOM(html);
    const document = dom.window.document;

    const currentPath = new URL(currentUrl).pathname;

    const articles: ArticleLink[] = [];
    const titleLinks = document.querySelectorAll("a.titleLink");
    
    const currentHtmlContent = document.body.textContent || "";

    titleLinks.forEach((link) => {
      const href = link.getAttribute("href");
      if (href) {
        const titleNumber = link.querySelector(".titleNumber");
        const titleText = titleNumber?.textContent?.trim() || "";

        if (titleText.includes("Article")) {
          let absoluteUrl: string;
          if (href.startsWith("http")) {
            absoluteUrl = href;
          } else if (href.startsWith("#")) {
            absoluteUrl = `${currentUrl}${href}`;
          } else {
            absoluteUrl = `https://ecode360.com${href}`;
          }

          try {
            const linkPath = new URL(absoluteUrl).pathname;

            const tocPattern = `subSectionOf-${link.querySelector('span[data-guid]')?.getAttribute('data-guid') || ''}`;
            const isTocStructure = currentHtmlContent.includes(tocPattern) || 
                                   currentHtmlContent.includes(`${titleText}\\nchevron_right`) ||
                                   currentHtmlContent.includes('class="subChild"') ||
                                   currentHtmlContent.includes('Navigate to ');
            
            const isDefinitelyToc = currentHtmlContent.includes('<div id="toc">') || 
                                    currentHtmlContent.includes('class="subChild"') ||
                                    (titleLinks.length > 3 && currentHtmlContent.includes('chevron_right'));

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
  } catch (error: any) {
    console.log(
      "  Warning: Error detecting article-based page:",
      error.message,
    );
    return { isArticleBased: false, articles: [] };
  }
}

export async function downloadAndStitchArticles(
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

      if (i < articles.length - 1) {
        await delay(3000);
      }
    } catch (error: any) {
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

// ─── Validation & cleanup ────────────────────────────────────────────────────

export async function validateEntityRelevance(
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

    const municipalityPatterns = [
      `${municipalityType.toLowerCase()} of ${municipalityName.toLowerCase()}`,
      `${municipalityName.toLowerCase()} ${municipalityType.toLowerCase()}`,
      municipalityName.toLowerCase(),
      municipalityName.replace(/[-\s]/g, "").toLowerCase(),
      `city of ${municipalityName.toLowerCase()}`,
      `town of ${municipalityName.toLowerCase()}`,
      `village of ${municipalityName.toLowerCase()}`,
    ];

    const foundExpected = municipalityPatterns.some((pattern) =>
      cleanContent.includes(pattern),
    );

    if (foundExpected) {
      logToFile(
        `✅ Validation passed: Found "${municipalityName}" references in statute for ${domain}`,
      );
      return { isValid: true };
    }

    const otherEntitySuggested = ["town of", "city of", "village of"];

    const currentEntityVariants = [
      municipalityName.toLowerCase(),
      municipalityName.replace(/[-\s]/g, "").toLowerCase(),
      municipalityName.replace(/\s/g, "-").toLowerCase(),
    ];

    const filteredProblemMunicipalities = otherEntitySuggested.filter(
      (problem) =>
        !currentEntityVariants.some(
          (variant) => problem.includes(variant) || variant.includes(problem),
        ),
    );

    const foundOtherMunicipalities: string[] = [];

    filteredProblemMunicipalities.forEach((municipality) => {
      if (cleanContent.includes(municipality)) {
        if (
          !currentEntityVariants.some((variant) =>
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

    logToFile(
      `⚠️ Validation uncertain: No clear municipality references found, assuming valid for ${municipalityName}`,
    );
    return { isValid: true };
  } catch (error: any) {
    const reason = `Error validating statute: ${error.message}`;
    logToFile(`❌ Validation error: ${reason}`);
    return { isValid: false, reason };
  }
}

export async function cleanupInvalidStatute(
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

  if (await fs.pathExists(metadataPath)) {
    console.log(`  🗑️  Cleaning up metadata.json (removing source information)`);
    try {
      const metadata = await readMetadata(metadataPath);
      if (metadata) {
        metadata.sources = [];
        
        delete metadata.sourceUrl;
        delete metadata.originalCellValue;
        delete metadata.downloadedAt;
        delete metadata.contentLength;
        delete metadata.sourceType;
        delete metadata.lastConverted;
        delete metadata.sourceUrls;

        await writeMetadata(metadataPath, metadata);
        logToFile(
          `Updated metadata.json: removed all source information (sources array and legacy fields)`,
        );
        console.log(`  ✅ Updated metadata.json: removed all source information`);
      }
    } catch (error: any) {
      logToFile(`Error updating metadata.json: ${error.message}`);
      console.log(`  ⚠️  Could not update metadata.json: ${error.message}`);
    }
  }
}

// ─── Utility functions ───────────────────────────────────────────────────────

export function getGradeColor(grade: string | null): string {
  switch (grade) {
    case "Very Good":
      return "#22c55e";
    case "Good":
      return "#84cc16";
    case "Yellow":
      return "#eab308";
    case "Red":
      return "#ef4444";
    default:
      return "#6b7280";
  }
}

export function hasBinaryData(content: string): boolean {
  const binaryPatterns = [
    /\x00/,
    /[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/,
  ];

  return binaryPatterns.some((pattern) => pattern.test(content));
}

export async function extractStatuteInfo(
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
      const patterns = [
        /^(§\s*[\d-]+[A-Z]*)\s*(?:\[[^\]]+\])?\s*([^;.]+)(?:[;.]|$)/,
        /^(§\s*[\d-]+[A-Z]*)\s+([A-Z][a-z\s]+?)(?:[;.]|$)/,
        /^(§\s*[\d-]+[A-Z]*)\s*[-–—]\s*([^.;]+)(?:[;.]|$)/,
        /^(Ch\s*[\d-]+[A-Z]*)\s*(?:\[[^\]]+\])?\s*([A-Z][^;.]*?)(?:[;.]|$)/,
        /^(Ch\s*[\d-]+[A-Z]*)\s+([A-Z][a-z\s]+?)(?:[;.]|$)/,
        /^(Chapter\s*[\d-]+[A-Z]*)\s*(?:\[[^\]]+\])?\s*([A-Z][^;.]*?)(?:[;.]|$)/,
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

    // Method 2: Try to extract from content structure
    if (!statuteNumber || !statuteTitle || statuteTitle === "N/A" || statuteTitle.length < 3 || statuteTitle.length > 50) {
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
          statuteTitle = titleText
            .replace(/\s+/g, " ")
            .replace(/\.$/, "")
            .replace(/^(Article\s+\d+\s*[-–—]?\s*)/i, "")
            .replace(/^(Chapter\s+\d+\s*[-–—]?\s*)/i, "")
            .replace(/^(Section\s+\d+\s*[-–—]?\s*)/i, "")
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
        const patterns = [
          /^(§\s*[\d-]+[A-Z]*):?\s*(.+)/,
          /^([\d-]+[A-Z]*)\s*[-–—]\s*(.+)/,
          /^Section\s+([\d-]+[A-Z]*)\s*[-–—]?\s*(.+)/i,
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

    if (statuteNumber) {
      statuteNumber = statuteNumber.replace(/§\s*/, "§ ").trim();
    }

    if (statuteTitle) {
      const wordCount = statuteTitle.split(/\s+/).length;
      const hasProperCapitalization = /^[A-Z]/.test(statuteTitle);
      
      if (wordCount > 8) {
        console.warn(`⚠️  Statute title too long (${wordCount} words): "${statuteTitle}"`);
        console.warn(`   This may indicate extraction error - typical titles are 1-3 words`);
      }
      
      if (!hasProperCapitalization) {
        console.warn(`⚠️  Statute title capitalization issue: "${statuteTitle}"`);
        console.warn(`   Expected proper capitalization (first letter uppercase)`);
      }
      
      if (statuteTitle.length > 100) {
        console.warn(`⚠️  Statute title suspiciously long (${statuteTitle.length} chars), likely extraction error`);
        statuteTitle = "";
      } else if (statuteTitle.includes('\n') || statuteTitle.includes('\t')) {
        console.warn(`⚠️  Statute title contains line breaks, likely extraction error: "${statuteTitle.substring(0, 50)}..."`);
        statuteTitle = statuteTitle.replace(/[\n\t\r]+/g, ' ').trim();
      }
    }

    const result = {
      number: statuteNumber || undefined,
      title: statuteTitle || undefined,
    };

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
  } catch (error: any) {
    console.warn(
      `Warning: Could not extract statute info from ${htmlPath}: ${error.message}`,
    );
    return {};
  }
}
