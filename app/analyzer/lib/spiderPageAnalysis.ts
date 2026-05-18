/**
 * Page-analysis utilities for the spider.
 *
 * Contains menu-link discovery and content-selector discovery/extraction.
 */

import { styleText } from "node:util";
import fs from "fs-extra";
import { JSDOM } from "jsdom";
import { Entity, Domain } from "@civillyengaged/ordinizer-core";
import { isDomainScoreMatch, scoreDomainDetailed } from "./domainScoring.js";
import type { SpiderDownloadRecord } from "./spiderHistory.js";
import type { HistoryStatus } from "./spiderHistory.js";
import type { CrawledPage, ExtractedLink } from "./domainScoring.js";
import {
  normalizeUrl,
  normalizeUrlForMatch,
  fromRelativeDownloadsPath,
  loadCachedPageFromHistory,
  extractLinksAndText,
  extractDocumentTitleWithCache,
  fetchPageContent,
  saveCrawledArtifacts,
  upsertHistoryEntry,
} from "./spiderHistory.js";
import { getLikelyHostname } from "./spiderBoilerplate.js";
import { convertHtmlToTextSimple } from "./simpleHtmlToText.js";
import { title } from "node:process";

export const SKIP_URL_PATTERN = /(calendar|account|alert|login|directory|mailto|instagra|search|profile|contact|png|jpg|jpeg|gif|bmp|svg|webp)/i;

const MENU_LINK_REDETERMINE_DAYS = 7;

export function shouldRedetermineMenuLinks(menuLinks: { timestamp?: string }): boolean {
  if (!menuLinks.timestamp) {
    return true;
  }
  const parsed = Date.parse(menuLinks.timestamp);
  if (!Number.isFinite(parsed)) {
    return true;
  }
  const ageMs = Date.now() - parsed;
  const cutoffMs = MENU_LINK_REDETERMINE_DAYS * 24 * 60 * 60 * 1000;
  return ageMs >= 0 && ageMs <= cutoffMs;
}

/**
 * Jaccard similarity between word-token sets of two strings.
 * Returns 0 (completely different) to 1 (identical).
 */
function computeJaccardSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(s.toLowerCase().split(/\s+/).filter((t) => t.length > 3));
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection += 1;
  }
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Ordered list of CSS selectors to probe as "main content" candidates.
 */
const CONTENT_SELECTOR_CANDIDATES = [
  "[data-cprole='mainContentContainer']",
  "#moduleContent",
  "#moduleContent #page",
  "#page.moduleContentNew",
  "main",
  "[role='main']",
  "#content",
  "#main-content",
  "#page-content",
  "#main",
  ".content",
  ".main-content",
  ".normal_content_area",
  ".page-content",
  ".entry-content",
  "article",
  "#maincontent",
  "#ContentPlaceHolder1_UpdatePanel1",
] as const;

const COMMENT_CONTENT_AREA_SELECTOR = "__comment_content_area__";

function findCommentContentAreaBounds(html: string): { start: number; end: number } | null {
  if (!html) return null;

  // Matches markers like:
  // <!--Center Content Area Starts-->
  // <!--/Center Content Area Starts-->
  const startRegex = /<!--\s*\/?\s*[\w-]*\s*Content Area Starts?\s*-->/ig;
  const endRegex = /<!--\s*\/?\s*[\w-]*\s*Content Area Ends?\s*-->/ig;

  const startMatch = startRegex.exec(html);
  if (!startMatch) return null;

  endRegex.lastIndex = startRegex.lastIndex;
  const endMatch = endRegex.exec(html);
  if (!endMatch) return null;
  if (endMatch.index <= startRegex.lastIndex) return null;

  return { start: startRegex.lastIndex, end: endMatch.index };
}

