/**
 * Domain keyword scoring for the spider.
 *
 * Extracted from spiderEntityWebsites.ts — contains all types and logic
 * needed to score a crawled page against configured domain definitions.
 */

import { type Domain } from "@civillyengaged/ordinizer-core";

// Re-export for consumers that previously imported DomainRow from this module
export type { Domain };

// ---------------------------------------------------------------------------
// Shared types used across the spider
// ---------------------------------------------------------------------------

export interface ExtractedLink {
  url: string;
  text: string;
}

export interface CrawledPage {
  url: string;
  depth: number;
  title: string;
  headers?: string[];
  htmlContent?: string;
  plainText: string;
  textSample: string;
  isPdf: boolean;
  links: string[];
  fromCache?: boolean;
}

// ---------------------------------------------------------------------------
// Scoring constants
// ---------------------------------------------------------------------------

// A domain match requires the weighted score to reach this threshold.
// Raise to reduce false positives; lower to catch more (but noisier) pages.
export const DOMAIN_MATCH_SCORE_THRESHOLD = 4;

// Per-zone multipliers for keyword hits in the regular domain scorer.
const SCORE_MULTIPLIER_TITLE = 2;
const SCORE_MULTIPLIER_HEADER = 2.5;
const SCORE_MULTIPLIER_URL = 0.5;
const SCORE_MULTIPLIER_BODY = 0.1;

// The boards-domain scorer uses phrase matching against a specific governing-body
// name rather than loose keyword lists, so each hit is a stronger signal.
const BOARDS_SCORE_MULTIPLIER_TITLE = 3;
const BOARDS_SCORE_MULTIPLIER_HEADER = 3.5;
const BOARDS_SCORE_MULTIPLIER_URL = 1.5;
const BOARDS_SCORE_MULTIPLIER_BODY = 0.5;

// Bonus applied to domains typed "general" to give them a slight edge.
const SCORE_GENERAL_DOMAIN_BONUS = 0.5;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface DomainScore {
  domainId: string;
  displayName: string;
  domainType?: Domain["type"];
  rawScore: number;
  titleHits: number;
  headerHits: number;
  urlHits: number;
  bodyHits: number;
  matchScore: number;
  weightedScore: number;
  totalKeywords: number;
  matchedKeywords: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toKeywordTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .map((v) => v.trim())
    .filter((v) => v.length >= 4);
}

function getDomainKeywords(domain: Domain): string[] {
  const manual = Array.isArray(domain.keywords) ? domain.keywords : [];
  const base = [domain.id, domain.name, domain.displayName || "", domain.description || "", ...manual]
    .filter(Boolean)
    .flatMap((v) => toKeywordTokens(String(v)));

  return Array.from(new Set(base));
}

function isBoardsDomain(domain: Domain): boolean {
  const id = String(domain.id || domain.name || "").toLowerCase();
  return id === "boards" || id === "board";
}

function buildFlexiblePhrasePattern(phrase: string): RegExp | null {
  const tokens = phrase
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    return null;
  }

  return new RegExp(`\\b${tokens.join("[\\s/-]+")}\\b`, "i");
}

function getBoardsDomainPhrases(governingBody?: string): Array<{ label: string; pattern: RegExp }> {
  const normalized = String(governingBody || "").trim().toLowerCase();
  if (!normalized || !normalized.includes("conservation")) {
    return [];
  }

  const pattern = buildFlexiblePhrasePattern(normalized);
  return pattern ? [{ label: normalized, pattern }] : [];
}

function countPhraseMatches(text: string, pattern: RegExp): number {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  return Array.from(text.matchAll(globalPattern)).length;
}

