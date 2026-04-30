import fs from "fs-extra";
import path from "path";
import axios from "axios";
import { JSDOM, VirtualConsole } from "jsdom";
import { convertHtmlToText } from "./simpleHtmlToText.js";
import {
  type ArticleLink,
  DOMAIN_MAPPING,
  DELAY_BETWEEN_DOWNLOADS,
  verboseLog,
  getProjectDataDir,
  getProjectRootDir,
  getDomainDisplayName,
  loadStatuteLibraryConfig,
  getLibraryForUrl,
} from "./extractionConfig.js";
import {
  type ISpreadsheetParser,
  DefaultSpreadsheetParser,
  getEntityPrefix,
  getStateCode,
} from "./spreadsheetParser.js";
import {
  logToFile,
  delay,
  addOrUpdateSource,
  getSourceUrl,
  getDownloadedAt,
  getTextFromPdfFile,
  downloadFromUrl,
  downloadFromUrlAndSave,
  getContentTypeFromUrl,
  isContentPdf,
  detectArticleBasedPage,
  downloadAndStitchArticles,
  pdfFormToText,
  validateEntityRelevance,
  extractStatuteInfo,
  extractStatuteInfoFromHTML,
  getGradeColor,
  hasBinaryData,
  getPrimarySource,
} from "./extractionUtils.js";
import { PDFParse } from "pdf-parse";
import { text } from "stream/consumers";
import { Ruleset, Domain, Entity, Realm } from "@civillyengaged/ordinizer-core";
import { IStorage, getDefaultStorage } from "@civillyengaged/ordinizer-servercore";

// ─── Per-entity download loop ────────────────────────────────────────────────

export async function downloadEntitySources(
  storage: IStorage,
  rows: any[][],
  realm: Realm,
  hyperlinkData: Record<string, Record<string, string>>,
  headers: string[],
  columnMap: Record<string, number>,
  domainsToProcess: string[],
  options: {
    targetDomain?: string;
    entityFilter?: string;
    forceMode?: boolean;
    noDownloadMode?: boolean;
    noDeleteMode?: boolean;
    verbose?: boolean;
    entitiesToInclude?: Set<string>;
    reloadMode?: boolean;
  },
  parser?: ISpreadsheetParser,
): Promise<void> {
  const {
    entityFilter,
    forceMode = false,
    noDownloadMode = false,
    noDeleteMode = false,
    verbose = false,
    entitiesToInclude,
    reloadMode = false,
  } = options;

  const sp = parser ?? new DefaultSpreadsheetParser(realm);
  let downloadCount = 0;
  const territory = realm.territory ?? '';

  for (const row of rows) {
    // Parse "Name (Type)" format from first column
    const nameTypeMatch = row[0]?.match(/^(.+?)\s*\((.+?)\)$/);
    if (!nameTypeMatch) continue; // Skip rows without "Name (Type)" format

    const { name: cleanName, type: rawType } = sp.parseNames(row[0]);
    const cleanType = rawType === "Town/Village" ? "Town" : rawType;

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
        grade = sp.parseGradeFromCell(cellText) || grade;
      }

      // If no hyperlink, check for direct HTTP URLs in cell text
      if (!url && cellText) {
        const httpUrlMatch = cellText.match(/https?:\/\/[^\s]*/);
        if (httpUrlMatch) {
          url = httpUrlMatch[0];

          // Extract grade from prefix
          grade = sp.parseGradeFromCell(cellText) || grade;
          if (grade) {
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
      const domainDir = domain.toLowerCase().replace(/\s+/g, "-");

      if (usesStateCode) {
        downloadCount = await checkStateMetadata(cleanName, 
          cleanType, sp, realm, domainDir, domain, url, cellText, downloadCount, territory);

        continue; // Skip the regular download logic for state code municipalities
      } else {
        await checkMetadataAndDownloadSources(
          storage,
          realm,
          domain,
          territory,
          cleanName,
          cleanType,
          url,
          cellText,
          grade,
          {
            noDeleteMode,
            forceMode,
            reloadMode,
            noDownloadMode,
          },
          downloadCount
        );
      }

      downloadCount++;
    }
  }

  console.log(`Extraction complete! Downloaded ${downloadCount} statute files`);

  // Generate comprehensive summary file
  // TODO - test and restire
  // if (entityFilter === "") 
  //   await generateSummaryFile(realm);
}

async function checkStateMetadata(cleanName: string, cleanType: string, sp: ISpreadsheetParser, realm: Realm, domainDir: string, domain: string, url: string, cellText: any, downloadCount: number, territory: string) {
  console.log(
    `  ${cleanName} - ${cleanType}: Uses ${sp.getStateCode()} State code, managing shared state reference`
  );

  // Create municipality directory for ruleset only
  const municipalityDirPath = path.join(
    getProjectDataDir(),
    realm.datapath,
    domainDir,
    `${sp.getEntityPrefix()}${cleanName}`
  );
  await fs.ensureDir(municipalityDirPath);
  const municipalityMetadataPath = path.join(
    municipalityDirPath,
    "ruleset.json"
  );

  // Save ruleset in municipality folder (no statute files)
  await fs.writeJson(
    municipalityMetadataPath,
    {
      municipality: cleanName,
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
      stateCodePath: `../${sp.getEntityPrefix()}State/statute.txt`,
    },
    { spaces: 2 }
  );
  console.log(
    `  Created ruleset reference for ${cleanName} - ${cleanType} (references state code)`
  );

  // Check if we need to download the actual state statute to shared state folder
  const stateDir = path.join(
    getProjectDataDir(),
    realm.datapath,
    domainDir,
    `${sp.getEntityPrefix()}State`
  );
  const stateFilePath = path.join(stateDir, "statute.txt");
  const stateHtmlPath = path.join(stateDir, "statute.html");
  const stateMetadataPath = path.join(stateDir, "ruleset.json");

  if (!(await fs.pathExists(stateFilePath))) {
    console.log(
      `  ${sp.getStateCode()} State statute not found, downloading to shared location: ${stateDir}`
    );
    await fs.ensureDir(stateDir);

    // Add delay between downloads to be respectful
    if (downloadCount > 0) {
      console.log(
        `  Waiting ${DELAY_BETWEEN_DOWNLOADS / 1000} seconds...`
      );
      await delay(DELAY_BETWEEN_DOWNLOADS);
    }

    const content = await downloadFromUrl(url);

    if (content) {
      // Always save original HTML source for potential later conversion
      await fs.writeFile(stateHtmlPath, content, "utf-8");
      console.log(`  Saved ${territory} State HTML source: ${stateHtmlPath}`);

      // Check if this is an article-based page for state code too
      const articles = detectArticleBasedPage(        content,        url      );
      let plainTextContent: string;
      let sourceUrls: ArticleLink[] | undefined;

      if (articles.length > 0) {
        console.log(
          `  📚 Processing article-based ${territory} State statute with ${articles.length} articles`
        );
        const articleResult = await downloadAndStitchArticles(articles);
        plainTextContent = articleResult.content;
        sourceUrls = articleResult.sourceUrls;

        if (!plainTextContent || plainTextContent.length < 100) {
          console.log(
            `  ⚠️  Article stitching resulted in insufficient content, falling back to main page`
          );
          plainTextContent = convertHtmlToText(content);
          sourceUrls = undefined;
        } else {
          console.log(
            `  ✅ Successfully stitched ${sourceUrls.length} articles into ${plainTextContent.length} characters`
          );
        }
      } else {
        // Regular single-page processing
        plainTextContent = convertHtmlToText(content);
      }

      await fs.writeFile(stateFilePath, plainTextContent, "utf-8");

      // Save state ruleset
      const stateMetadata: any = {
        municipality: `${territory} State`,
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
          `  📄 Added ${sourceUrls.length} article URLs to ${territory} State ruleset`
        );
      }

      await fs.writeJson(stateMetadataPath, stateMetadata, { spaces: 2 });

      console.log(
        `  ${domain}: Downloaded ${territory} State statute (${plainTextContent.length} characters plain text)`
      );
      downloadCount++;
    } else {
      console.log(`  ${domain}: Failed to download ${territory} State statute`);
    }
  } else {
    console.log(`  ${territory} State statute already exists: ${stateFilePath}`);
  }
  return downloadCount;
}

