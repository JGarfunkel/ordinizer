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

function normalizeBoilerplateCandidate(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

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

export function detectBoilerplateCandidates(text: string): { header?: string; footer?: string } {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 4) {
    return {};
  }

  const headerCandidate = normalizeBoilerplateCandidate(lines.slice(0, 2).join(" "));
  const footerCandidate = normalizeBoilerplateCandidate(lines.slice(-2).join(" "));
  return {
    ...(headerCandidate.length >= 24 && headerCandidate.length <= 220 ? { header: headerCandidate } : {}),
    ...(footerCandidate.length >= 24 && footerCandidate.length <= 220 ? { footer: footerCandidate } : {}),
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

  if (!record.headerCandidates || typeof record.headerCandidates !== "object") {
    record.headerCandidates = {};
  }
  if (!record.footerCandidates || typeof record.footerCandidates !== "object") {
    record.footerCandidates = {};
  }

  const candidates = detectBoilerplateCandidates(text);
  if (candidates.header) {
    record.headerCandidates[candidates.header] = (record.headerCandidates[candidates.header] || 0) + 1;
  }
  if (candidates.footer) {
    record.footerCandidates[candidates.footer] = (record.footerCandidates[candidates.footer] || 0) + 1;
  }

  record.activeHeader = selectActiveCandidate(record.headerCandidates);
  record.activeFooter = selectActiveCandidate(record.footerCandidates);
  return record;
}