function extractContentAreaByComments(html: string): string | null {
  const bounds = findCommentContentAreaBounds(html);
  if (!bounds) return null;

  const between = html.slice(bounds.start, bounds.end).trim();
  if (!between) return null;
  return between;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function looksLikeHeaderOnlyContent(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return true;
  if (normalized.length >= 220) return false;

  const lower = normalized.toLowerCase();
  const breadcrumbSignals = /(you are here|breadcrumb|home\s*[>/]|\s>\s|\s\|\s)/i.test(normalized);
  const navSignals = /(government|departments?|services|residents|business|how do i)/i.test(lower);
  const shortText = normalized.length < 160;
  return shortText && (breadcrumbSignals || navSignals);
}

function getElementTextForSelectorEvaluation(el: Element): string {
  let evaluationRoot: Element = el;
  try {
    const cloned = el.cloneNode(true) as Element;
    cloned.querySelectorAll("script, style, noscript, template").forEach((node) => node.remove());
    evaluationRoot = cloned;
  } catch {
    evaluationRoot = el;
  }

  const mainText = normalizeText(evaluationRoot.textContent || "");
  if (!looksLikeHeaderOnlyContent(mainText)) {
    return mainText;
  }

  const sibling = el.nextElementSibling;
  if (!sibling) {
    return mainText;
  }

  const siblingText = normalizeText(sibling.textContent || "");
  if (siblingText.length < 180) {
    return mainText;
  }

  return normalizeText(`${mainText}\n${siblingText}`);
}

function logSelectorDebug(message: string): void {
  if (process.env.SPIDER_SELECTOR_DEBUG === "1") {
    console.log(`[SELECTOR][DEBUG] ${message}`);
  }
}

type LocalityEntityContext = Pick<Entity, "name" | "type" | "state" | "displayName">;

const US_STATE_ABBREVIATIONS = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
]);

const US_STATE_NAMES = new Set([
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming", "district of columbia",
]);