export async function checkIfValidUrl(url: string): Promise<boolean> {
    if (url && url.trim() !== "" && url.toLowerCase() !== "n/a") {
    // TODO: move this call to a higher level function
    const config = await loadStatuteLibraryConfig();
    const library = getLibraryForUrl(url, config);
    if (library && !library.download) {
      console.log(
        `  ⚠️  Library not supported: ${library.name} - ${library.notes}`,
      );
      console.log(`      URL: ${url}`);
      return false;
    }
  }
  return true;
}


/**
 * Read the ruleset for the entity and determine if we need to download/update statute files based on URL changes,
 *  missing ruleset, or file age. 
 * Then proceed to download and save files as needed, while respecting no-download and no-delete modes. 
 */
export async function checkMetadataAndDownloadSources(
  storage: IStorage,
  realm: Realm,
  domain: string,
  territory: string,
  entityName: string,
  entityType: string,
  url: string,
  cellText: string,
  grade: string | null,
  options: {
    noDeleteMode: boolean,
    forceMode: boolean,
    reloadMode: boolean,
    noDownloadMode: boolean,
  },
  downloadCount: number
) {
  // Regular municipality - create full directory structure
  const entity = territory + "-" + entityName + (entityType ? `-${entityType}` : "");

  // console.log(`  Creating directory: ${dirPath}`);
  // await fs.ensureDir(dirPath);
  // const filePath = path.join(dirPath, "statute.txt");
  // const htmlPath = path.join(dirPath, "statute.html");
  // const pdfPath = path.join(dirPath, "statute.pdf");
  // const metadataPath = path.join(dirPath, "ruleset.json");

      // Check if URL is from a supported library first
  const { noDeleteMode, forceMode, reloadMode, noDownloadMode } = options;

      // Handle cases where no URL is determined (blank cell)
  if (await checkIfValidUrl(url) === false) 
    return;

  let downloadedTooLongAgo = false;
  let shouldUpdateDueToUrlChange = false;

  let ruleset = await storage.getRulesetOrCreate(domain, realm.id);
  if (url.trim() === "" || url.toLowerCase() === "n/a") {

    if (ruleset) {
      const primarySource = getPrimarySource(ruleset);
      if (primarySource) {

        const lastDownloadedAt = primarySource.downloadedAt;
        // check days since update 
        if (lastDownloadedAt) {
          const daysSinceUpdate = (Date.now() - new Date(lastDownloadedAt).getTime()) / (1000 * 60 * 60 * 24);
          downloadedTooLongAgo = daysSinceUpdate > 30;
        }

        const primarySourceUrl = primarySource.sourceUrl;
        // TODO - clear ruleset and save? under what conditions?

        // Compare determined URL with existing ruleset
        shouldUpdateDueToUrlChange = ( primarySourceUrl != null && primarySourceUrl !== url);

      // TODO Check if ruleset.json is missing and create it if statute.txt exists

      //  TODO Check if file already exists and is recent, or if ruleset indicates retroactive creation
      }
    } else {
      // TODO get domainName

      ruleset = {
        entityId: entity,
        domainId: domain,
        domain: domain,
        metadataCreated: new Date().toISOString(),
        stateCodeApplies: false,
        sources: [],
      };
      const primarySource = getPrimarySource(ruleset);
      primarySource.sourceUrl = url;
    }
    // Check all conditions for when to download/update
    if (
      !shouldUpdateDueToUrlChange &&
      !forceMode &&
      !reloadMode &&
      !noDownloadMode &&
      !downloadedTooLongAgo
    ) {
      console.log(
        `  ${domain}: File exists, is recent, and URL unchanged - skipping`,
      );
      return;
    }

    if (shouldUpdateDueToUrlChange && reloadMode) {
      console.log(`  ${domain}: Updating due to reload mode - regenerating from source`);
    } else if (shouldUpdateDueToUrlChange) {
      console.log(`  ${domain}: Updating due to URL change`);
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
          `Skipping download for ${entityName}/${domain} due to --nodownload mode`,
        );

        // TODO - review this
      //   // Validate existing statute file if it exists
      //   if (await fs.pathExists(filePath)) {
      //     const validation = await validateEntityRelevance(
      //       filePath,
      //       entityName,
      //       entityType,
      //       domain,
      //     );
      //     if (!validation.isValid) {
      //       if (noDeleteMode) {
      //         console.log(
      //           `🚫  Validation failed for ${entityName} (${domain}): ${validation.reason} [--nodelete mode: file preserved]`,
      //         );
      //         logToFile(
      //           `❌ Validation failed for ${entityName} (${domain}): ${validation.reason} [--nodelete mode: file preserved]`,
      //         );
      //       } else {
      //         await cleanupInvalidStatute(
      //           dirPath,
      //           entityName,
      //           domain,
      //           validation.reason || "Unknown validation error",
      //         );
      //       }
      //     }
      //   } else {
      //     console.log(`  ${domain}: No existing statute file to validate`);
      //     logToFile(
      //       `No existing statute file to validate for ${entityName}/${domain}`,
      //     );
      //   }
      //   continue;
      // }

      // Add delay between downloads to be respectful
      if (downloadCount > 0) {
        console.log(`  Waiting ${DELAY_BETWEEN_DOWNLOADS / 1000} seconds...`);
        await delay(DELAY_BETWEEN_DOWNLOADS);
      }

      await downloadAndProcessSource(realm.id, domain, entity, url);
    }
}