function scoreBoardsDomain(domain: Domain, page: CrawledPage, governingBody?: string): DomainScore {
  const id = domain.id || domain.name;
  const urlText = page.url.toLowerCase();
  const titleText = page.title.toLowerCase();
  const headersText = (page.headers || []).join(" ").toLowerCase();
  const bodyText = `${page.textSample} ${page.plainText.slice(0, 3000)}`.toLowerCase();
  const phrases = getBoardsDomainPhrases(governingBody);
  const matchedKeywords: string[] = [];
  let titleHits = 0;
  let headerHits = 0;
  let urlHits = 0;
  let bodyHits = 0;

  for (const phrase of phrases) {
    const totalHits = countPhraseMatches(urlText, phrase.pattern)
      + countPhraseMatches(titleText, phrase.pattern)
      + countPhraseMatches(headersText, phrase.pattern)
      + countPhraseMatches(bodyText, phrase.pattern);

    if (totalHits === 0) {
      continue;
    }

    matchedKeywords.push(phrase.label);
    titleHits += countPhraseMatches(titleText, phrase.pattern);
    headerHits += countPhraseMatches(headersText, phrase.pattern);
    urlHits += countPhraseMatches(urlText, phrase.pattern);
    bodyHits += countPhraseMatches(bodyText, phrase.pattern);
  }

  const rawScore = matchedKeywords.length;
  const matchScore = rawScore
    + (titleHits * BOARDS_SCORE_MULTIPLIER_TITLE)
    + (headerHits * BOARDS_SCORE_MULTIPLIER_HEADER)
    + (urlHits * BOARDS_SCORE_MULTIPLIER_URL)
    + (bodyHits * BOARDS_SCORE_MULTIPLIER_BODY);
  const generalBonus = domain.type === "general" ? SCORE_GENERAL_DOMAIN_BONUS : 0;

  return {
    domainId: id,
    displayName: domain.displayName || domain.name || id,
    domainType: domain.type,
    rawScore,
    titleHits,
    headerHits,
    urlHits,
    bodyHits,
    matchScore,
    weightedScore: matchScore + generalBonus,
    totalKeywords: phrases.length,
    matchedKeywords,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isDomainScoreMatch(score: DomainScore): boolean {
  return score.matchScore >= DOMAIN_MATCH_SCORE_THRESHOLD;
}

export function scoreDomainDetailed(domains: Domain[], page: CrawledPage, governingBody?: string): DomainScore[] {
  const urlText = page.url.toLowerCase();
  const titleText = page.title.toLowerCase();
  const headersText = (page.headers || []).join(" ").toLowerCase();
  const bodyText = `${page.textSample} ${page.plainText.slice(0, 3000)}`.toLowerCase();
  const scores: DomainScore[] = [];

  for (const domain of domains) {
    if (isBoardsDomain(domain)) {
      scores.push(scoreBoardsDomain(domain, page, governingBody));
      continue;
    }

    const id = domain.id || domain.name;
    const keywords = getDomainKeywords(domain);
    const matched = keywords.filter((kw) => {
      return urlText.includes(kw)
        || titleText.includes(kw)
        || headersText.includes(kw)
        || bodyText.includes(kw);
    });
    const titleHits = matched.filter((kw) => titleText.includes(kw)).length;
    const headerHits = matched.filter((kw) => headersText.includes(kw)).length;
    const urlHits = matched.filter((kw) => urlText.includes(kw)).length;
    const bodyHits = matched.filter((kw) => bodyText.includes(kw)).length;
    const matchScore = matched.length
      + (titleHits * SCORE_MULTIPLIER_TITLE)
      + (headerHits * SCORE_MULTIPLIER_HEADER)
      + (urlHits * SCORE_MULTIPLIER_URL)
      + (bodyHits * SCORE_MULTIPLIER_BODY);
    const generalBonus = domain.type === "general" ? SCORE_GENERAL_DOMAIN_BONUS : 0;
    scores.push({
      domainId: id,
      displayName: domain.displayName || domain.name || id,
      domainType: domain.type,
      rawScore: matched.length,
      titleHits,
      headerHits,
      urlHits,
      bodyHits,
      matchScore,
      weightedScore: matchScore + generalBonus,
      totalKeywords: keywords.length,
      matchedKeywords: matched,
    });
  }

  return scores.sort((a, b) => {
    if (b.weightedScore !== a.weightedScore) {
      return b.weightedScore - a.weightedScore;
    }
    if (b.rawScore !== a.rawScore) {
      return b.rawScore - a.rawScore;
    }
    return a.domainId.localeCompare(b.domainId);
  });
}

export function classifyDomains(domains: Domain[], page: CrawledPage, governingBody?: string): string[] {
  return scoreDomainDetailed(domains, page, governingBody)
    .filter((score) => isDomainScoreMatch(score))
    .map((score) => score.domainId);
}

export function buildLinkPseudoPage(link: ExtractedLink): CrawledPage {
  return {
    url: link.url,
    depth: 0,
    title: link.text,
    headers: [link.text],
    plainText: link.text,
    textSample: link.text,
    isPdf: false,
    links: [],
  };
}
