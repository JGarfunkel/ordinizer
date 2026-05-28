/**
 * Spider history, artifact persistence, and URL normalization utilities.
 *
 * Extracted from spiderEntityWebsites.ts — contains all types and logic
 * for reading/writing history.json, websites.json, and HTML/TXT artifacts,
 * as well as URL normalization helpers needed for canonical key storage.
 */

import fs from "fs-extra";
import path from "path";
import { JSDOM } from "jsdom";
import { convertHtmlToTextSimple } from "./simpleHtmlToText.js";
import { downloadFromUrlAnyType, extractTitleFromPDF } from "./extractionUtils.js";
import type { DownloadRequestOptions } from "./extractionUtils.js";
import type { CrawledPage, ExtractedLink } from "./domainScoring.js";
import { LinkedResource } from "@ordinizer/core/schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HistoryStatus = "404" | "blocked" | "no-content" | "robots-disallow" | "timeout" | "unrelated" | "related" | "index";

export interface SpiderDownloadRecord extends LinkedResource {
  entityId?: string; // optional as this is record is stored under an entityId
  status: HistoryStatus;
  localFile?: string; // relative path to HTML artifact
  localFileText?: string; // relative path to TXT artifact
  localFileTextSize?: number; // length of the text content in the TXT artifact, for quick reference
  fileType?: "HTML" | "PDF"; // optional hint about the type of the downloaded file
}

// Backward-compatible alias while call sites migrate to SpiderDownloadRecord.
export type SpiderHistoryEntry = SpiderDownloadRecord;

export interface SpiderHistoryFile {
  menuLinks: SpiderMenuLinkInfo;
  records: SpiderDownloadRecord[];
}

export interface SpiderMenuLinkInfo {
  timestamp: string;
  urls: string[];
}