export async function downloadAndProcessSource(realmId: string, domainId: string, entityId: string, url?: string) {
  const storage = getDefaultStorage(realmId);

  const currentRealm: Realm = await storage.getRealmConfig();
  const ruleset = await storage.getRulesetOrCreate(domainId, entityId);
  const destPath = await storage.getPathForDomainAndEntity(ruleset);

  let primarySource = getPrimarySource(ruleset);
  if (!url)
    url = primarySource.sourceUrl || "";
  const downloadedFilepath = await downloadFromUrlAndSave(url, destPath, currentRealm.ruleType);

  let sourceUrls: ArticleLink[] | undefined;
  let plainTextContent: string;

  primarySource.downloadedAt = new Date().toISOString();

  // now process the downloaded file based on its type (PDF vs HTML), and check for article-based structure if HTML
  if (downloadedFilepath.endsWith(".pdf")) {
    plainTextContent = await getTextFromPdfFile(downloadedFilepath);

  } else {
    // Check if this is an article-based page that needs special processing
    const content = await fs.readFile(downloadedFilepath, "utf-8");
    primarySource.contentLength = content.length; // Update content length in ruleset for ruleset
    const articles = detectArticleBasedPage(content, url);

    if (articles.length > 0) {
        ({ plainTextContent, sourceUrls } = await stitchArticlesAndGenerateContent(articles, sourceUrls, content));
    } else {
        // Regular single-page processing - check for anchor in URL
        const anchorMatch = url.match(/#(.+)$/);
        const anchorId = anchorMatch ? anchorMatch[1] : undefined;

        if (anchorId) {
          console.log(`  🎯 Processing URL with anchor: ${anchorId}`);
        }
        plainTextContent = convertHtmlToText(content, anchorId);
      }
      const statuteInfo = await extractStatuteInfoFromHTML(content);

      // TODO - review this mapping as it seems inconsistent
      ruleset.statuteNumber = statuteInfo.number;
      primarySource.title = statuteInfo.title // || getSourceTitle(url, content);  // TODO - get from the docyment title
      
    }

    const plaintextFilename = path.join(destPath, "statute.txt");
    await fs.writeFile(plaintextFilename, plainTextContent, "utf-8");

    // Add additional sources if this was an article-based page
    addArticleSources(sourceUrls, url, ruleset);

    // Process any undownloaded sources in the ruleset
    // await processUndownloadedSources(storage, ruleset, entityName, realm.ruleType);

    // TODO - Create analysis.json with grade information only if it doesn't exist - do we need this?
    // 
    // const analysisPath = path.join(dirPath, "analysis.json");

    // if (!(await fs.pathExists(analysisPath))) {
    //   const analysisData = {
    //     municipality: `${entityName} - ${entityType}`,
    //     domain: getDomainDisplayName(domain),
    //     grade: grade,
    //     gradeColor: getGradeColor(grade),
    //     lastUpdated: new Date().toISOString(),
    //   };

    //   await fs.writeJson(analysisPath, analysisData, { spaces: 2 });
    //   console.log(`  Created analysis.json with grade: ${grade || "None"}`);
    // } else {
    //   console.log(`  Preserved existing analysis.json (contains ${grade || "no"} grade)`);
    // }

    console.log(
      `  ${domainId}: Downloaded and saved (${plainTextContent.length} characters plain text)`
    );
    logToFile(
      `Successfully downloaded ${entityId}/${domainId}: ${plainTextContent.length} characters`
    );
    storage.saveRuleset(ruleset);

    // TODO - restart Validate the downloaded content
    // const validation = await validateEntityRelevance(
    //   filePath,
    //   entityName,
    //   entityType,
    //   domain
    // );
    // if (!validation.isValid) {
    //   await cleanupInvalidStatute(
    //     dirPath,
    //     entityName,
    //     domain,
    //     validation.reason || "Unknown validation error"
    //   );
    // }

  // } else {
  //   console.log(`  ${domain}: Failed to download`);
  //   logToFile(`Failed to download ${entityName}/${domain} from ${url}`);
  // }
}

function addArticleSources(sourceUrls: ArticleLink[] | undefined, url: string, ruleset: Ruleset) {
  if (sourceUrls && sourceUrls.length > 0) {
    for (const sourceUrlObj of sourceUrls) {
      if (sourceUrlObj.url && sourceUrlObj.url !== url) {
        addOrUpdateSource(ruleset, {
          downloadedAt: new Date().toISOString(),
          contentLength: 0,
          sourceUrl: sourceUrlObj.url,
          title: sourceUrlObj.title || "Article",
          type: "statute"
        });
      }
    }
    ruleset.isArticleBased = true;
    console.log(`  📄 Added ${sourceUrls.length} article URLs to sources`);
  } else {
    ruleset.isArticleBased = false;
  }
}

async function stitchArticlesAndGenerateContent(articles: ArticleLink[], sourceUrls: ArticleLink[] | undefined, content: string) {
  console.log(
    `  📚 Processing article-based statute with ${articles.length} articles`
  );
  const articleResult = await downloadAndStitchArticles(articles);
  let plainTextContent = articleResult.content;
  sourceUrls = articleResult.sourceUrls;

  if (!plainTextContent || plainTextContent.length < 100) {
    console.log(
      `  ⚠️  Article stitching resulted in insufficient content, falling back to main page`
    );
    plainTextContent = convertHtmlToText(content);
    sourceUrls = undefined;
  } else {
    console.log(
      `  ✅ Successfully stitched ${sourceUrls.length} articles into ${plainTextContent.length} characters`
    );
  }
  return { plainTextContent, sourceUrls };
}

// ─── Process undownloaded sources ────────────────────────────────────────────

// TODO: refactor this to reuse the other downloaders
export async function processUndownloadedSources(
  entityDir: string, 
  ruleset: Ruleset,
  entityName: string,
  realmType?: string
): Promise<boolean> {
  // Try to restore sources from legacy fields if sources array is empty
  if (!ruleset.sources || ruleset.sources.length === 0) {
    console.log(`  🔄 Attempting to restore sources from legacy fields for ${entityName}`);
    
    // Try to extract URLs from originalCellValue or sourceUrls
    const urlsToRestore: string[] = [];
    
    if (ruleset.originalCellValue && typeof ruleset.originalCellValue === 'string') {
      // Extract URLs from originalCellValue - look for http/https patterns
      const urlMatches = ruleset.originalCellValue.match(/https?:\/\/[^\s\],;"]+/g);
      if (urlMatches) {
        urlsToRestore.push(...urlMatches);
      }
    }
    
    // TODO fix these to new datastructure
    // if (ruleset.sourceUrls && Array.isArray(ruleset.sourceUrls)) {
    //   urlsToRestore.push(...ruleset.sourceUrls.filter(url => typeof url === 'string' && url.startsWith('http')));
    // }
    
    if (urlsToRestore.length > 0) {
      console.log(`  🔗 Found ${urlsToRestore.length} URLs to restore: ${urlsToRestore.join(', ')}`);
      
      // Create sources from discovered URLs
      ruleset.sources = urlsToRestore.map((url, index) => ({
        sourceUrl: url,
        type: realmType === "policy" ? "policy" : "statute", // Use actual realm type
        title: `${entityName} ${ruleset.domain} Document${urlsToRestore.length > 1 ? ` ${index + 1}` : ''}`,
      }));
      
      console.log(`  ✅ Restored ${ruleset.sources.length} sources for processing`);
    } else {
      console.log(`  ⏭️  No sources or legacy URLs found for ${entityName}`);
      return false;
    }
  }

  let downloadedAny = false;

  for (let i = 0; i < ruleset.sources.length; i++) {
    const source = ruleset.sources[i];
    
    // Skip sources that have already been downloaded
    if (source.downloadedAt) {
      continue;
    }

    console.log(`  📥 Downloading unprocessed source ${i + 1}/${ruleset.sources.length}: ${source.sourceUrl}`);
    
    try {
      // Get content type to determine if PDF or HTML with safe fallback
      let contentType = "text/html";
      try {
        contentType = await getContentTypeFromUrl(source.sourceUrl);
      } catch (error: any) {
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
      const sameTypeCount = ruleset.sources.slice(0, i).filter(s => s.type === source.type).length;
      const sourceIndex = sameTypeCount === 0 ? "" : `_${sameTypeCount + 1}`;
      const fileName = `${baseFileName}${sourceIndex}`;
      
      if (isPdf) {
        // Save PDF file with unique name
        const pdfPath = path.join(entityDir, `${fileName}.pdf`);
        textContent = await getTextFromPdfFile(pdfPath);
      } else {
        // Handle HTML content
        const htmlContent = Buffer.from(response.data).toString('utf-8');
        
        // Clean HTML by removing STYLE and SCRIPT elements
        const virtualConsole = new VirtualConsole();
        virtualConsole.forwardTo(console,  { jsdomErrors: "none" });
        const dom = new JSDOM(htmlContent, { virtualConsole });
        const document = dom.window.document;
        const elementsToRemove = document.querySelectorAll("script, style");
        elementsToRemove.forEach((element) => element.remove());
        const cleanedHtml = dom.serialize();
        
        // Save HTML file with unique name
        const htmlFilePath = path.join(entityDir, `${fileName}.html`);
        await fs.writeFile(htmlFilePath, cleanedHtml, 'utf-8');
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
      // TODO - fix this
      // source.filePaths = {
      //   html: isPdf ? undefined : `${fileName}.html`,
      //   pdf: isPdf ? `${fileName}.pdf` : undefined,
      //   txt: `${fileName}.txt`
      // };
      
      console.log(`    ✅ Updated source: ${title} (${textContent.length} chars)`);
      downloadedAny = true;
      
      // Add delay between downloads to be respectful
      await delay(DELAY_BETWEEN_DOWNLOADS);
      
    } catch (error: any) {
      console.error(`    ❌ Failed to download ${source.sourceUrl}: ${error.message}`);
      
      // Add delay even after failures to avoid hammering hosts
      await delay(1000);
      
      // Don't mark failed downloads as downloaded - skip this source
      console.log(`    ⏭️  Skipping failed source, will retry on next run`);
    }
  }
  
  // If we downloaded any sources, persist the updated ruleset
  if (downloadedAny) {
    const metadataPath = path.join(entityDir, "ruleset.json");
    // await writeMetadata(metadataPath, ruleset);
    console.log(`  💾 Updated ruleset with ${ruleset.sources.filter(s => s.downloadedAt).length} processed sources`);
  }
  
  return downloadedAny;
}

// ─── Create missing ruleset files ──────────────────────────────────────────

// export async function createMissingMetadataFiles(realm: Realm, reloadMode: boolean = false, entitiesToInclude?: Set<string>): Promise<void> {
//   if (reloadMode) {
//     console.log("\n🔄 Reload mode: Regenerating ruleset.json files from source data...");
//   } else {
//     console.log("\n🔍 Checking for missing ruleset.json files...");
//   }

//   const realmDir = path.join(getProjectDataDir(), realm.datapath);
//   if (!(await fs.pathExists(realmDir))) {
//     console.log(`  No realm directory found: ${realmDir}`);
//     return;
//   }
//   const domains = await fs.readdir(realmDir);
//   let missingCount = 0;
//   let createdCount = 0;

//   for (const domain of domains) {
//     const domainPath = path.join(realmDir, domain);
//     const stat = await fs.stat(domainPath);

//     if (
//       !stat.isDirectory() ||
//       domain.endsWith(".json") ||
//       domain.endsWith(".csv")
//     )
//       continue;

//     const municipalities = await fs.readdir(domainPath);

//     for (const municipality of municipalities) {
//       if (!municipality.startsWith(getEntityPrefix())) continue;

//       // Apply municipality filter if specified
//       if (entitiesToInclude) {
//         const prefixRegex = new RegExp(`^${getEntityPrefix()}(.+)-(.+)$`);
//         const match = municipality.match(prefixRegex);
//         const municipalityName = match ? match[1].replace(/([A-Z])/g, " $1").trim() : municipality;
//         const shouldProcess = entitiesToInclude.has(municipalityName.toLowerCase());
//         if (!shouldProcess) {
//           continue; // Skip this municipality
//         }
//       }

//       const municipalityPath = path.join(domainPath, municipality);
//       const municipalityStat = await fs.stat(municipalityPath);

//       if (!municipalityStat.isDirectory()) continue;

//       const statutePath = path.join(municipalityPath, "statute.txt");
//       const metadataPath = path.join(municipalityPath, "ruleset.json");

//       if (
//         (await fs.pathExists(statutePath)) &&
//         (!(await fs.pathExists(metadataPath)) || reloadMode)
//       ) {
//         if (reloadMode && (await fs.pathExists(metadataPath))) {
//           console.log(`  Reload mode: Regenerating ruleset.json: ${domain}/${municipality}`);
//         } else {
//           missingCount++;
//           console.log(`  Missing ruleset.json: ${domain}/${municipality}`);
//         }

//         try {
//           const statuteStats = await fs.stat(statutePath);
//           const statuteContent = await fs.readFile(statutePath, "utf-8");

//           // Parse municipality name and type from directory name
//           const prefixRegex = new RegExp(`^${getEntityPrefix()}(.+)-(.+)$`);
//           const match = municipality.match(prefixRegex);
//           const municipalityName = match
//             ? match[1].replace(/([A-Z])/g, " $1").trim()
//             : municipality;
//           const municipalityType = match ? match[2] : "Unknown";

//           // Check if ruleset already exists and preserve existing data if present
//           let existingMetadata: Ruleset | null = null;
//           let existingOriginalCellValue = "Not available";
//           if (await fs.pathExists(metadataPath)) {
//             try {
//               existingMetadata = await readMetadata(metadataPath);
//               if (existingMetadata?.originalCellValue) {
//                 existingOriginalCellValue = existingMetadata.originalCellValue;
//               }
//             } catch (error: any) {
//               // Ignore errors reading existing ruleset
//             }
//           }

//           const downloadedAt = statuteStats.birthtime?.toISOString() || statuteStats.mtime.toISOString();
          
//           // Extract statute number and title from HTML if available
//           let statuteTitle = domain.charAt(0).toUpperCase() + domain.slice(1).replace(/-/g, " ");
//           const htmlPath = path.join(municipalityPath, "statute.html");
//           if (await fs.pathExists(htmlPath)) {
//             const statuteInfo = await extractStatuteInfo(htmlPath);
//             if (statuteInfo.title) {
//               statuteTitle = statuteInfo.title;
//               console.log(`    📋 Extracted statute info: ${statuteInfo.number || "N/A"} - ${statuteInfo.title || "N/A"}`);
//             }
//           }

//           // Start with existing ruleset if available, otherwise create base ruleset
//           const ruleset: Ruleset = existingMetadata || {
//             municipality: municipalityName,
//             municipalityType: municipalityType,
//             domain: domain.charAt(0).toUpperCase() + domain.slice(1).replace(/-/g, " "),
//             domainId: domain,
//             sources: [],
//             originalCellValue: existingOriginalCellValue,
//             stateCodeApplies: false,
//             metadataCreated: new Date().toISOString(),
//             note: "Ruleset created retroactively for existing statute file",
//           };

//           // Always update basic fields from current processing
//           ruleset.municipality = municipalityName;
//           ruleset.municipalityType = municipalityType;
//           ruleset.domain = domain.charAt(0).toUpperCase() + domain.slice(1).replace(/-/g, " ");
//           ruleset.domainId = domain;
//           ruleset.originalCellValue = existingOriginalCellValue;

//           // Add or update the primary statute source using merge strategy
//           if ((existingMetadata && getSourceUrl(existingMetadata)) || existingOriginalCellValue !== "Not available") {
//             const sourceUrl = (existingMetadata && getSourceUrl(existingMetadata)) || existingOriginalCellValue;
//             if (sourceUrl && sourceUrl !== "Not available" && sourceUrl !== "Unknown") {
//               addOrUpdateSource(ruleset, {
//                 downloadedAt: (existingMetadata && getDownloadedAt(existingMetadata)) || downloadedAt,
//                 contentLength: statuteContent.length,
//                 sourceUrl: sourceUrl,
//                 title: statuteTitle,
//                 type: "statute"
//               });
//             }
//           } else {
//             // Create placeholder source if no URL is available
//             if (!ruleset.sources || ruleset.sources.length === 0) {
//               ruleset.sources = [{
//                 downloadedAt,
//                 contentLength: statuteContent.length,
//                 sourceUrl: "Unknown",
//                 title: statuteTitle,
//                 type: "statute"
//               }];
//             }
//           }

//           // Add statute number if extracted
//           if (await fs.pathExists(htmlPath)) {
//             const statuteInfo = await extractStatuteInfo(htmlPath);
//             if (statuteInfo.number) ruleset.statuteNumber = statuteInfo.number;
//           }

//           await writeMetadata(metadataPath, ruleset);
          
//           // Process any additional sources (form, guidance, etc.) after saving ruleset
//           try {
//             const processedSources = await processUndownloadedSources(municipalityPath, ruleset, `${municipalityName} - ${municipalityType}`, realm.ruleType);
//             if (processedSources) {
//               console.log(`    🔄 Processed additional sources for ${municipalityName} - ${municipalityType}`);
//             }
//           } catch (error: any) {
//             console.warn(`    ⚠️  Failed to process additional sources for ${municipalityName} - ${municipalityType}: ${error.message}`);
//           }
          
//           createdCount++;
//           if (reloadMode) {
//             console.log(
//               `    ✅ Regenerated ruleset.json for ${municipalityName} - ${municipalityType}`,
//             );
//           } else {
//             console.log(
//               `    ✅ Created ruleset.json for ${municipalityName} - ${municipalityType}`,
//             );
//           }
//         } catch (error: any) {
//           console.error(
//             `    ❌ Failed to create ruleset for ${municipality}: ${error.message}`,
//           );
//         }
//       }
//     }
//   }

//   if (reloadMode) {
//     console.log(
//       `\n📊 Reload complete: ${createdCount} ruleset files regenerated from source data`,
//     );
//   } else {
//     console.log(
//       `\n📊 Ruleset check complete: ${missingCount} missing files found, ${createdCount} created`,
//     );
//   }
// }

// ─── Generate summary file ──────────────────────────────────────────────────

export async function generateSummaryFile(realm: Realm): Promise<void> {
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

    const entData: any = {
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
        const statutePath = path.join(entityDir, `statute${realm.ruleType}`);
        const metadataPath = path.join(entityDir, "ruleset.json");

        if (
          (await fs.pathExists(statutePath)) ||
          (await fs.pathExists(metadataPath))
        ) {
          const domainData: any = {};

          // Read ruleset if it exists
          if (await fs.pathExists(metadataPath)) {
            try {
              // TODO - refactor this to read from Ruleset
              // const ruleset = await readMetadata(metadataPath);
              // if (ruleset) {
              //   domainData.sourceUrl = getSourceUrl(ruleset);
              //   domainData.lastDownloadTime = getDownloadedAt(ruleset);
              //   domainData.isArticleBased = ruleset.isArticleBased || false;
              //   domainData.usesStateCode = ruleset.stateCodeApplies || false;

              //   // Count sources for article count
              //   if (ruleset.sources && ruleset.sources.length > 1) {
              //     domainData.articleCount = ruleset.sources.length;
              //     domainData.sourceUrls = ruleset.sources.map(s => ({ url: s.sourceUrl, title: s.title }));
              //   }
              // }
            } catch (error: any) {
              console.log(
                `  Warning: Could not read ruleset for ${entity.id}/${domain}: ${error.message}`,
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
            } catch (error: any) {
              console.log(
                `  Warning: Could not read statute file for ${entity.id}/${domain}: ${error.message}`,
              );
              domainData.wordCount = 0;
              domainData.characterCount = 0;
            }
          } else if (domainData.usesStateCode) {
            // For state code municipalities, reference the shared state file
            const stateStatutePath = path.join(
              dataDir,
              realm.datapath,
              domainDir,
              `${getEntityPrefix()}State`,
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
              } catch (error: any) {
                domainData.wordCount = 0;
                domainData.characterCount = 0;
              }
            }
          } else {
            domainData.wordCount = 0;
            domainData.characterCount = 0;
          }

          entData.domains[domain] = domainData;
        }
      }
    }

    // Only add entity if it has data for at least one domain
    if (Object.keys(entData.domains).length > 0) {
      summary.push(entData);
    }
  }

  // Sort entities by name for consistent output
  summary.sort((a, b) => a.name.localeCompare(b.name));

  // Add ruleset about the summary
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

// ─── Create directory structure from JSON ────────────────────────────────────

export async function createDirectoryStructureFromJSON(
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
      
      // Create ruleset.json file with policy information
      const ruleset: any = {
        districtName: districtName,
        entityId: entityId,
        domain: domain,
        sourceUrl: sourceUrl,
        policyNumber: policy.policy_number || null,
        policyTitle: policy.policy_title || null,
        downloadedAt: new Date().toISOString(),
        realm: realm.id
      };
      
      await fs.writeJson(path.join(domainDir, "ruleset.json"), ruleset, { spaces: 2 });
      
      // Download policy URL if valid
      if (isValidUrl && sourceUrl) {
        try {
          console.log(`      Downloading policy: ${policy.policy_title || 'Untitled'}`);
          
          // Download content with binary support for both HTML and PDF
          const response = await axios.get(sourceUrl, {
            timeout: 30000,
            responseType: 'arraybuffer', // Handle both HTML and PDF
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; EntityCrawler/1.0)'
            }
          });
          
          // Detect content type with enhanced PDF detection
          const contentType = response.headers["content-type"]?.toString() || '';
          const isPdf = isContentPdf(response.data, contentType, sourceUrl);
          
          let textContent: string;
          
          if (isPdf) {
            console.log(`        📄 Processing PDF policy document...`);
            
            // Save as policy.pdf
            const policyPdfPath = path.join(domainDir, 'policy.pdf');
            await fs.writeFile(policyPdfPath, response.data);
            console.log(`        💾 Saved PDF: ${policyPdfPath}`);
            
            // Extract text from PDF
                textContent = await getTextFromPdfFile(policyPdfPath);
              console.log(`        📄 Extracted ${textContent.length} characters from PDF`);

              // should this be in a library?
              // Clean up PDF text similar to HTML cleaning
              textContent = textContent.replace(/\r\n/g, '\n');
              textContent = textContent.replace(/\n{3,}/g, '\n\n');
              textContent = textContent.replace(/[ \t]{2,}/g, ' ');
              textContent = textContent.replace(/\n /g, '\n');
              textContent = textContent.trim();
          } else {
            console.log(`        📄 Processing HTML policy document...`);
            
            // Convert response data to string for HTML processing
            const htmlContent = Buffer.from(response.data).toString('utf-8');
            
            // Clean HTML by removing STYLE and SCRIPT elements
            const virtualConsole = new VirtualConsole();
            virtualConsole.forwardTo(console, { jsdomErrors: "none" });
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
          
          // Update ruleset with content information through sources
          addOrUpdateSource(ruleset, {
            downloadedAt: ruleset.downloadedAt || new Date().toISOString(),
            contentLength: textContent.length,
            sourceUrl: sourceUrl,
            title: ruleset.statuteTitle || ruleset.policyTitle || ruleset.domain || (isPdf ? "PDF Document" : "HTML Document"),
            type: "statute"
          });
          ruleset.lastConverted = new Date().toISOString();
          
          // If PDF, add additional ruleset
          // TODO use this if needed
        //   if (isPdf && textContent.length > 0) {
        //     try {
              
        //       const pdfData = await pdfParse.default(response.data);
        //       ruleset.pdfPages = pdfData.numpages;
        //     } catch {
        //       // If PDF parsing failed for ruleset, continue without page count
        //     }
        //   }
          
          // Save updated ruleset
          await writeMetadata(path.join(domainDir, "ruleset.json"), ruleset);
          
          // Process any undownloaded sources in the ruleset  
          await processUndownloadedSources(domainDir, ruleset, districtName, realm.ruleType);
          
          console.log(`        ✅ Downloaded and converted: ${policy.policy_title || 'Untitled'}`);
          
          // Add small delay between downloads to be respectful
          await delay(1000);
          
        } catch (error: any) {
          // Handle HTTP errors specially
          if (error.response && error.response.status) {
            const httpCode = error.response.status;
            const failedUrl = `FAILED HTTP ${httpCode} ${sourceUrl}`;
            console.warn(`        ⚠️ HTTP ${httpCode} error downloading ${sourceUrl}`);
            
            // Update ruleset with failed URL through sources
            addOrUpdateSource(ruleset, {
              downloadedAt: new Date().toISOString(),
              contentLength: 0,
              sourceUrl: failedUrl,
              title: "Failed Download",
              type: "statute"
            });
            await writeMetadata(path.join(domainDir, "ruleset.json"), ruleset);
            
            logToFile(`HTTP ${httpCode} error downloading ${sourceUrl}`);
          } else {
            console.warn(`        ⚠️ Failed to download policy URL ${sourceUrl}: ${error.message}`);
            logToFile(`Failed to download policy URL ${sourceUrl}: ${error.message}`);
          }
        }
      } else if (sourceUrl) {
        console.log(`      Skipping download - invalid URL format: ${sourceUrl}`);
      }
      
      console.log(`      Created policy ruleset in ${domain}/${entityId}`);
    }
    
    processedCount++;
  }
  
  console.log(`✅ Created directories for ${processedCount} districts across ${directoryCount} domain/entity combinations`);
}

