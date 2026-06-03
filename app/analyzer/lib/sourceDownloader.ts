import fs from "fs-extra";
import path from "path";
import axios, { AxiosResponse } from "axios";
import { JSDOM, VirtualConsole } from "jsdom";
import { convertHtmlToText, convertHtmlToTextSimple } from "./simpleHtmlToText";
import {
  type ArticleLink,
  DELAY_BETWEEN_DOWNLOADS,
  verboseLog,
  getProjectRootDir,
  getDomainDisplayName,
  loadStatuteLibraryConfig,
  getLibraryForUrl,
} from "./extractionConfig";
import {
  type ISpreadsheetParser,
  DefaultSpreadsheetParser,
  getEntityPrefix,
  getStateCode,
} from "./spreadsheetParser";
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
} from "./extractionUtils";
import { PDFParse } from "pdf-parse";
import { text } from "stream/consumers";
import { Ruleset, Domain, Entity, Realm } from "@civillyengaged/ordinizer-core";
import { IStorage, getDefaultStorage } from "@civillyengaged/ordinizer-servercore";

// ─── Per-entity download loop ────────────────────────────────────────────────

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

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
  const stateProvince = realm.geo?.stateProvince ?? '';

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
      // const mappedDomain = DOMAIN_MAPPING[domain] || domain;
      const columnIndex = columnMap[domain];
      const cellText = row[columnIndex]; // Direct access to cell text
      let url = "";
      let grade: string | null = null;

      // First check if we have hyperlink data for this cell
      // API data (A2:Q50): rows[0] = headers, rows[1+] = data rows
      // Hyperlink data appears to be off by 1, so adjust mapping
      const allRowIndex = rows.indexOf(row); // Index in full rows array
      const dataRowIndex = allRowIndex - 1; // Exclude header row at rows[0]
      const rowIndex = dataRowIndex + 2; // Adjusted mapping to fix off-by-one error
      const colIndex = columnMap[domain];

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

      // Check if this municipality uses state code (cell text contains e.g. "NY State")
      const usesStateCode =
        !!stateProvince && (cellText?.toLowerCase().includes(`${stateProvince.toLowerCase()} state`) ?? false);

      // Convert domain name to kebab-case for directory naming
      const domainDir = domain.toLowerCase().replace(/\s+/g, "-");

      if (usesStateCode) {
        downloadCount = await checkStateMetadata(cleanName,
          cleanType, sp, realm, domainDir, domain, url, cellText, downloadCount, stateProvince);

        continue; // Skip the regular download logic for state code municipalities
      } else {
        await checkMetadataAndDownloadSources(
          storage,
          realm,
          domain,
          stateProvince,
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

async function checkStateMetadata(cleanName: string, cleanType: string, sp: ISpreadsheetParser, realm: Realm, domainDir: string, domain: string, url: string, cellText: any, downloadCount: number, stateProvince: string) {
  console.log(
    `  ${cleanName} - ${cleanType}: Uses ${sp.getStateCode()} State code, managing shared state reference`
  );

  // Create municipality directory for ruleset only
  const storage = getDefaultStorage(realm.id);
  const realmDir = path.join(storage.getRealmDir(), realm.datapath);
  
  const municipalityDirPath = path.join(
    realmDir,
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
    realmDir,
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
      console.log(`  Saved ${stateProvince} State HTML source: ${stateHtmlPath}`);

      // Check if this is an article-based page for state code too
      const articles = detectArticleBasedPage(        content,        url      );
      let plainTextContent: string;
      let sourceUrls: ArticleLink[] | undefined;

      if (articles.length > 0) {
        console.log(
          `  📚 Processing article-based ${stateProvince} State statute with ${articles.length} articles`
        );
        const articleResult = await downloadAndStitchArticles(articles);
        plainTextContent = articleResult.content;
        sourceUrls = articleResult.sourceUrls;

        if (!plainTextContent || plainTextContent.length < 100) {
          console.log(
            `  ⚠️  Article stitching resulted in insufficient content, falling back to main page`
          );
          plainTextContent = convertHtmlToTextSimple(content);
          sourceUrls = undefined;
        } else {
          console.log(
            `  ✅ Successfully stitched ${sourceUrls.length} articles into ${plainTextContent.length} characters`
          );
        }
      } else {
        // Regular single-page processing
        plainTextContent = convertHtmlToTextSimple(content);
      }

      await fs.writeFile(stateFilePath, plainTextContent, "utf-8");

      // Save state ruleset
      const stateMetadata: any = {
        municipality: `${stateProvince} State`,
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
          `  📄 Added ${sourceUrls.length} article URLs to ${stateProvince} State ruleset`
        );
      }

      await fs.writeJson(stateMetadataPath, stateMetadata, { spaces: 2 });

      console.log(
        `  ${domain}: Downloaded ${stateProvince} State statute (${plainTextContent.length} characters plain text)`
      );
      downloadCount++;
    } else {
      console.log(`  ${domain}: Failed to download ${stateProvince} State statute`);
    }
  } else {
    console.log(`  ${stateProvince} State statute already exists: ${stateFilePath}`);
  }
  return downloadCount;
}

