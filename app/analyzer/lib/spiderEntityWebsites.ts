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
import { Ruleset, RulesetSource, Entity, Realm, Domain, EntityLinkType } from "@civillyengaged/ordinizer-core";
import { parseCommonCliArgs, requireDataRootAndRealm } from "./scriptArgs.js";
import { styleText } from "node:util";
import {
  type CrawledPage,
  type ExtractedLink,
  type DomainScore,
  DOMAIN_MATCH_SCORE_THRESHOLD,
  PRODUCT_DOMAIN_MATCH_SCORE_THRESHOLD,
  isDomainScoreMatch,
  scoreDomainDetailed,
  classifyDomains,
  buildLinkPseudoPage,
} from "./domainScoring.js";
import {
  type HistoryStatus,
  type SpiderDownloadRecord,
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
  recordFileSize,
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
  extractDocumentTitleWithCache,
  loadCachedPageFromHistory,
  fetchPageContent,
} from "./spiderHistory.js";
import {
  detectBoilerplateCandidates,
  applyActiveBoilerplate,
  updateWebsiteHostRecord,
  getLikelyHostname,
} from "./spiderBoilerplate.js";
import { getVectorService } from "../services/vectorService.js";
import {
  SKIP_URL_PATTERN,
  shouldRedetermineMenuLinks,
  discoverLocalMenuLinks,
  readLinkCandidatesForMenuDiscovery,
  fetchHtmlForMenuDiscoveryCached,
  extractContentBlockLinkCandidates,
  extractSecondaryNavLinkCandidates,
  discoverContentSelector,
  discoverContentSelectorQuick,
  extractContentBlockText,
  stripBoilerplateZonesFromHtml,
  getEntityLink
} from "./spiderPageAnalysis.js";

// Re-exports for backwards compatibility
export type { DomainScore };
export { isDomainScoreMatch, scoreDomainDetailed };
export { canSkipStatus, migrateHistoryEntry, formatTxtArtifact };
export { detectBoilerplateCandidates, applyActiveBoilerplate, updateWebsiteHostRecord };
export { discoverContentSelector, discoverContentSelectorQuick, extractContentBlockText, stripBoilerplateZonesFromHtml };

// ---------------------------------------------------------------------------
// Language-path filtering (product realms only)
// ---------------------------------------------------------------------------

const KNOWN_LANG_CODES = new Set([
  'af','sq','am','ar','hy','az','eu','be','bn','bs','bg','ca','zh','co','hr',
  'cs','da','nl','en','eo','et','fi','fr','fy','gl','ka','de','el','gu','ha',
  'he','hi','hu','id','is','ig','ga','it','ja','jv','kn','kk','km','ko','ku',
  'ky','lo','la','lv','lt','lb','mk','mg','ms','ml','mt','mi','mr','mn','my',
  'ne','no','pl','pt','pt-BR','pa','ro','ru','sm','sr','sk','sl','so','es','su','sw',
  'sv','tg','ta','te','th','tr','uk','ur','uz','vi','cy','yo','zu',
]);

/**
 * Returns the 2-letter language code if the URL's first path segment looks like
 * a language prefix (e.g. /en/, /fr/, /de/, /zh-cn/). Returns null otherwise.
 */
function getLangPathPrefix(url: string): string | null {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    if (segments.length === 0) return null;
    const base = segments[0].toLowerCase().replace(/-[a-z]{2,3}$/, ''); // en-us -> en
    return KNOWN_LANG_CODES.has(base) ? base : null;
  } catch {
    return null;
  }
}

const CRAWL_SOURCES = ["governingUrl", "mainUrl", "hubUrl", "authorityUrl"] as const;
type CrawlSource = (typeof CRAWL_SOURCES)[number];

interface CrawlTask {
  url: string;
  depth: number;
  source: CrawlSource;
}

interface Args {
  dataRoot: string;
  realm: string;
  entity?: string;
  notbot: boolean;
  verbose: boolean;
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
  listLocal: boolean;
  reportRelatedWithoutDomains: boolean;
  rescore: boolean;
  generateSummary: boolean;
  force: boolean;
  forcePdf: boolean;
  seedUrl?: string;
  review: boolean;
  fix?: string;
}

type ReviewStatus = "related" | "index" | "unrelated";

interface LinkCandidateEvaluation {
  normalizedLinkUrl: string;
  hostname: string;
  existingLinkHistory?: SpiderDownloadRecord;
}

interface StatusCounts {
  related: number;
  index: number;
  unrelated: number;
  otherFailure: number;
}

const HISTORY_STATUSES: HistoryStatus[] = [
  "404",
  "blocked",
  "no-content",
  "robots-disallow",
  "timeout",
  "unrelated",
  "related",
  "index",
];

const SPIDER_LOG_FILE = path.resolve(process.cwd(), "spider.log");
let spiderLogInitialized = false;

