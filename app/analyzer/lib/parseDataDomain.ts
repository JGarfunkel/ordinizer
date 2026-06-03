#!/usr/bin/env tsx
/**
 * parseDataDomain — imports a Google Sheets spreadsheet into {domainId}/data.json.
 *
 * Reads data-config.json from the domain directory to learn:
 *  - sourceUrl: which spreadsheet to fetch
 *  - headerRow: which row (1-indexed) holds the column headers
 *  - entityNameColumn: header label for the entity name cell
 *  - entityTypeColumn: (optional) header label for the entity type cell
 *
 * The remaining columns are treated as data columns, typed automatically.
 * Each row is matched against the realm's entity list to resolve entityId.
 *
 * Usage:
 *   tsx lib/parseDataDomain.ts --realm <realmId> --domain <domainId> [--data-root <path>] [--dry-run]
 */

import dotenv from "dotenv";
dotenv.config();

import fs from "fs-extra";
import path from "path";
import axios from "axios";
import { parseCommonCliArgs, requireDataRootAndRealm } from "./scriptArgs.js";
import { DefaultSpreadsheetParser } from "./spreadsheetParser.js";
import type { Entity, DataDomainConfig, DataColumn, DomainDataFile } from "@civillyengaged/ordinizer-core";

// ─── CSV helpers ──────────────────────────────────────────────────────────────

function parseCsvText(csvText: string): string[][] {
  const lines = csvText.trim().split(/\r?\n/);
  return lines.map(line => {
    const values: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        values.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    values.push(current);
    return values;
  });
}

