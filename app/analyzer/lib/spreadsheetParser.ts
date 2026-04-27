import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import { type Realm } from "@civillyengaged/ordinizer-core";

// ─── Spreadsheet parser interface (DI-ready) ────────────────────────────────

export interface ISpreadsheetParser {
  /** Parse entity name from cell text. Returns the cleaned alphanumeric name, or null for empty/invalid text. */
  parseName(text: string): string | null;
  /** Parse a grade code from the leading portion of cell text. */
  parseGradeFromCell(cellText: string | undefined | null): string | null;
  /** Get the ID prefix for entities (e.g. "NY-"). */
  getEntityPrefix(): string;
  /** Get the state code (e.g. "NY"). */
  getStateCode(): string;
  /** Build domain name → column index mapping. */
  getColumnMap(): Record<string, number>;
}

// ─── Spreadsheet extraction properties ───────────────────────────────────────

interface DomainConfigEntry {
  name: string;
  displayName: string;
  description: string;
  columnSlug?: string;
  columnIndex?: number;
}

export interface SpreadsheetExtractionProperties {
  url: string;
  state: string;
  county: string;
  domains: DomainConfigEntry[];
  domainMapping: Record<string, string>;
  additionalColumnIndices: Record<string, number>;
  suppliedGrades: Record<string, string>;
}

let spreadsheetExtractionProperties: SpreadsheetExtractionProperties | null = null;

export function loadSpreadsheetExtractionProperties(): SpreadsheetExtractionProperties {
  if (spreadsheetExtractionProperties) return spreadsheetExtractionProperties;
  const confPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "spreadsheetExtractionProperties.json");
  spreadsheetExtractionProperties = fs.readJsonSync(confPath);
  return spreadsheetExtractionProperties!;
}

// ─── Standalone convenience functions ────────────────────────────────────────

/** Parse entity name from cell text. Returns the cleaned alphanumeric name, or null for empty/invalid text. */
export function parseName(text: string): string | null {
  return new DefaultSpreadsheetParser().parseName(text);
}

export function parseGradeFromCell(cellText: string | undefined | null): string | null {
  return new DefaultSpreadsheetParser().parseGradeFromCell(cellText);
}

export function getEntityPrefix(realm?: Realm): string {
  return new DefaultSpreadsheetParser(realm).getEntityPrefix();
}

export function getStateCode(realm?: Realm): string {
  return new DefaultSpreadsheetParser(realm).getStateCode();
}

/** Build a columnMap (domain name → column index) from spreadsheetExtractionProperties.json */
export function getColumnMap(): Record<string, number> {
  return new DefaultSpreadsheetParser().getColumnMap();
}

// ─── Default implementation (reads spreadsheetExtractionProperties.json) ─────

export class DefaultSpreadsheetParser implements ISpreadsheetParser {
  private realm?: Realm;

  constructor(realm?: Realm) {
    this.realm = realm;
  }

  parseName(text: string): string | null {
    if (!text?.trim()) return null;

    const match = text.match(/^(.+?)\s*\((.+?)\)$/);
    const name = match ? match[1].trim() : text.trim();
    const rawType = match ? match[2].trim() : "";
    const cleanType = rawType === "Town/Village" ? "Town" : rawType;

    const cleanName = name.replace(/[^a-zA-Z0-9\-]/g, "");
    if (!cleanType) return cleanName;
    return `${cleanName}-${cleanType.replace(/[^a-zA-Z0-9]/g, "")}`;
  }

  parseGradeFromCell(cellText: string | undefined | null): string | null {
    if (!cellText) return null;
    const grades = loadSpreadsheetExtractionProperties().suppliedGrades;
    // Sort keys longest-first so "GG" matches before "G"
    const codes = Object.keys(grades).sort((a, b) => b.length - a.length);
    const pattern = new RegExp(`^(${codes.join("|")})[-\\s]`);
    const match = cellText.match(pattern);
    return match ? grades[match[1]] : null;
  }

  getEntityPrefix(): string {
    const state = this.realm?.state || loadSpreadsheetExtractionProperties().state;
    return `${state}-`;
  }

  getStateCode(): string {
    if (this.realm?.state) return this.realm.state;
    return loadSpreadsheetExtractionProperties().state;
  }

  getColumnMap(): Record<string, number> {
    const conf = loadSpreadsheetExtractionProperties();
    const map: Record<string, number> = {};
    for (const d of conf.domains) {
      if (d.columnIndex != null) map[d.name] = d.columnIndex;
    }
    for (const [slug, index] of Object.entries(conf.additionalColumnIndices)) {
      map[slug] = index;
    }
    return map;
  }
}
