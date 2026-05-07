#!/usr/bin/env tsx

import dotenv from "dotenv";
dotenv.config();
import fs from "fs-extra";
import path from "path";
import axios from "axios";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { addOrUpdateSource, delay, downloadFromUrlAnyType, pdfToText } from "./extractionUtils.js";
import { convertHtmlToTextSimple } from "./simpleHtmlToText.js";
import { Ruleset, RulesetSource, Entity, Realm, Domain } from "@civillyengaged/ordinizer-core";
import { parseCommonCliArgs, requireDataRootAndRealm } from "./scriptArgs.js";
import { styleText } from "node:util";
import {
  type CrawledPage,
  type ExtractedLink,
  type DomainScore,
  DOMAIN_MATCH_SCORE_THRESHOLD,
  isDomainScoreMatch,
  scoreDomainDetailed,
  classifyDomains,
  buildLinkPseudoPage,
} from "./domainScoring.js";
import {
  type HistoryStatus,
  type SpiderHistoryEntry,
  type SpiderMenuLinkInfo,
  type WebsiteHostRecord,
  type WebsitesEntityFile,
  type DownloadedPage,
  normalizeUrl,
  normalizeUrlForMatch,
  normalizeMenuLinks,
  canSkipStatus,
  wasAttemptedRecently,
  migrateHistoryEntry,
  getEntityDownloadsRoot,
  getHistoryFilePath,
  getWebsitesFilePath,
  ensureEntityDownloadsLayout,
  ensureEntityHistoryLayout,
  loadHistoryData,
  saveHistoryData,
  upsertHistoryEntry,
  loadWebsitesFile,
  saveWebsitesFile,
  sanitizeFileSlug,
  inferSlugFromUrl,
  getUniqueArtifactBaseName,
  toRelativeDownloadsPath,
  fromRelativeDownloadsPath,
  formatTxtArtifact,
  parseTxtArtifactBody,
  saveCrawledArtifacts,
  cleanupArtifactsForHistoryEntry,
  extractLinksAndText,
  loadCachedPageFromHistory,
  fetchPageContent,
} from "./spiderHistory.js";
import {
  detectBoilerplateCandidates,
  applyActiveBoilerplate,
  updateWebsiteHostRecord,
  getLikelyHostname,
} from "./spiderBoilerplate.js";
import {
  SKIP_URL_PATTERN,
  shouldRedetermineMenuLinks,
  discoverLocalMenuLinks,
  readLinkCandidatesForMenuDiscovery,
  fetchHtmlForMenuDiscoveryCached,
  extractContentBlockLinkCandidates,
  discoverContentSelector,
  extractContentBlockText,
} from "./spiderPageAnalysis.js";

// Re-exports for backwards compatibility
export type { DomainScore };
export { isDomainScoreMatch, scoreDomainDetailed };
export { canSkipStatus, migrateHistoryEntry, formatTxtArtifact };
export { detectBoilerplateCandidates, applyActiveBoilerplate, updateWebsiteHostRecord };
export { discoverContentSelector, extractContentBlockText };

interface CrawlTask {
  url: string;
  depth: number;
  source: "mainUrl" | "governingUrl" | "authorityUrl";
}

interface Args {
  dataRoot: string;
  realm: string;
  entity?: string;
  all: boolean;
  domain?: string;
  dryRun: boolean;
  limit?: number;
  maxDepth: number;
  maxPages: number;
  maxPagesPerSource: number;
  specimenUrlsFile?: string;
  noDownload: boolean;
  recrawlDays: number;
  concurrency: number;
  interactive: boolean;
  interactiveHonorHistory: boolean;
  cleanup: boolean;
  rewriteText: boolean;
  scan: boolean;
  force: boolean;
}

type ReviewStatus = "related" | "index" | "unrelated";

interface LinkCandidateEvaluation {
  normalizedLinkUrl: string;
  hostname: string;
  existingLinkHistory?: SpiderHistoryEntry;
}

interface StatusCounts {
  related: number;
  index: number;
  unrelated: number;
  otherFailure: number;
}

const SPIDER_LOG_FILE = path.resolve(process.cwd(), "spider.log");
let spiderLogInitialized = false;

function getStatusCounts(historyMap: Map<string, SpiderHistoryEntry>): StatusCounts {
  let related = 0;
  let index = 0;
  let unrelated = 0;
  let otherFailure = 0;
  for (const entry of historyMap.values()) {
    if (entry.status === "related") {
      related += 1;
      continue;
    }
    if (entry.status === "index") {
      index += 1;
      continue;
    }
    if (entry.status === "unrelated") {
      unrelated += 1;
      continue;
    }
    otherFailure += 1;
  }
  return { related, index, unrelated, otherFailure };
}

function formatContentSelectorValue(values: string[]): string {
  return values.length > 0 ? values.join(",") : "(none)";
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

async function appendEntitySummaryMarkdown(entityId: string, fields: {
  contentSelector: string;
  menuLinks: number;
  spiderFetched: number;
  numDownloads: number;
  related: number;
  index: number;
  unrelated: number;
  otherFailure: number;
}): Promise<void> {
  if (!spiderLogInitialized) {
    const exists = await fs.pathExists(SPIDER_LOG_FILE);
    if (!exists) {
      const header = [
        "| timestamp | entityId | contentSelector | menuLinks | spiderFetched | numDownloads | related | index | unrelated | otherFailure |",
        "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
      ].join("\n");
      await fs.writeFile(SPIDER_LOG_FILE, `${header}\n`, "utf-8");
    }
    spiderLogInitialized = true;
  }

  const timestamp = new Date().toISOString();
  const row = [
    "|",
    escapeMarkdownCell(timestamp),
    "|",
    escapeMarkdownCell(entityId),
    "|",
    escapeMarkdownCell(fields.contentSelector),
    "|",
    String(fields.menuLinks),
    "|",
    String(fields.spiderFetched),
    "|",
    String(fields.numDownloads),
    "|",
    String(fields.related),
    "|",
    String(fields.index),
    "|",
    String(fields.unrelated),
    "|",
    String(fields.otherFailure),
    "|",
  ].join(" ");
  await fs.appendFile(SPIDER_LOG_FILE, `${row}\n`, "utf-8");
}

async function hasCachedHtmlArtifact(
  storage: any,
  historyMap: Map<string, SpiderHistoryEntry>,
  url: string,
): Promise<boolean> {
  const existing = historyMap.get(normalizeUrlForMatch(url));
  if (!existing?.localFile) return false;
  const htmlPath = fromRelativeDownloadsPath(storage, existing.localFile);
  return fs.pathExists(htmlPath);
}

const USER_AGENT = process.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/**
 * Signal for user-initiated clean exit from interactive mode
 */
class InteractiveExitSignal extends Error {
  constructor() {
    super("User requested exit");
    this.name = "InteractiveExitSignal";
  }
}

/** Thrown when the user presses F to auto-approve all subsequent URLs under the same folder path. */
class InteractiveFolderSignal extends Error {
  folderPrefix: string;
  constructor(folderPrefix: string) {
    super("User requested folder auto-approve");
    this.name = "InteractiveFolderSignal";
    this.folderPrefix = folderPrefix;
  }
}

/** Thrown when the user presses N to finish current entity and move to next. */
class InteractiveNextEntitySignal extends Error {
  constructor() {
    super("User requested next entity");
    this.name = "InteractiveNextEntitySignal";
  }
}
const REQUEST_DELAY_MS = 1000;

const DEFAULT_RECRAWL_DAYS = 3;
const DEFAULT_MAX_PAGES_PER_SOURCE = 30;
function normalizeReviewChoice(value: string, fallback: ReviewStatus): ReviewStatus {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized.startsWith("x")) throw new InteractiveExitSignal();
  if (normalized.startsWith("n")) throw new InteractiveNextEntitySignal();
  if (normalized.startsWith("r")) return "related";
  if (normalized.startsWith("i")) return "index";
  if (normalized.startsWith("d") || normalized.startsWith("u")) return "unrelated";
  return fallback;
}

function toReviewStatusFromHistory(status: HistoryStatus | undefined): ReviewStatus | null {
  if (status === "related" || status === "index" || status === "unrelated") {
    return status;
  }
  return null;
}

function getInteractivePromptLabel(status: ReviewStatus): string {
  if (status === "related") return "R";
  if (status === "index") return "I";
  return "D";
}

function getColorForStatus(status: ReviewStatus): string {
    if (status === "related") return "green";
    if (status === "index") return "blue";
    if (status === "unrelated") return "red";
    return "white";
}

async function promptInteractiveClassification(
  rl: ReturnType<typeof createInterface> | null,
  kind: "link" | "page",
  url: string,
  proposed: ReviewStatus,
  details: { text?: string; excerpt?: string; domainScores?: DomainScore[]; explanationLines?: string[] },
): Promise<ReviewStatus> {
  if (!rl) {
    return proposed;
  }

  const label = kind === "link" ? "LINK" : "PAGE";
  console.log(styleText('bold',`\n[INTERACTIVE][${label}] ${url}`));
  if (details.text) {
    console.log(`[INTERACTIVE][TEXT] ${details.text}`);
  }
  if (details.excerpt) {
    console.log(`[INTERACTIVE][EXCERPT] ${details.excerpt}`);
  }
  if (details.domainScores) {
    const matches = details.domainScores.filter((score) => isDomainScoreMatch(score));
    if (matches.length > 0) {
      const topMatches = matches.slice(0, 5);
      console.log("[INTERACTIVE][MATCHING DOMAINS]");
      for (const score of topMatches) {
        console.log(
          `[INTERACTIVE][SCORE] ${score.displayName} | weighted=${score.weightedScore.toFixed(2)} | match=${score.matchScore.toFixed(2)} | raw=${score.rawScore}/${score.totalKeywords}`,
        );
      }
    } else {
      console.log("[INTERACTIVE][MATCHING DOMAINS] none");
    }
  }

  const style = getColorForStatus(proposed);
  console.log(styleText(['bold', style] as any, `[INTERACTIVE][PROPOSAL] ${proposed}`));
  if (details.explanationLines && details.explanationLines.length > 0) {
    console.log(`[INTERACTIVE][EXPLANATION] ${details.explanationLines[0]}`);
  }
  const defaultLabel = getInteractivePromptLabel(proposed);
  while (true) {
    const answer = await rl.question("Accept [Enter], override with R/I/U, help with H, next entity with N, folder with F, or exit with X: ");
    const normalizedAnswer = answer.trim().toLowerCase();
    if (normalizedAnswer.startsWith("f")) {
      const folderPrefix = url.substring(0, url.lastIndexOf("/") + 1);
      console.log(`[INTERACTIVE] Folder mode: auto-approving all URLs under ${folderPrefix}`);
      throw new InteractiveFolderSignal(folderPrefix);
    }
    if (normalizedAnswer.startsWith("h")) {
      console.log("[INTERACTIVE][HELP] Classification rationale:");
      if (details.explanationLines && details.explanationLines.length > 0) {
        for (const line of details.explanationLines) {
          console.log(`[INTERACTIVE][HELP] ${line}`);
        }
      } else {
        console.log("[INTERACTIVE][HELP] No additional explanation is available for this item.");
      }
      continue;
    }

    const resolved = normalizeReviewChoice(answer, proposed);

    if (answer.trim().length > 0 && resolved === proposed && answer.trim().toUpperCase() !== defaultLabel) {
      console.log(`[INTERACTIVE] Unrecognized input '${answer.trim()}'; using proposed '${proposed}'.`);
    }
    return resolved;
  }
}

