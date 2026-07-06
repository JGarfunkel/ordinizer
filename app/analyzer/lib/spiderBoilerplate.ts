/**
 * Boilerplate detection and host tracking for the spider.
 *
 * Extracted from spiderEntityWebsites.ts — contains all logic for:
 *  - Detecting and stripping repeated header/footer text across pages
 *  - Tracking per-hostname observations (WebsiteHostRecord)
 */

import type { WebsiteHostRecord, WebsitesEntityFile } from "./spiderHistory.js";

// Re-export types consumed by spiderEntityWebsites and tests
export type { WebsiteHostRecord, WebsitesEntityFile };

// ---------------------------------------------------------------------------
// Hostname helper (used by menu discovery and the main crawl loop)
// ---------------------------------------------------------------------------

export function getLikelyHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Boilerplate detection and stripping
// ---------------------------------------------------------------------------

function selectActiveCandidate(candidates?: Record<string, number> | null): string | undefined {
  if (!candidates || typeof candidates !== "object") {
    return undefined;
  }
  const ranked = Object.entries(candidates)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => {
      if (b[1] !== a[1]) {
        return b[1] - a[1];
      }
      return a[0].localeCompare(b[0]);
    });
  return ranked.length > 0 ? ranked[0][0] : undefined;
}

// ---------------------------------------------------------------------------
// Selector-based zone detection (fast regex, no JSDOM required)
// ---------------------------------------------------------------------------

// Ranked by specificity preference: semantic elements first, then ARIA roles, then common id/class patterns.
const HEADER_ZONE_SELECTORS = [
  "header",
  "[role='banner']",
  "#header",
  "#site-header",
  "#masthead",
  ".site-header",
  ".header",
  ".masthead",
  "#page-header",
  ".page-header",
] as const;

const FOOTER_ZONE_SELECTORS = [
  "footer",
  "[role='contentinfo']",
  "#footer",
  "#site-footer",
  "#colophon",
  ".site-footer",
  ".footer",
  ".colophon",
  "#page-footer",
  ".page-footer",
] as const;

function detectSelectorPresence(html: string, selector: string): boolean {
  if (selector === "header") return /<header[\s>]/i.test(html);
  if (selector === "footer") return /<footer[\s>]/i.test(html);

  const roleMatch = selector.match(/^\[role='([^']+)'\]$/);
  if (roleMatch) {
    return new RegExp(`role=["']${roleMatch[1]}["']`, "i").test(html);
  }

  if (selector.startsWith("#")) {
    const id = selector.slice(1).replace(/\\/g, "");
    return new RegExp(`\\bid=["']${id.replace(/[-]/g, "[-]")}["']`, "i").test(html);
  }

  if (selector.startsWith(".")) {
    const cls = selector.slice(1).replace(/\\/g, "");
    return new RegExp(`\\bclass=["'][^"']*(?:^|\\s)${cls.replace(/[-]/g, "[-]")}(?:\\s|["'])`, "i").test(html);
  }

  return false;
}

function detectZoneSelector(html: string, selectors: readonly string[]): string | undefined {
  for (const sel of selectors) {
    if (detectSelectorPresence(html, sel)) return sel;
  }
  return undefined;
}

export interface BoilerplateCandidates {
  headerSelector?: string;
  footerSelector?: string;
}

export function detectBoilerplateCandidates(_text: string, htmlContent?: string): BoilerplateCandidates {
  if (!htmlContent) return {};
  return {
    headerSelector: detectZoneSelector(htmlContent, HEADER_ZONE_SELECTORS),
    footerSelector: detectZoneSelector(htmlContent, FOOTER_ZONE_SELECTORS),
  };
}

export function applyActiveBoilerplate(text: string, hostRecord?: WebsiteHostRecord): string {
  if (!hostRecord) {
    return text;
  }
  let output = text;
  if (hostRecord.activeHeader) {
    const headerPattern = hostRecord.activeHeader
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/ /g, "\\s+");
    output = output.replace(new RegExp(`^\\s*${headerPattern}\\s*`, "i"), "").trim();
  }
  if (hostRecord.activeFooter) {
    const footerPattern = hostRecord.activeFooter
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/ /g, "\\s+");
    output = output.replace(new RegExp(`\\s*${footerPattern}\\s*$`, "i"), "").trim();
  }
  return output;
}

export function updateWebsiteHostRecord(
  file: WebsitesEntityFile,
  hostname: string,
  text: string,
  timestamp: string,
  htmlContent?: string,
): WebsiteHostRecord | undefined {
  if (!file.hosts || typeof file.hosts !== "object") {
    file.hosts = {};
  }
  if (!hostname) {
    return undefined;
  }
  let record = file.hosts[hostname];
  if (!record) {
    record = {
      hostname,
      observations: 0,
      headerCandidates: {},
      footerCandidates: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    file.hosts[hostname] = record;
  }

  record.observations += 1;
  record.updatedAt = timestamp;

  const candidates = detectBoilerplateCandidates(text, htmlContent);

  if (candidates.headerSelector) {
    if (!record.headerSelectorCandidates) record.headerSelectorCandidates = {};
    record.headerSelectorCandidates[candidates.headerSelector] =
      (record.headerSelectorCandidates[candidates.headerSelector] || 0) + 1;
  }
  if (candidates.footerSelector) {
    if (!record.footerSelectorCandidates) record.footerSelectorCandidates = {};
    record.footerSelectorCandidates[candidates.footerSelector] =
      (record.footerSelectorCandidates[candidates.footerSelector] || 0) + 1;
  }
  record.activeHeaderSelector = selectActiveCandidate(record.headerSelectorCandidates);
  record.activeFooterSelector = selectActiveCandidate(record.footerSelectorCandidates);

  return record;
}
