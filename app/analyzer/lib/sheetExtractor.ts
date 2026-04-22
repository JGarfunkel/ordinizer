import fs from "fs-extra";
import path from "path";
import axios from "axios";
import { google } from "googleapis";
import {
  type Realm,
  type Metadata,
  DOMAINS,
  DOMAIN_MAPPING,
  verboseLog,
  getProjectDataDir,
  getDomainDisplayName,
  getDomainDescription,
  getDomainColumnIndex,
  getSpreadsheetUrl,
} from "./extractionConfig.js";
import {
  type ISpreadsheetParser,
  DefaultSpreadsheetParser,
  getEntityPrefix,
} from "./spreadsheetParser.js";
import {
  readMetadata,
  getSourceUrl,
} from "./extractionUtils.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ParsedEntityData {
  rows: any[][];
  headers: string[];
  columnMap: Record<string, number>;
  domainsToProcess: string[];
  entities: any[];
}

// ─── Google Sheets extraction ────────────────────────────────────────────────


// TODO: move this to a separate file - it's not needed
export async function analyzeSpreadsheetStructure(
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
          potentialDomains.forEach((domain: any) => {
            console.log(`     • "${domain}"`);
          });
        }
      } catch (sheetError: any) {
        if (verbose) {
          console.log(`   ❌ Could not read headers: ${sheetError}`);
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

export async function extractGoogleSheetsWithHyperlinks(
  sheetUrl: string,
  verbose: boolean = false,
): Promise<{
  csvData: string;
  hyperlinkData: Record<string, Record<string, string>>;
}> {
  try {
    const sheetIdMatch = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    const gidMatch = sheetUrl.match(/gid=(\d+)/);

    if (!sheetIdMatch) {
      throw new Error("Could not extract sheet ID from URL");
    }

    const sheetId = sheetIdMatch[1];
    const gid = gidMatch ? gidMatch[1] : "0";

    await analyzeSpreadsheetStructure(sheetId, verbose);

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

    let hyperlinkData: Record<string, Record<string, string>> = {};

    const apiKey = process.env.GOOGLE_SHEETS_API_KEY;
    if (apiKey) {
      try {
        console.log("Using Google Sheets API to extract hyperlinks...");
        const sheets = google.sheets({ version: "v4", auth: apiKey });

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

                let hyperlink =
                  cell.userEnteredValue?.formulaValue?.match(
                    /=HYPERLINK\("([^"]+)"/,
                  )?.[1] ||
                  cell.hyperlink;

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

export async function extractGoogleSheetsAsCsv(sheetUrl: string): Promise<string> {
  const { csvData } = await extractGoogleSheetsWithHyperlinks(sheetUrl);
  return csvData;
}

// ─── Filesystem-based entity discovery ───────────────────────────────────────

export async function getExistingMunicipalitiesFromFilesystem(realm: Realm, targetDomain?: string, entitiesToInclude?: Set<string>, verbose: boolean = false): Promise<any[][]> {
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
      if (!municipality.startsWith(getEntityPrefix())) {
        if (verbose) console.log(`  ⏭️  Skipping ${municipality} (doesn't match entity prefix)`);
        continue;
      }
      
      const municipalityPath = path.join(domainPath, municipality);
      const municipalityStat = await fs.stat(municipalityPath);
      
      if (!municipalityStat.isDirectory()) {
        if (verbose) console.log(`  ⏭️  Skipping ${municipality} (not a directory)`);
        continue;
      }
      
      console.log(`  🔍 Checking ${municipality}...`);
      
      const metadataPath = path.join(municipalityPath, "metadata.json");
      const statutePath = path.join(municipalityPath, "statute.txt");
      const hasMetadata = await fs.pathExists(metadataPath);
      const hasStatute = await fs.pathExists(statutePath);
      
      console.log(`    📄 Files found: metadata.json=${hasMetadata}, statute.txt=${hasStatute}`);
      
      if (hasMetadata || hasStatute) {
        const prefixRegex = new RegExp(`^${getEntityPrefix()}(.+)-(.+)$`);
        const match = municipality.match(prefixRegex);
        if (match) {
          const municipalityName = match[1].replace(/([A-Z])/g, " $1").trim();
          const municipalityType = match[2];
          
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
          
          const row = [
            `${municipalityName} (${municipalityType})`,
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
          
          if (hasMetadata) {
            try {
              const metadata = await readMetadata(metadataPath);
              const domainIndex = getDomainColumnIndex(domain);
              const sourceUrl = metadata ? getSourceUrl(metadata) : null;
              if (domainIndex !== -1 && sourceUrl) {
                row[domainIndex] = sourceUrl;
                console.log(`    🔗 Found source URL: ${sourceUrl}`);
              }
            } catch (error: any) {
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

// ─── Data source conversion ──────────────────────────────────────────────────

export function convertSchoolDistrictJsonToCsv(jsonData: any[]): string {
  const headers = ['District Name', 'Website', 'overall', 'building', 'curriculum', 'food', 'gardens', 'stormwater'];
  const rows: string[][] = [headers];
  
  for (const district of jsonData) {
    const row = [
      district.name || '',
      district.url || '',
      '', '', '', '', '', ''
    ];
    
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
    
    const categoryMap: Record<string, number> = {
      'overall': 2,
      'building': 3, 
      'curriculum': 4,
      'food': 5,
      'gardens': 6,
      'stormwater': 7
    };
    
    for (const [category, urls] of Object.entries(policiesByCategory)) {
      const headerIndex = categoryMap[category];
      if (headerIndex !== undefined) {
        row[headerIndex] = urls.join('; ');
      }
    }
    
    rows.push(row);
  }
  
  return rows.map(row => 
    row.map(cell => `"${cell.replace(/"/g, '""')}"`)
       .join(',')
  ).join('\n');
}

// ─── Entity parsing & file writing ──────────────────────────────────────────

export async function parseAndWriteEntities(
  csvData: string,
  realm: Realm,
  targetDomain?: string,
  entitiesToInclude?: Set<string>,
  verbose: boolean = false,
  parser?: ISpreadsheetParser,
): Promise<ParsedEntityData> {
  let rows: any[][];
  const sp = parser ?? new DefaultSpreadsheetParser(realm);
  
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
      const sheetUrl = getSpreadsheetUrl();
      if (!sheetUrl) {
        throw new Error("Spreadsheet URL is not configured in spreadsheetExtractionProperties.json");
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
      rows = parseCsvRows(csvData);
      
      console.log(`Found ${rows.length} entities from provided CSV data`);
    }
  } else {
    // Use provided CSV data (from JSON file conversion)
    rows = parseCsvRows(csvData);
    
    console.log(`Found ${rows.length} entities in ${realm.dataSource.type} data`);
  }


  // Set headers based on data source type
  let headers: string[];
  let columnMap: Record<string, number> = {};
  let domainsToProcess: string[];

  if (realm.dataSource.type === 'google-sheets') {
    // Build column map from spreadsheet parser
    columnMap = sp.getColumnMap();
    headers = Object.keys(columnMap);

    console.log(`Domain column mapping:`, columnMap);

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
    return { rows, headers, columnMap, domainsToProcess, entities: [] };
  }

  if (targetDomain) {
    console.log(`Processing single domain: ${domainsToProcess[0]}`);
  } else {
    console.log(`Processing all domains: ${domainsToProcess.join(", ")}`);
  }

  // Create entity file from data
  const entityColumnName = headers[0]; // First column contains entity names
  console.log(`Processing ${realm.entityType} from Column: ${entityColumnName}`);

  // Parse entity from cell text using the spreadsheet parser.
  const entityPrefix = sp.getEntityPrefix();
  const stateCode = sp.getStateCode();
  const isSheets = realm.dataSource.type === 'google-sheets';

  function parseEntity(text: string) {
    const cleanName = sp.parseName(text);
    if (!cleanName) return null;

    // Extract type from "Name (Type)" format
    const typeMatch = text.match(/\((.+?)\)$/);
    const rawType = typeMatch ? typeMatch[1].trim() : "";
    const type = rawType === "Town/Village" ? "Town" : rawType;
    if (isSheets && !type) return null; // Sheets format requires "Name (Type)" format

    const cleanType = type.replace(/[^a-zA-Z0-9]/g, "");
    const displayName = text.match(/^(.+?)\s*\(/)?.[1]?.trim() || text.trim();

    return {
      id: isSheets ? `${entityPrefix}${cleanName}-${cleanType}` : `${entityPrefix}${cleanName}`,
      name: displayName,
      type: type || "School District",
      state: stateCode,
      displayName: isSheets ? `${displayName} - ${type}` : displayName,
      singular: cleanName.toLowerCase(),
    };
  }

  // Process entities from row data
  const entityLabel = realm.entityType.slice(0, -1); // "municipalities" → "municipality"

  const entities = rows
    .map(row => parseEntity(row[0]))
    .filter(entity => {
      if (!entity) return false;

      const text = entity.name.toLowerCase();
      if (isSheets && (text.includes("environmental") || text.includes("key:"))) return false;

      if (entitiesToInclude) {
        const included = entitiesToInclude.has(text);
        if (included) console.log(`Including filtered ${entityLabel}: ${entity.displayName}`);
        return included;
      }

      console.log(`Including ${entityLabel}: ${entity.displayName}`);
      return true;
    });

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

  return { rows, headers, columnMap, domainsToProcess, entities };
}

// ─── CSV parsing helper ──────────────────────────────────────────────────────

function parseCsvRows(csvData: string): any[][] {
  const csvLines = csvData.trim().split('\n');
  return csvLines.slice(1).map(line => {
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
}