function parseArgs(args: string[]): Args {
  const { common, rest } = parseCommonCliArgs(args);
  requireDataRootAndRealm(common);

  const options: Args = {
    dataRoot: common.dataRoot,
    realm: common.realm,
    entity: common.entity,
    domain: common.domain,
    all: false,
    dryRun: common.dryRun,
    maxDepth: 2,
    maxPages: DEFAULT_MAX_PAGES_PER_SOURCE * 3,
    maxPagesPerSource: DEFAULT_MAX_PAGES_PER_SOURCE,
    noDownload: false,
    recrawlDays: DEFAULT_RECRAWL_DAYS,
    concurrency: 3,
    interactive: false,
    interactiveHonorHistory: false,
    cleanup: false,
    rewriteText: false,
    scan: false,
    force: false,
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--all") {
      options.all = true;
      continue;
    }
    if (arg === "--limit") {
      const value = Number(rest[i + 1]);
      if (!Number.isFinite(value) || value < 1) {
        throw new Error("--limit must be a positive integer");
      }
      options.limit = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === "--max-depth") {
      const value = Number(rest[i + 1]);
      if (!Number.isFinite(value) || value < 1 || value > 3) {
        throw new Error("--max-depth must be between 1 and 3");
      }
      options.maxDepth = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === "--max-pages") {
      const value = Number(rest[i + 1]);
      if (!Number.isFinite(value) || value < 5) {
        throw new Error("--max-pages must be at least 5");
      }
      options.maxPages = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === "--max-pages-per-source") {
      const value = Number(rest[i + 1]);
      if (!Number.isFinite(value) || value < 1) {
        throw new Error("--max-pages-per-source must be at least 1");
      }
      options.maxPagesPerSource = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === "--specimenUrlsFile") {
      const filePath = rest[i + 1];
      if (!filePath) throw new Error("--specimenUrlsFile requires a file path");
      options.specimenUrlsFile = filePath;
      i += 1;
      continue;
    }
    if (arg === "--nodownload") {
      options.noDownload = true;
      continue;
    }
    if (arg === "--recrawl-days") {
      const value = Number(rest[i + 1]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error("--recrawl-days must be a non-negative number");
      }
      options.recrawlDays = value;
      i += 1;
      continue;
    }
    if (arg === "--concurrency") {
      const value = Number(rest[i + 1]);
      if (!Number.isFinite(value) || value < 1 || value > 20) {
        throw new Error("--concurrency must be between 1 and 20");
      }
      options.concurrency = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === "--interactive") {
      options.interactive = true;
      continue;
    }
    if (arg === "--interactive-honor-history") {
      options.interactiveHonorHistory = true;
      continue;
    }
    if (arg === "--cleanup") {
      options.cleanup = true;
      continue;
    }
    if (arg === "--rewriteText") {
      options.rewriteText = true;
      continue;
    }
    if (arg === "--scan" || arg === "--nospider") {
      options.scan = true;
      continue;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.cleanup && !options.rewriteText && !options.all && !options.entity && !options.specimenUrlsFile) {
    throw new Error("Specify --entity <id>, --all, or --specimenUrlsFile <path>");
  }

  if (options.scan && (options.cleanup || options.rewriteText || Boolean(options.specimenUrlsFile))) {
    throw new Error("--scan/--nospider cannot be combined with --cleanup, --rewriteText, or --specimenUrlsFile");
  }

  if (options.interactiveHonorHistory) {
    options.interactive = true;
  }

  if (options.interactive && options.concurrency > 1) {
    console.log("[INTERACTIVE] forcing concurrency to 1 so prompts remain readable.");
    options.concurrency = 1;
  }

  return options;
}

function resolveDataRoot(inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}
export function isLikelyIndexPage(page: CrawledPage): boolean {
  const urlLower = page.url.toLowerCase();
  const titleLower = page.title.toLowerCase();
  const hasIndexMarker = /\b(index|table of contents|contents|sitemap|directory)\b/.test(`${urlLower} ${titleLower}`);
  const bodyText = `${page.title}\n${page.plainText || page.textSample || ""}`;
  const hasCapitalizedIndexDensity = hasHighCapitalizedIndexDensity(bodyText);
  return hasIndexMarker || page.links.length >= 40 || hasCapitalizedIndexDensity;
}