/**
 * @deprecated
 */
async function writeMetadata(path: string, content: string) {

}

// ─── Cleanup mode ────────────────────────────────────────────────────────────

// TODO - review this and refactor
export async function runCleanupMode(
  realm: Realm,
  targetDomain?: string,
  entityFilter?: string,
  forceMode: boolean = false,
): Promise<void> {
  console.log("\n🧹 Starting cleanup mode...");
  logToFile("Starting cleanup mode");

//   const realmDir = path.join(getProjectDataDir(), realm.datapath);
//   if (!(await fs.pathExists(realmDir))) {
//     console.log(`  No realm directory found: ${realmDir}`);
//     return;
//   }
//   const domains = await fs.readdir(realmDir);

//   let processedCount = 0;
//   let updatedCount = 0;
//   let binaryDetectedCount = 0;

//   // Filter domains if specified
//   const domainsToProcess = targetDomain
//     ? domains.filter((d) => d.toLowerCase() === targetDomain.toLowerCase())
//     : domains;

//   if (targetDomain && domainsToProcess.length === 0) {
//     console.error(
//       `Domain "${targetDomain}" not found. Available domains: ${domains.join(", ")}`,
//     );
//     return;
//   }

//   for (const domain of domainsToProcess) {
//     const domainPath = path.join(realmDir, domain);
//     const stat = await fs.stat(domainPath);

//     if (
//       !stat.isDirectory() ||
//       domain.endsWith(".json") ||
//       domain.endsWith(".csv")
//     )
//       continue;

//     console.log(`\n📁 Processing domain: ${domain}`);

//     const municipalities = await fs.readdir(domainPath);

//     for (const municipality of municipalities) {
//       if (!municipality.startsWith(getEntityPrefix())) continue;

//       // Apply municipality filter if specified
//       if (entityFilter) {
//         const filters = entityFilter
//           .split(",")
//           .map((f) => f.trim().toLowerCase());
//         const municipalityName = municipality.toLowerCase();
//         const found = filters.some((filter) =>
//           municipalityName.includes(filter),
//         );
//         if (!found) continue;
//       }

//       const municipalityPath = path.join(domainPath, municipality);
//       const municipalityStat = await fs.stat(municipalityPath);

//       if (!municipalityStat.isDirectory()) continue;

//       const metadataPath = path.join(municipalityPath, "ruleset.json");
//       const statutePath = path.join(municipalityPath, "statute.txt");
//       const statuteHtmlPath = path.join(municipalityPath, "statute.html");
//       const statutePdfPath = path.join(municipalityPath, "statute.pdf");

//       console.log(`  🔍 Checking ${municipality}...`);
//       processedCount++;

//       try {
//         // Step 1: Check ruleset.json
//         if (!(await fs.pathExists(metadataPath))) {
//           console.log(`    ⏭️  Skipping - no ruleset.json`);
//           continue;
//         }

//         const ruleset = await fs.readJson(metadataPath);

//         // Step 1: Handle referencesStateCode==true directories
//         if (ruleset.referencesStateCode === true) {
//           console.log(`    🏛️  State code reference detected - cleaning up local files`);
//           let removedFiles = 0;
          
//           // Remove all statute.* files
//           const statuteFiles = ['statute.txt', 'statute.html', 'statute.pdf'];
//           for (const fileName of statuteFiles) {
//             const fPath = path.join(municipalityPath, fileName);
//             if (await fs.pathExists(fPath)) {
//               await fs.remove(fPath);
//               console.log(`    🗑️  Removed ${fileName}`);
//               removedFiles++;
//               logToFile(`Removed ${municipality}/${domain}: ${fileName} (referencesStateCode=true)`);
//             }
//           }
          
//           // Remove analysis.json file
//           const analysisPath = path.join(municipalityPath, 'analysis.json');
//           if (await fs.pathExists(analysisPath)) {
//             await fs.remove(analysisPath);
//             console.log(`    🗑️  Removed analysis.json`);
//             removedFiles++;
//             logToFile(`Removed ${municipality}/${domain}: analysis.json (referencesStateCode=true)`);
//           }
          
//           // Remove backup files (statute.*.backup-*)
//           const files = await fs.readdir(municipalityPath);
//           const backupFiles = files.filter(file => file.includes('.backup-'));
//           for (const backupFile of backupFiles) {
//             const backupPath = path.join(municipalityPath, backupFile);
//             await fs.remove(backupPath);
//             console.log(`    🗑️  Removed ${backupFile}`);
//             removedFiles++;
//             logToFile(`Removed ${municipality}/${domain}: ${backupFile} (referencesStateCode=true)`);
//           }
          
//           if (removedFiles > 0) {
//             console.log(`    ✅ Cleaned up ${removedFiles} files for state code reference`);
//             updatedCount++;
//           } else {
//             console.log(`    ✅ Already clean (no statute/analysis files found)`);
//           }
//           continue;
//         }

//         // Step 2: Skip if no sourceUrl or points to state code
//         const sourceUrl = getSourceUrl(ruleset);
//         if (!sourceUrl) {
//           console.log(`    ⏭️  Skipping - no sourceUrl`);
//           continue;
//         }

//         if (
//           ruleset.stateCodeApplies === true ||
//           sourceUrl.toLowerCase().includes("state") ||
//           sourceUrl.toLowerCase().includes("nys.gov")
//         ) {
//           console.log(`    ⏭️  Skipping - uses state code`);
//           continue;
//         }

//         // Step 3: Re-download if original file doesn't exist (HTML or PDF)
//         const hasHtml = await fs.pathExists(statuteHtmlPath);
//         const hasPdf = await fs.pathExists(statutePdfPath);
        
//         if (!hasHtml && !hasPdf) {
//           console.log(`    📥 Re-downloading statute file...`);
//           try {
//             const contentType = await getContentTypeFromUrl(sourceUrl);
//             // Initial detection - will be enhanced after download
//             let isPdf = contentType.includes('application/pdf') || sourceUrl.toLowerCase().endsWith('.pdf');
            
//             const response = await axios.get(sourceUrl, {
//               timeout: 30000,
//               responseType: isPdf ? 'arraybuffer' : 'text',
//               headers: {
//                 "User-Agent": "Mozilla/5.0 (compatible; OrdinanceCrawler/1.0)",
//               },
//             });

//             if (isPdf) {
//               await fs.writeFile(statutePdfPath, Buffer.from(response.data));
//               logToFile(`Re-downloaded ${municipality}/${domain}: statute.pdf`);
//             } else {
//               await fs.writeFile(statuteHtmlPath, response.data);
//               logToFile(`Re-downloaded ${municipality}/${domain}: statute.html`);
//             }
//           } catch (downloadError: any) {
//             console.log(
//               `    ❌ Failed to re-download: ${downloadError.message}`,
//             );
//             logToFile(
//               `Failed to re-download ${municipality}/${domain}: ${downloadError.message}`,
//             );
//             continue;
//           }
//         }

//         // Step 4: Generate new statute.txt from original file (HTML or PDF)
//         let newText: string = "";
        
//         if (await fs.pathExists(statutePdfPath)) {
//           // Handle PDF files
//             newText = await getTextFromPdfFile(statutePdfPath);
//         } else if (await fs.pathExists(statuteHtmlPath)) {
//           // Handle HTML files
//           const htmlContent = await fs.readFile(statuteHtmlPath, "utf-8");

//           // Extract anchor from source URL if present for targeted section extraction
//           const primarySourceUrl = getSourceUrl(ruleset) || "";
//           const anchorMatch = primarySourceUrl.match(/#(.+)$/);
//           const anchorId = anchorMatch ? anchorMatch[1] : undefined;

//           // Use conversion with anchor support for targeted extraction
//           newText = convertHtmlToText(htmlContent, anchorId);
//         } else {
//           console.log(`    ⚠️  No source file found (neither HTML nor PDF)`);
//           continue;
//         }

//         if (newText) {
//           // Extract anchor info for logging
//           const primarySourceUrl = getSourceUrl(ruleset) || "";
//           const anchorMatch = primarySourceUrl.match(/#(.+)$/);
//           const anchorId = anchorMatch ? anchorMatch[1] : undefined;

//           if (forceMode) {
//             // Force mode: just compare with existing and update if different
//             const existingText = (await fs.pathExists(statutePath))
//               ? await fs.readFile(statutePath, "utf-8")
//               : "";

//             if (newText !== existingText) {
//               await fs.writeFile(statutePath, newText, "utf-8");
//               console.log(
//                 `    🔄 Force update: statute.txt regenerated (${existingText.length} -> ${newText.length} chars)${anchorId ? ` [anchor: #${anchorId}]` : ""}`,
//               );

//               // Update timestamp and content length in ruleset
//               const primarySrcUrl = getSourceUrl(ruleset) || "";
//               ruleset.lastCleanup = new Date().toISOString();
//               addOrUpdateSource(ruleset, {
//                 downloadedAt: getDownloadedAt(ruleset) || new Date().toISOString(),
//                 contentLength: newText.length,
//                 sourceUrl: primarySrcUrl,
//                 title: getSourceTitle(ruleset),
//                 type: "statute"
//               });
//               await writeMetadata(metadataPath, ruleset);

//               // Process any undownloaded sources in the ruleset
//               await processUndownloadedSources(municipalityPath, ruleset, municipality, realm.ruleType);

//               updatedCount++;
//               logToFile(
//                 `Force updated ${municipality}/${domain}: statute.txt regenerated from HTML`,
//               );
//             } else {
//               console.log(`    ✅ No changes needed (force mode)`);
//             }
//           } else {
//             // Normal cleanup mode: use temporary file and compare
//             const newStatutePath = path.join(
//               municipalityPath,
//               "statute_new.txt",
//             );
//             await fs.writeFile(newStatutePath, newText);

//             if (anchorId) {
//               console.log(`    🎯 Using anchor-based extraction: #${anchorId}`);
//             }

//             // Step 5: Compare with existing statute.txt (normal cleanup mode)
//             let shouldUpdate = false;
//             let diffReason = "";

//             if (!(await fs.pathExists(statutePath))) {
//               shouldUpdate = true;
//               diffReason = "no existing statute.txt";
//             } else {
//               const existingText = await fs.readFile(statutePath, "utf-8");
//               if (newText !== existingText) {
//                 shouldUpdate = true;
//                 diffReason = `content differs (${existingText.length} -> ${newText.length} chars)`;
//               }
//             }

//             if (shouldUpdate) {
//               console.log(`    🔄 Updating statute.txt - ${diffReason}`);

//               // Replace statute.txt
//               await fs.move(newStatutePath, statutePath, { overwrite: true });

//               // Update timestamps and content length through sources
//               const currentTime = new Date().toISOString();
//               const primarySrcUrl = getSourceUrl(ruleset) || "";
//               addOrUpdateSource(ruleset, {
//                 downloadedAt: currentTime,
//                 contentLength: newText.length,
//                 sourceUrl: primarySrcUrl,
//                 title: getSourceTitle(ruleset),
//                 type: "statute"
//               });
//               ruleset.lastCleanup = currentTime;
//               await writeMetadata(metadataPath, ruleset);

//               // Process any undownloaded sources in the ruleset
//               await processUndownloadedSources(municipalityPath, ruleset, municipality, realm.ruleType);

//               updatedCount++;
//               logToFile(
//                 `Updated ${municipality}/${domain}: statute.txt (${diffReason})`,
//               );
//             } else {
//               console.log(`    ✅ No changes needed`);
//               await fs.remove(newStatutePath);
//             }
//           }
//         } else {
//           console.log(`    ⚠️  No valid text content extracted`);
//         }

//         // Step 4: Delete statute.txt.backup* files
//         const backupFiles = await fs.readdir(municipalityPath);
//         const backupFilesToDelete = backupFiles.filter((file) =>
//           file.startsWith("statute.txt.backup"),
//         );

//         if (backupFilesToDelete.length > 0) {
//           console.log(
//             `    🗑️  Removing ${backupFilesToDelete.length} backup files`,
//           );
//           for (const backupFile of backupFilesToDelete) {
//             await fs.remove(path.join(municipalityPath, backupFile));
//             logToFile(
//               `Deleted backup: ${municipality}/${domain}/${backupFile}`,
//             );
//           }
//         }

//         // Step 5: Extract statute number and title
//         if (await fs.pathExists(statuteHtmlPath)) {
//           const statuteInfo = await extractStatuteInfo(statuteHtmlPath);
//           if (statuteInfo.number || statuteInfo.title) {
//             console.log(
//               `    📋 Statute info: ${statuteInfo.number || "N/A"} - ${statuteInfo.title || "N/A"}`,
//             );

//             // Update ruleset with statute info
//             if (statuteInfo.number) ruleset.statuteNumber = statuteInfo.number;
//             if (statuteInfo.title) ruleset.statuteTitle = statuteInfo.title;

//             await fs.writeJson(metadataPath, ruleset, { spaces: 2 });
//             logToFile(
//               `Extracted statute info for ${municipality}/${domain}: ${statuteInfo.number} - ${statuteInfo.title}`,
//             );
//           }
//         }

//         // Step 6: Analyze statute.txt for binary data
//         if (await fs.pathExists(statutePath)) {
//           const statuteContent = await fs.readFile(statutePath, "utf-8");
//           if (hasBinaryData(statuteContent)) {
//             console.log(`    ⚠️  BINARY DATA DETECTED in statute.txt!`);
//             logToFile(
//               `ERROR: Binary data detected in ${municipality}/${domain}/statute.txt`,
//             );
//             binaryDetectedCount++;
//           }
//         }
//       } catch (error: any) {
//         console.log(
//           `    ❌ Error processing ${municipality}: ${error.message}`,
//         );
//         logToFile(
//           `Error processing ${municipality}/${domain}: ${error.message}`,
//         );
//       }
//     }
//   }

//   console.log(`\n✅ Cleanup completed!`);
//   console.log(`   📊 Processed: ${processedCount} municipalities`);
//   console.log(`   🔄 Updated: ${updatedCount} statute files`);
//   if (binaryDetectedCount > 0) {
//     console.log(
//       `   ⚠️  Binary data detected: ${binaryDetectedCount} files (check logs)`,
//     );
//   }

//   logToFile(
//     `Cleanup completed - Processed: ${processedCount}, Updated: ${updatedCount}, Binary detected: ${binaryDetectedCount}`,
//   );
}