function slugify(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ─── Type detection ───────────────────────────────────────────────────────────

function detectColumnType(values: string[]): "number" | "boolean" | "string" {
  const nonEmpty = values.filter(v => v.trim() !== "");
  if (nonEmpty.length === 0) return "string";

  const boolSet = new Set(["true", "false", "yes", "no"]);
  if (nonEmpty.every(v => boolSet.has(v.trim().toLowerCase()))) return "boolean";

  const numericCount = nonEmpty.filter(v => !isNaN(parseFloat(v.trim().replace(/,/g, "")))).length;
  if (numericCount / nonEmpty.length >= 0.8) return "number";

  return "string";
}

function coerceValue(raw: string, type: "number" | "boolean" | "string" | "percentage"): any {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (type === "number" || type === "percentage") {
    const n = parseFloat(trimmed.replace(/,/g, ""));
    return isNaN(n) ? null : n;
  }
  if (type === "boolean") {
    return ["true", "yes"].includes(trimmed.toLowerCase());
  }
  return trimmed;
}

// ─── Entity matching ──────────────────────────────────────────────────────────

const KNOWN_TYPES = ["Town", "City", "Village", "Borough", "Township"] as const;
const sp = new DefaultSpreadsheetParser();

/**
 * Parse a name cell into { name, type } using existing spreadsheet parser logic,
 * with additional handling for bare type suffixes ("Albany City" → name="Albany", type="City").
 */
function parseNameCell(nameCell: string): { name: string; type: string } {
  // First try the existing parser which handles "Name (Type)" and "Town/Village" normalization
  const parsed = sp.parseNames(nameCell);
  if (parsed.type) return parsed;

  // No type found via parens — check for a bare type suffix word
  for (const knownType of KNOWN_TYPES) {
    const suffix = new RegExp(`\\s+${knownType}$`, "i");
    if (suffix.test(nameCell.trim())) {
      const rawName = nameCell.trim().replace(suffix, "").trim();
      return {
        name: rawName.replace(/[^a-zA-Z0-9\-]/g, ""),
        type: knownType,
      };
    }
  }

  return parsed; // name only, no type
}

/** Normalize the separate type column value (e.g. "Town/Village" → "Town"). */
function normalizeTypeCell(typeCell: string): string {
  const trimmed = typeCell.trim();
  if (trimmed === "Town/Village") return "Town";
  return trimmed.replace(/[^a-zA-Z0-9]/g, "");
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findEntityId(
  nameCellValue: string,
  typeCellValue: string | undefined,
  entities: Entity[],
  entityPrefix: string,
): string | null {
  // Parse name cell using shared logic (handles parens format + bare suffixes)
  const { name: parsedName, type: nameEmbeddedType } = parseNameCell(nameCellValue);

  // Prefer type from separate column, fall back to type embedded in name cell
  const resolvedType = typeCellValue
    ? normalizeTypeCell(typeCellValue)
    : nameEmbeddedType;

  const normName = normalizeForMatch(parsedName);
  if (!normName) return null;

  for (const entity of entities) {
    const normEntity = normalizeForMatch(entity.name || entity.displayName);
    if (normEntity !== normName) continue;

    if (resolvedType) {
      const normType = normalizeForMatch(resolvedType);
      const normEntityType = normalizeForMatch(entity.type || "");
      if (normEntityType && normEntityType !== normType) continue;
    }

    return entity.id;
  }

  // Fallback: construct an ID from the prefix + cleaned name + type
  const cleanType = resolvedType.replace(/[^a-zA-Z0-9]/g, "");
  return cleanType ? `${entityPrefix}${parsedName}-${cleanType}` : `${entityPrefix}${parsedName}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { common } = parseCommonCliArgs(process.argv.slice(2));
  requireDataRootAndRealm(common);

  if (!common.domain) {
    throw new Error("Missing required argument: --domain <domainId>");
  }

  const dataRoot = path.resolve(common.dataRoot);
  process.env.DATA_ROOT = dataRoot;

  const { getDefaultStorage } = await import("@civillyengaged/ordinizer-servercore");
  const storage = getDefaultStorage(common.realm);
  const realmDir = storage.getRealmDir();
  const realm = await storage.getRealmConfig();

  const domainDir = path.join(realmDir, common.domain);
  const configPath = path.join(domainDir, "data-config.json");

  if (!(await fs.pathExists(configPath))) {
    throw new Error(`data-config.json not found at ${configPath}`);
  }

  const config: DataDomainConfig = await fs.readJson(configPath);
  const { sourceUrl, headerRow = 1, entityNameColumn, entityTypeColumn } = config;

  console.log(`Realm:     ${common.realm}`);
  console.log(`Domain:    ${common.domain}`);
  console.log(`Source:    ${sourceUrl}`);
  console.log(`HeaderRow: ${headerRow}`);
  console.log(`EntityCol: ${entityNameColumn}${entityTypeColumn ? ` + ${entityTypeColumn}` : ""}`);

  // Download CSV
  const csvExportUrl = sourceUrl.replace(/\/edit.*$/, "/export?format=csv");
  console.log(`\nDownloading: ${csvExportUrl}`);

  const response = await axios.get<string>(csvExportUrl, {
    timeout: 30_000,
    headers: { "User-Agent": "Ordinizer/1.0" },
  });

  const allRows = parseCsvText(response.data);
  if (allRows.length < headerRow) {
    throw new Error(`Sheet has ${allRows.length} rows but headerRow=${headerRow}`);
  }

  const headers = allRows[headerRow - 1].map(h => h.trim());
  const dataRows = allRows.slice(headerRow); // rows after the header

  console.log(`\nHeaders (${headers.length}): ${headers.join(", ")}`);
  console.log(`Data rows: ${dataRows.length}`);

  const nameColIdx = headers.indexOf(entityNameColumn);
  if (nameColIdx === -1) {
    throw new Error(`entityNameColumn "${entityNameColumn}" not found in headers: ${headers.join(", ")}`);
  }

  const typeColIdx = entityTypeColumn ? headers.indexOf(entityTypeColumn) : -1;
  if (entityTypeColumn && typeColIdx === -1) {
    throw new Error(`entityTypeColumn "${entityTypeColumn}" not found in headers: ${headers.join(", ")}`);
  }

  // Identify data columns (everything except entity identifier columns)
  const entityColIndices = new Set([nameColIdx, ...(typeColIdx >= 0 ? [typeColIdx] : [])]);
  const dataColIndices = headers
    .map((_, i) => i)
    .filter(i => !entityColIndices.has(i) && headers[i] !== "");

  // Detect column types from all non-header values
  const columns: DataColumn[] = dataColIndices.map(i => {
    const values = dataRows.map(row => row[i] ?? "");
    return {
      key: slugify(headers[i]),
      label: headers[i],
      type: detectColumnType(values),
    };
  });

  console.log(`\nData columns detected:`);
  columns.forEach(c => console.log(`  ${c.key} (${c.type}) — "${c.label}"`));

  // Load entities for matching
  const entities = await storage.getEntities();
  const statePrefix = (realm.geo?.stateProvince || "") + "-";

  // Build output rows
  const rows: DomainDataFile["rows"] = [];
  let matched = 0;
  let unmatched = 0;

  for (const row of dataRows) {
    const nameCellValue = (row[nameColIdx] || "").trim();
    if (!nameCellValue) continue;

    const typeCellValue = typeColIdx >= 0 ? (row[typeColIdx] || "").trim() : undefined;

    const entityId = findEntityId(nameCellValue, typeCellValue, entities, statePrefix);
    if (!entityId) {
      console.warn(`  [SKIP] Could not resolve entity: "${nameCellValue}"`);
      unmatched++;
      continue;
    }

    const outputRow: DomainDataFile["rows"][number] = {
      entityId,
      entityName: nameCellValue,
    };

    for (let ci = 0; ci < dataColIndices.length; ci++) {
      const col = columns[ci];
      const rawValue = row[dataColIndices[ci]] ?? "";
      outputRow[col.key] = coerceValue(rawValue, col.type);
    }

    rows.push(outputRow);
    matched++;
  }

  console.log(`\nMatched: ${matched}  Unmatched: ${unmatched}`);

  const output: DomainDataFile = {
    domain: common.domain,
    generated: new Date().toISOString(),
    sourceUrl,
    columns,
    rows,
  };

  if (common.dryRun) {
    console.log("\n[DRY RUN] Would write data.json with", rows.length, "rows.");
    console.log(JSON.stringify(output, null, 2).slice(0, 800), "...");
    return;
  }

  await fs.ensureDir(domainDir);
  const outPath = path.join(domainDir, "data.json");
  await fs.writeJson(outPath, output, { spaces: 2 });
  console.log(`\nWrote ${outPath}`);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
