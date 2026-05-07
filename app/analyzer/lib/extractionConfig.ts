import fs from "fs-extra";
import path from "path";
import { type Realm } from "@civillyengaged/ordinizer-core";
import { loadSpreadsheetExtractionProperties } from "./spreadsheetParser.js";
import { IStorage, getDefaultStorage } from "@civillyengaged/ordinizer-servercore";

export type { Realm };
export { parseName, parseGradeFromCell, getEntityPrefix, getStateCode, getColumnMap } from "./spreadsheetParser.js";

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface EntityRow {
  Entity: string;
  Type: string;
  [key: string]: string; // Domain columns (Trees, Zoning, etc.)
}

export interface CellData {
  value: string;
  hyperlink?: string;
}

export interface StatuteLibrary {
  id: string;
  name: string;
  baseUrl: string;
  urlPatterns: string[];
  download: boolean;
  extractionSupported: boolean;
  useCurl?: boolean;
  anchorSupported: boolean;
  notes: string;
}

export interface StatuteLibraryConfig {
  libraries: StatuteLibrary[];
  defaultLibrary: string;
  lastUpdated: string;
}

export interface RealmsConfig {
  realms: Realm[];
  lastUpdated: string;
}

export interface Source {
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

export interface Metadata {
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

export interface ArticleLink {
  title: string;
  url: string;
}

// ─── Domain config ───────────────────────────────────────────────────────────

// TODO - move to spreadsheet parser
// export function getSpreadsheetUrl(): string {
//   return loadSpreadsheetExtractionProperties().url;
// }

// export function getDomains(): string[] {
//   return loadSpreadsheetExtractionProperties().domains.map((d) => d.name);
// }

// /** @deprecated Use getDomains() instead */
// export const DOMAINS = getDomains();

// export function getDomainMapping(): Record<string, string> {
//   return loadSpreadsheetExtractionProperties().domainMapping;
// }

// /** @deprecated Use getDomainMapping() instead */
// export const DOMAIN_MAPPING = getDomainMapping();

export const DELAY_BETWEEN_DOWNLOADS = 5000; // 5 seconds

// ─── Verbose logging ─────────────────────────────────────────────────────────

// Global verbose flag
export let VERBOSE_MODE = false;

export function setVerboseMode(enabled: boolean): void {
  VERBOSE_MODE = enabled;
}

export function verboseLog(...args: any[]): void {
  if (VERBOSE_MODE) {
    console.log("[VERBOSE]", ...args);
  }
}

// ─── Path helpers ────────────────────────────────────────────────────────────

export function getProjectRootDir(): string {
  // return the path that we are running the script from
  return process.cwd();
}

// ─── Domain display helpers ──────────────────────────────────────────────────

export function getDomainDisplayName(domain: string): string {
  const entry = loadSpreadsheetExtractionProperties().domains.find((d) => d.name === domain);
  return entry?.displayName ?? domain;
}

export function getDomainDescription(domain: string): string {
  const entry = loadSpreadsheetExtractionProperties().domains.find((d) => d.name === domain);
  return entry?.description ?? `${domain} municipal regulations`;
}

export function getDomainColumnIndex(domain: string): number {
  const conf = loadSpreadsheetExtractionProperties();
  // Check domain entries by columnSlug first
  const entry = conf.domains.find((d) => d.columnSlug === domain);
  if (entry?.columnIndex != null) return entry.columnIndex;
  // Fall back to additionalColumnIndices
  return conf.additionalColumnIndices[domain] ?? -1;
}

// ─── Config loaders ──────────────────────────────────────────────────────────

let statuteLibraryConfig: StatuteLibraryConfig | null = null;
let realmsConfig: RealmsConfig | null = null;

// TODO: move to storage
export async function loadStatuteLibraryConfig(storage: IStorage): Promise<StatuteLibraryConfig | null> {
  if (statuteLibraryConfig) {
    return statuteLibraryConfig;
  }

  try {
    // Statute libraries are shared above individual realm folders.
    const dataDir = await storage.getDataDir();
    const localConfigPath = path.join(dataDir, "statute-libraries.json");
    statuteLibraryConfig = await fs.readJson(localConfigPath);
    return statuteLibraryConfig!;
  } catch (error: any) {
    console.warn(
      `Warning: Could not load statute library config: ${error.message}`,
    );
    return null;
  }
}

export function getLibraryForUrl(
  url: string,
  config: StatuteLibraryConfig,
): StatuteLibrary | null {
  return (
    config.libraries.find((library) =>
      library.urlPatterns.some((pattern) => url.includes(pattern)),
    ) || null
  );
}

// ─── CLI helpers ─────────────────────────────────────────────────────────────

export function levenshteinDistance(a: string, b: string): number {
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

export function findSimilarFlags(unknownFlag: string, validFlags: string[]): string[] {
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