function looksLikeLocalityPart(part: string, entity?: Partial<LocalityEntityContext>): boolean {
  const normalized = normalizeText(part);
  if (!normalized) return false;

  if (entity) {
    const partLower = normalized.toLowerCase();
    const entityName = normalizeText(entity.name || entity.displayName || "").toLowerCase();
    const entityType = normalizeText(entity.type || "").toLowerCase();
    const stateRaw = normalizeText(entity.state || "");
    const stateLower = stateRaw.toLowerCase();
    const stateAbbrevLower = stateRaw.replace(/\./g, "").toLowerCase();

    const hasEntityName = Boolean(entityName) && partLower.includes(entityName);
    const hasEntityType = Boolean(entityType) && partLower.includes(entityType);
    const hasState = Boolean(stateRaw)
      && (
        partLower.includes(`, ${stateLower}`)
        || partLower.endsWith(` ${stateLower}`)
        || partLower.endsWith(` ${stateAbbrevLower}`)
      );

    if (entityName && partLower === entityName) {
      return true;
    }
    if (hasEntityName && (hasEntityType || hasState)) {
      return true;
    }
  }

  const stateOnlyToken = normalized.replace(/\./g, "").toUpperCase();
  if (US_STATE_ABBREVIATIONS.has(stateOnlyToken)) {
    return true;
  }

  if (US_STATE_NAMES.has(normalized.toLowerCase())) {
    return true;
  }

  const cityStateAbbrev = /^([A-Za-z .'-]+),\s*([A-Za-z.]{2,})$/;
  const cityStateName = /^([A-Za-z .'-]+),\s*([A-Za-z .'-]{4,})$/;

  const abbrevMatch = normalized.match(cityStateAbbrev);
  if (abbrevMatch) {
    const stateToken = abbrevMatch[2].replace(/\./g, "").toUpperCase();
    if (US_STATE_ABBREVIATIONS.has(stateToken)) {
      return true;
    }
  }

  const nameMatch = normalized.match(cityStateName);
  if (nameMatch) {
    const stateName = normalizeText(nameMatch[2]).toLowerCase();
    if (US_STATE_NAMES.has(stateName)) {
      return true;
    }
  }

  return false;
}

function pruneLocalitySuffix(value: string): string {
  let pruned = normalizeText(value);
  const localitySuffix = /,\s*([A-Za-z. ]{2,})$/;
  const match = pruned.match(localitySuffix);
  if (!match) {
    return pruned;
  }

  const stateTokenRaw = normalizeText(match[1]);
  const stateTokenUpper = stateTokenRaw.replace(/\./g, "").toUpperCase();
  const stateTokenLower = stateTokenRaw.toLowerCase();
  if (US_STATE_ABBREVIATIONS.has(stateTokenUpper) || US_STATE_NAMES.has(stateTokenLower)) {
    pruned = pruned.slice(0, match.index).trim();
  }
  return pruned;
}

function extractTitleNeedle(rawTitle: string, entity?: Partial<LocalityEntityContext>): string | null {
  const normalized = normalizeText(rawTitle);
  if (!normalized) return null;

  const parts = normalized
    .split(/\s\|\s|\s-\s|,\s/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4);

  if (parts.length === 0) {
    const pruned = pruneLocalitySuffix(normalized);
    return pruned.length >= 4 ? pruned.toLowerCase() : null;
  }

  const nonLocalityPart = parts.find((part) => !looksLikeLocalityPart(part, entity));
  const candidate = pruneLocalitySuffix(nonLocalityPart || parts[0]);
  return candidate.length >= 4 ? candidate.toLowerCase() : null;
}

function titleAppearsNearStart(text: string, titleNeedle: string): boolean {
  const idx = text.toLowerCase().indexOf(titleNeedle);
  return idx >= 0 && idx <= 320;
}

function selectorLooksMainLike(selector: string): boolean {
  const lower = selector.toLowerCase();
  return /(^|\s|>)main([.#:>\s]|$)|#main\b|freeform-main|#entry\b|#post\b|main-content|page-content|\bcontent\b/.test(lower);
}

function titleAcceptablePlacement(text: string, titleNeedle: string, selector: string): boolean {
  const idx = text.toLowerCase().indexOf(titleNeedle);
  if (idx < 0) return false;
  if (idx <= 320) return true;
  if (selectorLooksMainLike(selector) && idx <= 3000) return true;
  return false;
}

function escapeCssIdent(value: string): string {
  return value.replace(/([ #;?%&,.+*~':"!^$[\]()=>|/@])/g, "\\$1");
}

function getNthOfTypeIndex(el: Element): number {
  let index = 1;
  let prev = el.previousElementSibling;
  const ownTag = (el.tagName || "").toLowerCase();
  while (prev) {
    if ((prev.tagName || "").toLowerCase() === ownTag) {
      index += 1;
    }
    prev = prev.previousElementSibling;
  }
  return index;
}

function buildStructuralSelector(el: Element): string | null {
  const parts: string[] = [];
  let current: Element | null = el;
  let safety = 0;

  while (current && safety < 8) {
    safety += 1;

    const id = current.getAttribute?.("id");
    if (id && id.trim()) {
      parts.unshift(`#${escapeCssIdent(id.trim())}`);
      break;
    }

    const tagName = (current.tagName || "").toLowerCase();
    if (!tagName) {
      return null;
    }

    const classAttr = normalizeText(current.getAttribute?.("class") || "");
    const firstClass = classAttr.split(/\s+/).filter(Boolean)[0];
    if (firstClass) {
      parts.unshift(`${tagName}.${escapeCssIdent(firstClass)}`);
    } else {
      parts.unshift(`${tagName}:nth-of-type(${getNthOfTypeIndex(current)})`);
    }

    const parent: HTMLElement | null = current.parentElement;
    if (!parent) {
      break;
    }
    const parentTag = (parent.tagName || "").toLowerCase();
    if (parentTag === "body" || parentTag === "html") {
      break;
    }
    current = parent;
  }

  if (parts.length === 0) {
    return null;
  }

  const selector = parts.join(" > ");
  try {
    const resolved = el.ownerDocument?.querySelector(selector);
    if (resolved === el) {
      return selector;
    }
  } catch {
    return null;
  }
  return null;
}

function buildElementSelector(el: Element): string | null {
  const id = el.getAttribute("id");
  if (id && id.trim()) {
    return `#${escapeCssIdent(id.trim())}`;
  }
  const cprole = el.getAttribute("data-cprole");
  if (cprole && cprole.trim()) {
    return `[data-cprole='${cprole.trim().replace(/'/g, "\\'")}']`;
  }
  return buildStructuralSelector(el);
}

function scoreSelectorShape(selector: string): number {
  const lower = selector.toLowerCase();
  let score = 0;

  if (selector === "#moduleContent") score += 5;
  if (selector === "#page") score += 4;
  if (selector.includes("mainContentContainer")) score += 4;
  if (selector.startsWith("#")) score += 2;

  if (/(^|\s|>)main([.#:>\s]|$)/.test(lower)) score += 8;
  if (/(^|\s|>)[^>]*\b(content|freeform|entry|page-content|main-content)\b/.test(lower)) score += 4;
  if (/(^|\s|>)article([.#:>\s]|$)|(^|\s|>)section([.#:>\s]|$)/.test(lower)) score += 2;

  if (/(^|\s|>)header([.#:>\s]|$)|(^|\s|>)nav([.#:>\s]|$)/.test(lower)) score -= 12;
  if (/breadcrumbs?|breadcrumb|menu|translation|social|footer/.test(lower)) score -= 8;

  return score;
}

function getDocumentTitleNeedle(dom: JSDOM, entity?: Partial<LocalityEntityContext>): string | null {
  const doc = dom.window.document;
  const titleCandidates: string[] = [];

  if (doc.title) {
    titleCandidates.push(doc.title);
  }

  const pageMenuTitle = doc.querySelector("#pageMenuTitle")?.getAttribute("value");
  if (pageMenuTitle) {
    titleCandidates.push(pageMenuTitle);
  }

  const headline = normalizeText(doc.querySelector("#versionHeadLine")?.textContent || "");
  if (headline) {
    titleCandidates.push(headline);
  }

  for (const candidate of titleCandidates) {
    const needle = extractTitleNeedle(candidate, entity);
    if (needle) return needle;
  }

  return null;
}

function discoverSelectorFromTitle(pageDom: JSDOM, titleNeedle: string): string | undefined {
  const pageDoc = pageDom.window.document;

  const candidates = Array.from(pageDoc.querySelectorAll("[id], [data-cprole], main, article, section"));

  const ranked: Array<{ selector: string; score: number }> = [];

  for (const el of candidates) {
    const selector = buildElementSelector(el);
    if (!selector) continue;

    const mainText = getElementTextForSelectorEvaluation(el);
    if (mainText.length < 120) continue;
    if (!titleAcceptablePlacement(mainText, titleNeedle, selector)) continue;

    let score = 0;
    score += scoreSelectorShape(selector);

    const titleIndex = mainText.toLowerCase().indexOf(titleNeedle);
    score += Math.max(0, 300 - Math.max(0, titleIndex));

    ranked.push({ selector, score });

    const parent = el.parentElement;
    if (parent) {
      const parentSelector = buildElementSelector(parent);
      if (parentSelector) {
        const mainParentText = normalizeText(parent.textContent || "");
        if (
          mainParentText.length >= 120
          && titleAcceptablePlacement(mainParentText, titleNeedle, parentSelector)
        ) {
          let parentScore = score + 3;
          parentScore += scoreSelectorShape(parentSelector) - scoreSelectorShape(selector);
          ranked.push({ selector: parentSelector, score: parentScore });
        } else if (titleAcceptablePlacement(mainParentText, titleNeedle, parentSelector)) {
          // if parent text is short consider the sibling relationship as a potential signal (e.g. title in header block, content in sibling block)
          let parentScore = score + 1;
          // find the sibling of the parent
          const sibling = parent.nextElementSibling;
          if (sibling) {
            const siblingText = normalizeText(sibling.textContent || "");
            if (siblingText.length >= 120) {
              const siblingSelector = buildElementSelector(sibling);
              if (siblingSelector) {
                ranked.push({ selector: siblingSelector, score: parentScore + scoreSelectorShape(siblingSelector) });
              }
            }
          }
        }
      }
    }
  }

  ranked.sort((a, b) => b.score - a.score || a.selector.localeCompare(b.selector));
  return ranked[0]?.selector;
}

/**
 * Compare two HTML pages to discover a CSS selector that identifies the main content block.
 *
 * Primary strategy: low cross-page similarity (page-specific content).
 * Fallback strategy: if no selector passes primary checks, prefer selectors where the page
 * title appears near the start of the content (common content-body signal).
 */
export function discoverContentSelector(
  entity: Partial<LocalityEntityContext> | undefined,
  specimenHtml: string,
  specimenUrl: string,
  homePageHtml?: string,
  homePageUrl?: string,
): string | undefined {
  let homePageDom: JSDOM | undefined;
  let specimenDom: JSDOM;
  if (!specimenHtml || !specimenUrl) {
    return undefined;
  }
  try {
    specimenDom = new JSDOM(specimenHtml, { url: specimenUrl });
    logSelectorDebug(`Spec DOM: title="${specimenDom.window.document.title}" #moduleContent=${!!specimenDom.window.document.querySelector("#moduleContent")} #page=${!!specimenDom.window.document.querySelector("#page")} [data-cprole='mainContentContainer']=${!!specimenDom.window.document.querySelector("[data-cprole='mainContentContainer']")} bodyLen=${specimenDom.window.document.body?.innerHTML.length ?? 0}`);
  } catch {
    logSelectorDebug("Specimen JSDOM parse failed; returning undefined");
    return undefined;
  }

  // Strategy 1 (first): infer best selector from the specimen page itself.
  // Then validate/refine against home page only if it exists.
  const titleNeedle = getDocumentTitleNeedle(specimenDom, entity);

  if (titleNeedle) {
    logSelectorDebug(`Selector-first title needle: ${titleNeedle}`);
    const specimenFirstSelector = discoverSelectorFromTitle(specimenDom, titleNeedle);
    if (specimenFirstSelector) {
      // Try to validate against home page if available.
      try {
        homePageDom = new JSDOM(homePageHtml, { url: homePageUrl });
      } catch {
        homePageDom = undefined;
        logSelectorDebug(`Selector-first selected ${specimenFirstSelector} (specimen-only, home parse failed)`);
        return specimenFirstSelector;
      }

      logSelectorDebug(`Comparing pages: homePage=${homePageUrl} specimen=${specimenUrl}`);
      logSelectorDebug(`Home DOM: title="${homePageDom?.window.document.title || ""}" #moduleContent=${!!homePageDom?.window.document.querySelector("#moduleContent")} #page=${!!homePageDom?.window.document.querySelector("#page")} [data-cprole='mainContentContainer']=${!!homePageDom?.window.document.querySelector("[data-cprole='mainContentContainer']")} bodyLen=${homePageDom?.window.document.body?.innerHTML.length ?? 0}`);

      const specimenEl = specimenDom.window.document.querySelector(specimenFirstSelector);
      const homePageEl = homePageDom?.window.document.querySelector(specimenFirstSelector);
      if (specimenEl && homePageEl) {
        const specimenText = getElementTextForSelectorEvaluation(specimenEl);
        const homePageText = getElementTextForSelectorEvaluation(homePageEl);
        if (specimenText.length >= 120 && homePageText.length >= 120) {
          const similarity = computeJaccardSimilarity(homePageText, specimenText);
          logSelectorDebug(`Selector-first validation ${specimenFirstSelector}: similarity=${similarity.toFixed(3)}`);
          if (similarity < 0.9 || titleAppearsNearStart(specimenText, titleNeedle)) {
            logSelectorDebug(`Selector-first selected ${specimenFirstSelector}`);
            return specimenFirstSelector;
          }
        } else {
          logSelectorDebug(`Selector-first selected ${specimenFirstSelector} (short text tolerated)`);
          return specimenFirstSelector;
        }
      } else {
        // If selector is strong on specimen but absent on home-page template, keep it.
        logSelectorDebug(`Selector-first selected ${specimenFirstSelector} (missing on home-page template)`);
        return specimenFirstSelector;
      }
    }
  }

  // Strategy 2: cross-page candidate scan.
  for (const selector of CONTENT_SELECTOR_CANDIDATES) {
    if (!homePageDom) break;
    const homePageEl = homePageDom.window.document.querySelector(selector);
    const specimenEl = specimenDom.window.document.querySelector(selector);
    if (!homePageEl || !specimenEl) {
      logSelectorDebug(`Primary pass ${selector}: missing element in ${!homePageEl ? "homePage" : "specimen"}`);
      continue;
    }

    const homePageText = getElementTextForSelectorEvaluation(homePageEl);
    const specimenText = getElementTextForSelectorEvaluation(specimenEl);

    if (homePageText.length < 150 || specimenText.length < 150) {
      logSelectorDebug(`Primary pass ${selector}: text too short homePage=${homePageText.length} specimen=${specimenText.length}`);
      continue;
    }

    const similarity = computeJaccardSimilarity(homePageText, specimenText);
    logSelectorDebug(`Primary pass ${selector}: similarity=${similarity.toFixed(3)}`);
    if (similarity < 0.6) {
      logSelectorDebug(`Primary pass selected ${selector}`);
      return selector;
    }
  }

  if (!titleNeedle) {
    logSelectorDebug("No title needle found; returning undefined");
    return undefined;
  }
  logSelectorDebug(`Fallback title needle: ${titleNeedle}`);

  for (const selector of CONTENT_SELECTOR_CANDIDATES) {
    if (!homePageDom) break;
    const homePageEl = homePageDom.window.document.querySelector(selector);
    const specimenEl = specimenDom.window.document.querySelector(selector);
    if (!homePageEl || !specimenEl) {
      logSelectorDebug(`Title pass ${selector}: missing element in ${!homePageEl ? "homePage" : "specimen"}`);
      continue;
    }

    const homePageText = getElementTextForSelectorEvaluation(homePageEl);
    const specimenText = getElementTextForSelectorEvaluation(specimenEl);

    if (homePageText.length < 120 || specimenText.length < 120) {
      logSelectorDebug(`Title pass ${selector}: text too short homePage=${homePageText.length} specimen=${specimenText.length}`);
      continue;
    }
    if (!titleAppearsNearStart(homePageText, titleNeedle)) {
      logSelectorDebug(`Title pass ${selector}: title not near start in homePage`);
      continue;
    }

    const similarity = computeJaccardSimilarity(homePageText, specimenText);
    logSelectorDebug(`Title pass ${selector}: similarity=${similarity.toFixed(3)}`);
    if (similarity < 0.85) {
      logSelectorDebug(`Title pass selected ${selector}`);
      return selector;
    }
  }

  // Last-resort fallback: infer from title placement on a single page.
  // Prefer specimen because home page can be a different template/host or unavailable.
  const fallbackSelector = discoverSelectorFromTitle(specimenDom, titleNeedle)
    || (homePageDom ? discoverSelectorFromTitle(homePageDom, titleNeedle) : undefined);
  if (fallbackSelector) {
    logSelectorDebug(`Single-page fallback selected ${fallbackSelector}`);
    return fallbackSelector;
  }

  const commentAreaFallback = extractContentAreaByComments(specimenHtml)
    || (homePageHtml ? extractContentAreaByComments(homePageHtml) : null);
  if (commentAreaFallback) {
    logSelectorDebug("Comment-marker fallback selected __comment_content_area__");
    return COMMENT_CONTENT_AREA_SELECTOR;
  }

  logSelectorDebug("No selector found in any pass; returning undefined");

  return undefined;
}

/**
 * Extract plain text from just the content block identified by a CSS selector.
 */
export function extractContentBlockText(html: string, baseUrl: string, contentSelector: string): string | null {
  if (contentSelector === COMMENT_CONTENT_AREA_SELECTOR) {
    const between = extractContentAreaByComments(html);
    if (!between) return null;
    console.log("[SELECTOR][DEBUG] Extracted content area by comments, length=", between.length, ", original length=", html.length);
    return convertHtmlToTextSimple(between).trim() || null;
  }

  try {
    const dom = new JSDOM(html, { url: baseUrl });
    const el = dom.window.document.querySelector(contentSelector);
    if (!el) return null;

    const mainText = normalizeText(el.textContent || "");
    let htmlToConvert = el.outerHTML;

    // Some templates isolate heading/breadcrumb text in the selected block and put
    // substantive content in the immediate sibling block.
    if (looksLikeHeaderOnlyContent(mainText) && el.nextElementSibling) {
      const siblingText = normalizeText(el.nextElementSibling.textContent || "");
      if (siblingText.length >= 180) {
        htmlToConvert = `${el.outerHTML}\n${el.nextElementSibling.outerHTML}`;
      }
    }

    console.log("[SELECTOR][DEBUG] Converting HTML to text, length=", htmlToConvert.length, ", original length=", html.length );
    return convertHtmlToTextSimple(htmlToConvert).trim() || null;
  } catch {
    return null;
  }
}

export async function readLinkCandidatesForMenuDiscovery(
  storage: any,
  historyMap: Map<string, SpiderDownloadRecord>,
  url: string,
): Promise<ExtractedLink[]> {
  const normalizedUrl = normalizeUrlForMatch(url);
  const existingHistory = historyMap.get(normalizedUrl);
  if (existingHistory) {
    const cached = await loadCachedPageFromHistory(storage, existingHistory, 0);
    if (cached && cached.linkCandidates.length > 0) {
      return cached.linkCandidates;
    }
  }

  const fetched = await fetchPageContent(url);
  if (!fetched.page || fetched.page.kind !== "html") {
    return [];
  }

  const extracted = extractLinksAndText(url, fetched.page.html || "");
  return extracted.linkCandidates;
}

async function fetchHtmlForMenuDiscovery(
  storage: any,
  historyMap: Map<string, SpiderDownloadRecord>,
  entityId: string,
  url: string,
  options?: {
    forceRelated?: boolean;
    domains?: Domain[];
    governingBody?: string;
  },
): Promise<string | null> {
  const evaluateStatus = (html: string): HistoryStatus | null => {
    if (options?.forceRelated) {
      return "related";
    }
    if (options?.domains && options.domains.length > 0) {
      const extracted = extractLinksAndText(url, html);
      const page: CrawledPage = {
        url,
        depth: 0,
        title: extracted.title || url,
        headers: extracted.headers,
        htmlContent: html,
        plainText: extracted.plainText,
        textSample: extracted.sample,
        isPdf: false,
        links: extracted.links,
      };
      const hasDomainMatch = scoreDomainDetailed(options.domains, page, options.governingBody)
        .some((score) => isDomainScoreMatch(score));
      return hasDomainMatch ? "related" : "unrelated";
    }
    return null;
  };

  const normalizedUrl = normalizeUrlForMatch(url);
  const existingHistory = historyMap.get(normalizedUrl);
  if (existingHistory?.localFile) {
    const htmlPath = fromRelativeDownloadsPath(storage, existingHistory.localFile);
    if (await fs.pathExists(htmlPath)) {
      const cachedHtml = await fs.readFile(htmlPath, "utf-8");
      const status = evaluateStatus(cachedHtml);
      const extractedTitle = await extractDocumentTitleWithCache(storage, historyMap, normalizedUrl, cachedHtml);
      const resourceTitle = (extractedTitle || existingHistory.title || normalizedUrl).trim();
      if (status && existingHistory.status !== status) {
        upsertHistoryEntry(historyMap, {
          url: normalizedUrl,
          title: resourceTitle,
          entityId,
          matchedDomainIds: status === "related" ? existingHistory.matchedDomainIds || [] : [],
          status,
          timestamp: new Date().toISOString(),
          ...(existingHistory.localFile ? { localFile: existingHistory.localFile } : {}),
          ...(existingHistory.localFileText ? { localFileText: existingHistory.localFileText } : {}),
        });
      }
      return cachedHtml;
    }
  }

  const fetched = await fetchPageContent(url);
  if (!fetched.page || fetched.page.kind !== "html") {
    return null;
  }

  const html = fetched.page.html || "";
  if (!html.trim()) {
    return null;
  }

  // Cache secondary/main pages used for menu discovery so later runs avoid refetch.
  const extracted = extractLinksAndText(url, html);
  const page: CrawledPage = {
    url,
    depth: 0,
    title: extracted.title || url,
    headers: extracted.headers,
    htmlContent: html,
    plainText: extracted.plainText,
    textSample: extracted.sample,
    isPdf: false,
    links: extracted.links,
  };
  const status = evaluateStatus(html) || "related";
  const timestamp = new Date().toISOString();
  const extractedTitle = await extractDocumentTitleWithCache(storage, historyMap, normalizedUrl, html);
  const resourceTitle = (extractedTitle || extracted.title || normalizedUrl).trim();
  const saved = await saveCrawledArtifacts(storage, entityId, page, timestamp);
  upsertHistoryEntry(historyMap, {
    url: normalizedUrl,
    title: resourceTitle,
    entityId,
    matchedDomainIds: [],
    status,
    timestamp,
    ...(saved.localFile ? { localFile: saved.localFile } : {}),
    ...(saved.localFileText ? { localFileText: saved.localFileText } : {}),
  });

  return html;
}

export async function fetchHtmlForMenuDiscoveryCached(
  storage: any,
  historyMap: Map<string, SpiderDownloadRecord>,
  entityId: string,
  url: string,
  options?: {
    forceRelated?: boolean;
    domains?: Domain[];
    governingBody?: string;
  },
): Promise<string | null> {
  return fetchHtmlForMenuDiscovery(storage, historyMap, entityId, url, options);
}

export function extractContentBlockLinkCandidates(
  html: string,
  baseUrl: string,
  contentSelector: string,
): ExtractedLink[] {
  if (contentSelector === COMMENT_CONTENT_AREA_SELECTOR) {
    const between = extractContentAreaByComments(html);
    if (!between) return [];
    return extractLinksAndText(baseUrl, between).linkCandidates;
  }

  try {
    const dom = new JSDOM(html, { url: baseUrl });
    const el = dom.window.document.querySelector(contentSelector);
    if (!el) return [];
    return extractLinksAndText(baseUrl, el.outerHTML).linkCandidates;
  } catch {
    return [];
  }
}

export async function discoverLocalMenuLinks(
  storage: any,
  historyMap: Map<string, SpiderDownloadRecord>,
  entity: Entity,
  entityRecordUrls: Set<string>,
  options?: {
    domains?: Domain[];
  },
): Promise<{ discovered: Set<string>; contentSelectors: Map<string, string> }> {
  const discovered = new Set<string>();
  const contentSelectors = new Map<string, string>();
  const governingUrl = normalizeUrl(entity.governingUrl);
  const mainUrl = normalizeUrl(entity.mainUrl);
  if (!governingUrl || !mainUrl) {
    return { discovered, contentSelectors };
  }
  const mainHostname = getLikelyHostname(mainUrl);
  if (!mainHostname) {
    return { discovered, contentSelectors };
  }

  const normalizedMainUrl = normalizeUrlForMatch(mainUrl);
  const normalizedGoverningUrl = normalizeUrlForMatch(governingUrl);
  const allowedHosts = new Set<string>(
    [mainUrl, governingUrl, normalizeUrl(entity.hubUrl)]
      .filter((value): value is string => Boolean(value))
      .map((url) => getLikelyHostname(url))
      .filter(Boolean),
  );
  const mainLinks = await readLinkCandidatesForMenuDiscovery(storage, historyMap, mainUrl);
  const mainLinkSet = new Set(
    mainLinks
      .map((link) => normalizeUrlForMatch(link.url))
      .filter((url) => {
        if (url === normalizedMainUrl || url === normalizedGoverningUrl) return false;
        if (SKIP_URL_PATTERN.test(url)) return false;
        return getLikelyHostname(url) === mainHostname;
      }),
  );
  const secondaryCandidates = mainLinks
    .map((link) => normalizeUrlForMatch(link.url))
    .filter((url) => {
      if (url === normalizedMainUrl || url === normalizedGoverningUrl) return false;
      if (SKIP_URL_PATTERN.test(url)) return false;
      return getLikelyHostname(url) === mainHostname;
    });

  const secondaryPageUrl = secondaryCandidates[0];
  const secondaryPageUrl2 = secondaryCandidates[1];
  if (!secondaryPageUrl) {
    console.log(styleText('red',`[MENU][DEBUG] ${entity.id} could not identify secondary page from mainUrl links.`));
    // list the candidates considered for easier debugging
    if (mainLinks.length === 0) {
      const mainFetch = await fetchPageContent(mainUrl);
      if (!mainFetch.page) {
        if (mainFetch.status === "blocked") {
          console.log(styleText('yellow',`[MENU][DEBUG] ${entity.id} mainUrl fetch is blocked (status=${mainFetch.status}).`));
        } else {
          console.log(styleText('yellow',`[MENU][DEBUG] ${entity.id} mainUrl fetch returned no page (status=${mainFetch.status}).`));
        }
      }
      console.log(styleText('yellow',`[MENU][DEBUG] ${entity.id} no links found on mainUrl page.`));
    }
    else {
      console.log(styleText('yellow',`[MENU][DEBUG] ${entity.id} secondary page candidates from mainUrl links:`));
      for (const link of secondaryCandidates) {
        console.log(styleText('yellow',`[MENU][DEBUG]   ${link}`));
      }
    }
    return { discovered, contentSelectors };
  }
  console.log(styleText("bold", `[MENU][DEBUG] ${entity.id} secondary page selected: ${secondaryPageUrl}`));
  if (secondaryPageUrl2) {
    console.log(styleText("bold", `[MENU][DEBUG] ${entity.id} second secondary page selected: ${secondaryPageUrl2}`));
  }

  const [mainHtml, secondaryHtml, secondaryHtml2] = await Promise.all([
    fetchHtmlForMenuDiscovery(storage, historyMap, entity.id, mainUrl, {
      forceRelated: true,
      domains: options?.domains,
      governingBody: entity.governingBody,
    }),
    fetchHtmlForMenuDiscovery(storage, historyMap, entity.id, secondaryPageUrl, {
      domains: options?.domains,
      governingBody: entity.governingBody,
    }),
    secondaryPageUrl2
      ? fetchHtmlForMenuDiscovery(storage, historyMap, entity.id, secondaryPageUrl2, {
        domains: options?.domains,
        governingBody: entity.governingBody,
      })
      : Promise.resolve<string | null>(null),
  ]);

  let selector: string | undefined;
  if (secondaryHtml && secondaryHtml2 && secondaryPageUrl2) {
    selector = discoverContentSelector(entity, secondaryHtml, secondaryPageUrl, secondaryHtml2, secondaryPageUrl2);
  }
  if (!selector && mainHtml && secondaryHtml) {
    selector = discoverContentSelector(entity, secondaryHtml, secondaryPageUrl, mainHtml, mainUrl);
  }

  if (selector) {
    const analyzedHost = getLikelyHostname(secondaryPageUrl) || mainHostname;
    contentSelectors.set(analyzedHost, selector);
    console.log(styleText("bold", `[MENU][DEBUG] ${entity.id} content selector discovered: "${selector}" (applied to host ${analyzedHost})`));
  } else {
    console.log(styleText(["bold","red"], `[MENU][DEBUG] ${entity.id} no content selector identified from page comparison`));
  }

  const secondaryLinks = await readLinkCandidatesForMenuDiscovery(storage, historyMap, secondaryPageUrl);
  const overlappingMenuUrls = new Set(
    secondaryLinks
      .map((link) => normalizeUrlForMatch(link.url))
      .filter((url) => mainLinkSet.has(url)),
  );

  for (const normalized of overlappingMenuUrls) {
    if (entityRecordUrls.has(normalized)) continue;
    if (!allowedHosts.has(getLikelyHostname(normalized))) continue;
    discovered.add(normalized);
  }

  return { discovered, contentSelectors };
}