export function getCapitalizedWordStats(text: string): {
  eligibleWords: number;
  capitalizedWords: number;
  ratio: number;
} {
  const words = (text.match(/[A-Za-z][A-Za-z'\-]*/g) || [])
    .map((word) => word.trim())
    .filter((word) => word.length >= 3);

  if (words.length === 0) {
    return { eligibleWords: 0, capitalizedWords: 0, ratio: 0 };
  }

  const capitalizedWords = words.filter((word) => /^[A-Z][a-z]/.test(word) || /^[A-Z]{2,5}$/.test(word)).length;
  return {
    eligibleWords: words.length,
    capitalizedWords,
    ratio: capitalizedWords / words.length,
  };
}

export function hasHighCapitalizedIndexDensity(text: string): boolean {
  const lower = text.toLowerCase();
  const stats = getCapitalizedWordStats(text);

  const navSignals = [
    "quick links",
    "site links",
    "categories",
    "government",
    "departments",
    "resident resources",
    "how do i",
    "home",
    "site map",
    "sign in",
  ];
  const personnelSignals = [
    "board members",
    "staff directory",
    "commission members",
    "town board",
    "planning board",
    "committee members",
    "contact",
  ];

  const navHitCount = navSignals.filter((signal) => lower.includes(signal)).length;
  const personnelHitCount = personnelSignals.filter((signal) => lower.includes(signal)).length;

  const hasHighDensity = stats.eligibleWords >= 45 && stats.ratio >= 0.42;
  const hasNavigationContext = navHitCount >= 3;
  const looksPrimarilyPersonnel = personnelHitCount >= 3 && navHitCount < 5;

  return hasHighDensity && hasNavigationContext && !looksPrimarilyPersonnel;
}
function slugTokens(value: string): string[] {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return [];

  const stop = new Set(["town", "city", "village", "of", "the", "and", "on", "hudson", "manor"]);
  const parts = cleaned.split(/[\s-]+/).filter((p) => p.length >= 4 && !stop.has(p));
  return Array.from(new Set(parts));
}

function buildAffiliateMatcher(entity: Entity) {
  const tokens = new Set<string>([
    ...slugTokens(entity.name || ""),
    ...slugTokens(entity.displayName || ""),
    ...(entity.singular ? [entity.singular.toLowerCase()] : []),
  ]);

  return (host: string): boolean => {
    const lowerHost = host.toLowerCase();
    for (const token of tokens) {
      if (token.length >= 4 && lowerHost.includes(token)) {
        return true;
      }
    }
    return false;
  };
}

function classifyLinkBySignals(link: ExtractedLink, domains: Domain[], governingBody?: string): ReviewStatus {
  const combined = `${link.text} ${link.url}`.toLowerCase();
  const hasIndexSignal = /\b(index|directory|departments|boards?|commissions?)\b/.test(combined);

  const pseudoPage: CrawledPage = {
    url: link.url,
    depth: 0,
    title: link.text,
    headers: [link.text],
    plainText: link.text,
    textSample: link.text,
    isPdf: false,
    links: [],
  };

  // Domain match is required — only classify as index/related if a domain matches.
  const matchedDomains = classifyDomains(domains, pseudoPage, governingBody);
  if (matchedDomains.length === 0) return "unrelated";

  // Domain matched — now determine if it's an index or a regular related page.
  if (hasIndexSignal || isLikelyIndexPage(pseudoPage)) return "index";
  return "related";
}

function explainLinkClassification(
  link: ExtractedLink,
  domains: Domain[],
  domainScores: DomainScore[],
  governingBody?: string,
): { status: ReviewStatus; explanationLines: string[] } {
  const combined = `${link.text} ${link.url}`.toLowerCase();
  const matched = domainScores.filter((score) => isDomainScoreMatch(score));
  const hasIndexSignal = /\b(index|directory|departments|boards?|commissions?)\b/.test(combined);

  // Domain match is required — only classify as index/related if a domain matches.
  if (matched.length === 0) {
    return {
      status: "unrelated",
      explanationLines: ["No domain keyword score met threshold."],
    };
  }

  const pseudoPage: CrawledPage = {
    url: link.url,
    depth: 0,
    title: link.text,
    headers: [link.text],
    plainText: link.text,
    textSample: link.text,
    isPdf: false,
    links: [],
  };

  // Domain matched — now determine if it's an index or a regular related page.
  if (hasIndexSignal || isLikelyIndexPage(pseudoPage)) {
    return {
      status: "index",
      explanationLines: [
        "Domain keyword scoring matched and index-style signals found in the link text/URL.",
        `Matched domains: ${matched.slice(0, 3).map((score) => score.displayName).join(", ")}`,
      ],
    };
  }

  return {
    status: "related",
    explanationLines: [
      "Domain keyword scoring matched at least one configured domain.",
      `Matched domains: ${matched.slice(0, 3).map((score) => score.displayName).join(", ")}`,
    ],
  };
}

function getSeedUrls(entity: Entity): Array<{ url: string; source: "mainUrl" | "governingUrl" | "authorityUrl" }> {
  const urls: Array<{ url: string; source: "mainUrl" | "governingUrl" | "authorityUrl" }> = [];
  const governing = normalizeUrl(entity.governingUrl);
  const main = normalizeUrl(entity.mainUrl);
  const hub = normalizeUrl(entity.hubUrl);
  const authority = normalizeUrl(entity.authorityUrl);

  if (governing) urls.push({ url: governing, source: "governingUrl" });
  if (main) urls.push({ url: main, source: "mainUrl" });
  if (hub) urls.push({ url: hub, source: "authorityUrl" });
  if (authority) urls.push({ url: authority, source: "authorityUrl" });

  return urls;
}

function getEntityRecordUrls(entity: Entity): Set<string> {
  const urls = [entity.governingUrl, entity.mainUrl, entity.hubUrl, entity.authorityUrl]
    .map((value) => normalizeUrl(value || undefined))
    .filter((value): value is string => Boolean(value))
    .map((value) => normalizeUrlForMatch(value));
  return new Set(urls);
}

function isKnownCloudHost(hostname: string): boolean {
  return /(^|\.)(google\.com|googleapis\.com|gstatic\.com|googleusercontent\.com|amazonaws\.com|cloudfront\.net|awsstatic\.com)$/i.test(hostname);
}

function isHostWithinAllowedDomains(hostname: string, allowedHosts: Set<string>): boolean {
  return allowedHosts.has(hostname);
}

function isAllowedCrawlHost(hostname: string, allowedHosts: Set<string>): boolean {
  // Strict host policy: only exact seed hostnames are allowed.
  return isHostWithinAllowedDomains(hostname, allowedHosts);
}

function evaluateLinkCandidate(
  linkUrl: string,
  context: {
    visited: Set<string>;
    queuedNormalizedUrls: Set<string>;
    historyMap: Map<string, SpiderHistoryEntry>;
    allowedHosts: Set<string>;
    localMenuUrls: Set<string>;
    entityRecordUrls: Set<string>;
    recrawlDays: number;
  },
): LinkCandidateEvaluation | null {
  const normalizedLinkUrl = normalizeUrlForMatch(linkUrl);
  if (context.entityRecordUrls.has(normalizedLinkUrl)) {
    return null;
  }
  if (context.visited.has(normalizedLinkUrl) || context.queuedNormalizedUrls.has(normalizedLinkUrl)) {
    return null;
  }
  if (context.localMenuUrls.has(normalizedLinkUrl)) {
    return null;
  }
  if (SKIP_URL_PATTERN.test(normalizedLinkUrl)) {
    return null;
  }

  let hostname = "";
  try {
    hostname = new URL(normalizedLinkUrl).hostname.toLowerCase();
  } catch {
    return null;
  }

  if (!isAllowedCrawlHost(hostname, context.allowedHosts)) {
    return null;
  }

  const existingLinkHistory = context.historyMap.get(normalizedLinkUrl);
  if (existingLinkHistory && canSkipStatus(existingLinkHistory.status)) {
    return null;
  }
  if (wasAttemptedRecently(existingLinkHistory, context.recrawlDays)) {
    return null;
  }

  return {
    normalizedLinkUrl,
    hostname,
    existingLinkHistory,
  };
}
function inferSourceType(url: string, title: string): RulesetSource["type"] {
  if (/\.pdf(\?.*)?$/i.test(url)) return "form";
  const text = `${url} ${title}`.toLowerCase();
  if (text.includes("form") || text.includes("permit") || text.includes("application")) {
    return "form";
  }
  if (text.includes("policy") || text.includes("guideline") || text.includes("manual")) {
    return "guidance";
  }
  return "guidance";
}

async function runSpecimenMode(
  storage: any,
  specimenFile: string,
  domains: Domain[],
  args: Args,
  specimenEntity?: Entity,
) {
  const resolvedFile = path.isAbsolute(specimenFile)
    ? specimenFile
    : path.resolve(process.cwd(), specimenFile);

  if (!(await fs.pathExists(resolvedFile))) {
    throw new Error(`Specimen file not found: ${resolvedFile}`);
  }

  const raw = await fs.readFile(resolvedFile, "utf-8");
  const urls = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  if (urls.length === 0) {
    throw new Error("Specimen file contains no URLs");
  }

  const domainsToUse = args.domain
    ? domains.filter((d) => (d.id || d.name) === args.domain)
    : domains;

  await ensureEntityDownloadsLayout(storage);
  const specimenEntityId = args.entity || "__specimen__";
  await ensureEntityHistoryLayout(storage, specimenEntityId);
  const { historyMap } = await loadHistoryData(storage, specimenEntityId);

  console.log(`[SPECIMEN] Evaluating ${urls.length} URL(s) against ${domainsToUse.length} domain(s)\n`);

  for (const url of urls) {
    console.log(`${"-".repeat(72)}`);
    console.log(`[URL] ${url}`);

    let page: CrawledPage;
    const normalizedUrl = normalizeUrlForMatch(url);
    let status: HistoryStatus = "related";

    const fetched = await fetchPageContent(url);
    if (!fetched.page) {
      status = fetched.status;
      console.log(`[ERROR] Could not fetch or parse URL (${status})`);
      upsertHistoryEntry(historyMap, {
        url: normalizedUrl,
        entityId: specimenEntityId,
        matchedDomainIds: [],
        status,
      });
      continue;
    }

    if (fetched.page.kind === "pdf") {
      const filename = new URL(url).pathname.split("/").filter(Boolean).pop() || url;
      page = { url, depth: 0, title: decodeURIComponent(filename), headers: [], plainText: "", textSample: "", isPdf: true, links: [] };
      console.log(`[TYPE] PDF — text content not extracted`);
    } else {
      const extracted = extractLinksAndText(url, fetched.page.html || "");
      page = {
        url,
        depth: 0,
        title: extracted.title,
        headers: extracted.headers,
        plainText: extracted.plainText,
        textSample: extracted.sample,
        isPdf: false,
        links: extracted.links,
      };
      console.log(`[TITLE] ${page.title}`);
      const previewLength = 200;
      const preview = page.textSample.slice(0, previewLength);
      console.log(`[TEXT SAMPLE LEN] ${page.textSample.length}`);
      console.log(`[TEXT SAMPLE PREVIEW]`);
      console.log(preview);
      if (page.textSample.length > preview.length) {
        console.log(`[TEXT SAMPLE TRUNCATED] showing first ${preview.length} chars`);
      }
    }

    const scores = scoreDomainDetailed(domainsToUse, page, specimenEntity?.governingBody);
    const matchedDomainIds = scores
      .filter((score) => isDomainScoreMatch(score))
      .map((score) => score.domainId);

    status = matchedDomainIds.length > 0 ? "related" : "unrelated";
    upsertHistoryEntry(historyMap, {
      url: normalizedUrl,
      entityId: specimenEntityId,
      matchedDomainIds,
      status,
    });

    console.log(`\n[DOMAIN SCORES] (match score threshold >= ${DOMAIN_MATCH_SCORE_THRESHOLD})`);

    for (const s of scores) {
      const flag = isDomainScoreMatch(s) ? "MATCH" : "     ";
      const kwList = s.matchedKeywords.length > 0 ? s.matchedKeywords.join(", ") : "(none)";
      console.log(
        `  [${flag}] ${s.displayName.padEnd(40)} weighted=${s.weightedScore.toFixed(1)} match=${s.matchScore.toFixed(1)} raw=${s.rawScore}/${s.totalKeywords} titleHits=${s.titleHits} headerHits=${s.headerHits} type=${s.domainType || "unknown"} keywords: ${kwList}`,
      );
    }

    console.log("");
  }

  await saveHistoryData(storage, specimenEntityId, historyMap);

  console.log(`${"-".repeat(72)}`);
  console.log("[SPECIMEN] Done.");
}

async function readRobotsAllows(url: string): Promise<(targetUrl: string) => boolean> {
  try {
    const robotsUrl = new URL("/robots.txt", url).toString();
    const response = await axios.get(robotsUrl, {
      timeout: 5000,
      headers: { "User-Agent": USER_AGENT },
      validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 400 || typeof response.data !== "string") {
      return () => true;
    }

    const disallowed: string[] = [];
    const lines = response.data.split(/\r?\n/);
    let inGlobalUserAgent = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const [rawKey, ...rest] = line.split(":");
      const key = rawKey.toLowerCase().trim();
      const value = rest.join(":").trim();

      if (key === "user-agent") {
        inGlobalUserAgent = value === "*";
      }

      if (inGlobalUserAgent && key === "disallow" && value) {
        disallowed.push(value);
      }
    }

    return (targetUrl: string) => {
      const u = new URL(targetUrl);
      const pathname = u.pathname || "/";
      return !disallowed.some((prefix) => prefix !== "/" && pathname.startsWith(prefix));
    };
  } catch {
    return () => true;
  }
}

async function spiderEntity(
  entity: Entity,
  domains: Domain[],
  args: Args,
  storage: any,
  interactiveRl: ReturnType<typeof createInterface> | null,
) {
  const entityDownloadsDir = path.join(getEntityDownloadsRoot(storage), entity.id);
  await fs.ensureDir(entityDownloadsDir);

  const seeds = getSeedUrls(entity);
  if (seeds.length === 0) {
    console.log(`[SKIP] ${entity.id}: no seed URLs available`);
    return;
  }

  await ensureEntityHistoryLayout(storage, entity.id);
  const { historyMap, menuLinks } = await loadHistoryData(storage, entity.id);
  const websitesFile = await loadWebsitesFile(storage, entity.id);

  const domainsToUse = args.domain
    ? domains.filter((d) => (d.id || d.name) === args.domain)
    : domains;
  const allowedHosts = new Set<string>();
  for (const seed of seeds) {
    const host = new URL(seed.url).hostname.toLowerCase();
    allowedHosts.add(host);
  }

  const robotsCheckers = new Map<string, (targetUrl: string) => boolean>();
  for (const host of Array.from(allowedHosts)) {
    const checker = await readRobotsAllows(`https://${host}`);
    robotsCheckers.set(host, checker);
  }

  const queue: CrawlTask[] = seeds.map((s) => ({ url: s.url, depth: 0, source: s.source }));
  const queuedNormalizedUrls = new Set<string>(queue.map((task) => normalizeUrlForMatch(task.url)));
  const entityRecordUrls = getEntityRecordUrls(entity);
  const visited = new Set<string>();
  const pages: CrawledPage[] = [];
  const pagesBySource: Record<CrawlTask["source"], number> = {
    governingUrl: 0,
    mainUrl: 0,
    authorityUrl: 0,
  };
  let interactiveModeStopped = false;
  let interactiveFolderPrefix: string | null = null;
  const interactiveReviewedStatuses = new Map<string, ReviewStatus>();
  const localMenuUrls = new Set<string>(menuLinks.urls.map((url) => normalizeUrlForMatch(url)).filter((url) => !entityRecordUrls.has(url)));
  menuLinks.urls = Array.from(localMenuUrls);

  const shouldRefreshMenuLinks = shouldRedetermineMenuLinks(menuLinks);
  if (shouldRefreshMenuLinks) {
    const { discovered: discoveredMenuLinks, contentSelectors } = await discoverLocalMenuLinks(storage, historyMap, entity, entityRecordUrls, {
      domains: domainsToUse,
    });
    localMenuUrls.clear();
    for (const menuUrl of discoveredMenuLinks) {
      localMenuUrls.add(menuUrl);
    }
    menuLinks.urls = Array.from(localMenuUrls);
    menuLinks.timestamp = new Date().toISOString();
    console.log(`[MENU] ${entity.id} re-determined local menu links; total=${localMenuUrls.size}`);

    // Apply discovered content selectors to the websites file so page processing can use them
    for (const [hostname, selector] of contentSelectors) {
      let hostRecord = websitesFile.hosts[hostname];
      if (!hostRecord) {
        const now = new Date().toISOString();
        hostRecord = { hostname, observations: 0, headerCandidates: {}, footerCandidates: {}, createdAt: now, updatedAt: now };
        websitesFile.hosts[hostname] = hostRecord;
      }
      if ((args.force || !hostRecord.contentSelector) && hostRecord.contentSelector !== selector) {
        hostRecord.contentSelector = selector;
        hostRecord.updatedAt = new Date().toISOString();
        console.log(`[MENU] ${entity.id} set content selector for ${hostname}: "${selector}"`);
      }
    }
  } else {
    console.log(`[MENU] ${entity.id} reusing cached local menu links; total=${localMenuUrls.size} timestamp=${menuLinks.timestamp}`);
  }

  // Governing URL validation pass: any URL that is directly linked from the governing URL
  // is validated as important. Remove such URLs from the menu-link filter so they are
  // crawled during this session rather than silently skipped. Also persist the removal
  // so it takes effect on subsequent runs without re-discovery.
  const _governingUrl = normalizeUrl(entity.governingUrl);
  const _mainUrl = normalizeUrl(entity.mainUrl);
  const governingUrlLinkedUrls = new Set<string>();
  const governingMainContentLinkedUrls = new Set<string>();
  if (_governingUrl) {
    for (const l of await readLinkCandidatesForMenuDiscovery(storage, historyMap, _governingUrl)) {
      governingUrlLinkedUrls.add(normalizeUrlForMatch(l.url));
    }

    const governingHost = getLikelyHostname(_governingUrl);
    const governingSelector = governingHost ? websitesFile.hosts[governingHost]?.contentSelector : undefined;
    if (governingSelector) {
      const governingHtml = await fetchHtmlForMenuDiscoveryCached(storage, historyMap, entity.id, _governingUrl);
      if (governingHtml) {
        for (const link of extractContentBlockLinkCandidates(governingHtml, _governingUrl, governingSelector)) {
          governingMainContentLinkedUrls.add(normalizeUrlForMatch(link.url));
        }
      }
    }

    let removedFromMenuFilter = 0;
    for (const url of governingMainContentLinkedUrls) {
      if (localMenuUrls.has(url)) {
        localMenuUrls.delete(url);
        removedFromMenuFilter++;
      }
    }
    if (removedFromMenuFilter > 0) {
      // Keep menuLinks.urls in sync (de-duped via Set) so next run also crawls these.
      menuLinks.urls = Array.from(localMenuUrls);
      console.log(`[MENU] ${entity.id} removed ${removedFromMenuFilter} governing-main-content URL(s) from menu filter`);
    }
  }

  // Determine score threshold for pages directly linked from the governing URL.
  // If the governing URL is on a separate dedicated hostname (not the main site),
  // lower the threshold further — most pages on that dedicated site are likely relevant.
  const governingHostname = _governingUrl ? getLikelyHostname(_governingUrl) : "";
  const mainHostname = _mainUrl ? getLikelyHostname(_mainUrl) : "";
  const isGovDedicatedSite =
    Boolean(governingHostname) && Boolean(mainHostname) && governingHostname !== mainHostname;
  const GOVERNING_LINKED_THRESHOLD = isGovDedicatedSite ? 2 : 3;

  const stopInteractiveMode = (): void => {
    if (!interactiveModeStopped) {
      interactiveModeStopped = true;
      console.log(`\n[INTERACTIVE] Next requested: completing ${entity.id} without more prompts, then moving to the next entity...`);
    }
  };

  const processCollectedPages = async (skipInteractivePrompts = false): Promise<void> => {
    console.log(`[SUMMARY] ${entity.id} crawled pages: ${pages.length}`);
    console.log(
      `[SUMMARY] ${entity.id} pages by source: governing=${pagesBySource.governingUrl}, main=${pagesBySource.mainUrl}, authority=${pagesBySource.authorityUrl}`,
    );

    for (const page of pages) {
      const cacheLabel = page.fromCache ? "[CACHE]" : "[FETCH]";
      console.log(`${cacheLabel} processing ${page.url}`);
      const normalizedPageUrl = normalizeUrlForMatch(page.url);
      const priorEntry = historyMap.get(normalizedPageUrl);
      const statusTimestamp = page.fromCache && priorEntry?.timestamp
        ? priorEntry.timestamp
        : new Date().toISOString();

      const hostname = getLikelyHostname(page.url);
      const hostRecordBefore = websitesFile.hosts[hostname];

      // If a content selector was discovered, extract just the content block from the raw HTML.
      // This removes nav/header/footer noise before any further boilerplate stripping.
      const baseText = (hostRecordBefore?.contentSelector && page.htmlContent)
        ? (extractContentBlockText(page.htmlContent, page.url, hostRecordBefore.contentSelector) ?? page.plainText)
        : page.plainText;

      const trimmedByActive = applyActiveBoilerplate(baseText, hostRecordBefore);
      const hostRecordAfter = updateWebsiteHostRecord(websitesFile, hostname, trimmedByActive, statusTimestamp);
      const trimmedText = applyActiveBoilerplate(trimmedByActive, hostRecordAfter);
      const effectiveTextSample = trimmedText.slice(0, 3000);

      console.log(`[PROCESS] ${page.url}: plainText=${page.plainText.length} -> baseText=${baseText.length} -> trimmedText=${trimmedText.length}${hostRecordBefore?.contentSelector ? ` (selector: ${hostRecordBefore.contentSelector})` : ""}`);

      const scoredPage: CrawledPage = {
        ...page,
        plainText: trimmedText,
        textSample: effectiveTextSample,
      };

      const scoredDomains = scoreDomainDetailed(domainsToUse, scoredPage, entity.governingBody);
      let matchedScores = scoredDomains.filter((score) => isDomainScoreMatch(score));
      // Pages directly linked from the governing URL use a lower threshold to ensure
      // they are not missed. On a dedicated governing site, the threshold drops further.
      if (matchedScores.length === 0 && governingUrlLinkedUrls.has(normalizedPageUrl)) {
        matchedScores = scoredDomains.filter((s) => s.matchScore >= GOVERNING_LINKED_THRESHOLD);
        if (matchedScores.length > 0) {
          console.log(
            `[PROCESS] ${page.url}: matched via governing-URL threshold (${GOVERNING_LINKED_THRESHOLD}${isGovDedicatedSite ? ", dedicated site" : ""})`,
          );
        }
      }
      const matchedDomainIds = matchedScores.map((score) => score.domainId);

      // Check if this page is a seed/entity URL (depth 0) - always treat as related
      const normalizedMainUrl = entity.mainUrl ? normalizeUrlForMatch(entity.mainUrl) : null;
      const isMainUrl = normalizedMainUrl && normalizedPageUrl === normalizedMainUrl;
      const isSeedEntityUrl = page.depth === 0;

      // Index is only a valid classification if the page also matches a domain.
      const isIndex = !isSeedEntityUrl && matchedDomainIds.length > 0 && isLikelyIndexPage(scoredPage);
      let finalStatus: HistoryStatus = isSeedEntityUrl
        ? "related"
        : matchedDomainIds.length === 0
          ? "unrelated"
          : isIndex
            ? "index"
            : "related";

      const pageExplanationLines: string[] = [];
      if (isSeedEntityUrl) {
        pageExplanationLines.push("This URL is a depth-0 entity seed URL, which is always classified as related.");
      } else if (matchedDomainIds.length === 0) {
        pageExplanationLines.push("No domain-score match met threshold.");
      } else if (isIndex) {
        pageExplanationLines.push(`Domain-score match found (${matchedDomainIds.slice(0, 3).join(", ")}) and index-page heuristics triggered.`);
      } else {
        pageExplanationLines.push(`Domain-score match found for: ${matchedDomainIds.slice(0, 3).join(", ")}.`);
      }

      const folderSkipPage = interactiveFolderPrefix !== null && normalizedPageUrl.startsWith(interactiveFolderPrefix);
      if (args.interactive && !skipInteractivePrompts && !interactiveModeStopped && !folderSkipPage && !entityRecordUrls.has(normalizedPageUrl)) {
        const excerpt = (scoredPage.textSample || scoredPage.plainText || "").replace(/\s+/g, " ").slice(0, 280);
        const reviewedStatus = interactiveReviewedStatuses.get(normalizedPageUrl);
        const honoredStatus = reviewedStatus || (args.interactiveHonorHistory
          ? toReviewStatusFromHistory(priorEntry?.status)
          : null);
        if (honoredStatus) {
          finalStatus = honoredStatus;
          if (reviewedStatus) {
            console.log(`[INTERACTIVE][SESSION] page status accepted from prior review: ${scoredPage.url} -> ${honoredStatus}`);
          } else {
            console.log(`[INTERACTIVE][HISTORY] page status accepted from history: ${scoredPage.url} -> ${honoredStatus}`);
          }
          interactiveReviewedStatuses.set(normalizedPageUrl, honoredStatus);
        } else {
        try {
          const reviewedStatus = await promptInteractiveClassification(
            interactiveRl,
            "page",
            scoredPage.url,
            finalStatus,
            {
              excerpt,
              domainScores: scoredDomains,
              explanationLines: pageExplanationLines,
            },
          );
          finalStatus = reviewedStatus;
          interactiveReviewedStatuses.set(normalizedPageUrl, reviewedStatus);
        } catch (err) {
          if (err instanceof InteractiveFolderSignal) {
            interactiveFolderPrefix = err.folderPrefix;
          } else if (err instanceof InteractiveNextEntitySignal) {
            stopInteractiveMode();
          } else {
            throw err;
          }
        }
        }
      }

      // For entityUrl (depth=0), always save artifacts regardless of classification.
      // This ensures the main entry point can always be loaded from cache on subsequent runs.
      const isEntityUrl = page.depth === 0;

      if (finalStatus === "unrelated" && !isEntityUrl) {
        await cleanupArtifactsForHistoryEntry(storage, priorEntry);
        if (!entityRecordUrls.has(normalizedPageUrl)) {
          upsertHistoryEntry(historyMap, {
            url: normalizedPageUrl,
            entityId: entity.id,
            matchedDomainIds: [],
            status: finalStatus,
            timestamp: statusTimestamp,
          });
        }
        continue;
      }

      // Save artifacts for:
      // - entityUrl (depth=0) always
      // - related and index pages
      // Cache hits normally reuse artifacts, but if artifact files are missing, re-save them.
      let localFile: string | undefined = priorEntry?.localFile;
      let localFileText: string | undefined = priorEntry?.localFileText;

      const hasHtmlArtifact = localFile
        ? await fs.pathExists(fromRelativeDownloadsPath(storage, localFile))
        : false;
      const hasTxtArtifact = localFileText
        ? await fs.pathExists(fromRelativeDownloadsPath(storage, localFileText))
        : false;

      const needsHtmlArtifact = Boolean(scoredPage.htmlContent) && !hasHtmlArtifact;
      const needsTxtArtifact = Boolean(scoredPage.plainText) && !hasTxtArtifact;
      const shouldPersistArtifacts = !args.dryRun
        && !args.noDownload
        && (!page.fromCache || needsHtmlArtifact || needsTxtArtifact);

      if (shouldPersistArtifacts) {
        const saved = await saveCrawledArtifacts(storage, entity.id, scoredPage, statusTimestamp, {
          contentSelector: hostRecordBefore?.contentSelector,
        });
        if (saved.localFile) localFile = saved.localFile;
        if (saved.localFileText) localFileText = saved.localFileText;
        console.log(`[ARTIFACTS] saved for ${scoredPage.url}: localFile=${localFile}, localFileText=${localFileText}`);
      } else if (page.fromCache) {
        console.log(`[ARTIFACTS] skipped (fromCache) for ${scoredPage.url}: reusing localFile=${localFile}, localFileText=${localFileText}`);
      } else if (args.dryRun || args.noDownload) {
        console.log(`[ARTIFACTS] skipped (flags) for ${scoredPage.url}: dryRun=${args.dryRun} noDownload=${args.noDownload}`);
      }

      // Persist history immediately after classification/artifact handling so exit saves are resilient
      // even if downstream ruleset updates fail.
      if (!entityRecordUrls.has(normalizedPageUrl)) {
        upsertHistoryEntry(historyMap, {
          url: normalizedPageUrl,
          entityId: entity.id,
          matchedDomainIds,
          status: finalStatus,
          timestamp: statusTimestamp,
          ...(localFile ? { localFile } : {}),
          ...(localFileText ? { localFileText } : {}),
        });
        console.log(`[HISTORY] entry for ${finalStatus}: url=${normalizedPageUrl} localFile=${localFile || '(none)'} localFileText=${localFileText || '(none)'}`);
      }

      if (finalStatus !== "index") {
        for (const scored of matchedScores) {
          try {
            const domain = domainsToUse.find((d) => (d.id || d.name) === scored.domainId);

            // Use the TXT artifact as downloadedFilename, or HTML if TXT not available
            const downloadedFilename = localFileText || localFile || "";

            const source: RulesetSource = {
              sourceUrl: scoredPage.url,
              downloadedAt: new Date().toISOString(),
              title: scoredPage.title || scoredPage.url,
              type: inferSourceType(scoredPage.url, scoredPage.title),
              downloadedFilename,
            };

            const ruleset = await storage.getRulesetOrCreate(scored.domainId, entity.id);
            ruleset.municipality = ruleset.municipality || entity.name;
            ruleset.municipalityType = ruleset.municipalityType || entity.type;
            ruleset.domain = ruleset.domain || domain?.displayName || scored.domainId;
            ruleset.homePage = ruleset.homePage || normalizeUrl(entity.mainUrl) || scoredPage.url;

            const before = (ruleset.sources || []).length;
            addOrUpdateSource(ruleset, source);
            const after = (ruleset.sources || []).length;

            if (args.dryRun) {
              console.log(
                `[DRY-RUN][MATCH] ${entity.id} ${scored.domainId} <- ${scoredPage.url} (sources ${before} -> ${after}) file=${downloadedFilename}`,
              );
            } else {
              await storage.saveRuleset(ruleset);
              const metadataPath = path.join(await storage.getPathForDomainAndEntity(ruleset), "metadata.json");
              console.log(`[UPDATE] ${entity.id} ${scored.domainId} metadata: ${metadataPath}`);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[WARN] ${entity.id} failed updating ${scored.domainId} for ${scoredPage.url}: ${message}`);
          }
        }
      } else {
        console.log(`[INDEX] ${entity.id}: ${scoredPage.url} classified as index (artifacts/history kept, source writes skipped)`);
      }
    }
  };

  try {
    while (queue.length > 0 && pages.length < args.maxPages) {
    const task = queue.shift()!;
    const isBaseEntityUrl = task.depth === 0;
    if (pagesBySource[task.source] >= args.maxPagesPerSource) {
      continue;
    }

    const normalizedTaskUrl = normalizeUrlForMatch(task.url);
    queuedNormalizedUrls.delete(normalizedTaskUrl);
    if (visited.has(normalizedTaskUrl)) {
      continue;
    }

    const existingHistory = historyMap.get(normalizedTaskUrl);
    if (existingHistory && wasAttemptedRecently(existingHistory, args.recrawlDays)) {
      const cached = await loadCachedPageFromHistory(storage, existingHistory, task.depth);
      if (cached) {
        const cacheFile = existingHistory.localFile || existingHistory.localFileText || "(no artifact)";
        console.log(`[CACHE] using cached artifacts for ${task.url} (last download ${existingHistory.timestamp}) file=${cacheFile}`);
        pages.push(cached.page);
        pagesBySource[task.source] += 1;

        let linkCandidatesToEvaluate = cached.linkCandidates;
        if (cached.page.htmlContent) {
          const hostRecord = websitesFile.hosts[getLikelyHostname(task.url)];
          if (hostRecord?.contentSelector) {
            linkCandidatesToEvaluate = extractContentBlockLinkCandidates(
              cached.page.htmlContent,
              task.url,
              hostRecord.contentSelector,
            );
          }
        }

        if (task.depth < args.maxDepth && linkCandidatesToEvaluate.length > 0) {
          for (const link of linkCandidatesToEvaluate) {
            const evaluatedLink = evaluateLinkCandidate(link.url, {
              visited,
              queuedNormalizedUrls,
              historyMap,
              allowedHosts,
              localMenuUrls,
              entityRecordUrls,
              recrawlDays: args.recrawlDays,
            });
            if (!evaluatedLink) {
              continue;
            }

            try {
              const { normalizedLinkUrl, existingLinkHistory } = evaluatedLink;
              const linkScores = scoreDomainDetailed(domainsToUse, buildLinkPseudoPage(link), entity.governingBody);
              const linkClassification = explainLinkClassification(link, domainsToUse, linkScores, entity.governingBody);
              const proposedLinkStatus = governingMainContentLinkedUrls.has(normalizedLinkUrl)
                ? "related"
                : linkClassification.status;
              let reviewedLinkStatus = proposedLinkStatus;
              const folderSkipCachedLink = interactiveFolderPrefix !== null && normalizedLinkUrl.startsWith(interactiveFolderPrefix);
              if (args.interactive && !interactiveModeStopped && !folderSkipCachedLink && !entityRecordUrls.has(normalizedLinkUrl)) {
                const sessionStatus = interactiveReviewedStatuses.get(normalizedLinkUrl);
                const honoredStatus = sessionStatus || (args.interactiveHonorHistory
                  ? toReviewStatusFromHistory(existingLinkHistory?.status)
                  : null);
                if (honoredStatus) {
                  reviewedLinkStatus = honoredStatus;
                  if (sessionStatus) {
                    console.log(`[INTERACTIVE][SESSION] link status accepted from prior review: ${normalizedLinkUrl} -> ${honoredStatus}`);
                  } else {
                    console.log(`[INTERACTIVE][HISTORY] link status accepted from history: ${normalizedLinkUrl} -> ${honoredStatus}`);
                  }
                  interactiveReviewedStatuses.set(normalizedLinkUrl, honoredStatus);
                } else {
                try {
                  reviewedLinkStatus = await promptInteractiveClassification(interactiveRl, "link", normalizedLinkUrl, proposedLinkStatus, {
                    text: link.text,
                    domainScores: linkScores,
                    explanationLines: linkClassification.explanationLines,
                  });
                  interactiveReviewedStatuses.set(normalizedLinkUrl, reviewedLinkStatus);
                } catch (err) {
                  if (err instanceof InteractiveFolderSignal) {
                    interactiveFolderPrefix = err.folderPrefix;
                    reviewedLinkStatus = proposedLinkStatus;
                  } else if (err instanceof InteractiveNextEntitySignal) {
                    stopInteractiveMode();
                    reviewedLinkStatus = proposedLinkStatus;
                  } else {
                    throw err;
                  }
                }
                }
              }

              if (reviewedLinkStatus === "unrelated") {
                if (!entityRecordUrls.has(normalizedLinkUrl)) {
                  upsertHistoryEntry(historyMap, {
                    url: normalizedLinkUrl,
                    entityId: entity.id,
                    matchedDomainIds: [],
                    status: "unrelated",
                  });
                  console.log(`[HISTORY] link marked unrelated: ${normalizedLinkUrl}`);
                }
                continue;
              }

              queue.push({ url: normalizedLinkUrl, depth: task.depth + 1, source: task.source });
              queuedNormalizedUrls.add(normalizedLinkUrl);
            } catch (err) {
              if (err instanceof InteractiveFolderSignal) {
                interactiveFolderPrefix = err.folderPrefix;
                continue;
              }
              if (err instanceof InteractiveNextEntitySignal) {
                stopInteractiveMode();
                continue;
              }
              if (err instanceof InteractiveExitSignal) {
                throw err;
              }
              // ignore malformed URLs
            }
          }
        }
        continue;
      }

      if (!isBaseEntityUrl) {
        console.log(`[HISTORY] recent skip ${task.url} (last attempt ${existingHistory.timestamp}; cache miss)`);
        continue;
      }
    }

    if (!isBaseEntityUrl && existingHistory && canSkipStatus(existingHistory.status)) {
      console.log(`[HISTORY] skip ${task.url} (${existingHistory.status})`);
      continue;
    }
    if (!isBaseEntityUrl && wasAttemptedRecently(existingHistory, args.recrawlDays)) {
      console.log(`[HISTORY] recent skip ${task.url} (last attempt ${existingHistory?.timestamp})`);
      continue;
    }

    visited.add(normalizedTaskUrl);

    let host: string;
    try {
      host = new URL(task.url).hostname.toLowerCase();
    } catch {
      if (!entityRecordUrls.has(normalizedTaskUrl)) {
        upsertHistoryEntry(historyMap, {
          url: normalizedTaskUrl,
          entityId: entity.id,
          matchedDomainIds: [],
          status: "no-content",
        });
      }
      continue;
    }

    const allowedByHost = isAllowedCrawlHost(host, allowedHosts);
    if (!allowedByHost) {
      continue;
    }

    // Skip URLs that are usually irrelevant to domain-policy crawling.
    if (!isBaseEntityUrl && SKIP_URL_PATTERN.test(task.url)) {
      continue;
    }

    let checker = robotsCheckers.get(host);
    if (!checker) {
      checker = await readRobotsAllows(`https://${host}`);
      robotsCheckers.set(host, checker);
    }
    if (!checker(task.url)) {
      console.log(`[ROBOTS] skip ${task.url}`);
      if (!entityRecordUrls.has(normalizedTaskUrl)) {
        upsertHistoryEntry(historyMap, {
          url: normalizedTaskUrl,
          entityId: entity.id,
          matchedDomainIds: [],
          status: "robots-disallow",
        });
      }
      continue;
    }

    console.log(`[FETCH] ${entity.id} depth=${task.depth} ${task.url}`);

    const fetched = await fetchPageContent(task.url);
    await delay(REQUEST_DELAY_MS);
    if (!fetched.page) {
      if (!entityRecordUrls.has(normalizedTaskUrl)) {
        upsertHistoryEntry(historyMap, {
          url: normalizedTaskUrl,
          entityId: entity.id,
          matchedDomainIds: [],
          status: fetched.status,
        });
      }
      continue;
    }

    if (fetched.page.kind === "pdf") {
      const filename = new URL(task.url).pathname.split("/").filter(Boolean).pop() || task.url;
      const title = decodeURIComponent(filename);
      let plainText = "";
      if (fetched.page.pdfBuffer) {
        plainText = (await pdfToText(fetched.page.pdfBuffer, title, false)).trim();
      }
      pages.push({
        url: task.url,
        depth: task.depth,
        title,
        headers: [],
        plainText,
        textSample: plainText.slice(0, 3000),
        isPdf: true,
        links: [],
      });
      pagesBySource[task.source] += 1;
    } else {
      const extracted = extractLinksAndText(task.url, fetched.page.html || "");
      const page: CrawledPage = {
        url: task.url,
        depth: task.depth,
        title: extracted.title,
        headers: extracted.headers,
        htmlContent: fetched.page.html,
        plainText: extracted.plainText,
        textSample: extracted.sample,
        isPdf: false,
        links: extracted.links,
      };
      pages.push(page);
      pagesBySource[task.source] += 1;

      if (task.depth >= args.maxDepth) {
        continue;
      }

      let linkCandidatesToEvaluate = extracted.linkCandidates;
      const hostRecord = websitesFile.hosts[getLikelyHostname(task.url)];
      if (hostRecord?.contentSelector && fetched.page.html) {
        linkCandidatesToEvaluate = extractContentBlockLinkCandidates(
          fetched.page.html,
          task.url,
          hostRecord.contentSelector,
        );
      }

      for (const link of linkCandidatesToEvaluate) {
        const evaluatedLink = evaluateLinkCandidate(link.url, {
          visited,
          queuedNormalizedUrls,
          historyMap,
          allowedHosts,
          localMenuUrls,
          entityRecordUrls,
          recrawlDays: args.recrawlDays,
        });
        if (!evaluatedLink) {
          continue;
        }

        try {
          const { normalizedLinkUrl, existingLinkHistory } = evaluatedLink;
          const linkScores = scoreDomainDetailed(domainsToUse, buildLinkPseudoPage(link), entity.governingBody);
          const linkClassification = explainLinkClassification(link, domainsToUse, linkScores, entity.governingBody);
          const proposedLinkStatus = governingMainContentLinkedUrls.has(normalizedLinkUrl)
            ? "related"
            : linkClassification.status;
          let reviewedLinkStatus = proposedLinkStatus;
          const folderSkipLiveLink = interactiveFolderPrefix !== null && normalizedLinkUrl.startsWith(interactiveFolderPrefix);
          if (args.interactive && !interactiveModeStopped && !folderSkipLiveLink && !entityRecordUrls.has(normalizedLinkUrl)) {
            const sessionStatus = interactiveReviewedStatuses.get(normalizedLinkUrl);
            const honoredStatus = sessionStatus || (args.interactiveHonorHistory
              ? toReviewStatusFromHistory(existingLinkHistory?.status)
              : null);
            if (honoredStatus) {
              reviewedLinkStatus = honoredStatus;
              if (sessionStatus) {
                console.log(`[INTERACTIVE][SESSION] link status accepted from prior review: ${normalizedLinkUrl} -> ${honoredStatus}`);
              } else {
                console.log(`[INTERACTIVE][HISTORY] link status accepted from history: ${normalizedLinkUrl} -> ${honoredStatus}`);
              }
              interactiveReviewedStatuses.set(normalizedLinkUrl, honoredStatus);
            } else {
            try {
              reviewedLinkStatus = await promptInteractiveClassification(interactiveRl, "link", normalizedLinkUrl, proposedLinkStatus, {
                text: link.text,
                domainScores: linkScores,
                explanationLines: linkClassification.explanationLines,
              });
              interactiveReviewedStatuses.set(normalizedLinkUrl, reviewedLinkStatus);
            } catch (err) {
              if (err instanceof InteractiveFolderSignal) {
                interactiveFolderPrefix = err.folderPrefix;
                reviewedLinkStatus = proposedLinkStatus;
              } else if (err instanceof InteractiveNextEntitySignal) {
                stopInteractiveMode();
                reviewedLinkStatus = proposedLinkStatus;
              } else {
                throw err;
              }
            }
            }
          }

          if (reviewedLinkStatus === "unrelated") {
            if (!entityRecordUrls.has(normalizedLinkUrl)) {
              upsertHistoryEntry(historyMap, {
                url: normalizedLinkUrl,
                entityId: entity.id,
                matchedDomainIds: [],
                status: "unrelated",
              });
              console.log(`[HISTORY] link marked unrelated: ${normalizedLinkUrl}`);
            }
            continue;
          }

          queue.push({ url: normalizedLinkUrl, depth: task.depth + 1, source: task.source });
          queuedNormalizedUrls.add(normalizedLinkUrl);
        } catch (err) {
          if (err instanceof InteractiveFolderSignal) {
            interactiveFolderPrefix = err.folderPrefix;
            continue;
          }
          if (err instanceof InteractiveNextEntitySignal) {
            stopInteractiveMode();
            continue;
          }
          if (err instanceof InteractiveExitSignal) {
            throw err;
          }
          // ignore malformed URLs
        }
      }
    }
  }

  await processCollectedPages();
  } catch (err) {
    if (err instanceof InteractiveExitSignal) {
      console.log(`\n[INTERACTIVE] Exit requested — saving history and stopping...`);
      await processCollectedPages(true);
      await saveHistoryData(storage, entity.id, historyMap, menuLinks);
      await saveWebsitesFile(storage, entity.id, websitesFile);
      throw err;
    } else {
      throw err;
    }
  }

  // Flush any collected pages to history entries that haven't been processed yet
  // (e.g., due to early exit during crawl/link phases)
  for (const page of pages) {
    const normalizedPageUrl = normalizeUrlForMatch(page.url);
    if (entityRecordUrls.has(normalizedPageUrl)) {
      continue;
    }
    const priorEntry = historyMap.get(normalizedPageUrl);
    if (!priorEntry) {
      // Page was crawled but not yet processed by main loop; create default history entry
      // Default to "unrelated" to align with classification logic (no domain matches = unrelated)
      upsertHistoryEntry(historyMap, {
        url: normalizedPageUrl,
        entityId: entity.id,
        matchedDomainIds: [],
        status: "unrelated",
        timestamp: new Date().toISOString(),
      });
    }
  }

  const selectorValues = Array.from(new Set(
    Array.from(allowedHosts)
      .map((hostname) => websitesFile.hosts[hostname]?.contentSelector)
      .filter((value): value is string => Boolean(value)),
  ));
  const contentSelectorLog = formatContentSelectorValue(selectorValues);
  const spiderFetchedCount = pages.filter((page) => !page.fromCache).length;
  const statusCounts = getStatusCounts(historyMap);
  await appendEntitySummaryMarkdown(entity.id, {
    contentSelector: contentSelectorLog,
    menuLinks: localMenuUrls.size,
    spiderFetched: spiderFetchedCount,
    numDownloads: spiderFetchedCount,
    related: statusCounts.related,
    index: statusCounts.index,
    unrelated: statusCounts.unrelated,
    otherFailure: statusCounts.otherFailure,
  });

  await saveHistoryData(storage, entity.id, historyMap, menuLinks);
  await saveWebsitesFile(storage, entity.id, websitesFile);
}

async function runRewriteTextMode(storage: any, targets: Entity[], args: Args): Promise<void> {
  let totalHtml = 0;
  let totalRewritten = 0;
  let totalSkipped = 0;
  let totalBytesBefore = 0;
  let totalBytesAfter = 0;

  for (const entity of targets) {
    const historyPath = getHistoryFilePath(storage, entity.id);
    if (!(await fs.pathExists(historyPath))) {
      continue;
    }

    const { historyMap } = await loadHistoryData(storage, entity.id);
    const websitesFile = await loadWebsitesFile(storage, entity.id);

    for (const [, entry] of historyMap.entries()) {
      if (!entry.localFile) continue;

      const htmlAbsPath = fromRelativeDownloadsPath(storage, entry.localFile);
      if (!(await fs.pathExists(htmlAbsPath))) continue;

      totalHtml += 1;
      const html = await fs.readFile(htmlAbsPath, "utf-8");
      const hostname = getLikelyHostname(entry.url);
      let hostRecord = websitesFile.hosts[hostname];
      if (!hostRecord && hostname) {
        if (!hostname.startsWith("www.") && websitesFile.hosts["www." + hostname]) {
          hostRecord = websitesFile.hosts["www." + hostname];
        } else if (hostname.startsWith("www.") && websitesFile.hosts[hostname.replace(/^www\./, "")]) {
          hostRecord = websitesFile.hosts[hostname.replace(/^www\./, "")];
        }
      }
      console.log(`[REWRITE-TEXT] processing ${hostname} with content selector "${hostRecord?.contentSelector || "none"}"`);
      const contentSelector = hostRecord?.contentSelector;

      let newText: string;
      if (contentSelector) {
        newText = extractContentBlockText(html, entry.url, contentSelector) ?? convertHtmlToTextSimple(html).trim();
        console.log(`[REWRITE-TEXT] ${entry.url} extracted text with selector "${contentSelector}" (${newText.length} chars)`);
      } else {
        newText = convertHtmlToTextSimple(html).trim();
      }

      const timestamp = entry.timestamp || new Date().toISOString();
      const newContent = formatTxtArtifact(entry.url, timestamp, newText);

      let oldBytes = 0;
      let newBytes = Buffer.byteLength(newContent, "utf-8");

      if (entry.localFileText) {
        const txtAbsPath = fromRelativeDownloadsPath(storage, entry.localFileText);
        if (await fs.pathExists(txtAbsPath)) {
          const stat = await fs.stat(txtAbsPath);
          oldBytes = stat.size;
        }
      }

      const delta = newBytes - oldBytes;
      const sign = delta >= 0 ? "+" : "";
      const selectorLabel = contentSelector ? ` [selector: ${contentSelector}]` : "";
      const label = oldBytes > 0 ? `${oldBytes}B -> ${newBytes}B (${sign}${delta})` : `new: ${newBytes}B`;
      console.log(`[REWRITE-TEXT] ${entry.url}${selectorLabel} ${label}`);

      totalBytesBefore += oldBytes;
      totalBytesAfter += newBytes;

      if (args.dryRun) {
        totalSkipped += 1;
        continue;
      }

      // Determine txt path: reuse existing or derive from html path
      let txtRelPath = entry.localFileText;
      if (!txtRelPath) {
        const htmlBase = entry.localFile.replace(/\.html$/, "");
        txtRelPath = `${htmlBase}.txt`;
      }

      const txtAbsPath = fromRelativeDownloadsPath(storage, txtRelPath);
      await fs.writeFile(txtAbsPath, newContent, "utf-8");
      totalRewritten += 1;

      if (entry.localFileText !== txtRelPath) {
        historyMap.set(entry.url, { ...entry, localFileText: txtRelPath });
      }
    }

    if (!args.dryRun) {
      await saveHistoryData(storage, entity.id, historyMap);
    }
  }

  const bytesDelta = totalBytesAfter - totalBytesBefore;
  const sign = bytesDelta >= 0 ? "+" : "";
  console.log(
    `[REWRITE-TEXT] done. htmlFiles=${totalHtml} rewritten=${totalRewritten} skipped=${totalSkipped} totalDelta=${sign}${bytesDelta}B${args.dryRun ? " (dry-run)" : ""}`,
  );
}

async function runCleanupMode(storage: any, targets: Entity[], args: Args): Promise<void> {
  let totalScanned = 0;
  let totalFilesDeleted = 0;
  let totalEntriesUpdated = 0;

  for (const entity of targets) {
    const historyPath = getHistoryFilePath(storage, entity.id);
    if (!(await fs.pathExists(historyPath))) {
      continue;
    }

    const { historyMap, menuLinks } = await loadHistoryData(storage, entity.id);
    const menuLinkUrls = new Set(menuLinks.urls.map((url) => normalizeUrlForMatch(url)));
    const allowedCleanupHosts = new Set<string>([
      normalizeUrl(entity.mainUrl),
      normalizeUrl(entity.governingUrl),
      normalizeUrl(entity.hubUrl),
    ].filter((value): value is string => Boolean(value)).map((url) => getLikelyHostname(url)));

    let entityUpdated = false;

    const removeHistoryEntryAndArtifacts = async (
      url: string,
      entry: SpiderHistoryEntry,
      reason: string,
    ): Promise<void> => {
      const pathsToDelete = [entry.localFile, entry.localFileText].filter(Boolean) as string[];
      for (const relPath of pathsToDelete) {
        const absPath = fromRelativeDownloadsPath(storage, relPath);
        if (await fs.pathExists(absPath)) {
          if (!args.dryRun) {
            await fs.remove(absPath);
          }
          totalFilesDeleted += 1;
          console.log(`[CLEANUP]${args.dryRun ? "[DRY-RUN]" : ""} deleted ${relPath} (${url})`);
        } else {
          console.log(`[CLEANUP] missing artifact (already gone): ${relPath} (${url})`);
        }
      }

      if (!args.dryRun) {
        historyMap.delete(url);
      }
      entityUpdated = true;
      totalEntriesUpdated += 1;
      console.log(`[CLEANUP]${args.dryRun ? "[DRY-RUN]" : ""} removed history entry (${reason}): ${url}`);
    };

    for (const [url, entry] of historyMap.entries()) {
      totalScanned += 1;
      const normalizedUrl = normalizeUrlForMatch(url);
      const hostname = getLikelyHostname(normalizedUrl);

      if (allowedCleanupHosts.size > 0 && (!hostname || !allowedCleanupHosts.has(hostname))) {
        await removeHistoryEntryAndArtifacts(url, entry, "outside allowed hostnames");
        continue;
      }

      if (SKIP_URL_PATTERN.test(normalizedUrl)) {
        await removeHistoryEntryAndArtifacts(url, entry, "matches SKIP_URL_PATTERN");
        continue;
      }

      if (menuLinkUrls.has(normalizedUrl)) {
        await removeHistoryEntryAndArtifacts(url, entry, "menu link");
        continue;
      }

      if (entry.status !== "unrelated") {
        continue;
      }
      if (!entry.localFile && !entry.localFileText) {
        continue;
      }

      const pathsToDelete = [entry.localFile, entry.localFileText].filter(Boolean) as string[];
      for (const relPath of pathsToDelete) {
        const absPath = fromRelativeDownloadsPath(storage, relPath);
        if (await fs.pathExists(absPath)) {
          if (!args.dryRun) {
            await fs.remove(absPath);
          }
          totalFilesDeleted += 1;
          console.log(`[CLEANUP]${args.dryRun ? "[DRY-RUN]" : ""} deleted ${relPath} (${url})`);
        } else {
          console.log(`[CLEANUP] missing artifact (already gone): ${relPath} (${url})`);
        }
      }

      if (!args.dryRun) {
        const { localFile: _lf, localFileText: _lt, ...rest } = entry;
        historyMap.set(url, rest as SpiderHistoryEntry);
      }
      entityUpdated = true;
      totalEntriesUpdated += 1;
    }

    if (entityUpdated && !args.dryRun) {
      await saveHistoryData(storage, entity.id, historyMap, menuLinks);
      console.log(`[CLEANUP] saved updated history for ${entity.id}`);
    }
  }

  console.log(`[CLEANUP] done. scanned=${totalScanned} filesDeleted=${totalFilesDeleted} entriesUpdated=${totalEntriesUpdated}${args.dryRun ? " (dry-run)" : ""}`);
}

interface ScanSummary {
  entityId: string;
  seedsCached: number;
  secondaryCached: number;
  selectorFound: boolean;
  menuLinks: number;
  contentSelector: string;
  numDownloads: number;
  statusCounts: StatusCounts;
}

async function runScanForEntity(storage: any, entity: Entity, domains: Domain[], args: Args): Promise<ScanSummary> {
  await ensureEntityHistoryLayout(storage, entity.id);
  const { historyMap, menuLinks } = await loadHistoryData(storage, entity.id);
  const websitesFile = await loadWebsitesFile(storage, entity.id);

  const seedUrls = Array.from(new Set([
    normalizeUrl(entity.mainUrl),
    normalizeUrl(entity.hubUrl),
    normalizeUrl(entity.governingUrl),
    normalizeUrl(entity.authorityUrl),
  ].filter((value): value is string => Boolean(value))));

  const entityRecordUrls = getEntityRecordUrls(entity);
  const allowedHosts = new Set(seedUrls.map((url) => getLikelyHostname(url)).filter(Boolean));

  let seedsCached = 0;
  let numDownloads = 0;
  const seedHtmlByUrl = new Map<string, string>();
  for (const seedUrl of seedUrls) {
    const hadCachedHtml = await hasCachedHtmlArtifact(storage, historyMap, seedUrl);
    const html = await fetchHtmlForMenuDiscoveryCached(storage, historyMap, entity.id, seedUrl, {
      forceRelated: true,
      domains,
      governingBody: entity.governingBody,
    });
    if (html) {
      seedsCached += 1;
      seedHtmlByUrl.set(seedUrl, html);
      if (!hadCachedHtml) {
        numDownloads += 1;
      }
    }
  }

  let secondaryUrl: string | undefined;
  const normalizedMainUrl = normalizeUrl(entity.mainUrl);
  const mainHostname = normalizedMainUrl ? getLikelyHostname(normalizedMainUrl) : "";
  if (normalizedMainUrl && mainHostname) {
    const linkCandidates = await readLinkCandidatesForMenuDiscovery(storage, historyMap, normalizedMainUrl);
    const candidate = linkCandidates
      .map((link) => normalizeUrlForMatch(link.url))
      .find((url) => {
        if (entityRecordUrls.has(url)) return false;
        if (SKIP_URL_PATTERN.test(url)) return false;
        return getLikelyHostname(url) === mainHostname;
      });
    if (candidate) {
      secondaryUrl = candidate;
    }
  }

  let secondaryCached = 0;
  let secondaryHtml: string | null = null;
  if (secondaryUrl) {
    const hadCachedHtml = await hasCachedHtmlArtifact(storage, historyMap, secondaryUrl);
    secondaryHtml = await fetchHtmlForMenuDiscoveryCached(storage, historyMap, entity.id, secondaryUrl, {
      domains,
      governingBody: entity.governingBody,
    });
    if (secondaryHtml) {
      secondaryCached = 1;
      if (!hadCachedHtml) {
        numDownloads += 1;
      }
    }
  }

  let discoveredMenuLinks = new Set<string>();
  const contentSelectors = new Map<string, string>();

  const hasMainAndGoverning = Boolean(normalizeUrl(entity.mainUrl) && normalizeUrl(entity.governingUrl));
  if (hasMainAndGoverning) {
    const discovered = await discoverLocalMenuLinks(storage, historyMap, entity, entityRecordUrls, {
      domains,
    });
    discoveredMenuLinks = discovered.discovered;
    for (const [hostname, selector] of discovered.contentSelectors) {
      contentSelectors.set(hostname, selector);
    }
  }

  if (contentSelectors.size === 0 && secondaryUrl && secondaryHtml) {
    const primaryUrl = normalizeUrl(entity.mainUrl)
      || normalizeUrl(entity.governingUrl)
      || normalizeUrl(entity.hubUrl)
      || normalizeUrl(entity.authorityUrl);
    const primaryHtml = primaryUrl ? (seedHtmlByUrl.get(primaryUrl) || null) : null;
    if (primaryUrl && primaryHtml) {
      const selector = discoverContentSelector(entity, secondaryHtml, secondaryUrl, primaryHtml, primaryUrl);
      if (selector) {
        for (const host of allowedHosts) {
          contentSelectors.set(host, selector);
        }
      }
    }
  }

  const localMenuUrls = new Set<string>(
    menuLinks.urls
      .map((url) => normalizeUrlForMatch(url))
      .filter((url) => !entityRecordUrls.has(url)),
  );
  for (const url of discoveredMenuLinks) {
    localMenuUrls.add(url);
  }
  menuLinks.urls = Array.from(localMenuUrls);
  menuLinks.timestamp = new Date().toISOString();

  for (const [hostname, selector] of contentSelectors) {
    let hostRecord = websitesFile.hosts[hostname];
    if (!hostRecord) {
      const now = new Date().toISOString();
      hostRecord = { hostname, observations: 0, headerCandidates: {}, footerCandidates: {}, createdAt: now, updatedAt: now };
      websitesFile.hosts[hostname] = hostRecord;
    }
    if ((args.force || !hostRecord.contentSelector) && hostRecord.contentSelector !== selector) {
      hostRecord.contentSelector = selector;
      hostRecord.updatedAt = new Date().toISOString();
    }
  }

  await saveHistoryData(storage, entity.id, historyMap, menuLinks);
  await saveWebsitesFile(storage, entity.id, websitesFile);

  const selectorValues = Array.from(new Set(
    Object.values(websitesFile.hosts)
      .map((host) => host?.contentSelector)
      .filter((value): value is string => Boolean(value)),
  ));
  const statusCounts = getStatusCounts(historyMap);

  return {
    entityId: entity.id,
    seedsCached,
    secondaryCached,
    selectorFound: contentSelectors.size > 0,
    menuLinks: localMenuUrls.size,
    contentSelector: formatContentSelectorValue(selectorValues),
    numDownloads,
    statusCounts,
  };
}

async function runScanMode(storage: any, targets: Entity[], domains: Domain[], args: Args): Promise<void> {
  console.log(`[SCAN] Running scan-only mode (${args.scan ? "enabled" : "disabled"})`);
  let totalSeedsCached = 0;
  let totalSecondaryCached = 0;
  let selectorEntities = 0;
  let menuLinksTotal = 0;

  for (let i = 0; i < targets.length; i += args.concurrency) {
    const batch = targets.slice(i, i + args.concurrency);
    const batchResults = await Promise.all(batch.map((entity) => runScanForEntity(storage, entity, domains, args)));
    for (const result of batchResults) {
      totalSeedsCached += result.seedsCached;
      totalSecondaryCached += result.secondaryCached;
      menuLinksTotal += result.menuLinks;
      if (result.selectorFound) selectorEntities += 1;
      await appendEntitySummaryMarkdown(result.entityId, {
        contentSelector: result.contentSelector,
        menuLinks: result.menuLinks,
        spiderFetched: 0,
        numDownloads: result.numDownloads,
        related: result.statusCounts.related,
        index: result.statusCounts.index,
        unrelated: result.statusCounts.unrelated,
        otherFailure: result.statusCounts.otherFailure,
      });
      console.log(
        `[SCAN] ${result.entityId}: seedsCached=${result.seedsCached} secondaryCached=${result.secondaryCached} selectorFound=${result.selectorFound} menuLinks=${result.menuLinks}`,
      );
    }
  }

  console.log(
    `[SCAN] done. entities=${targets.length} seedsCached=${totalSeedsCached} secondaryCached=${totalSecondaryCached} selectorEntities=${selectorEntities} menuLinksTotal=${menuLinksTotal}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataRoot = resolveDataRoot(args.dataRoot);
  process.env.DATA_ROOT = dataRoot;
  const { getDefaultStorage } = await import("@civillyengaged/ordinizer-servercore");
  const storage = getDefaultStorage(args.realm);

  await ensureEntityDownloadsLayout(storage);
  console.log(`Entity downloads root: ${getEntityDownloadsRoot(storage)}`);
  console.log(`using USER-AGENT: ${USER_AGENT}`);

  const realm = (await storage.getRealmConfig()) as Realm;
  const entities = (await storage.getEntities()) as Entity[];
  const domains = (await storage.getDomains()) as Domain[];

  if (entities.length === 0) {
    throw new Error("No entities found");
  }

  let targets = entities;
  if (args.entity) {
    targets = targets.filter((e) => e.id === args.entity);
  }
  if (args.limit) {
    targets = targets.slice(0, args.limit);
  }

  if (args.specimenUrlsFile) {
    const specimenEntity = args.entity
      ? entities.find((entity) => entity.id === args.entity)
      : undefined;
    await runSpecimenMode(storage, args.specimenUrlsFile, domains, args, specimenEntity);
    return;
  }

  if (args.cleanup) {
    await runCleanupMode(storage, targets, args);
    return;
  }

  if (args.rewriteText) {
    await runRewriteTextMode(storage, targets, args);
    return;
  }

  if (args.scan) {
    await runScanMode(storage, targets, domains, args);
    return;
  }

  console.log(`Realm: ${realm.id}`);
  console.log(`Entities total: ${entities.length}`);
  console.log(`Entities targeted: ${targets.length}`);
  console.log(`Domains loaded: ${domains.length}`);
  console.log(`Crawl caps: total maxPages=${args.maxPages}, maxPagesPerSource=${args.maxPagesPerSource}`);

  console.log(`Concurrency: ${args.concurrency} entities in parallel`);

  const interactiveRl = args.interactive
    ? createInterface({ input, output })
    : null;

  try {
    for (let i = 0; i < targets.length; i += args.concurrency) {
      const batch = targets.slice(i, i + args.concurrency);
      await Promise.all(batch.map((entity) => spiderEntity(entity, domains, args, storage, interactiveRl)));
    }
  } finally {
    await interactiveRl?.close();
  }

  if (args.dryRun) {
    console.log("Done (dry-run). No files were modified.");
  } else {
    console.log("Done. Metadata updates saved.");
  }
}

const entryFile = process.argv[1] ? process.argv[1].replace(/\\/g, "/") : "";
const isCliEntrypoint = /(^|\/)spiderEntityWebsites\.(ts|js)$/.test(entryFile);
if (isCliEntrypoint) {
  main().catch((error: unknown) => {
    if (error instanceof InteractiveExitSignal) {
      console.log("[INTERACTIVE] Exited. History saved.");
      process.exit(0);
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Script failed: ${message}`, error instanceof Error ? error.stack : undefined);
    process.exit(1);
  });
}