function getStatusCounts(historyMap: Map<string, SpiderDownloadRecord>): StatusCounts {
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

function getDetailedStatusCounts(historyMap: Map<string, SpiderDownloadRecord>): Record<HistoryStatus, number> {
  const counts = Object.fromEntries(HISTORY_STATUSES.map((status) => [status, 0])) as Record<HistoryStatus, number>;
  for (const entry of historyMap.values()) {
    counts[entry.status] += 1;
  }
  return counts;
}

function formatAgeFromTimestamp(timestamp: string): string {
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts)) {
    return "unknown";
  }

  const elapsedMs = Math.max(0, Date.now() - ts);
  const minutes = Math.floor(elapsedMs / (60 * 1000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remMinutes = minutes % 60;
    return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
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
  historyMap: Map<string, SpiderDownloadRecord>,
  url: string,
): Promise<boolean> {
  const existing = historyMap.get(normalizeUrlForMatch(url));
  if (!existing?.localFile) return false;
  const htmlPath = fromRelativeDownloadsPath(storage, existing.localFile);
  return fs.pathExists(htmlPath);
}

const USER_AGENT = process.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const GENERIC_USER_AGENT = process.env.GENERIC_USER_AGENT || "Mozilla/5.0";

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
const REQUEST_DELAY_MS = 2000;
const BOT_REJECTION_STREAK_THRESHOLD = 3;

function isBotRejectedStatus(status: HistoryStatus): boolean {
  return status === "blocked";
}

async function fetchPageWithBotFallback(
  url: string,
  consecutiveBotRejections: number,
  forceGenericUserAgent = false,
): Promise<{ fetched: Awaited<ReturnType<typeof fetchPageContent>>; consecutiveBotRejections: number }> {
  const fetched = forceGenericUserAgent
    ? await fetchPageContent(url, { userAgent: GENERIC_USER_AGENT })
    : await fetchPageContent(url);
  await delay(REQUEST_DELAY_MS);

  if (forceGenericUserAgent) {
    return {
      fetched,
      consecutiveBotRejections: isBotRejectedStatus(fetched.status) ? consecutiveBotRejections + 1 : 0,
    };
  }

  if (!fetched.page && isBotRejectedStatus(fetched.status)) {
    const updatedRejections = consecutiveBotRejections + 1;
    if (updatedRejections >= BOT_REJECTION_STREAK_THRESHOLD) {
      console.log(`[FETCH][RETRY] ${updatedRejections} bot rejections in a row. Retrying with generic USER-AGENT for: ${url}`);
      const retryFetched = await fetchPageContent(url, { userAgent: GENERIC_USER_AGENT });
      await delay(REQUEST_DELAY_MS);
      if (retryFetched.page) {
        return { fetched: retryFetched, consecutiveBotRejections: 0 };
      }
      return {
        fetched: retryFetched,
        consecutiveBotRejections: isBotRejectedStatus(retryFetched.status) ? updatedRejections : 0,
      };
    }
    return { fetched, consecutiveBotRejections: updatedRejections };
  }

  return { fetched, consecutiveBotRejections: 0 };
}

const DEFAULT_RECRAWL_DAYS = 3;
const DEFAULT_MAX_PAGES_PER_SOURCE = 30;
/** Maximum number of domain matches stored per page. Keeping this small avoids overfit and noisy data. */
const MAX_MATCHED_DOMAINS = 3;
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
  details: { text?: string; excerpt?: string; domainScores?: DomainScore[]; explanationLines?: string[]; cached?: boolean },
): Promise<ReviewStatus> {
  if (!rl) {
    return proposed;
  }

  const label = kind === "link" ? "LINK" : "PAGE";
  const cacheTag = details.cached === true ? " [cached]" : details.cached === false ? " [live]" : "";
  console.log(styleText('bold',`\n[INTERACTIVE][${label}]${cacheTag} ${url}`));
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
    notbot: common.notbot,
    verbose: false,
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
    listLocal: false,
    reportRelatedWithoutDomains: false,
    rescore: false,
    generateSummary: false,
    force: false,
    forcePdf: false,
    seedUrl: undefined,
    review: false,
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
    if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
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
    if (arg === "--listlocal") {
      options.listLocal = true;
      continue;
    }
    if (arg === "--report-related-without-domains") {
      options.reportRelatedWithoutDomains = true;
      continue;
    }
    if (arg === "--rescore") {
      options.rescore = true;
      continue;
    }
    if (arg === "--generateSummary" || arg === "--generate-summary") {
      options.generateSummary = true;
      continue;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--force-pdf") {
      options.forcePdf = true;
      continue;
    }
    if (arg === "--review") {
      options.review = true;
      continue;
    }
    if (arg === "--seed-url") {
      const value = rest[i + 1];
      if (!value) throw new Error("--seed-url requires a value (type name or URL)");
      options.seedUrl = value;
      i += 1;
      continue;
    }
    if (arg === "--fix") {
      const value = rest[i + 1];
      if (!value) throw new Error("--fix requires a value (e.g. domain-to-related)");
      options.fix = value;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.generateSummary && !options.all && !options.entity) {
    options.all = true;
  }

  if (options.fix && !options.all && !options.entity) {
    options.all = true;
  }

  if (!options.cleanup && !options.rewriteText && !options.listLocal && !options.reportRelatedWithoutDomains && !options.rescore && !options.generateSummary && !options.review && !options.fix && !options.all && !options.entity && !options.specimenUrlsFile) {
    throw new Error("Specify --entity <id>, --all, or --specimenUrlsFile <path>");
  }

  if (options.scan && (options.cleanup || options.rewriteText || options.listLocal || options.reportRelatedWithoutDomains || options.rescore || options.generateSummary || Boolean(options.specimenUrlsFile))) {
    throw new Error("--scan/--nospider cannot be combined with --cleanup, --rewriteText, --listlocal, --report-related-without-domains, --rescore, --generateSummary, or --specimenUrlsFile");
  }

  if (options.listLocal && (options.cleanup || options.rewriteText || options.scan || options.reportRelatedWithoutDomains || options.rescore || options.generateSummary || Boolean(options.specimenUrlsFile))) {
    throw new Error("--listlocal cannot be combined with --cleanup, --rewriteText, --scan/--nospider, --report-related-without-domains, --rescore, --generateSummary, or --specimenUrlsFile");
  }

  if (options.reportRelatedWithoutDomains && (options.cleanup || options.rewriteText || options.scan || options.listLocal || options.rescore || options.generateSummary || Boolean(options.specimenUrlsFile))) {
    throw new Error("--report-related-without-domains cannot be combined with --cleanup, --rewriteText, --scan/--nospider, --listlocal, --rescore, --generateSummary, or --specimenUrlsFile");
  }

  if (options.rescore && (options.cleanup || options.rewriteText || options.scan || options.listLocal || options.reportRelatedWithoutDomains || options.generateSummary || Boolean(options.specimenUrlsFile))) {
    throw new Error("--rescore cannot be combined with --cleanup, --rewriteText, --scan/--nospider, --listlocal, --report-related-without-domains, --generateSummary, or --specimenUrlsFile");
  }

  if (options.generateSummary && (options.cleanup || options.rewriteText || options.scan || options.listLocal || options.reportRelatedWithoutDomains || options.rescore || Boolean(options.specimenUrlsFile))) {
    throw new Error("--generateSummary cannot be combined with --cleanup, --rewriteText, --scan/--nospider, --listlocal, --report-related-without-domains, --rescore, or --specimenUrlsFile");
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
export function isLikelyIndexPage(page: CrawledPage, contentAreaLinkCount?: number, realmNavSignals?: string[]): boolean {
  const urlLower = page.url.toLowerCase();
  const titleLower = page.title.toLowerCase();
  const hasIndexMarker = /\b(index|table of contents|contents|sitemap|directory)\b/.test(`${urlLower} ${titleLower}`);
  const bodyText = `${page.title}\n${page.plainText || page.textSample || ""}`;
  const hasCapitalizedIndexDensity = hasHighCapitalizedIndexDensity(bodyText, realmNavSignals);
  const linkCount = contentAreaLinkCount ?? page.links.length;
  return hasIndexMarker || linkCount >= 40 || hasCapitalizedIndexDensity;
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

export function hasHighCapitalizedIndexDensity(text: string, realmNavSignals?: string[]): boolean {
  const lower = text.toLowerCase();
  const stats = getCapitalizedWordStats(text);

  const navSignals = realmNavSignals && realmNavSignals.length > 0
    ? realmNavSignals
    : [
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

function getSeedUrls(entity: Entity): Array<{ url: string; source: CrawlSource }> {
  const urls: Array<{ url: string; source: CrawlSource }> = [];
  const governing = normalizeUrl(getEntityLink(entity, "governing"));
  const main = normalizeUrl(getEntityLink(entity, "main"));
  const hub = normalizeUrl(getEntityLink(entity, "hub"));
  const authority = normalizeUrl(getEntityLink(entity, "authority"));

  if (governing) urls.push({ url: governing, source: "governingUrl" });
  if (main) urls.push({ url: main, source: "mainUrl" });
  if (hub) urls.push({ url: hub, source: "hubUrl" });
  if (authority) urls.push({ url: authority, source: "authorityUrl" });

  return urls;
}

const LINK_TYPE_TO_SOURCE: Record<string, CrawlSource> = {
  main: "mainUrl",
  governing: "governingUrl",
  hub: "hubUrl",
  authority: "authorityUrl",
};

function filterSeeds(
  seeds: Array<{ url: string; source: CrawlSource }>,
  seedUrl: string,
): Array<{ url: string; source: CrawlSource }> {
  if (seedUrl in LINK_TYPE_TO_SOURCE) {
    const source = LINK_TYPE_TO_SOURCE[seedUrl];
    return seeds.filter((s) => s.source === source);
  }
  // Direct URL: prefer a matching seed (to keep the right source label),
  // otherwise inject it as-is and let the source default to "mainUrl".
  const normalizedTarget = normalizeUrlForMatch(seedUrl);
  const match = seeds.find((s) => normalizeUrlForMatch(s.url) === normalizedTarget);
  return match ? [match] : [{ url: seedUrl, source: "mainUrl" }];
}

function getEntityRecordUrls(entity: Entity): Set<string> {
  const urls = (["governing", "main", "hub", "authority"] as const).map((t) => getEntityLink(entity, t))
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
    historyMap: Map<string, SpiderDownloadRecord>;
    allowedHosts: Set<string>;
    localMenuUrls: Set<string>;
    entityRecordUrls: Set<string>;
    recrawlDays: number;
    verbose: boolean;
    /** When true, skip the localMenuUrls filter and allow re-queuing of previously-unrelated URLs. */
    bypassMenuAndUnrelatedFilter?: boolean;
  },
): LinkCandidateEvaluation | null {
  const normalizedLinkUrl = normalizeUrlForMatch(linkUrl);
  const logSkip = (reason: string): null => {
    if (context.verbose) {
      console.log(`[LINK][SKIP] ${normalizedLinkUrl} - ${reason}`);
    }
    return null;
  };

  if (context.entityRecordUrls.has(normalizedLinkUrl)) {
    return logSkip("entity seed URL");
  }
  if (context.visited.has(normalizedLinkUrl) || context.queuedNormalizedUrls.has(normalizedLinkUrl)) {
    return logSkip("already visited or already queued");
  }
  if (!context.bypassMenuAndUnrelatedFilter && context.localMenuUrls.has(normalizedLinkUrl)) {
    return logSkip("known local menu URL");
  }
  if (SKIP_URL_PATTERN.test(normalizedLinkUrl)) {
    return logSkip("matches skip URL pattern");
  }

  let hostname = "";
  try {
    hostname = new URL(normalizedLinkUrl).hostname.toLowerCase();
  } catch {
    return logSkip("invalid URL");
  }

  if (!isAllowedCrawlHost(hostname, context.allowedHosts)) {
    return logSkip(`host not allowed (${hostname})`);
  }

  const existingLinkHistory = context.historyMap.get(normalizedLinkUrl);
  if (existingLinkHistory && canSkipStatus(existingLinkHistory.status)) {
    // Priority/seed-page links are allowed through even if previously marked unrelated,
    // but not if the prior failure was a fetch error (404, blocked, timeout, etc.).
    if (!context.bypassMenuAndUnrelatedFilter || existingLinkHistory.status !== "unrelated") {
      return logSkip(`history status skip (${existingLinkHistory.status})`);
    }
  }
  if (wasAttemptedRecently(existingLinkHistory, context.recrawlDays)) {
    return logSkip(`attempted recently (${existingLinkHistory?.timestamp || "unknown"})`);
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
    return "general";
  }
  return "general";
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
  let consecutiveBotRejections = 0;

  console.log(`[SPECIMEN] Evaluating ${urls.length} URL(s) against ${domainsToUse.length} domain(s)\n`);

  for (const url of urls) {
    console.log(`${"-".repeat(72)}`);
    console.log(`[URL] ${url}`);

    let page: CrawledPage;
    const normalizedUrl = normalizeUrlForMatch(url);
    let status: HistoryStatus = "related";

    const fetchResult = await fetchPageWithBotFallback(url, consecutiveBotRejections, args.notbot);
    const fetched = fetchResult.fetched;
    consecutiveBotRejections = fetchResult.consecutiveBotRejections;
    if (!fetched.page) {
      status = fetched.status;
      console.log(`[ERROR] Could not fetch or parse URL (${status})`);
      upsertHistoryEntry(historyMap, {
        url: normalizedUrl,
        title: normalizedUrl,
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
      .map((score) => score.domainId)
      .slice(0, MAX_MATCHED_DOMAINS);

    status = matchedDomainIds.length > 0 ? "related" : "unrelated";
    const specimenTitle = page.title?.trim() || undefined;
    upsertHistoryEntry(historyMap, {
      url: normalizedUrl,
      title: specimenTitle || normalizedUrl,
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

async function readRobotsAllows(url: string, userAgent: string = USER_AGENT): Promise<(targetUrl: string) => boolean> {
  try {
    const robotsUrl = new URL("/robots.txt", url).toString();
    const response = await axios.get(robotsUrl, {
      timeout: 5000,
      headers: { "User-Agent": userAgent },
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
  realm: Realm,
  args: Args,
  storage: any,
  interactiveRl: ReturnType<typeof createInterface> | null,
) {
  const entityDownloadsDir = path.join(getEntityDownloadsRoot(storage), entity.id);
  await fs.ensureDir(entityDownloadsDir);

  const isProductRealm = realm.entityType === 'product';
  const priorityPathKeywords: string[] = realm.spiderHints?.priorityPathKeywords ?? [];
  const indexNavSignals: string[] | undefined = realm.spiderHints?.indexNavSignals;

  // Per-host language-prefix tracking for multilingual site detection (product realms only).
  const hostLangCodes = new Map<string, Set<string>>();

  function recordLangPrefixes(links: { url: string }[], fromUrl: string): void {
    if (!isProductRealm) return;
    const host = getLikelyHostname(fromUrl);
    if (!host) return;
    if (!hostLangCodes.has(host)) hostLangCodes.set(host, new Set());
    const codes = hostLangCodes.get(host)!;
    for (const link of links) {
      const code = getLangPathPrefix(link.url);
      if (code) codes.add(code);
    }
    // If the page being crawled has no language prefix (English-default root) and we found
    // language-prefixed links, infer 'en' so the multilingual detection fires without needing
    // an explicit /en/ path (e.g. asana.com serves English at / not /en/).
    if (getLangPathPrefix(fromUrl) === null && codes.size > 0) {
      codes.add('en');
    }
    // Persist multilingual preference when English + at least one other language are seen.
    if (codes.has('en') && codes.size > 1) {
      const hostRecord = websitesFile.hosts[host];
      if (hostRecord && !hostRecord.skipOtherLanguages) {
        hostRecord.preferredLanguage = 'en';
        hostRecord.skipOtherLanguages = true;
      }
    }
  }

  // Returns true when the URL is a non-English localization path and should be fully ignored
  // (no fetch, no analysis, no history entry). Checks both in-memory detection and persisted
  // host settings from websites.json so the filter works across runs.
  function shouldSkipLangPath(url: string): boolean {
    if (!isProductRealm) return false;
    const lang = getLangPathPrefix(url);
    if (lang === null || lang === 'en') return false;
    const host = getLikelyHostname(url);
    const hostRecord = websitesFile.hosts[host];
    if (hostRecord?.skipOtherLanguages) return true;
    const codes = hostLangCodes.get(host);
    return codes?.has('en') === true;
  }

  const allSeeds = getSeedUrls(entity);
  const seeds = args.seedUrl ? filterSeeds(allSeeds, args.seedUrl) : allSeeds;
  if (seeds.length === 0) {
    console.log(`[SKIP] ${entity.id}: no seed URLs available${args.seedUrl ? ` (--seed-url ${args.seedUrl})` : ""}`);
    return;
  }
  for (const seed of seeds) {
    console.log(`[SEED] ${entity.id} source=${seed.source} ${seed.url}`);
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
    const checker = await readRobotsAllows(`https://${host}`, args.notbot ? GENERIC_USER_AGENT : USER_AGENT);
    robotsCheckers.set(host, checker);
  }

  const queue: CrawlTask[] = seeds.map((s) => ({ url: s.url, depth: 0, source: s.source }));
  const queuedNormalizedUrls = new Set<string>(queue.map((task) => normalizeUrlForMatch(task.url)));

  // Enqueue a link, pushing to front of queue when it matches a priority path keyword.
  function enqueueLink(url: string, depth: number, source: CrawlSource): void {
    const isPriority = priorityPathKeywords.length > 0 &&
      priorityPathKeywords.some(kw => url.toLowerCase().includes(kw));
    if (isPriority) {
      queue.unshift({ url, depth, source });
      if (args.verbose) console.log(`[LINK][PRIORITY] ${url}`);
    } else {
      queue.push({ url, depth, source });
    }
    queuedNormalizedUrls.add(url);
  }

  const entityRecordUrls = getEntityRecordUrls(entity);
  const visited = new Set<string>();
  const pages: CrawledPage[] = [];
  const pagesBySource: Record<CrawlSource, number> = {
    governingUrl: 0,
    mainUrl: 0,
    hubUrl: 0,
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
    // Preserve wildcard entries — they are managed by cleanup mode and should survive menu link rediscovery.
    const wildcardUrls = Array.from(localMenuUrls).filter((url) => url.endsWith("*"));
    localMenuUrls.clear();
    for (const menuUrl of discoveredMenuLinks) {
      localMenuUrls.add(menuUrl);
    }
    for (const wildcard of wildcardUrls) {
      localMenuUrls.add(wildcard);
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
  const _governingUrl = normalizeUrl(getEntityLink(entity, "governing"));
  const _mainUrl = normalizeUrl(getEntityLink(entity, "main"));
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

  const processCollectedPages = async (skipInteractivePrompts = false, fromIndex = 0): Promise<void> => {
    if (fromIndex === 0) {
      console.log(`[SUMMARY] ${entity.id} crawled pages: ${pages.length}`);
      console.log(
        `[SUMMARY] ${entity.id} pages by source: governing=${pagesBySource.governingUrl}, main=${pagesBySource.mainUrl}, hub=${pagesBySource.hubUrl}, authority=${pagesBySource.authorityUrl}`,
      );
    } else {
      console.log(`[COVERAGE][SUMMARY] ${entity.id} processing ${pages.length - fromIndex} extension page(s)`);
    }

    for (let _pi = fromIndex; _pi < pages.length; _pi++) {
    const page = pages[_pi];
      const cacheLabel = page.fromCache ? "[CACHE]" : "[FETCH]";
      console.log(`${cacheLabel} processing ${page.url}`);
      const normalizedPageUrl = normalizeUrlForMatch(page.url);
      const priorEntry = historyMap.get(normalizedPageUrl);
      const statusTimestamp = page.fromCache && priorEntry?.timestamp
        ? priorEntry.timestamp
        : new Date().toISOString();

      const hostname = getLikelyHostname(page.url);
      const hostRecordBefore = websitesFile.hosts[hostname];

      // Quick-win content selector discovery: runs on every HTML page for hosts that
      // don't yet have a selector, so coverage no longer depends on menu-link refresh timing.
      if (!hostRecordBefore?.contentSelector && page.htmlContent) {
        const quickSelector = discoverContentSelectorQuick(page.htmlContent, page.url);
        if (quickSelector) {
          let hostRecord = websitesFile.hosts[hostname];
          if (!hostRecord) {
            const now = statusTimestamp;
            hostRecord = { hostname, observations: 0, headerCandidates: {}, footerCandidates: {}, createdAt: now, updatedAt: now };
            websitesFile.hosts[hostname] = hostRecord;
          }
          if (!hostRecord.contentSelector) {
            hostRecord.contentSelector = quickSelector;
            hostRecord.updatedAt = statusTimestamp;
            console.log(`[PROCESS] ${hostname}: quick-win content selector: ${quickSelector}`);
          }
        }
      }

      // Strip header/footer zone elements from HTML using promoted selectors before
      // content extraction, so nav/chrome is removed at the DOM level rather than by text matching.
      const htmlForExtraction = (page.htmlContent && (hostRecordBefore?.activeHeaderSelector || hostRecordBefore?.activeFooterSelector))
        ? stripBoilerplateZonesFromHtml(page.htmlContent, page.url, hostRecordBefore)
        : page.htmlContent;

      // If a content selector is now known (possibly just discovered above), extract just that block.
      // If no selector but zones were stripped, convert the stripped HTML to text rather than
      // falling back to the pre-computed plainText (which came from the original unstripped HTML).
      const effectiveHostRecord = websitesFile.hosts[hostname];
      let baseText: string;
      if (effectiveHostRecord?.contentSelector && htmlForExtraction) {
        baseText = extractContentBlockText(htmlForExtraction, page.url, effectiveHostRecord.contentSelector) ?? page.plainText;
      } else if (htmlForExtraction && htmlForExtraction !== page.htmlContent) {
        baseText = convertHtmlToTextSimple(htmlForExtraction).trim() || page.plainText;
      } else {
        baseText = page.plainText;
      }

      const trimmedByActive = applyActiveBoilerplate(baseText, hostRecordBefore);
      const hostRecordAfter = updateWebsiteHostRecord(websitesFile, hostname, trimmedByActive, statusTimestamp, htmlForExtraction ?? page.htmlContent);
      const trimmedText = applyActiveBoilerplate(trimmedByActive, hostRecordAfter);
      const effectiveTextSample = trimmedText.slice(0, 3000);

      console.log(`[PROCESS] ${page.url}: plainText=${page.plainText.length} -> baseText=${baseText.length} -> trimmedText=${trimmedText.length}${effectiveHostRecord?.contentSelector ? ` (selector: ${effectiveHostRecord.contentSelector})` : ""}`);

      const scoredPage: CrawledPage = {
        ...page,
        plainText: trimmedText,
        textSample: effectiveTextSample,
      };

      const scoredDomains = scoreDomainDetailed(domainsToUse, scoredPage, entity.governingBody);
      let matchedScores = isProductRealm
        ? scoredDomains.filter((s) => s.matchScore >= PRODUCT_DOMAIN_MATCH_SCORE_THRESHOLD)
        : scoredDomains.filter((score) => isDomainScoreMatch(score));
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
      const matchedDomainIds = matchedScores.map((score) => score.domainId).slice(0, MAX_MATCHED_DOMAINS);

      // Check if this page is a seed/entity URL (depth 0) - always treat as related
      const normalizedMainUrl = getEntityLink(entity, "main") ? normalizeUrlForMatch(getEntityLink(entity, "main")!) : null;
      const isMainUrl = normalizedMainUrl && normalizedPageUrl === normalizedMainUrl;
      const isSeedEntityUrl = page.depth === 0;

      // Hub pages are purpose-built content sites — never demote them to index.
      const hubHostname = getLikelyHostname(normalizeUrl(getEntityLink(entity, "hub")) ?? "");
      const isHubPage = Boolean(hubHostname && getLikelyHostname(page.url) === hubHostname);

      // For non-hub pages use content-area link count (not whole-page) to avoid false positives.
      let contentAreaLinkCount: number | undefined;
      if (!isHubPage && effectiveHostRecord?.contentSelector && htmlForExtraction) {
        contentAreaLinkCount = extractContentBlockLinkCandidates(
          htmlForExtraction, page.url, effectiveHostRecord.contentSelector,
        ).length;
      }

      // Index is only a valid classification if the page also matches a domain.
      // Product realms are dedicated product/vendor sites where index-style pages are rare.
      const isIndex = !isProductRealm && !isSeedEntityUrl && !isHubPage && matchedDomainIds.length > 0 && isLikelyIndexPage(scoredPage, contentAreaLinkCount, indexNavSignals);

      // A page whose URL or title contains a priority keyword (e.g. "faq", "features") is
      // always saved as related, even when domain scoring finds no match.
      const isPriorityPage = !isSeedEntityUrl && priorityPathKeywords.length > 0 && (
        priorityPathKeywords.some(kw => scoredPage.url.toLowerCase().includes(kw)) ||
        priorityPathKeywords.some(kw => scoredPage.title.toLowerCase().includes(kw))
      );

      let finalStatus: HistoryStatus = isSeedEntityUrl
        ? "related"
        : isPriorityPage && matchedDomainIds.length === 0
          ? "related"
          : matchedDomainIds.length === 0
            ? "unrelated"
            : isIndex
              ? "index"
              : "related";

      const pageExplanationLines: string[] = [];
      if (isSeedEntityUrl) {
        pageExplanationLines.push("This URL is a depth-0 entity seed URL, which is always classified as related.");
      } else if (isPriorityPage && matchedDomainIds.length === 0) {
        pageExplanationLines.push(`Priority keyword matched in URL or title; saved as related despite no domain score.`);
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
              cached: page.fromCache,
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
      const extractedTitle = await extractDocumentTitleWithCache(
        storage,
        historyMap,
        normalizedPageUrl,
        scoredPage.htmlContent,
      );
      const resourceTitle = (extractedTitle || scoredPage.title || normalizedPageUrl).trim();

      if (finalStatus === "unrelated" && !isEntityUrl) {
        await cleanupArtifactsForHistoryEntry(storage, priorEntry);
        if (!entityRecordUrls.has(normalizedPageUrl)) {
          upsertHistoryEntry(historyMap, {
            url: normalizedPageUrl,
            title: resourceTitle,
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
      let localFileTextSize: number | undefined = priorEntry?.localFileTextSize;
      let fileType: "HTML" | "PDF" | undefined = priorEntry?.fileType;

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
          existingLocalFile: priorEntry?.localFile,
          existingLocalFileText: priorEntry?.localFileText,
        });
        if (saved.localFile) localFile = saved.localFile;
        if (saved.fileType) fileType = saved.fileType;
        if (saved.localFileText) {
          localFileText = saved.localFileText;
          localFileTextSize = await recordFileSize(storage, historyMap, {
            url: normalizedPageUrl,
            title: resourceTitle,
            entityId: entity.id,
            matchedDomainIds,
            status: finalStatus,
            timestamp: statusTimestamp,
            ...(localFile ? { localFile } : {}),
            localFileText,
          });
        }
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
          title: resourceTitle,
          entityId: entity.id,
          matchedDomainIds,
          status: finalStatus,
          timestamp: statusTimestamp,
          ...(fileType ? { fileType } : {}),
          ...(localFile ? { localFile } : {}),
          ...(localFileText ? { localFileText } : {}),
          ...(typeof localFileTextSize === "number" ? { localFileTextSize } : {}),
        });
        console.log(`[HISTORY] entry for ${finalStatus}: url=${normalizedPageUrl} fileType=${fileType || '(none)'} localFile=${localFile || '(none)'} localFileText=${localFileText || '(none)'}`);
      }

      // if (finalStatus !== "index") {
      //   for (const scored of matchedScores) {
      //     try {
      //       const domain = domainsToUse.find((d) => (d.id || d.name) === scored.domainId);

      //       // Use the TXT artifact as downloadedFilename, or HTML if TXT not available
      //       const downloadedFilename = localFileText || localFile || "";

      //       const source: RulesetSource = {
      //         sourceUrl: scoredPage.url,
      //         downloadedAt: new Date().toISOString(),
      //         title: scoredPage.title || scoredPage.url,
      //         type: inferSourceType(scoredPage.url, scoredPage.title),
      //         downloadedFilename,
      //       };

      //       const ruleset = await storage.getRulesetOrCreate(scored.domainId, entity.id);
      //       ruleset.municipality = ruleset.municipality || entity.name;
      //       ruleset.municipalityType = ruleset.municipalityType || entity.type;
      //       ruleset.domain = ruleset.domain || domain?.displayName || scored.domainId;
      //       ruleset.homePage = ruleset.homePage || normalizeUrl(entity.mainUrl) || scoredPage.url;

      //       const before = (ruleset.sources || []).length;
      //       addOrUpdateSource(ruleset, source);
      //       const after = (ruleset.sources || []).length;

      //       if (args.dryRun) {
      //         console.log(
      //           `[DRY-RUN][MATCH] ${entity.id} ${scored.domainId} <- ${scoredPage.url} (sources ${before} -> ${after}) file=${downloadedFilename}`,
      //         );
      //       } else {
      //         await storage.saveRuleset(ruleset);
      //         const metadataPath = path.join(await storage.getPathForDomainAndEntity(ruleset), "metadata.json");
      //         console.log(`[UPDATE] ${entity.id} ${scored.domainId} metadata: ${metadataPath}`);
      //       }
      //     } catch (error) {
      //       const message = error instanceof Error ? error.message : String(error);
      //       console.warn(`[WARN] ${entity.id} failed updating ${scored.domainId} for ${scoredPage.url}: ${message}`);
      //     }
      //   }
      // } else {
      //   console.log(`[INDEX] ${entity.id}: ${scoredPage.url} classified as index (artifacts/history kept, source writes skipped)`);
      // }
    }
  };

  try {
    let consecutiveBotRejections = 0;
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
    if (shouldSkipLangPath(task.url)) {
      console.log(`[TASK][LANG] ${task.url}`);
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
        if (cached.page.htmlContent && task.source !== "hubUrl") {
          const hostRecord = websitesFile.hosts[getLikelyHostname(task.url)];
          if (hostRecord?.contentSelector) {
            linkCandidatesToEvaluate = extractContentBlockLinkCandidates(
              cached.page.htmlContent,
              task.url,
              hostRecord.contentSelector,
            );
          }
        }

        console.log(`[EXTRACT][CACHE] ${entity.id} source=${task.source} depth=${task.depth} links=${linkCandidatesToEvaluate.length} ${task.url}`);
        recordLangPrefixes(linkCandidatesToEvaluate, task.url);
        if (task.depth < args.maxDepth + (task.source === "hubUrl" ? 1 : 0) && linkCandidatesToEvaluate.length > 0) {
          for (const link of linkCandidatesToEvaluate) {
            if (shouldSkipLangPath(link.url)) { if (args.verbose) console.log(`[LINK][LANG] ${link.url}`); continue; }
            const isPriorityBySignalCache = priorityPathKeywords.length > 0 &&
              priorityPathKeywords.some(kw =>
                link.url.toLowerCase().includes(kw) || link.text.toLowerCase().includes(kw)
              );
            const bypassLinkFiltersCache = isPriorityBySignalCache || isProductRealm;
            const evaluatedLink = evaluateLinkCandidate(link.url, {
              visited,
              queuedNormalizedUrls,
              historyMap,
              allowedHosts,
              localMenuUrls: task.source === "hubUrl" ? new Set<string>() : localMenuUrls,
              entityRecordUrls,
              recrawlDays: args.recrawlDays,
              verbose: args.verbose,
              bypassMenuAndUnrelatedFilter: bypassLinkFiltersCache,
            });
            if (!evaluatedLink) {
              continue;
            }

            try {
              const { normalizedLinkUrl, existingLinkHistory } = evaluatedLink;
              const linkScores = scoreDomainDetailed(domainsToUse, buildLinkPseudoPage(link), entity.governingBody);
              const linkClassification = explainLinkClassification(link, domainsToUse, linkScores, entity.governingBody);
              const proposedLinkStatus = (
                governingMainContentLinkedUrls.has(normalizedLinkUrl) ||
                (isProductRealm && task.depth === 0) ||
                isPriorityBySignalCache
              ) ? "related" : linkClassification.status;
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

              enqueueLink(normalizedLinkUrl, task.depth + 1, task.source);
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

        if (task.source === "governingUrl" && task.depth === 0 && cached.page.htmlContent) {
          const secondaryNavLinks = extractSecondaryNavLinkCandidates(cached.page.htmlContent, task.url);
          if (secondaryNavLinks.length > 0) {
            console.log(`[SECONDARY-NAV] ${entity.id} found ${secondaryNavLinks.length} links on governing URL (cache)`);
            for (const link of secondaryNavLinks) {
              if (shouldSkipLangPath(link.url)) continue;
              const evaluatedLink = evaluateLinkCandidate(link.url, {
                visited,
                queuedNormalizedUrls,
                historyMap,
                allowedHosts,
                localMenuUrls: new Set<string>(),
                entityRecordUrls,
                recrawlDays: args.recrawlDays,
                verbose: args.verbose,
              });
              if (!evaluatedLink) continue;
              enqueueLink(evaluatedLink.normalizedLinkUrl, task.depth + 1, task.source);
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
      // For product realms, allow previously-unrelated pages to be re-fetched so they
      // can be re-scored against the lower product threshold. Hard failures (404, blocked,
      // timeout, etc.) are still skipped regardless.
      if (!isProductRealm || existingHistory.status !== "unrelated") {
        console.log(`[HISTORY] skip ${task.url} (${existingHistory.status})`);
        continue;
      }
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
      checker = await readRobotsAllows(`https://${host}`, args.notbot ? GENERIC_USER_AGENT : USER_AGENT);
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

    if (args.dryRun) {
      console.log(`[DRY-RUN][SKIP-FETCH] ${task.url} (no cached artifact available)`);
      continue;
    }

    const isPdfUrl = /\.pdf(\?.*)?$/i.test(task.url);
    if (isPdfUrl && !args.forcePdf && existingHistory?.localFileText) {
      const absPath = fromRelativeDownloadsPath(storage, existingHistory.localFileText);
      if (await fs.pathExists(absPath)) {
        console.log(`[PDF][SKIP] already downloaded: ${task.url} (use --force-pdf to re-download)`);
        const cached = await loadCachedPageFromHistory(storage, existingHistory, task.depth);
        if (cached) {
          pages.push(cached.page);
          pagesBySource[task.source] += 1;
        }
        continue;
      }
    }

    console.log(`[FETCH] ${entity.id} source=${task.source} depth=${task.depth} ${task.url}`);

    const fetchResult = await fetchPageWithBotFallback(task.url, consecutiveBotRejections, args.notbot);
    const fetched = fetchResult.fetched;
    consecutiveBotRejections = fetchResult.consecutiveBotRejections;
    let cachedHtmlForBlockedFetch: string | null = null;
    if (!fetched.page) {
      if (fetched.status === "blocked" && existingHistory) {
        const cached = await loadCachedPageFromHistory(storage, existingHistory, task.depth);
        if (cached?.page.htmlContent) {
          cachedHtmlForBlockedFetch = cached.page.htmlContent;
          const cacheFile = existingHistory.localFile || existingHistory.localFileText || "(no artifact)";
          console.log(`[CACHE] fetch blocked for ${task.url}; using cached HTML for link scan file=${cacheFile}`);
        }
      }

      if (!cachedHtmlForBlockedFetch) {
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
    }

    if (fetched.page?.kind === "pdf") {
      const filename = new URL(task.url).pathname.split("/").filter(Boolean).pop() || task.url;
      const title = decodeURIComponent(filename);
      let plainText = "";
      if (fetched.page?.pdfBuffer) {
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
        pdfBuffer: fetched.page.pdfBuffer,
        links: [],
      });
      pagesBySource[task.source] += 1;
    } else {
      const extracted = extractLinksAndText(task.url, fetched.page?.html || cachedHtmlForBlockedFetch || "");
      console.log(`[EXTRACT] ${entity.id} source=${task.source} depth=${task.depth} links=${extracted.linkCandidates.length}${cachedHtmlForBlockedFetch ? " (cached)" : ""} ${task.url}`);
      const page: CrawledPage = {
        url: task.url,
        depth: task.depth,
        title: extracted.title,
        headers: extracted.headers,
        htmlContent: fetched.page?.html || cachedHtmlForBlockedFetch || undefined,
        plainText: extracted.plainText,
        textSample: extracted.sample,
        isPdf: false,
        links: extracted.links,
        ...(cachedHtmlForBlockedFetch ? { fromCache: true } : {}),
      };
      pages.push(page);
      pagesBySource[task.source] += 1;

      if (task.depth >= args.maxDepth + (task.source === "hubUrl" ? 1 : 0)) {
        continue;
      }

      let linkCandidatesToEvaluate = extracted.linkCandidates;
      const hostRecord = websitesFile.hosts[getLikelyHostname(task.url)];
      if (hostRecord?.contentSelector && page.htmlContent && task.source !== "hubUrl") {
        linkCandidatesToEvaluate = extractContentBlockLinkCandidates(
          page.htmlContent,
          task.url,
          hostRecord.contentSelector,
        );
      }

      recordLangPrefixes(linkCandidatesToEvaluate, task.url);
      for (const link of linkCandidatesToEvaluate) {
        if (shouldSkipLangPath(link.url)) { if (args.verbose) console.log(`[LINK][LANG] ${link.url}`); continue; }
        const isPriorityBySignalLive = priorityPathKeywords.length > 0 &&
          priorityPathKeywords.some(kw =>
            link.url.toLowerCase().includes(kw) || link.text.toLowerCase().includes(kw)
          );
        const bypassLinkFiltersLive = isPriorityBySignalLive || isProductRealm;
        const evaluatedLink = evaluateLinkCandidate(link.url, {
          visited,
          queuedNormalizedUrls,
          historyMap,
          allowedHosts,
          localMenuUrls: task.source === "hubUrl" ? new Set<string>() : localMenuUrls,
          entityRecordUrls,
          recrawlDays: args.recrawlDays,
          verbose: args.verbose,
          bypassMenuAndUnrelatedFilter: bypassLinkFiltersLive,
        });
        if (!evaluatedLink) {
          continue;
        }

        try {
          const { normalizedLinkUrl, existingLinkHistory } = evaluatedLink;
          const linkScores = scoreDomainDetailed(domainsToUse, buildLinkPseudoPage(link), entity.governingBody);
          const linkClassification = explainLinkClassification(link, domainsToUse, linkScores, entity.governingBody);
          const proposedLinkStatus = (
            governingMainContentLinkedUrls.has(normalizedLinkUrl) ||
            (isProductRealm && task.depth === 0) ||
            isPriorityBySignalLive
          ) ? "related" : linkClassification.status;
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

          enqueueLink(normalizedLinkUrl, task.depth + 1, task.source);
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

      if (task.source === "governingUrl" && task.depth === 0 && page.htmlContent) {
        const secondaryNavLinks = extractSecondaryNavLinkCandidates(page.htmlContent, task.url);
        if (secondaryNavLinks.length > 0) {
          console.log(`[SECONDARY-NAV] ${entity.id} found ${secondaryNavLinks.length} links on governing URL`);
          for (const link of secondaryNavLinks) {
            if (shouldSkipLangPath(link.url)) continue;
            const evaluatedLink = evaluateLinkCandidate(link.url, {
              visited,
              queuedNormalizedUrls,
              historyMap,
              allowedHosts,
              localMenuUrls: new Set<string>(),
              entityRecordUrls,
              recrawlDays: args.recrawlDays,
              verbose: args.verbose,
            });
            if (!evaluatedLink) continue;
            enqueueLink(evaluatedLink.normalizedLinkUrl, task.depth + 1, task.source);
          }
        }
      }
    }
  }

  await processCollectedPages();

  // Coverage extension: for product realms, if any domain has < 2 related pages after the
  // initial crawl, re-queue links from boundary pages (at maxDepth) and crawl one level deeper.
  const MIN_DOMAIN_COVERAGE = 2;
  if (isProductRealm && domainsToUse.length > 0) {
    const domainHits = new Map<string, number>(domainsToUse.map(d => [d.id || d.name, 0]));
    for (const entry of historyMap.values()) {
      if (entry.status === 'related') {
        for (const id of (entry.matchedDomainIds || [])) {
          if (domainHits.has(id)) domainHits.set(id, domainHits.get(id)! + 1);
        }
      }
    }

    const undercovered = [...domainHits.entries()]
      .filter(([, n]) => n < MIN_DOMAIN_COVERAGE)
      .map(([id]) => id);

    if (undercovered.length > 0) {
      console.log(`[COVERAGE] ${entity.id} undercovered domains (< ${MIN_DOMAIN_COVERAGE} pages): ${undercovered.join(', ')}`);

      const boundaryPages = pages.filter(p => p.depth >= args.maxDepth && p.htmlContent);
      console.log(`[COVERAGE] ${entity.id} boundary pages with HTML: ${boundaryPages.length}`);

      if (boundaryPages.length > 0 && !args.dryRun) {
        const extDepth = args.maxDepth + 1;
        let extQueued = 0;

        for (const bp of boundaryPages) {
          const bpHostRecord = websitesFile.hosts[getLikelyHostname(bp.url)];
          const bpLinks = bpHostRecord?.contentSelector
            ? extractContentBlockLinkCandidates(bp.htmlContent!, bp.url, bpHostRecord.contentSelector)
            : extractLinksAndText(bp.url, bp.htmlContent!).linkCandidates;

          recordLangPrefixes(bpLinks, bp.url);
          for (const link of bpLinks) {
            if (shouldSkipLangPath(link.url)) continue;
            const evaluated = evaluateLinkCandidate(link.url, {
              visited,
              queuedNormalizedUrls,
              historyMap,
              allowedHosts,
              localMenuUrls,
              entityRecordUrls,
              recrawlDays: args.recrawlDays,
              verbose: args.verbose,
            });
            if (!evaluated) continue;
            // Only extend toward links that appear domain-relevant.
            const linkScores = scoreDomainDetailed(domainsToUse, buildLinkPseudoPage(link), entity.governingBody);
            if (!linkScores.some(s => isDomainScoreMatch(s))) continue;
            enqueueLink(evaluated.normalizedLinkUrl, extDepth, 'mainUrl');
            extQueued++;
          }
        }

        console.log(`[COVERAGE] ${entity.id} queued ${extQueued} extension URL(s) at depth ${extDepth}`);

        if (extQueued > 0) {
          const extPageCap = Math.min(args.maxPagesPerSource, 20);
          let extFetched = 0;
          const firstPassCount = pages.length;

          while (queue.length > 0 && extFetched < extPageCap) {
            const task = queue.shift()!;
            if (task.depth !== extDepth) { queue.push(task); break; } // non-extension tasks shouldn't be here
            const normalizedTaskUrl = normalizeUrlForMatch(task.url);
            queuedNormalizedUrls.delete(normalizedTaskUrl);
            if (visited.has(normalizedTaskUrl)) continue;
            if (shouldSkipLangPath(task.url)) {
              if (args.verbose) console.log(`[TASK][LANG] ${task.url}`);
              continue;
            }

            const existingHistory = historyMap.get(normalizedTaskUrl);
            if (existingHistory && wasAttemptedRecently(existingHistory, args.recrawlDays)) {
              const cached = await loadCachedPageFromHistory(storage, existingHistory, task.depth);
              if (cached) { pages.push(cached.page); extFetched++; }
              continue;
            }

            visited.add(normalizedTaskUrl);
            const extHost = getLikelyHostname(task.url);
            if (!extHost || !isAllowedCrawlHost(extHost, allowedHosts)) continue;

            let checker = robotsCheckers.get(extHost);
            if (!checker) {
              checker = await readRobotsAllows(`https://${extHost}`, args.notbot ? GENERIC_USER_AGENT : USER_AGENT);
              robotsCheckers.set(extHost, checker);
            }
            if (!checker(task.url)) {
              if (!entityRecordUrls.has(normalizedTaskUrl)) {
                upsertHistoryEntry(historyMap, { url: normalizedTaskUrl, entityId: entity.id, matchedDomainIds: [], status: 'robots-disallow' });
              }
              continue;
            }

            console.log(`[COVERAGE][FETCH] ${entity.id} depth=${task.depth} ${task.url}`);
            const fetchResult = await fetchPageWithBotFallback(task.url, 0, args.notbot);
            const fetched = fetchResult.fetched;
            if (!fetched.page || fetched.page.kind !== 'html') {
              if (!fetched.page && !entityRecordUrls.has(normalizedTaskUrl)) {
                upsertHistoryEntry(historyMap, { url: normalizedTaskUrl, entityId: entity.id, matchedDomainIds: [], status: fetched.status });
              }
              continue;
            }

            const extExtracted = extractLinksAndText(task.url, fetched.page.html || '');
            pages.push({
              url: task.url,
              depth: task.depth,
              title: extExtracted.title,
              headers: extExtracted.headers,
              htmlContent: fetched.page.html,
              plainText: extExtracted.plainText,
              textSample: extExtracted.sample,
              isPdf: false,
              links: extExtracted.links,
            });
            extFetched++;
          }

          if (extFetched > 0) {
            console.log(`[COVERAGE] ${entity.id} fetched ${extFetched} extension page(s); processing...`);
            await processCollectedPages(false, firstPassCount);
          }
        }
      }
    } else {
      console.log(`[COVERAGE] ${entity.id} all domains covered (>= ${MIN_DOMAIN_COVERAGE} pages each)`);
    }
  }

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

    // Always retire legacy text-based boilerplate fields — selector-based detection supersedes them.
    // --force additionally resets selector data so it can be fully re-discovered from cached HTML.
    for (const hostRecord of Object.values(websitesFile.hosts)) {
      hostRecord.headerCandidates = {};
      hostRecord.footerCandidates = {};
      delete hostRecord.activeHeader;
      delete hostRecord.activeFooter;
      if (args.force) {
        delete hostRecord.contentSelector;
        delete hostRecord.activeHeaderSelector;
        delete hostRecord.activeFooterSelector;
        hostRecord.headerSelectorCandidates = {};
        hostRecord.footerSelectorCandidates = {};
      }
    }

    const now = new Date().toISOString();

    for (const [, entry] of historyMap.entries()) {
      if (!entry.localFile) continue;

      const htmlAbsPath = fromRelativeDownloadsPath(storage, entry.localFile);
      if (!(await fs.pathExists(htmlAbsPath))) continue;

      totalHtml += 1;
      const html = await fs.readFile(htmlAbsPath, "utf-8");
      const hostname = getLikelyHostname(entry.url);

      // Resolve or create the host record for this hostname
      if (!websitesFile.hosts[hostname] && hostname) {
        const aliasWww = !hostname.startsWith("www.") ? websitesFile.hosts["www." + hostname] : undefined;
        const aliasNoWww = hostname.startsWith("www.") ? websitesFile.hosts[hostname.replace(/^www\./, "")] : undefined;
        if (aliasWww) {
          websitesFile.hosts[hostname] = aliasWww;
        } else if (aliasNoWww) {
          websitesFile.hosts[hostname] = aliasNoWww;
        } else {
          websitesFile.hosts[hostname] = { hostname, observations: 0, headerCandidates: {}, footerCandidates: {}, createdAt: now, updatedAt: now };
        }
      }
      const hostRecord = websitesFile.hosts[hostname];

      // Quick-win content selector discovery for hosts that don't have one yet
      if (hostRecord && !hostRecord.contentSelector) {
        const quickSelector = discoverContentSelectorQuick(html, entry.url);
        if (quickSelector) {
          hostRecord.contentSelector = quickSelector;
          hostRecord.updatedAt = now;
          console.log(`[REWRITE-TEXT] ${hostname}: discovered content selector: ${quickSelector}`);
        }
      }

      // Strip header/footer zone elements at HTML level using any already-promoted selectors
      const htmlForExtraction = stripBoilerplateZonesFromHtml(html, entry.url, hostRecord);

      const contentSelector = hostRecord?.contentSelector;
      console.log(`[REWRITE-TEXT] processing ${hostname} with content selector "${contentSelector || "none"}"`);

      let newText: string;
      if (contentSelector) {
        newText = extractContentBlockText(htmlForExtraction, entry.url, contentSelector) ?? convertHtmlToTextSimple(htmlForExtraction).trim();
        console.log(`[REWRITE-TEXT] ${entry.url} extracted text with selector "${contentSelector}" (${newText.length} chars)`);
      } else {
        newText = convertHtmlToTextSimple(htmlForExtraction).trim();
      }

      // Apply text-based boilerplate stripping (active header/footer text, legacy fallback)
      const preStrip = applyActiveBoilerplate(newText, hostRecord);

      // Update host record: builds up header/footer selector candidates across pages
      const timestamp = entry.timestamp || now;
      const updatedHostRecord = updateWebsiteHostRecord(websitesFile, hostname, preStrip, timestamp, htmlForExtraction);

      // Apply boilerplate stripping again with newly promoted candidates
      const finalText = applyActiveBoilerplate(preStrip, updatedHostRecord);

      const newContent = formatTxtArtifact(entry.url, timestamp, finalText);

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

      const refreshedEntry = historyMap.get(entry.url) || { ...entry, localFileText: txtRelPath };
      await recordFileSize(storage, historyMap, {
        ...refreshedEntry,
        localFileText: txtRelPath,
      });
    }

    if (!args.dryRun) {
      await saveHistoryData(storage, entity.id, historyMap);
      await saveWebsitesFile(storage, entity.id, websitesFile);
    }
  }

  const bytesDelta = totalBytesAfter - totalBytesBefore;
  const sign = bytesDelta >= 0 ? "+" : "";
  console.log(
    `[REWRITE-TEXT] done. htmlFiles=${totalHtml} rewritten=${totalRewritten} skipped=${totalSkipped} totalDelta=${sign}${bytesDelta}B${args.dryRun ? " (dry-run)" : ""}`,
  );
}

async function runRelatedWithoutDomainsReport(storage: any, targets: Entity[]): Promise<void> {
  const relatedWithoutDomainsGlobal: Array<{ entityId: string; url: string }> = [];

  for (const entity of targets) {
    const historyPath = getHistoryFilePath(storage, entity.id);
    if (!(await fs.pathExists(historyPath))) {
      continue;
    }

    const { historyMap } = await loadHistoryData(storage, entity.id);
    const relatedWithoutDomainsEntity: string[] = [];

    for (const [url, entry] of historyMap.entries()) {
      const normalizedUrl = normalizeUrlForMatch(url);
      if (entry.status === "related" && (!entry.matchedDomainIds || entry.matchedDomainIds.length === 0)) {
        relatedWithoutDomainsEntity.push(normalizedUrl);
      }
    }

    if (relatedWithoutDomainsEntity.length > 0) {
      relatedWithoutDomainsGlobal.push(...relatedWithoutDomainsEntity.map((url) => ({ entityId: entity.id, url })));
      console.log(`[REPORT] ${entity.id}: related entries without matchedDomainIds (${relatedWithoutDomainsEntity.length})`);
      for (const url of relatedWithoutDomainsEntity) {
        console.log(`  [REPORT][RELATED-WITHOUT-DOMAINS] ${url}`);
      }
    }
  }

  if (relatedWithoutDomainsGlobal.length === 0) {
    console.log("[REPORT] No related entries without matchedDomainIds found.");
    return;
  }

  console.log(`[REPORT] related entries without matchedDomainIds (global: ${relatedWithoutDomainsGlobal.length})`);
  for (const item of relatedWithoutDomainsGlobal) {
    console.log(`  [REPORT][RELATED-WITHOUT-DOMAINS] ${item.entityId} ${item.url}`);
  }
}

async function runListLocalMode(storage: any, targets: Entity[], args: Args, domains: Domain[], realm: Realm): Promise<void> {
  const reportPath = path.join(getEntityDownloadsRoot(storage), "FileReport.md");
  const reportLines: string[] = [
    "# Entity Local File Report",
    "",
    `Generated at: ${new Date().toISOString()}`,
    "",
  ];

  const vectorService = process.env.PINECONE_API_KEY ? getVectorService(realm.id) : null;
  if (!vectorService) {
    console.warn("[LISTLOCAL] PINECONE_API_KEY not set; skipping vector chunk counts");
  }

  let entitiesWithHistory = 0;
  let totalFiles = 0;
  let totalSize = 0;
  let totalUpdatedSizes = 0;

  for (const entity of targets) {
    const historyPath = getHistoryFilePath(storage, entity.id);
    if (!(await fs.pathExists(historyPath))) {
      continue;
    }

    entitiesWithHistory += 1;
    const { historyMap, menuLinks } = await loadHistoryData(storage, entity.id);
    let entityUpdated = false;

    for (const [url, entry] of historyMap.entries()) {
      if (!entry.localFileText) {
        continue;
      }
      const previousSize = entry.localFileTextSize;
      const updatedSize = await recordFileSize(storage, historyMap, entry);
      if (typeof updatedSize === "number" && updatedSize !== previousSize) {
        entityUpdated = true;
        totalUpdatedSizes += 1;
      }

      if (url !== normalizeUrlForMatch(url)) {
        // Keep key in map normalized if legacy data slipped in.
        const normalized = normalizeUrlForMatch(url);
        const normalizedEntry = historyMap.get(url);
        if (normalizedEntry) {
          historyMap.delete(url);
          historyMap.set(normalized, normalizedEntry);
        }
      }
    }

    if (entityUpdated && !args.dryRun) {
      await saveHistoryData(storage, entity.id, historyMap, menuLinks);
    }

    const statusCounts = getDetailedStatusCounts(historyMap);
    const entriesWithFiles = Array.from(historyMap.values())
      .filter((entry) => Boolean(entry.localFileText) && entry.status === "related")
      .sort((a, b) => a.url.localeCompare(b.url));

    reportLines.push(`## ${entity.id} (${entity.name})`);
    reportLines.push("");
    reportLines.push("### Entity URLs");
    reportLines.push(`- governingUrl: ${getEntityLink(entity, "governing") || "(none)"}`);
    reportLines.push(`- mainUrl: ${getEntityLink(entity, "main") || "(none)"}`);
    reportLines.push(`- hubUrl: ${getEntityLink(entity, "hub") || "(none)"}`);
    reportLines.push(`- authorityUrl: ${getEntityLink(entity, "authority") || "(none)"}`);
    reportLines.push("");

    reportLines.push("### History Status Summary");
    reportLines.push("| status | count |");
    reportLines.push("| --- | ---: |");
    for (const status of HISTORY_STATUSES) {
      reportLines.push(`| ${status} | ${statusCounts[status]} |`);
    }
    reportLines.push("");

    reportLines.push("### Domain Summary");
    reportLines.push("| domain | documents | vector chunks |");
    reportLines.push("| --- | ---: | ---: |");
    for (const domain of domains) {
      const domainDocs = entriesWithFiles.filter((e) => e.matchedDomainIds.includes(domain.id)).length;
      let chunkCount = "-";
      if (vectorService) {
        try {
          chunkCount = String(await vectorService.countChunksByMetadata(entity.id, domain.id));
        } catch {
          chunkCount = "err";
        }
      }
      reportLines.push(`| ${domain.displayName ?? domain.id} | ${domainDocs} | ${chunkCount} |`);
    }
    reportLines.push("");

    reportLines.push("### Local Downloaded Files");
    if (entriesWithFiles.length === 0) {
      reportLines.push("(none)");
      reportLines.push("");
      continue;
    }

    reportLines.push("| localFileText | url | matchedDomains | age | filesize |");
    reportLines.push("| --- | --- | --- | --- | ---: |");
    for (const entry of entriesWithFiles) {
      const size = typeof entry.localFileTextSize === "number" ? entry.localFileTextSize : 0;
      totalFiles += 1;
      totalSize += size;
      const matchedDomains = entry.matchedDomainIds.length > 0 ? entry.matchedDomainIds.join(", ") : "(none)";
      reportLines.push(`| ${escapeMarkdownCell(entry.localFileText || "")} | ${escapeMarkdownCell(entry.url)} | ${escapeMarkdownCell(matchedDomains)} | ${formatAgeFromTimestamp(entry.timestamp)} | ${size} |`);
    }
    reportLines.push("");
  }

  reportLines.push("## Totals");
  reportLines.push("");
  reportLines.push(`- entitiesWithHistory: ${entitiesWithHistory}`);
  reportLines.push(`- localTextFiles: ${totalFiles}`);
  reportLines.push(`- totalTextSize: ${totalSize}`);
  reportLines.push(`- updatedSizeEntries: ${totalUpdatedSizes}${args.dryRun ? " (dry-run; history not saved)" : ""}`);
  reportLines.push("");

  await fs.ensureDir(path.dirname(reportPath));
  await fs.writeFile(reportPath, reportLines.join("\n"), "utf-8");
  console.log(`[LISTLOCAL] report written: ${reportPath}`);
}

async function runrescoreMode(storage: any, targets: Entity[], domains: Domain[], args: Args): Promise<void> {
  const domainsToUse = args.domain
    ? domains.filter((d) => (d.id || d.name) === args.domain)
    : domains;

  let totalChecked = 0;
  let totalrescoreed = 0;
  let totalUpdated = 0;

  for (const entity of targets) {
    const { historyMap, menuLinks } = await loadHistoryData(storage, entity.id);
    let entityUpdated = false;
    let consecutiveBotRejections = 0;

    const relatedEntries = Array.from(historyMap.entries()).filter(([, entry]) => entry.status === "related");
    console.log(`[rescore] ${entity.id}: ${relatedEntries.length} related entries`);

    for (const [normalizedUrl, entry] of relatedEntries) {
      totalChecked += 1;

      let plainText: string | undefined;
      let localFile: string | undefined = entry.localFile;
      let localFileText: string | undefined = entry.localFileText;
      let localFileTextSize: number | undefined = entry.localFileTextSize;
      let sizeUpdated = false;

      const hasLocal = localFile
        ? await fs.pathExists(fromRelativeDownloadsPath(storage, localFile))
        : false;

      if (!hasLocal) {
        // Re-download the page
        console.log(`[rescore] ${entry.url}: no local file, re-downloading`);
        const fetchResult = await fetchPageWithBotFallback(entry.url, consecutiveBotRejections, args.notbot);
        const fetched = fetchResult.fetched;
        consecutiveBotRejections = fetchResult.consecutiveBotRejections;
        if (!fetched.page) {
          console.log(`[rescore] ${entry.url}: fetch failed (${fetched.status}), skipping`);
          continue;
        }
        if (fetched.page.kind === "pdf") {
          console.log(`[rescore] ${entry.url}: PDF, skipping domain re-score`);
          continue;
        }
        const extracted = extractLinksAndText(entry.url, fetched.page.html || "");
        plainText = extracted.plainText;
        if (!args.dryRun) {
          const statusTimestamp = new Date().toISOString();
          const page: CrawledPage = {
            url: entry.url,
            depth: 0,
            title: extracted.title,
            headers: extracted.headers,
            htmlContent: fetched.page.html,
            plainText,
            textSample: extracted.sample,
            isPdf: false,
            links: extracted.links,
          };
          const saved = await saveCrawledArtifacts(storage, entity.id, page, statusTimestamp, {});
          if (saved.localFile) localFile = saved.localFile;
          if (saved.localFileText) {
            localFileText = saved.localFileText;
            localFileTextSize = await recordFileSize(storage, historyMap, {
              ...entry,
              ...(localFile ? { localFile } : {}),
              localFileText,
            });
            sizeUpdated = typeof localFileTextSize === "number" && localFileTextSize !== entry.localFileTextSize;
          }
        }
        totalrescoreed += 1;
      } else {
        // Read from existing local artifacts
        if (localFileText) {
          const txtPath = fromRelativeDownloadsPath(storage, localFileText);
          if (await fs.pathExists(txtPath)) {
            plainText = await fs.readFile(txtPath, "utf-8");
          }
        }
        if (!plainText && localFile) {
          const htmlPath = fromRelativeDownloadsPath(storage, localFile);
          const html = await fs.readFile(htmlPath, "utf-8");
          const extracted = extractLinksAndText(entry.url, html);
          plainText = extracted.plainText;
        }
      }

      if (!plainText) {
        console.log(`[rescore] ${entry.url}: no text available, skipping`);
        continue;
      }

      // Re-run domain scoring
      const page: CrawledPage = {
        url: entry.url,
        depth: 0,
        title: "",
        headers: [],
        plainText,
        textSample: plainText.slice(0, 3000),
        isPdf: false,
        links: [],
      };

      const scoredDomains = scoreDomainDetailed(domainsToUse, page, entity.governingBody);
      const matchedDomainIds = scoredDomains
        .filter((score) => isDomainScoreMatch(score))
        .map((score) => score.domainId)
        .slice(0, MAX_MATCHED_DOMAINS);

      const prevIds = (entry.matchedDomainIds || []).slice().sort().join(",");
      const newIds = matchedDomainIds.slice().sort().join(",");

      if (prevIds !== newIds) {
        console.log(`[rescore] ${entry.url}: matchedDomainIds [${prevIds || "none"}] -> [${newIds || "none"}]`);
        upsertHistoryEntry(historyMap, {
          ...entry,
          url: normalizedUrl,
          matchedDomainIds,
          ...(localFile ? { localFile } : {}),
          ...(localFileText ? { localFileText } : {}),
          ...(typeof localFileTextSize === "number" ? { localFileTextSize } : {}),
        });
        entityUpdated = true;
        totalUpdated += 1;
      } else if (sizeUpdated) {
        entityUpdated = true;
      }
    }

    if (entityUpdated && !args.dryRun) {
      await saveHistoryData(storage, entity.id, historyMap, menuLinks);
      console.log(`[rescore] ${entity.id}: history saved`);
    }
  }

  console.log(
    `[rescore] done. checked=${totalChecked} rescoreed=${totalrescoreed} updated=${totalUpdated}${args.dryRun ? " (dry-run)" : ""}`,
  );
}

type ReviewSummaryRow = { group: string; related: number; index: number; unrelated: number };

function buildReviewSummary(entries: SpiderDownloadRecord[], hubHostname: string): ReviewSummaryRow[] {
  const groups = new Map<string, ReviewSummaryRow>();
  for (const entry of entries) {
    let hostname = "";
    let firstDir = "";
    try {
      const parsed = new URL(entry.url);
      hostname = parsed.hostname.toLowerCase();
      firstDir = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
    } catch {
      continue;
    }
    const isHub = hubHostname && hostname === hubHostname;
    const group = isHub && firstDir ? `${hostname}/${firstDir}` : hostname;
    if (!groups.has(group)) groups.set(group, { group, related: 0, index: 0, unrelated: 0 });
    const row = groups.get(group)!;
    if (entry.status === "related") row.related++;
    else if (entry.status === "index") row.index++;
    else if (entry.status === "unrelated") row.unrelated++;
  }
  return Array.from(groups.values()).sort((a, b) => a.group.localeCompare(b.group));
}

function printReviewSummaryTable(rows: ReviewSummaryRow[]): void {
  if (rows.length === 0) return;
  const groupW = Math.max(30, ...rows.map((r) => r.group.length)) + 2;
  const cols = ["related", "index", "unrelated"] as const;
  const colW = 9;
  const sep = "-".repeat(groupW) + "+" + cols.map(() => "-".repeat(colW)).join("+");
  const header = "Group".padEnd(groupW) + "|" + cols.map((c) => c.padStart(colW - 1).padEnd(colW)).join("|");
  console.log(sep);
  console.log(header);
  console.log(sep);
  for (const row of rows) {
    const line = row.group.padEnd(groupW) + "|" +
      cols.map((c) => String(row[c]).padStart(colW - 1).padEnd(colW)).join("|");
    console.log(line);
  }
  const totals = { related: 0, index: 0, unrelated: 0 };
  for (const row of rows) { totals.related += row.related; totals.index += row.index; totals.unrelated += row.unrelated; }
  console.log(sep);
  const totalLine = "TOTAL".padEnd(groupW) + "|" +
    cols.map((c) => String(totals[c]).padStart(colW - 1).padEnd(colW)).join("|");
  console.log(totalLine);
  console.log(sep);
}

async function runReviewMode(storage: any, targets: Entity[], domains: Domain[], args: Args): Promise<void> {
  const rl = createInterface({ input, output });
  try {
    for (const entity of targets) {
      const { historyMap, menuLinks } = await loadHistoryData(storage, entity.id);

      const reviewable = Array.from(historyMap.values()).filter(
        (entry) =>
          (entry.localFile || entry.localFileText) &&
          (entry.status === "related" || entry.status === "unrelated" || entry.status === "index"),
      );

      if (reviewable.length === 0) {
        console.log(`[REVIEW] ${entity.id}: no reviewable entries`);
        continue;
      }

      const hubHostname = getLikelyHostname(normalizeUrl(getEntityLink(entity, "hub")) ?? "") ?? "";
      const allClassified = Array.from(historyMap.values()).filter(
        (e) => e.status === "related" || e.status === "index" || e.status === "unrelated",
      );
      console.log(`\n[REVIEW] ${entity.id}: ${reviewable.length} reviewable entries (${allClassified.length} total classified)`);
      printReviewSummaryTable(buildReviewSummary(allClassified, hubHostname));

      let changed = 0;
      let skipToNextEntity = false;
      let folderPrefix: string | null = null;
      let folderStatus: ReviewStatus | null = null;
      let folderDomains: string[] | null = null;

      for (const entry of reviewable) {
        if (skipToNextEntity) break;

        // Fast-forward: apply folder selection without prompting
        if (folderPrefix && entry.url.startsWith(folderPrefix) && folderStatus) {
          const currentStatus = toReviewStatusFromHistory(entry.status) ?? "unrelated";
          let newMatchedDomainIds: string[];
          let newStatus: ReviewStatus;

          if (folderDomains !== null) {
            // Fixed: apply the same status and domain set uniformly
            newMatchedDomainIds = folderDomains;
            newStatus = folderStatus;
          } else {
            // Auto: score each page individually; download if not cached
            let ff = await loadCachedPageFromHistory(storage, entry, 0);
            if (!ff) {
              console.log(`[REVIEW][FOLDER] downloading ${entry.url}...`);
              const { page: downloaded } = await fetchPageContent(entry.url);
              if (downloaded?.kind === "html" && downloaded.html) {
                const builtPage: CrawledPage = {
                  url: entry.url,
                  depth: 0,
                  title: entry.title ?? "",
                  htmlContent: downloaded.html,
                  plainText: "",
                  textSample: "",
                  isPdf: false,
                  links: [],
                };
                const timestamp = new Date().toISOString();
                const saved = await saveCrawledArtifacts(storage, entity.id, builtPage, timestamp);
                upsertHistoryEntry(historyMap, {
                  ...entry,
                  ...(saved.localFile ? { localFile: saved.localFile } : {}),
                  ...(saved.localFileText ? { localFileText: saved.localFileText } : {}),
                });
                ff = { page: builtPage, linkCandidates: [] };
              }
            }
            if (ff) {
              const ffScores = scoreDomainDetailed(domains, ff.page, entity.governingBody);
              const matched = ffScores.filter((s) => isDomainScoreMatch(s));
              newMatchedDomainIds = matched.map((s) => s.domainId);
              newStatus = newMatchedDomainIds.length > 0 ? "related" : currentStatus;
            } else {
              newMatchedDomainIds = entry.matchedDomainIds ?? [];
              newStatus = currentStatus;
            }
          }

          const statusChanged = newStatus !== currentStatus;
          const domainsChanged = JSON.stringify(newMatchedDomainIds.slice().sort()) !== JSON.stringify((entry.matchedDomainIds ?? []).slice().sort());
          if (statusChanged || domainsChanged) {
            upsertHistoryEntry(historyMap, { ...entry, status: newStatus, matchedDomainIds: newMatchedDomainIds });
            console.log(`[REVIEW][FOLDER] ${entry.url} -> ${newStatus} | domains: [${newMatchedDomainIds.join(", ")}]`);
            changed++;
          }
          continue;
        }

        const cached = await loadCachedPageFromHistory(storage, entry, 0);
        const currentStatus = toReviewStatusFromHistory(entry.status) ?? "unrelated";
        const style = getColorForStatus(currentStatus);
        const cacheTag = cached ? "[cached]" : "[no cache]";

        console.log(styleText("bold", `\n[REVIEW][PAGE] ${cacheTag} ${entry.url}`));

        if (!cached) {
          console.log(styleText(["bold", style] as any, `[REVIEW][STATUS] ${currentStatus}`) +
            ` | stored domains: ${entry.matchedDomainIds?.join(", ") || "(none)"}`);
          console.log("[REVIEW] No cached content — skipping domain scoring.");
          continue;
        }

        const scoredDomains = scoreDomainDetailed(domains, cached.page, entity.governingBody);
        const matchedScores = scoredDomains.filter((s) => isDomainScoreMatch(s));

        if (cached.page.title) console.log(`[REVIEW][TITLE] ${cached.page.title}`);
        console.log(styleText(["bold", style] as any, `[REVIEW][STATUS] ${currentStatus}`) +
          ` | stored domains: ${entry.matchedDomainIds?.join(", ") || "(none)"}`);
        if (cached.page.textSample) {
          console.log(`[REVIEW][EXCERPT] ${cached.page.textSample.slice(0, 300)}`);
        }
        if (matchedScores.length > 0) {
          console.log("[REVIEW][SCORED DOMAINS]");
          matchedScores.slice(0, 8).forEach((s, i) =>
            console.log(`  ${i + 1}. [${s.domainId}] ${s.displayName} | weighted=${s.weightedScore.toFixed(2)}`),
          );
        } else {
          console.log("[REVIEW][SCORED DOMAINS] none matched threshold");
        }

        let newStatus = currentStatus;
        let changeDomains = false;
        let applyToFolder = false;
        while (true) {
          const answer = await rl.question("Keep [Enter], R=related I=index D=unrelated C=change-domains F=apply-to-folder N=next-entity X=exit: ");
          const norm = answer.trim().toLowerCase();
          if (!norm) break;
          if (norm.startsWith("x")) return;
          if (norm.startsWith("n")) { skipToNextEntity = true; break; }
          if (norm.startsWith("r")) { newStatus = "related"; changeDomains = true; break; }
          if (norm.startsWith("i")) { newStatus = "index"; changeDomains = true; break; }
          if (norm.startsWith("d") || norm.startsWith("u")) { newStatus = "unrelated"; break; }
          if (norm.startsWith("c")) { changeDomains = true; break; }
          if (norm.startsWith("f")) { applyToFolder = true; changeDomains = true; break; }
          console.log(`Unrecognized input '${answer.trim()}'`);
        }
        if (skipToNextEntity) break;

        let newMatchedDomainIds: string[] = entry.matchedDomainIds ?? [];

        if (changeDomains) {
          const domainChoices = matchedScores.length > 0 ? matchedScores : scoredDomains.slice(0, 10);
          if (domainChoices.length > 0) {
            console.log("[REVIEW] Select domains (comma-separated numbers, A=all matched, Enter=keep current):");
            domainChoices.forEach((s, i) => {
              const isCurrent = newMatchedDomainIds.includes(s.domainId);
              console.log(`  ${i + 1}. ${s.displayName} [${s.domainId}]${isCurrent ? " *" : ""}`);
            });
            const domainAnswer = await rl.question("Domains: ");
            const trimmed = domainAnswer.trim();
            if (trimmed.toLowerCase() === "a") {
              newMatchedDomainIds = matchedScores.map((s) => s.domainId);
            } else if (trimmed) {
              const indices = trimmed
                .split(",")
                .map((s) => parseInt(s.trim(), 10) - 1)
                .filter((i) => i >= 0 && i < domainChoices.length);
              newMatchedDomainIds = indices.map((i) => domainChoices[i].domainId);
            }
            // If domains were selected via C/F, promote status to "related"
            if (newMatchedDomainIds.length > 0 && newStatus !== "related" && newStatus !== "index") {
              newStatus = "related";
            }
          }
        } else if (newStatus === "unrelated") {
          newMatchedDomainIds = [];
        }

        if (applyToFolder) {
          folderPrefix = entry.url.substring(0, entry.url.lastIndexOf("/") + 1);
          folderStatus = newStatus;
          // null = auto-score each entry; fixed array = apply same domains to all
          const domainSelectionMade = newMatchedDomainIds.join(",") !== (entry.matchedDomainIds ?? []).join(",");
          folderDomains = domainSelectionMade ? newMatchedDomainIds : null;
          const domainsDesc = folderDomains ? `[${folderDomains.join(", ")}]` : "(auto-scored per page)";
          console.log(`[REVIEW][FOLDER] Fast-forward enabled for: ${folderPrefix} -> ${folderStatus} | domains: ${domainsDesc}`);
        }

        const statusChanged = newStatus !== currentStatus;
        const domainsChanged = JSON.stringify(newMatchedDomainIds.slice().sort()) !== JSON.stringify((entry.matchedDomainIds ?? []).slice().sort());
        if (statusChanged || domainsChanged) {
          upsertHistoryEntry(historyMap, { ...entry, status: newStatus, matchedDomainIds: newMatchedDomainIds });
          console.log(`[REVIEW] ${currentStatus} -> ${newStatus} | domains: [${newMatchedDomainIds.join(", ")}]`);
          changed++;
        }
      }

      if (changed > 0) {
        if (!args.dryRun) {
          await saveHistoryData(storage, entity.id, historyMap, menuLinks);
          console.log(`[REVIEW] ${entity.id}: saved ${changed} change(s)`);
        } else {
          console.log(`[REVIEW] ${entity.id}: ${changed} change(s) (dry-run, not saved)`);
        }
      } else {
        console.log(`[REVIEW] ${entity.id}: no changes`);
      }
    }
  } finally {
    rl.close();
  }
}

async function runCleanupMode(storage: any, targets: Entity[], args: Args): Promise<void> {
  let totalScanned = 0;
  let totalFilesDeleted = 0;
  let totalEntriesUpdated = 0;
  let totalMenuLinksAdded = 0;
  let totalMenuLinksReduced = 0;
  let totalMenuWildcardsCreated = 0;
  const relatedWithoutDomainsGlobal: Array<{ entityId: string; url: string }> = [];

  for (const entity of targets) {
    const historyPath = getHistoryFilePath(storage, entity.id);
    if (!(await fs.pathExists(historyPath))) {
      continue;
    }

    const { historyMap, menuLinks } = await loadHistoryData(storage, entity.id);
    const menuLinkUrls = new Set(menuLinks.urls.map((url) => normalizeUrlForMatch(url)));
    const wildcardMenuPrefixes = new Set<string>();
    for (const url of menuLinkUrls) {
      if (url.endsWith("*")) {
        wildcardMenuPrefixes.add(url.slice(0, -1));
      }
    }

    const isRootUrl = (url: string): boolean => {
      try {
        const parsed = new URL(url);
        return parsed.pathname === "/" || parsed.pathname === "";
      } catch {
        return false;
      }
    };

    const matchesWildcardMenuPrefix = (url: string): boolean => {
      if (isRootUrl(url)) {
        return false;
      }
      for (const prefix of wildcardMenuPrefixes) {
        if (url.startsWith(prefix)) {
          return true;
        }
      }
      return false;
    };

    const relatedUrls = new Set<string>(
      Array.from(historyMap.entries())
        .filter(([, entry]) => entry.status === "related")
        .map(([url]) => normalizeUrlForMatch(url)),
    );

    let menuLinksChanged = false;

    // Auto-promote menu link prefixes to wildcard when there are no related pages
    // under that prefix (excluding root URLs).
    let createdWildcardsHere = 0;
    const explicitMenuLinks = Array.from(menuLinkUrls).filter((url) => !url.endsWith("*"));
    for (const baseUrl of explicitMenuLinks) {
      if (isRootUrl(baseUrl)) {
        continue;
      }
      const hasDescendantMenuLink = explicitMenuLinks.some((candidate) => candidate !== baseUrl && candidate.startsWith(`${baseUrl}/`));
      if (!hasDescendantMenuLink) {
        continue;
      }

      const hasRelatedUnderPrefix = Array.from(relatedUrls).some((relatedUrl) => relatedUrl.startsWith(baseUrl));
      if (hasRelatedUnderPrefix) {
        continue;
      }

      const wildcardUrl = `${baseUrl}*`;
      if (!menuLinkUrls.has(wildcardUrl)) {
        if (!args.dryRun) {
          menuLinkUrls.add(wildcardUrl);
          wildcardMenuPrefixes.add(baseUrl);
          menuLinksChanged = true;
        }
        createdWildcardsHere += 1;
      }
    }
    totalMenuWildcardsCreated += createdWildcardsHere;
    if (createdWildcardsHere > 0) {
      console.log(`[CLEANUP]${args.dryRun ? "[DRY-RUN]" : ""} created ${createdWildcardsHere} wildcard menu link(s) for ${entity.id}`);
    }

    // Compact explicit menu links that are already covered by wildcard entries,
    // but never reduce root URLs.
    if (wildcardMenuPrefixes.size > 0) {
      let reducedHere = 0;
      for (const url of Array.from(menuLinkUrls)) {
        if (url.endsWith("*")) {
          continue;
        }
        if (matchesWildcardMenuPrefix(url)) {
          if (!args.dryRun) {
            menuLinkUrls.delete(url);
            menuLinksChanged = true;
          }
          reducedHere += 1;
        }
      }
      totalMenuLinksReduced += reducedHere;
      if (reducedHere > 0) {
        console.log(`[CLEANUP]${args.dryRun ? "[DRY-RUN]" : ""} reduced ${reducedHere} menu link(s) using wildcard entries for ${entity.id}`);
      }
    }

    const relatedWithoutDomainsEntity: string[] = [];
    const allowedCleanupHosts = new Set<string>((["main", "governing", "hub"] as const)
      .map((t) => normalizeUrl(getEntityLink(entity, t)))
      .filter((value): value is string => Boolean(value))
      .map((url) => getLikelyHostname(url)));

    let entityUpdated = false;

    const removeHistoryEntryAndArtifacts = async (
      url: string,
      entry: SpiderDownloadRecord,
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

      if (menuLinkUrls.has(normalizedUrl) || matchesWildcardMenuPrefix(normalizedUrl)) {
        await removeHistoryEntryAndArtifacts(url, entry, "menu link");
        continue;
      }

      if (entry.status === "related" && (!entry.matchedDomainIds || entry.matchedDomainIds.length === 0)) {
        relatedWithoutDomainsEntity.push(normalizedUrl);
      }

      if (entry.status !== "unrelated") {
        continue;
      }

      if (!menuLinkUrls.has(normalizedUrl)) {
        if (!args.dryRun) {
          menuLinkUrls.add(normalizedUrl);
          menuLinksChanged = true;
        }
        totalMenuLinksAdded += 1;
        console.log(`[CLEANUP]${args.dryRun ? "[DRY-RUN]" : ""} moved unrelated URL to menuLinks: ${normalizedUrl}`);
      }

      await removeHistoryEntryAndArtifacts(url, entry, "unrelated -> menuLinks");
    }

    if (relatedWithoutDomainsEntity.length > 0) {
      relatedWithoutDomainsGlobal.push(...relatedWithoutDomainsEntity.map((url) => ({ entityId: entity.id, url })));
      console.log(`[CLEANUP] ${entity.id}: related entries without matchedDomainIds (${relatedWithoutDomainsEntity.length})`);
      for (const url of relatedWithoutDomainsEntity) {
        console.log(`  [CLEANUP][RELATED-WITHOUT-DOMAINS] ${url}`);
      }
    }

    if ((entityUpdated || menuLinksChanged) && !args.dryRun) {
      menuLinks.urls = Array.from(menuLinkUrls);
      menuLinks.timestamp = new Date().toISOString();
      await saveHistoryData(storage, entity.id, historyMap, menuLinks);
      console.log(`[CLEANUP] saved updated history for ${entity.id}`);
    }
  }

  if (relatedWithoutDomainsGlobal.length > 0) {
    console.log(`[CLEANUP] related entries without matchedDomainIds (global: ${relatedWithoutDomainsGlobal.length})`);
    for (const item of relatedWithoutDomainsGlobal) {
      console.log(`  [CLEANUP][RELATED-WITHOUT-DOMAINS] ${item.entityId} ${item.url}`);
    }
  }

  console.log(
    `[CLEANUP] done. scanned=${totalScanned} filesDeleted=${totalFilesDeleted} entriesUpdated=${totalEntriesUpdated} menuLinksAdded=${totalMenuLinksAdded} menuLinksReduced=${totalMenuLinksReduced} menuWildcardsCreated=${totalMenuWildcardsCreated}${args.dryRun ? " (dry-run)" : ""}`,
  );
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

/**
 * Discovers and caches site structure for a single entity.
 *
 * Fetches the HTML for each seed URL (main/hub/governing/authority), picks one secondary
 * page linked from the main homepage, then runs menu-link discovery across those pages.
 * If a content selector (CSS selector isolating the main content area) can be inferred by
 * diffing the secondary page against the primary, it is written to the websites file keyed
 * by hostname. Discovered menu links are merged into the persisted menuLinks list.
 * History data and the websites file are saved before returning a summary of what was found.
 *
 * Does NOT re-score or re-evaluate existing history records against domains.
 */
async function runScanForEntity(storage: any, entity: Entity, domains: Domain[], args: Args): Promise<ScanSummary> {
  await ensureEntityHistoryLayout(storage, entity.id);
  const { historyMap, menuLinks } = await loadHistoryData(storage, entity.id);
  const websitesFile = await loadWebsitesFile(storage, entity.id);

  const seedUrls = Array.from(new Set(
    (["main", "hub", "governing", "authority"] as const)
      .map((t) => normalizeUrl(getEntityLink(entity, t)))
      .filter((value): value is string => Boolean(value))
  ));

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
  const normalizedMainUrl = normalizeUrl(getEntityLink(entity, "main"));
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

  const hasMainAndGoverning = Boolean(normalizeUrl(getEntityLink(entity, "main")) && normalizeUrl(getEntityLink(entity, "governing")));
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
    const primaryUrl = (["main", "governing", "hub", "authority"] as const)
      .map((t) => normalizeUrl(getEntityLink(entity, t)))
      .find(Boolean);
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

async function runGenerateSummaryMode(storage: any, targets: Entity[]): Promise<void> {
  const summaryPath = path.join(storage.getRealmDir(), "downloadSummary.json");
  const summary = [] as Array<{
    id: string;
    name: string;
    displayName: string;
    linkedResources: Array<{
      url: string;
      title: string;
      matchedDomainIds: string[];
      timestamp: string;
    }>;
  }>;

  for (const entity of targets) {
    const historyPath = getHistoryFilePath(storage, entity.id);
    if (!(await fs.pathExists(historyPath))) {
      summary.push({
        id: entity.id,
        name: entity.name || entity.id,
        displayName: entity.displayName || entity.name || entity.id,
        linkedResources: [],
      });
      continue;
    }

    const { historyMap } = await loadHistoryData(storage, entity.id);
    const linkedResources: Array<{
      url: string;
      title: string;
      matchedDomainIds: string[];
      timestamp: string;
    }> = [];

    const records = Array.from(historyMap.values())
      .filter((entry) => Boolean(entry.localFile || entry.localFileText))
      .sort((a, b) => a.url.localeCompare(b.url));

    for (const entry of records) {
      const resolvedTitle = (entry.title && entry.title !== entry.url) ? entry.title : await extractDocumentTitleWithCache(storage, historyMap, entry.url);
      linkedResources.push({
        url: entry.url,
        title: resolvedTitle,
        matchedDomainIds: Array.isArray(entry.matchedDomainIds) ? entry.matchedDomainIds : [],
        timestamp: entry.timestamp,
      });
    }

    summary.push({
      id: entity.id,
      name: entity.name || entity.id,
      displayName: entity.displayName || entity.name || entity.id,
      linkedResources,
    });
  }

  await fs.writeJson(summaryPath, summary, { spaces: 2 });
  console.log(`[SUMMARY] wrote ${summaryPath} with ${summary.length} entities`);
}

async function runFixMode(storage: any, targets: Entity[], fixOp: string, args: Args): Promise<void> {
  const SUPPORTED_OPS = ["domain-to-related"];
  if (!SUPPORTED_OPS.includes(fixOp)) {
    throw new Error(`Unknown --fix operation: "${fixOp}". Supported: ${SUPPORTED_OPS.join(", ")}`);
  }

  let totalChanged = 0;

  for (const entity of targets) {
    const { historyMap, menuLinks } = await loadHistoryData(storage, entity.id);
    let entityChanged = 0;

    for (const [url, entry] of historyMap) {
      if (fixOp === "domain-to-related") {
        const hasDomains = Array.isArray(entry.matchedDomainIds) && entry.matchedDomainIds.length > 0;
        if (hasDomains && entry.status !== "related") {
          console.log(`[FIX] ${entity.id} | ${entry.status} -> related | domains: [${entry.matchedDomainIds!.join(", ")}] | ${url}`);
          if (!args.dryRun) {
            historyMap.set(url, { ...entry, status: "related" });
          }
          entityChanged++;
        }
      }
    }

    if (entityChanged > 0 && !args.dryRun) {
      await saveHistoryData(storage, entity.id, historyMap, menuLinks);
      console.log(`[FIX] ${entity.id}: ${entityChanged} record(s) updated`);
    } else if (entityChanged > 0 && args.dryRun) {
      console.log(`[FIX] ${entity.id}: ${entityChanged} record(s) would be updated (dry-run)`);
    }

    totalChanged += entityChanged;
  }

  console.log(`\n[FIX] Done. ${totalChanged} record(s) ${args.dryRun ? "would be" : ""} updated across ${targets.length} entity/entities.`);
}

function printHelp(): void {
  console.log(`
spiderEntityWebsites — crawl municipal entity websites and classify pages by domain

Usage:
  tsx spiderEntityWebsites.ts [options] --entity <id> | --all | --specimenUrlsFile <path>

Target selection (required unless using a utility mode):
  --entity <id>               Crawl a single entity by ID
  --all                       Crawl all entities in the realm
  --specimenUrlsFile <path>   Crawl URLs listed in a JSON file

Common options:
  --realm <realm-id>          Realm to use (or set CURRENT_REALM env var)
  --data-root <path>          Path to the data root (or set DATA_ROOT env var)
  --domain <id>               Restrict scoring/classification to one domain
  --dry-run                   Skip writing any files
  --verbose, -v               Extra logging
  --help, -h                  Show this help message and exit

Crawl control:
  --max-depth <n>             Maximum crawl depth, 1–3 (default: 2)
  --max-pages <n>             Total page cap across all sources (default: 3× per-source limit)
  --max-pages-per-source <n>  Page cap per seed source (default: varies)
  --concurrency <n>           Parallel fetch concurrency, 1–20 (default: 3)
  --recrawl-days <n>          Re-fetch pages older than N days (default: varies)
  --seed-url <type|url>       Restrict crawl to one seed — named type (mainUrl, hubUrl,
                              governingUrl, authorityUrl) or a direct URL
  --force                     Force re-crawl even if recently visited
  --rescore                   Re-fetch and re-score all known pages
  --nodownload                Score existing cached pages without fetching new ones
  --notbot                    Use a generic User-Agent (avoids bot detection)

Interactive / review:
  --interactive               Prompt for domain confirmation per page
  --interactive-honor-history Skip pages that already have a definitive status
  --review                    Show a summary table of crawled pages and review interactively

Utility modes (no crawling):
  --scan, --nospider          Re-score already-downloaded pages without fetching
  --cleanup                   Remove orphaned download artifacts
  --rewriteText               Re-generate .txt artifacts from cached HTML
  --listlocal                 List locally downloaded files for each entity
  --report-related-without-domains  Report related pages that have no matched domains
  --generateSummary           Write a summary JSON across all entities
  --fix <operation>           Apply a batch fix to history records (use with --dry-run first)
                                domain-to-related  Set status to "related" for any record
                                                   that has matched domains but isn't already related
`);
}

export async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  const args = parseArgs(process.argv.slice(2));
  const dataRoot = resolveDataRoot(args.dataRoot);
  process.env.DATA_ROOT = dataRoot;
  const { getDefaultStorage } = await import("@civillyengaged/ordinizer-servercore");
  const storage = getDefaultStorage(args.realm);

  await ensureEntityDownloadsLayout(storage);
  console.log(`Entity downloads root: ${getEntityDownloadsRoot(storage)}`);
  console.log(`using USER-AGENT: ${args.notbot ? GENERIC_USER_AGENT : USER_AGENT}`);
  console.log(`bot rejection fallback USER-AGENT: ${GENERIC_USER_AGENT}`);
  if (args.notbot) {
    console.log("notbot mode enabled: forcing generic USER-AGENT for fetches");
  }

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

  if (args.reportRelatedWithoutDomains) {
    await runRelatedWithoutDomainsReport(storage, targets);
    return;
  }

  if (args.listLocal) {
    await runListLocalMode(storage, targets, args, domains, realm);
    return;
  }

  if (args.rescore) {
    await runrescoreMode(storage, targets, domains, args);
    return;
  }

  if (args.review) {
    await runReviewMode(storage, targets, domains, args);
    return;
  }

  if (args.fix) {
    await runFixMode(storage, targets, args.fix, args);
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

  if (args.generateSummary) {
    await runGenerateSummaryMode(storage, targets);
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
      await Promise.all(batch.map((entity) => spiderEntity(entity, domains, realm, args, storage, interactiveRl)));
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