export interface WebsiteHostRecord {
  hostname: string;
  observations: number;
  headerCandidates: Record<string, number>;
  footerCandidates: Record<string, number>;
  activeHeader?: string;
  activeFooter?: string;
  contentSelector?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebsitesEntityFile {
  hosts: Record<string, WebsiteHostRecord>;
}

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

export function normalizeUrl(url: string | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

export function normalizeUrlForMatch(url: string): string {
  const normalized = normalizeUrl(url) || url.trim();
  try {
    const parsed = new URL(normalized);
    parsed.hash = "";
    parsed.search = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    return parsed.toString();
  } catch {
    return normalized.replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

// ---------------------------------------------------------------------------
// History status helpers
// ---------------------------------------------------------------------------

export function isHistoryStatus(value: unknown): value is HistoryStatus {
  return value === "404"
    || value === "blocked"
    || value === "no-content"
    || value === "robots-disallow"
    || value === "timeout"
    || value === "unrelated"
    || value === "related"
    || value === "index";
}

export function normalizeHistoryStatus(value: unknown): HistoryStatus {
  if (value === "irrelevant") return "unrelated";
  if (value === "good") return "related";
  if (value === "good-index") return "index";
  return isHistoryStatus(value) ? value : "no-content";
}

export function canSkipStatus(status: HistoryStatus): boolean {
  return status !== "related" && status !== "index";
}

export function wasAttemptedRecently(entry: SpiderDownloadRecord | undefined, recrawlDays: number): boolean {
  if (!entry || recrawlDays <= 0) {
    return false;
  }
  const attemptedAt = Date.parse(entry.timestamp);
  if (!Number.isFinite(attemptedAt)) {
    return false;
  }
  const ageMs = Date.now() - attemptedAt;
  const cutoffMs = recrawlDays * 24 * 60 * 60 * 1000;
  return ageMs >= 0 && ageMs < cutoffMs;
}

// ---------------------------------------------------------------------------
// Menu links normalization
// ---------------------------------------------------------------------------

export function normalizeMenuLinks(rawMenuLinks: unknown): SpiderMenuLinkInfo {
  const rawTimestamp = rawMenuLinks && typeof rawMenuLinks === "object"
    ? (rawMenuLinks as { timestamp?: unknown }).timestamp
    : undefined;
  const rawUrls = rawMenuLinks && typeof rawMenuLinks === "object"
    ? (rawMenuLinks as { urls?: unknown }).urls
    : undefined;

  const timestamp = typeof rawTimestamp === "string" ? rawTimestamp : "";
  const urls = Array.isArray(rawUrls)
    ? Array.from(new Set(rawUrls.filter((value): value is string => typeof value === "string").map((value) => normalizeUrlForMatch(value))))
    : [];

  return { timestamp, urls };
}

// ---------------------------------------------------------------------------
// History entry migration
// ---------------------------------------------------------------------------

export function migrateHistoryEntry(raw: any): SpiderDownloadRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const rawUrl = typeof raw.url === "string" ? raw.url : "";
  if (!rawUrl) {
    return null;
  }
  // Always store the normalized form in url
  const url = typeof raw.normalizedUrl === "string" && raw.normalizedUrl
    ? raw.normalizedUrl
    : normalizeUrlForMatch(rawUrl);
  const status: HistoryStatus = normalizeHistoryStatus(raw.status);
  const entityId = typeof raw.entityId === "string" && raw.entityId ? raw.entityId : "__unknown__";
  const timestamp = typeof raw.timestamp === "string" && raw.timestamp
    ? raw.timestamp
    : new Date().toISOString();
  const matchedDomainIds = Array.isArray(raw.matchedDomainIds)
    ? raw.matchedDomainIds.filter((v: unknown): v is string => typeof v === "string")
    : [];
  const fileType: "PDF" | "HTML" | undefined = raw.fileType === "PDF" || raw.fileType === "HTML" ? raw.fileType : undefined;
  const localFile = typeof raw.localFile === "string" && raw.localFile ? raw.localFile : undefined;
  const localFileText = typeof raw.localFileText === "string" && raw.localFileText ? raw.localFileText : undefined;
  const documentTitle = typeof raw.documentTitle === "string" && raw.documentTitle.trim()
    ? raw.documentTitle.trim()
    : (typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : undefined);
  const title = typeof raw.title === "string" && raw.title.trim()
    ? raw.title.trim()
    : (documentTitle || url);
  // Legacy migration: convert old artifactPaths array to new schema
  let migratedLocalFile = localFile;
  let migratedLocalFileText = localFileText;
  if (!localFile && Array.isArray(raw.artifactPaths)) {
    const htmlPath = raw.artifactPaths.find((p: any) => typeof p === "string" && p.endsWith(".html"));
    const txtPath = raw.artifactPaths.find((p: any) => typeof p === "string" && p.endsWith(".txt"));
    if (htmlPath) migratedLocalFile = htmlPath;
    if (txtPath) migratedLocalFileText = txtPath;
  }
  return {
    url,
    title,
    entityId,
    matchedDomainIds,
    status,
    timestamp,
    ...(fileType ? { fileType } : {}),
    ...(documentTitle ? { documentTitle } : {}),
    ...(migratedLocalFile ? { localFile: migratedLocalFile } : {}),
    ...(migratedLocalFileText ? { localFileText: migratedLocalFileText } : {}),
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function getEntityDownloadsRoot(storage: any): string {
  return path.join(storage.getRealmDir(), "EntityDownloads");
}

export function getHistoryFilePath(storage: any, entityId: string): string {
  return path.join(getEntityDownloadsRoot(storage), entityId, "history.json");
}

export function getWebsitesFilePath(storage: any, entityId: string): string {
  return path.join(getEntityDownloadsRoot(storage), entityId, "websites.json");
}

// ---------------------------------------------------------------------------
// Directory scaffolding
// ---------------------------------------------------------------------------

export async function ensureEntityDownloadsLayout(storage: any): Promise<void> {
  await fs.ensureDir(getEntityDownloadsRoot(storage));
}

export async function ensureEntityHistoryLayout(storage: any, entityId: string): Promise<void> {
  const entityDir = path.join(getEntityDownloadsRoot(storage), entityId);
  await fs.ensureDir(entityDir);
  const historyPath = getHistoryFilePath(storage, entityId);
  if (!(await fs.pathExists(historyPath))) {
    await fs.writeJson(historyPath, { menuLinks: { timestamp: "", urls: [] }, records: [] }, { spaces: 2 });
  }
}

// ---------------------------------------------------------------------------
// History CRUD
// ---------------------------------------------------------------------------

export async function loadHistoryData(storage: any, entityId: string): Promise<{
  historyMap: Map<string, SpiderDownloadRecord>;
  menuLinks: SpiderMenuLinkInfo;
}> {
  const historyPath = getHistoryFilePath(storage, entityId);
  if (!(await fs.pathExists(historyPath))) {
    return {
      historyMap: new Map<string, SpiderDownloadRecord>(),
      menuLinks: { timestamp: "", urls: [] },
    };
  }
  const loaded = (await fs.readJson(historyPath).catch(() => ({ records: [] }))) as SpiderHistoryFile;
  const entries = Array.isArray(loaded.records) ? loaded.records : [];
  const historyMap = new Map<string, SpiderDownloadRecord>();
  for (const rawEntry of entries) {
    const migrated = migrateHistoryEntry(rawEntry);
    if (migrated) {
      historyMap.set(migrated.url, migrated);
    }
  }

  return {
    historyMap,
    menuLinks: normalizeMenuLinks((loaded as { menuLinks?: unknown }).menuLinks),
  };
}

export async function saveHistoryData(
  storage: any,
  entityId: string,
  historyMap: Map<string, SpiderDownloadRecord>,
  menuLinks: SpiderMenuLinkInfo = { timestamp: "", urls: [] },
): Promise<void> {
  const historyPath = getHistoryFilePath(storage, entityId);
  await fs.ensureDir(path.dirname(historyPath));
  const payload: SpiderHistoryFile = {
    menuLinks: normalizeMenuLinks(menuLinks),
    records: Array.from(historyMap.values()).sort((a, b) => a.url.localeCompare(b.url)),
  };
  await fs.writeJson(historyPath, payload, { spaces: 2 });
}

export function upsertHistoryEntry(
  historyMap: Map<string, SpiderDownloadRecord>,
  input: {
    url: string;
    matchedDomainIds: string[];
    status: HistoryStatus;
    entityId?: string;
    title?: string;
    fileType?: "HTML" | "PDF";
    localFile?: string;
    localFileText?: string;
    localFileTextSize?: number;
    timestamp?: string;
  },
): void {
  const timestamp = input.timestamp || new Date().toISOString();
  const title = (input.title || input.url).trim();
  historyMap.set(input.url, {
    ...input,
    title,
    timestamp,
  });
}

export async function recordFileSize(
  storage: any,
  historyMap: Map<string, SpiderDownloadRecord>,
  entry: SpiderDownloadRecord,
): Promise<number | undefined> {
  if (!entry.localFileText) {
    return undefined;
  }

  const txtPath = fromRelativeDownloadsPath(storage, entry.localFileText);
  if (!(await fs.pathExists(txtPath))) {
    return undefined;
  }

  const fileText = await fs.readFile(txtPath, "utf-8");
  const localFileTextSize = fileText.length;

  upsertHistoryEntry(historyMap, {
    ...entry,
    localFileTextSize,
  });

  return localFileTextSize;
}

// ---------------------------------------------------------------------------
// Websites file CRUD
// ---------------------------------------------------------------------------

export async function loadWebsitesFile(storage: any, entityId: string): Promise<WebsitesEntityFile> {
  const websitesPath = getWebsitesFilePath(storage, entityId);
  if (!(await fs.pathExists(websitesPath))) {
    return { hosts: {} };
  }
  const raw = await fs.readJson(websitesPath).catch(() => ({ hosts: {} }));
  // Migrate legacy array format to map
  if (Array.isArray(raw.hosts)) {
    const hosts: Record<string, WebsiteHostRecord> = {};
    for (const record of raw.hosts as WebsiteHostRecord[]) {
      if (record?.hostname) hosts[record.hostname] = record;
    }
    return { hosts };
  }
  if (!raw.hosts || typeof raw.hosts !== "object") {
    return { hosts: {} };
  }
  return raw as WebsitesEntityFile;
}

export async function saveWebsitesFile(storage: any, entityId: string, file: WebsitesEntityFile): Promise<void> {
  const websitesPath = getWebsitesFilePath(storage, entityId);
  await fs.ensureDir(path.dirname(websitesPath));
  await fs.writeJson(websitesPath, file, { spaces: 2 });
}

// ---------------------------------------------------------------------------
// Artifact file name helpers
// ---------------------------------------------------------------------------

export function sanitizeFileSlug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || "source";
}

export function inferSlugFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const last = parts.length > 0 ? parts[parts.length - 1] : "";
    const withoutExt = last.replace(/\.[a-z0-9]{1,6}$/i, "");
    return sanitizeFileSlug(withoutExt || parsed.hostname);
  } catch {
    return sanitizeFileSlug(url);
  }
}

export async function getUniqueArtifactBaseName(dirPath: string, baseName: string): Promise<string> {
  let candidate = baseName;
  let suffix = 2;
  while (
    await fs.pathExists(path.join(dirPath, `${candidate}.html`)) ||
    await fs.pathExists(path.join(dirPath, `${candidate}.txt`))
  ) {
    candidate = `${baseName}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function toRelativeDownloadsPath(storage: any, absolutePath: string): string {
  const root = getEntityDownloadsRoot(storage);
  return path.relative(root, absolutePath).replace(/\\/g, "/");
}

export function fromRelativeDownloadsPath(storage: any, relativePathValue: string): string {
  return path.join(getEntityDownloadsRoot(storage), relativePathValue.replace(/\//g, path.sep));
}

// ---------------------------------------------------------------------------
// TXT artifact format
// ---------------------------------------------------------------------------

export function formatTxtArtifact(url: string, timestamp: string, text: string): string {
  const header = `# ${url} downloaded at ${timestamp}, converted at ${new Date().toISOString()}`;
  const trimmedBody = text.trim();
  return `${header}\n\n${trimmedBody}`;
}

export function parseTxtArtifactBody(rawText: string): string {
  const normalized = rawText.replace(/\r\n/g, "\n");
  return normalized.replace(/^# .* downloaded at .*?, converted at .*?\n\n/, "").trim();
}

// ---------------------------------------------------------------------------
// Artifact save / cleanup
// ---------------------------------------------------------------------------

export async function saveCrawledArtifacts(
  storage: any,
  entityId: string,
  page: CrawledPage,
  timestamp: string,
  options?: {
    contentSelector?: string;
  },
): Promise<{ localFile?: string; localFileText?: string; fileType?: "HTML" | "PDF" }> {
  const destinationDir = path.join(getEntityDownloadsRoot(storage), entityId);
  await fs.ensureDir(destinationDir);

  const slugFromUrl = inferSlugFromUrl(page.url);
  const slugFromTitle = sanitizeFileSlug(page.title || "source");
  const baseSlugSeed = slugFromUrl || slugFromTitle || "source";
  const baseSlug = await getUniqueArtifactBaseName(destinationDir, baseSlugSeed);

  let localFile: string | undefined;
  let localFileText: string | undefined;
  let fileType: "HTML" | "PDF" | undefined;

  console.log(`[SAVE-ARTIFACTS] page.url=${page.url} isPdf=${page.isPdf} hasHtmlContent=${!!page.htmlContent} hasPlainText=${!!page.plainText} plainTextLen=${page.plainText?.length || 0}`);

  if (page.isPdf && page.pdfBuffer) {
    const pdfPath = path.join(destinationDir, `${baseSlug}.pdf`);
    await fs.writeFile(pdfPath, page.pdfBuffer);
    localFile = toRelativeDownloadsPath(storage, pdfPath);
    fileType = "PDF";
    console.log(`[SAVE-ARTIFACTS] saved PDF: ${localFile}`);
  } else if (page.htmlContent) {
    const htmlPath = path.join(destinationDir, `${baseSlug}.html`);
    await fs.writeFile(htmlPath, page.htmlContent, "utf-8");
    localFile = toRelativeDownloadsPath(storage, htmlPath);
    fileType = "HTML";
    console.log(`[SAVE-ARTIFACTS] saved HTML: ${localFile}`);
  }
  let textForArtifact = (page.plainText || "").trim();
  if (page.htmlContent && options?.contentSelector) {
    try {
      const pageAnalysis = await import("./spiderPageAnalysis.js");
      const extracted = pageAnalysis.extractContentBlockText(page.htmlContent, page.url, options.contentSelector);
      if (extracted && extracted.trim()) {
        textForArtifact = extracted.trim();
      }
    } catch {
      // Fall back to provided plainText if selector extraction fails.
    }
  }

  if (!textForArtifact && page.htmlContent) {
    textForArtifact = convertHtmlToTextSimple(page.htmlContent).trim();
  }

  if (textForArtifact) {
    const txtPath = path.join(destinationDir, `${baseSlug}.txt`);
    await fs.writeFile(txtPath, formatTxtArtifact(page.url, timestamp, textForArtifact), "utf-8");
    localFileText = toRelativeDownloadsPath(storage, txtPath);
    console.log(`[SAVE-ARTIFACTS] saved TXT: ${localFileText}`);
  }
  return {
    ...(localFile ? { localFile } : {}),
    ...(localFileText ? { localFileText } : {}),
    ...(fileType ? { fileType } : {}),
  };
}

export async function cleanupArtifactsForHistoryEntry(
  storage: any,
  historyEntry: SpiderDownloadRecord | undefined,
): Promise<void> {
  if (!historyEntry) {
    return;
  }

  const pathsToClean = [historyEntry.localFile, historyEntry.localFileText].filter(Boolean) as string[];
  for (const relativePathValue of pathsToClean) {
    const absolutePath = fromRelativeDownloadsPath(storage, relativePathValue);
    if (await fs.pathExists(absolutePath)) {
      await fs.remove(absolutePath);
    }
  }
}

// ---------------------------------------------------------------------------
// HTML parsing — extractLinksAndText
// (Lives here because loadCachedPageFromHistory depends on it)
// ---------------------------------------------------------------------------

export function extractLinksAndText(baseUrl: string, html: string): {
  title: string;
  headers: string[];
  sample: string;
  plainText: string;
  links: string[];
  linkCandidates: ExtractedLink[];
} {
  const dom = new JSDOM(html, { url: baseUrl });
  const document = dom.window.document;
  const title = (document.querySelector("title")?.textContent || "").trim();
  const headers = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))
    .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
    .filter((value) => value.length >= 3)
    .slice(0, 30);
  const plainText = convertHtmlToTextSimple(html).trim();
  const sample = plainText.slice(0, 3000);

  const linkCandidates = Array.from(document.querySelectorAll("a[href]"))
    .map((a) => {
      const href = (a.getAttribute("href") || "").trim();
      const text = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (!href) {
        return null;
      }
      try {
        return {
          url: new URL(href, baseUrl).toString(),
          text,
        };
      } catch {
        return null;
      }
    })
    .filter((v): v is ExtractedLink => Boolean(v));

  const uniqueLinkMap = new Map<string, ExtractedLink>();
  for (const link of linkCandidates) {
    const normalizedLinkUrl = normalizeUrlForMatch(link.url);
    const existing = uniqueLinkMap.get(normalizedLinkUrl);
    if (!existing) {
      uniqueLinkMap.set(normalizedLinkUrl, { url: normalizedLinkUrl, text: link.text });
      continue;
    }
    if (!existing.text && link.text) {
      uniqueLinkMap.set(normalizedLinkUrl, { url: normalizedLinkUrl, text: link.text });
    }
  }
  const dedupedLinkCandidates = Array.from(uniqueLinkMap.values());

  return {
    title,
    headers,
    sample,
    plainText,
    links: dedupedLinkCandidates.map((link) => link.url),
    linkCandidates: dedupedLinkCandidates,
  };
}

function getDocumentTitleFromHtml(html: string, fallbackUrl?: string): string | undefined {
  try {
    const dom = new JSDOM(html, fallbackUrl ? { url: fallbackUrl } : undefined);
    const document = dom.window.document;
    const candidates = [
      document.querySelector("title")?.textContent,
      document.querySelector("meta[property='og:title']")?.getAttribute("content"),
      document.querySelector("meta[name='twitter:title']")?.getAttribute("content"),
      document.querySelector("h1")?.textContent,
      document.querySelector("h2")?.textContent,
    ];
    for (const candidate of candidates) {
      const normalized = (candidate || "").replace(/\s+/g, " ").trim();
      if (normalized) {
        return normalized.slice(0, 300);
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function extractDocumentTitleWithCache(
  storage: any,
  historyMap: Map<string, SpiderDownloadRecord>,
  url: string,
  html?: string,
): Promise<string> {
  const normalizedUrl = normalizeUrlForMatch(url);
  const existing = historyMap.get(normalizedUrl);
  const existingTitle = existing?.title?.trim();

  if (existing?.localFile) {
    const filePath = fromRelativeDownloadsPath(storage, existing.localFile);
    if (await fs.pathExists(filePath)) {
      if (url.toLocaleLowerCase().endsWith(".pdf")) {
        const pdfBuffer = await fs.readFile(filePath);
        const title = await extractTitleFromPDF(pdfBuffer);
        if (title) {
          console.debug("[Title Extraction] Extracted title from cached PDF for URL:", url, "title:", title);
          return title;
        }
      } else {
        const cachedHtml = await fs.readFile(filePath, "utf-8");
        const cachedTitle = getDocumentTitleFromHtml(cachedHtml, url);
        if (cachedTitle) {
          // console.debug("[Title Extraction] Extracted title from cached HTML for URL:", url, "title:", cachedTitle);
          return cachedTitle;
        }
      }
    }
  }

  const htmlTitle = html ? getDocumentTitleFromHtml(html, url) : undefined;
  if (htmlTitle) {
    // console.debug("[Title Extraction] Extracted title from provided HTML for URL:", url, "title:", htmlTitle);
    return htmlTitle;
  }

  if (existingTitle && existingTitle !== url) {
    //console.debug("[Title Extraction] Using existing title for URL:", url, "title:", existingTitle);
    return existingTitle;
  }

  // find URL slug, convert _ and - to spaces, and convert to title case
  try {
    const urlObj = new URL(url);
    const slug = urlObj.pathname.split("/").filter(Boolean).pop() || urlObj.hostname;
    const slugWithSpaces = slug.replace(/[-_]+/g, " ");
    const titleCased = slugWithSpaces.replace(/\b\w/g, (char) => char.toUpperCase());
    return titleCased;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Cache loading
// ---------------------------------------------------------------------------

export async function loadCachedPageFromHistory(
  storage: any,
  entry: SpiderDownloadRecord,
  depth: number,
): Promise<{ page: CrawledPage; linkCandidates: ExtractedLink[] } | null> {
  if (!entry.localFile && !entry.localFileText) {
    return null;
  }

  const htmlRelativePath = entry.localFile;
  const txtRelativePath = entry.localFileText;

  let htmlContent: string | undefined;
  let txtBody = "";

  if (htmlRelativePath) {
    const htmlPath = fromRelativeDownloadsPath(storage, htmlRelativePath);
    if (await fs.pathExists(htmlPath)) {
      htmlContent = await fs.readFile(htmlPath, "utf-8");
    }
  }

  if (txtRelativePath) {
    const txtPath = fromRelativeDownloadsPath(storage, txtRelativePath);
    if (await fs.pathExists(txtPath)) {
      txtBody = parseTxtArtifactBody(await fs.readFile(txtPath, "utf-8"));
    }
  }

  if (!htmlContent && !txtBody) {
    return null;
  }

  if (htmlContent) {
    const extracted = extractLinksAndText(entry.url, htmlContent);
    const plainText = txtBody || extracted.plainText;
    return {
      page: {
        url: entry.url,
        depth,
        title: extracted.title || entry.url,
        headers: extracted.headers,
        htmlContent,
        plainText,
        textSample: plainText.slice(0, 3000),
        isPdf: false,
        links: extracted.links,
        fromCache: true,
      },
      linkCandidates: extracted.linkCandidates,
    };
  }

  const filename = new URL(entry.url).pathname.split("/").filter(Boolean).pop() || entry.url;
  return {
    page: {
      url: entry.url,
      depth,
      title: decodeURIComponent(filename),
      headers: [],
      plainText: txtBody,
      textSample: txtBody.slice(0, 3000),
      isPdf: /\.pdf(\?.*)?$/i.test(entry.url),
      links: [],
      fromCache: true,
    },
    linkCandidates: [],
  };
}

// ---------------------------------------------------------------------------
// Network fetch utilities
// ---------------------------------------------------------------------------

export interface DownloadedPage {
  kind: "html" | "pdf";
  html?: string;
  pdfBuffer?: Buffer;
}

export function classifyDownloadError(error: unknown): HistoryStatus {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("404") || message.includes("410")) {
    return "404";
  }
  if (
    message.includes("403")
    || message.includes("401")
    || message.includes("429")
    || message.includes("forbidden")
    || message.includes("access denied")
    || message.includes("akamai")
    || message.includes("reference-error")
    || message.includes("captcha")
    || message.includes("challenge")
  ) {
    return "blocked";
  }
  if (message.includes("timeout") || message.includes("timed out") || message.includes("etimedout") || message.includes("econnaborted")) {
    return "timeout";
  }
  return "no-content";
}

export async function fetchPageContent(
  url: string,
  options: DownloadRequestOptions = {},
): Promise<{ page: DownloadedPage | null; status: HistoryStatus }> {
  try {
    const downloaded = await downloadFromUrlAnyType(url, undefined, undefined, options);
    if (downloaded.isPdf) {
      return { page: { kind: "pdf", pdfBuffer: downloaded.data }, status: "related" };
    }

    const html = downloaded.data.toString("utf-8").trim();
    if (!html) {
      return { page: null, status: "no-content" };
    }

    const looksLikeHtml = /<html|<body|<head|<!doctype\s+html/i.test(html);
    if (!looksLikeHtml) {
      return { page: null, status: "no-content" };
    }

    return { page: { kind: "html", html }, status: "related" };
  } catch (error) {
    return { page: null, status: classifyDownloadError(error) };
  }
}