export async function checkIfValidUrl(storage: IStorage, url: string): Promise<boolean> {
  if (url && url.trim() !== "" && url.toLowerCase() !== "n/a") {
    // TODO: move this call to a higher level function
    const config = await loadStatuteLibraryConfig(storage);
    if (!config) {
      return true;
    }
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
  stateProvince: string,
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
): Promise<void> {
  const entityId = stateProvince + "-" + entityName + (entityType ? `-${entityType}` : "");
  const { noDeleteMode, forceMode, reloadMode, noDownloadMode } = options;

  if (!(await checkIfValidUrl(storage, url))) return;

  let ruleset = await storage.getRulesetOrCreate(domain, entityId);
  let updateReason = getRulesetUpdateReason(ruleset, url, forceMode, reloadMode);

  if (!updateReason && !noDownloadMode) {
    console.log(`  ${domain}: File exists, is recent, and URL unchanged - skipping`);
    return;
  }
  if (updateReason) console.log(`  ${domain}: ${updateReason}`);

  if (noDownloadMode) {
    // Optionally validate or clean up here using helpers
    logToFile(`Skipping download for ${entityName}/${domain} due to --nodownload mode`);
    // validateOrCleanupStatute(storage, ruleset, entityName, entityType, domain, noDeleteMode);
    return;
  }

  if (downloadCount > 0) await delay(DELAY_BETWEEN_DOWNLOADS);

  await downloadAndProcessSource(realm.id, domain, entityId, url);
  await storage.saveRuleset(ruleset);
}
      //   } else {
      //     console.log(`  ${domain}: No existing statute file to validate`);
function getRulesetUpdateReason(ruleset: any, url: string, forceMode: boolean, reloadMode: boolean): string | null {
  if (!ruleset) return "No ruleset found, creating new.";
  const primarySource = getPrimarySource(ruleset);
  if (!primarySource) return "No primary source in ruleset.";
  const lastDownloadedAt = primarySource.downloadedAt;
  let downloadedTooLongAgo = false;
  if (lastDownloadedAt) {
    const daysSinceUpdate = (Date.now() - new Date(lastDownloadedAt).getTime()) / (1000 * 60 * 60 * 24);
    downloadedTooLongAgo = daysSinceUpdate > 30;
  }
  const primarySourceUrl = primarySource.sourceUrl;
  const shouldUpdateDueToUrlChange = (primarySourceUrl != null && primarySourceUrl !== url);
  if (shouldUpdateDueToUrlChange && reloadMode) return "Updating due to reload mode - regenerating from source";
  if (shouldUpdateDueToUrlChange) return "Updating due to URL change";
  if (forceMode) return "Force mode enabled, redownloading existing file";
  if (reloadMode) return "Reload mode enabled, redownloading from source";
  if (downloadedTooLongAgo) return "File is older than 30 days, updating";
  return null;
}
      //     logToFile(
      //       `No existing statute file to validate for ${entityName}/${domain}`,
// function validateOrCleanupStatute(storage: IStorage, ruleset: any, entityName: string, entityType: string, domain: string, noDeleteMode: boolean) {
//   // ...migrate legacy validation/cleanup logic here...
// }
      //     );
      //   }
      //   continue;
      // }

// ...existing code...

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

export async function convertExistingSourceToText(realmId: string, domainId: string, entityId: string): Promise<void> {
  const storage = getDefaultStorage(realmId);
  const currentRealm: Realm = await storage.getRealmConfig();
  const ruleType = currentRealm.ruleType ?? "statute";
  const ruleset = await storage.getRulesetOrCreate(domainId, entityId);
  const destPath = await storage.getPathForDomainAndEntity(ruleset);

  const htmlPath = path.join(destPath, `${ruleType}.html`);
  const pdfPath = path.join(destPath, `${ruleType}.pdf`);

  let downloadedFilepath: string;
  if (await fs.pathExists(htmlPath)) {
    downloadedFilepath = htmlPath;
  } else if (await fs.pathExists(pdfPath)) {
    downloadedFilepath = pdfPath;
  } else {
    throw new Error(`No source file found for ${entityId}/${domainId} (expected ${htmlPath} or ${pdfPath})`);
  }

  let sourceUrls: ArticleLink[] | undefined;
  let plainTextContent: string;

  if (downloadedFilepath.endsWith(".pdf")) {
    plainTextContent = await getTextFromPdfFile(downloadedFilepath);
  } else {
    const content = await fs.readFile(downloadedFilepath, "utf-8");
    const primarySource = getPrimarySource(ruleset);
    const url = primarySource?.sourceUrl ?? "";
    primarySource.contentLength = content.length;
    const articles = detectArticleBasedPage(content, url);

    if (articles.length > 0) {
      ({ plainTextContent, sourceUrls } = await stitchArticlesAndGenerateContent(articles, sourceUrls, content));
    } else {
      const anchorMatch = url.match(/#(.+)$/);
      const anchorId = anchorMatch ? anchorMatch[1] : undefined;
      plainTextContent = convertHtmlToText(content, anchorId);
    }

    const statuteInfo = await extractStatuteInfoFromHTML(content);
    ruleset.statuteNumber = statuteInfo.number;
    if (primarySource) primarySource.title = statuteInfo.title;
  }

  const plaintextFilename = path.join(destPath, `${ruleType}.txt`);
  await fs.writeFile(plaintextFilename, plainTextContent, "utf-8");

  addArticleSources(sourceUrls, getPrimarySource(ruleset)?.sourceUrl ?? "", ruleset);

  console.log(`  ${domainId}: Converted existing source (${plainTextContent.length} characters)`);
  storage.saveRuleset(ruleset);
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
    plainTextContent = convertHtmlToTextSimple(content);
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
  ruleset: any,
  entityName: string,
  realmType?: string
): Promise<boolean> {
  // Refactored: restore sources from legacy if needed, use modular helpers
  if (!ruleset.sources || ruleset.sources.length === 0) {
    restoreLegacySources(ruleset, entityName, realmType);
    if (!ruleset.sources || ruleset.sources.length === 0) {
      console.log(`  ⏭️  No sources or legacy URLs found for ${entityName}`);
      return false;
    }
  }

  let downloadedAny = false;

  for (let i = 0; i < ruleset.sources.length; i++) {
    const source = ruleset.sources[i];
    if (source.downloadedAt) continue;
    console.log(`  📥 Downloading unprocessed source ${i + 1}/${ruleset.sources.length}: ${source.sourceUrl}`);
    try {
      const { textContent, title } = await downloadAndExtractSourceContent(source, entityDir, entityName, ruleset.domain, realmType);
      // Save text file with unique name
      const baseFileName = source.type || "statute";
      const sameTypeCount = ruleset.sources.slice(0, i).filter((s: any) => s.type === source.type).length;
      const sourceIndex = sameTypeCount === 0 ? "" : `_${sameTypeCount + 1}`;
      const fileName = `${baseFileName}${sourceIndex}`;
      const txtPath = path.join(entityDir, `${fileName}.txt`);
      await fs.writeFile(txtPath, textContent, 'utf-8');
      source.downloadedAt = new Date().toISOString();
      source.contentLength = textContent.length;
      source.title = title;
      console.log(`    ✅ Updated source: ${title} (${textContent.length} chars)`);
      downloadedAny = true;
      await delay(DELAY_BETWEEN_DOWNLOADS);
    } catch (error: any) {
      console.error(`    ❌ Failed to download ${source.sourceUrl}: ${error.message}`);
      await delay(1000);
      console.log(`    ⏭️  Skipping failed source, will retry on next run`);
    }
  }
  if (downloadedAny) {
    // Optionally persist ruleset using storage API
    // await storage.saveRuleset(ruleset);
    console.log(`  💾 Updated ruleset with ${ruleset.sources.filter((s: any) => s.downloadedAt).length} processed sources`);
  }
  return downloadedAny;
}
function restoreLegacySources(ruleset: any, entityName: string, realmType?: string) {
  if (!ruleset.originalCellValue || typeof ruleset.originalCellValue !== 'string') return;
  const urlMatches = ruleset.originalCellValue.match(/https?:\/\/[\S\],;"']+/g);
  if (urlMatches && urlMatches.length > 0) {
    ruleset.sources = urlMatches.map((url: string, index: number) => ({
      sourceUrl: url,
      type: realmType === "policy" ? "policy" : "statute",
      title: `${entityName} ${ruleset.domain} Document${urlMatches.length > 1 ? ` ${index + 1}` : ''}`,
    }));
    console.log(`  ✅ Restored ${ruleset.sources.length} sources for processing`);
  }
}

/**
 * @see downloadFromUrlAndSave
 */
async function downloadAndExtractSourceContent(source: any, entityDir: string, entityName: string, domain: string, realmType?: string) {
  const sourceType = source.type || "statute";
  const downloadedFilepath = await downloadFromUrlAndSave(source.sourceUrl, entityDir, sourceType);
  const isPdf = downloadedFilepath.endsWith(".pdf");
  let textContent = "";
  let title = source.title;

  if (isPdf) {
    textContent = await getTextFromPdfFile(downloadedFilepath);
    if (!title || title === "Unknown Document" || title === "Document") {
      title = `${entityName} ${sourceType} (PDF)`;
    }
  } else {
    const htmlContent = await fs.readFile(downloadedFilepath, "utf-8");
    ({ textContent, title } = await extractAndCleanHtmlContent(
      htmlContent));
    if (title === "") {
      title = `${entityName} ${sourceType}`;
    }

  }
  // TODO - this doesn't really need to return the textContent or the title...
  return { textContent, title };
}


export async function extractAndCleanHtmlContent(htmlContent: string) 
  : Promise<{ textContent: string, title: string }>   {
    // Pre-strip script/style blocks so cleaning works even when JSDOM is mocked in tests.
    const htmlWithoutExecutableContent = htmlContent
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");

    const virtualConsole = new VirtualConsole();
    virtualConsole.forwardTo(console, { jsdomErrors: "none" });
    const dom = new JSDOM(htmlWithoutExecutableContent, { virtualConsole });
    const document = dom.window.document;
    const elementsToRemove = document.querySelectorAll("script, style");
    elementsToRemove.forEach((element) => element.remove());
    const cleanedHtml = dom.serialize();
    let textContent = convertHtmlToTextSimple(cleanedHtml);
    if (!textContent || textContent.trim().length === 0) {
      // Fallback for pages where DOM-based extraction unexpectedly yields empty output.
      textContent = htmlWithoutExecutableContent
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }
    let title = "";
    const titleElement = document.title ||
      document.querySelector('h1')?.textContent?.trim() ||
      document.querySelector('h2')?.textContent?.trim();
    if (titleElement) {
      title = titleElement.substring(0, 100);
    } else {
      title = "";
    }
  return { textContent, title };
}


// ─── Generate summary file ──────────────────────────────────────────────────

export async function generateSummaryFile(realm: Realm): Promise<void> {
  console.log(
    `\n📊 Generating ${realm.id}-summary.json summary...`,
  );

  const storage = getDefaultStorage(realm.id);
  const domains = await storage.getDomains();

  const dataDir = path.join(storage.getRealmDir(), realm.datapath);
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
    for (const domain of domains) {
      const domainDir = domain.id;
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

          entData.domains[domain.id] = domainData;
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
    availableDomains: domains.map(d => d.id),
    summary: summary,
  };

  await fs.writeJson(summaryPath, summaryWithMetadata, { spaces: 2 });

  console.log(
    `✅ Generated summary file: ${path.relative(getProjectRootDir(), summaryPath)}`,
  );
  console.log(`   📍 Total ${realm.entityType} with data: ${summary.length}`);
  console.log(`   📂 Total domains checked: ${domains.length}`);

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
  const storage = getDefaultStorage(realm.id);
  const dataDir = path.join(storage.getRealmDir(), realm.datapath);
  
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
              'User-Agent': USER_AGENT,
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
            textContent = convertHtmlToTextSimple(htmlContent);
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
          storage.saveRuleset(ruleset);
          
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
            storage.saveRuleset(ruleset);
            
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

