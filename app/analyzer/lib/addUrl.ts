#!/usr/bin/env tsx

import dotenv from "dotenv";
dotenv.config();

import fs from "fs-extra";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { getDefaultStorage } from "@civillyengaged/ordinizer-servercore";
import type { Entity, Domain, Analysis, AnalyzedQuestion } from "@civillyengaged/ordinizer-core";

import { parseCommonCliArgs, requireDataRootAndRealm } from "./scriptArgs.js";
import {
  normalizeUrlForMatch,
  loadHistoryData,
  saveHistoryData,
  upsertHistoryEntry,
  saveCrawledArtifacts,
  ensureEntityHistoryLayout,
  loadWebsitesFile,
  fetchPageContent,
  extractLinksAndText,
  type SpiderDownloadRecord,
  fromRelativeDownloadsPath,
} from "./spiderHistory.js";
import {
  scoreDomainDetailed,
  type CrawledPage,
  type DomainScore,
} from "./domainScoring.js";
import { convertHtmlToText } from "./simpleHtmlToText.js";
import {
  addOrUpdateSource,
  detectArticleBasedPage,
  extractStatuteInfoFromHTML,
  downloadAndStitchArticles,
  hasBinaryData,
} from "./extractionUtils.js";
import { indexEntity } from "./indexDocumentService.js";
import { doAnalysis } from "./analyzeStatutes.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Rl = ReturnType<typeof createInterface>;

interface Args {
  realm: string;
}

interface QuestionDiff {
  questionId: string | number;
  question: string;
  oldAnswer: string;
  newAnswer: string;
  oldScore: number;
  newScore: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUTE_LIBRARY_HOSTS = new Set([
  "library.municode.com",
  "www.municode.com",
  "municode.com",
  "ecode360.com",
  "www.ecode360.com",
  "www.generalcode.com",
  "generalcode.com",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isStatuteLibraryUrl(url: string): boolean {
  try {
    return STATUTE_LIBRARY_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function buildHostEntityMap(
  storage: ReturnType<typeof getDefaultStorage>,
  entities: Entity[],
): Promise<Map<string, string>> {
  const hostMap = new Map<string, string>();

  for (const entity of entities) {
    for (const urlField of [entity.mainUrl, entity.governingUrl, entity.authorityUrl]) {
      if (!urlField) continue;
      try {
        hostMap.set(new URL(urlField).hostname.toLowerCase(), entity.id);
      } catch {
        // skip malformed URLs
      }
    }

    try {
      const websitesFile = await loadWebsitesFile(storage, entity.id);
      for (const hostname of Object.keys(websitesFile.hosts)) {
        hostMap.set(hostname.toLowerCase(), entity.id);
      }
    } catch {
      // no websites.json for this entity — skip silently
    }
  }

  return hostMap;
}

function detectEntityCandidates(
  url: string,
  hostEntityMap: Map<string, string>,
  entities: Entity[],
  pageTitle?: string,
): Entity[] {
  if (!isStatuteLibraryUrl(url)) {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      const entityId = hostEntityMap.get(hostname);
      if (entityId) {
        const entity = entities.find((e) => e.id === entityId);
        if (entity) return [entity];
      }
    } catch {
      // fall through
    }
    return [];
  }

  // Statute library: fuzzy match page title against entity names
  if (!pageTitle) return [];
  const titleLower = pageTitle.toLowerCase();
  const scored: Array<{ entity: Entity; hits: number }> = [];
  for (const entity of entities) {
    const nameWords = entity.name.toLowerCase().split(/\s+/).filter((w) => w.length >= 4);
    const hits = nameWords.filter((w) => titleLower.includes(w)).length;
    if (hits > 0) scored.push({ entity, hits });
  }
  scored.sort((a, b) => b.hits - a.hits);
  return scored.slice(0, 5).map((s) => s.entity);
}

function buildCrawledPage(url: string, html: string): CrawledPage {
  const extracted = extractLinksAndText(url, html);
  return {
    url,
    depth: 0,
    title: extracted.title,
    headers: extracted.headers,
    htmlContent: html,
    plainText: extracted.plainText,
    textSample: extracted.sample,
    isPdf: false,
    links: extracted.links,
  };
}

async function pickDomain(
  rl: Rl,
  domainScores: DomainScore[],
  allDomains: Domain[],
): Promise<string | null> {
  const top3 = domainScores.slice(0, 3);

  if (top3.length === 0) {
    const answer = (await rl.question("No domain matches found. Enter domain ID (or Enter to skip): ")).trim();
    if (!answer) return null;
    const valid = allDomains.find((d) => d.id === answer);
    if (valid) return answer;
    console.log(`Unknown domain ID: ${answer}`);
    return null;
  }

  console.log("\nTop domain matches:");
  for (let i = 0; i < top3.length; i++) {
    const s = top3[i];
    const keywords = s.matchedKeywords.slice(0, 5).join(", ");
    console.log(
      `  ${i + 1}. ${s.displayName} (${s.domainId}) — score: ${s.weightedScore.toFixed(2)}, keywords: ${keywords}`,
    );
  }
  console.log("  (or type an existing domain ID directly, or Enter to skip)");

  const answer = (await rl.question("Pick domain [1/2/3 or domain-id]: ")).trim();
  if (!answer) return null;

  const idx = parseInt(answer, 10);
  if (idx >= 1 && idx <= top3.length) return top3[idx - 1].domainId;

  const valid = allDomains.find((d) => d.id === answer);
  if (valid) return answer;

  console.log(`Unknown domain ID: ${answer}`);
  return null;
}

function getQuestionId(q: AnalyzedQuestion): string | number {
  return (q as any).id ?? (q as any).questionId ?? "";
}

function diffAnalysis(before: Analysis | null, after: Analysis | null): QuestionDiff[] {
  if (!after?.questions) return [];
  const beforeMap = new Map<string | number, AnalyzedQuestion>(
    (before?.questions ?? []).map((q) => [getQuestionId(q), q]),
  );
  const diffs: QuestionDiff[] = [];
  for (const q of after.questions) {
    const qid = getQuestionId(q);
    const prev = beforeMap.get(qid);
    const answerChanged = !prev || prev.answer !== q.answer;
    const scoreChanged = !prev || Math.abs(((prev as any).score ?? 0) - ((q as any).score ?? 0)) >= 1;
    if (answerChanged || scoreChanged) {
      diffs.push({
        questionId: qid,
        question: q.question,
        oldAnswer: prev?.answer ?? "(none)",
        newAnswer: q.answer,
        oldScore: (prev as any)?.score ?? 0,
        newScore: (q as any)?.score ?? 0,
      });
    }
  }
  return diffs;
}

function printDiff(diffs: QuestionDiff[]): void {
  if (diffs.length === 0) {
    console.log("  No questions changed.");
    return;
  }
  console.log(`\n  ${diffs.length} question(s) changed:\n`);
  for (const d of diffs) {
    console.log(`  Q[${d.questionId}]: ${d.question.slice(0, 60)}`);
    console.log(`    Before (score ${d.oldScore}): ${d.oldAnswer.slice(0, 80)}`);
    console.log(`    After  (score ${d.newScore}): ${d.newAnswer.slice(0, 80)}`);
  }
}

// ---------------------------------------------------------------------------
// Statute library source pipeline
// ---------------------------------------------------------------------------

async function processStatuteLibraryUrl(
  storage: ReturnType<typeof getDefaultStorage>,
  entityId: string,
  domainId: string,
  url: string,
  html: string,
  ruleType: string,
): Promise<{ text: string; wordCount: number }> {
  const entityDir = path.join(storage.getRealmDir(), domainId, entityId);
  await fs.ensureDir(entityDir);

  const htmlPath = path.join(entityDir, `${ruleType}.html`);
  await fs.writeFile(htmlPath, html, "utf-8");
  console.log(`Saved ${ruleType}.html (${Math.round(html.length / 1024)} KB)`);

  // Check for article-based structure (common on municode)
  const articles = detectArticleBasedPage(html, url);
  let text: string;

  if (articles.length > 0) {
    console.log(`Article-based page detected (${articles.length} articles), downloading and stitching...`);
    const result = await downloadAndStitchArticles(articles);
    text = result.content;
    if (!text || text.length < 100) {
      console.log("Article stitching yielded too little content, falling back to main page.");
      const anchorId = url.match(/#(.+)$/)?.[1];
      text = convertHtmlToText(html, anchorId);
    } else {
      console.log(`Stitched ${result.sourceUrls.length} articles.`);
    }
  } else {
    const anchorId = url.match(/#(.+)$/)?.[1];
    text = convertHtmlToText(html, anchorId);
  }

  const txtPath = path.join(entityDir, `${ruleType}.txt`);
  await fs.writeFile(txtPath, text, "utf-8");

  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;

  // Extract title/number and update ruleset
  const statuteInfo = await extractStatuteInfoFromHTML(html);
  const ruleset = await storage.getRulesetOrCreate(domainId, entityId);
  addOrUpdateSource(ruleset, {
    sourceUrl: url,
    downloadedAt: new Date().toISOString(),
    contentLength: html.length,
    title: statuteInfo.title ?? "",
    type: ruleType as "statute" | "policy",
  });
  if (statuteInfo.number) ruleset.statuteNumber = statuteInfo.number;
  await storage.saveRuleset(ruleset);

  return { text, wordCount };
}

async function validateStatuteText(rl: Rl, text: string, wordCount: number): Promise<boolean> {
  if (hasBinaryData(text)) {
    console.log("WARNING: Text appears to contain binary data — HTML may not have converted correctly.");
  }

  const preview = text.slice(0, 500).replace(/\n{3,}/g, "\n\n");
  console.log(`\nConverted text (${wordCount} words):\n---\n${preview}\n---`);

  if (wordCount < 30) {
    console.log("WARNING: Very little text extracted — conversion may have failed.");
  }

  const answer = (await rl.question("Does the text look correct? [Y/n]: ")).trim().toLowerCase();
  return answer !== "n" && answer !== "no";
}

// ---------------------------------------------------------------------------
// Main REPL
// ---------------------------------------------------------------------------

async function runRepl(args: Args): Promise<void> {
  const storage = getDefaultStorage(args.realm);
  const rl = createInterface({ input, output });

  try {
    console.log("Loading entities and domains...");
    const [entities, allDomains, realmConfig] = await Promise.all([
      storage.getEntities(),
      storage.getDomains(),
      storage.getRealmConfig(),
    ]);
    const ruleType = realmConfig.ruleType ?? "statute";
    const hostEntityMap = await buildHostEntityMap(storage, entities);
    console.log(`Loaded ${entities.length} entities, ${allDomains.length} domains.\n`);
    console.log("Press Ctrl+C or type 'quit' to exit.\n");

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // --- Step 1: URL prompt ---
      const rawUrl = (await rl.question("Enter URL: ")).trim();
      if (!rawUrl || rawUrl.toLowerCase() === "quit" || rawUrl.toLowerCase() === "q") break;

      const normalizedUrl = normalizeUrlForMatch(rawUrl) ?? rawUrl;
      const isStatuteLib = isStatuteLibraryUrl(normalizedUrl);

      // --- Step 2: Entity detection (hostname-based, before download) ---
      const hostCandidates = isStatuteLib ? [] : detectEntityCandidates(normalizedUrl, hostEntityMap, entities);
      let selectedEntity: Entity | null = null;

      if (hostCandidates.length > 0) {
        console.log(`\nDetected entity candidates (from websites.json):`);
        for (let i = 0; i < hostCandidates.length; i++) {
          console.log(`  ${i + 1}. ${hostCandidates[i].name} (${hostCandidates[i].id})`);
        }
        const answer = (await rl.question("Pick entity [1-N, entity-id, or Enter to skip]: ")).trim();
        if (answer) {
          const idx = parseInt(answer, 10);
          selectedEntity = (idx >= 1 && idx <= hostCandidates.length)
            ? hostCandidates[idx - 1]
            : (entities.find((e) => e.id === answer) ?? null);
          if (!selectedEntity) console.log(`Entity ID not found: ${answer}`);
        }
      } else if (!isStatuteLib) {
        const answer = (await rl.question("Entity not detected. Enter entity ID (or Enter to skip): ")).trim();
        if (answer) {
          selectedEntity = entities.find((e) => e.id === answer) ?? null;
          if (!selectedEntity) console.log(`Entity ID not found: ${answer}`);
        }
      }

      // --- Step 3: History check ---
      let existingEntry: SpiderDownloadRecord | undefined;
      let historyMap: Map<string, SpiderDownloadRecord> | null = null;
      let menuLinks: Awaited<ReturnType<typeof loadHistoryData>>["menuLinks"] | null = null;

      if (selectedEntity) {
        await ensureEntityHistoryLayout(storage, selectedEntity.id);
        const loaded = await loadHistoryData(storage, selectedEntity.id);
        historyMap = loaded.historyMap;
        menuLinks = loaded.menuLinks;
        existingEntry = historyMap.get(normalizedUrl);
        if (existingEntry) {
          console.log(`\n[INDEX] URL already in history:`);
          console.log(`  status:    ${existingEntry.status}`);
          console.log(`  domains:   ${existingEntry.matchedDomainIds?.join(", ") || "(none)"}`);
          console.log(`  title:     ${existingEntry.title || "(none)"}`);
          console.log(`  timestamp: ${existingEntry.timestamp || "(unknown)"}`);
          const proceed = (await rl.question("Already indexed. Continue to update? [y/N]: ")).trim().toLowerCase();
          if (proceed !== "y" && proceed !== "yes") {
            console.log("Skipped.\n");
            continue;
          }
        }
      }

      // --- Step 4: Download (or use cache) ---
      let crawledPage: CrawledPage | null = null;
      let cachedHtml: string | null = null;
      if (existingEntry?.localFile) {
        try {
          const htmlPath = fromRelativeDownloadsPath(storage, existingEntry.localFile);
          if (await fs.pathExists(htmlPath)) cachedHtml = await fs.readFile(htmlPath, "utf-8");
        } catch { /* fall through to download */ }
      }

      if (cachedHtml) {
        crawledPage = buildCrawledPage(normalizedUrl, cachedHtml);
        console.log(`Using cached HTML. Title: ${crawledPage.title}`);
      } else {
        console.log(isStatuteLib ? "Statute library URL detected, downloading..." : "Downloading...");
        const { page: downloadedPage, status: downloadStatus } = await fetchPageContent(normalizedUrl);
        if (downloadedPage?.kind === "html" && downloadedPage.html) {
          crawledPage = buildCrawledPage(normalizedUrl, downloadedPage.html);
          console.log(`Title: ${crawledPage.title}`);
        } else if (downloadedPage?.kind === "pdf") {
          console.log("Downloaded a PDF — domain scoring will be skipped.");
        } else {
          console.log(`Could not download page (status: ${downloadStatus}).`);
        }
      }

      // --- Step 5: Entity detection for statute library URLs (needs title) ---
      if (isStatuteLib && !selectedEntity) {
        const titleCandidates = detectEntityCandidates(normalizedUrl, hostEntityMap, entities, crawledPage?.title);
        if (titleCandidates.length > 0) {
          console.log(`\nDetected entity candidates (from title match):`);
          for (let i = 0; i < titleCandidates.length; i++) {
            console.log(`  ${i + 1}. ${titleCandidates[i].name} (${titleCandidates[i].id})`);
          }
          const answer = (await rl.question("Pick entity [1-N, entity-id, or Enter to skip]: ")).trim();
          if (answer) {
            const idx = parseInt(answer, 10);
            selectedEntity = (idx >= 1 && idx <= titleCandidates.length)
              ? titleCandidates[idx - 1]
              : (entities.find((e) => e.id === answer) ?? null);
          }
        } else {
          const answer = (await rl.question("Entity not detected. Enter entity ID (or Enter to skip): ")).trim();
          if (answer) selectedEntity = entities.find((e) => e.id === answer) ?? null;
        }
        if (selectedEntity && !historyMap) {
          await ensureEntityHistoryLayout(storage, selectedEntity.id);
          const loaded = await loadHistoryData(storage, selectedEntity.id);
          historyMap = loaded.historyMap;
          menuLinks = loaded.menuLinks;
        }
      }

      if (!selectedEntity) {
        console.log("No entity selected — skipping.\n");
        continue;
      }

      console.log(`Entity: ${selectedEntity.name} (${selectedEntity.id})`);

      // --- Step 4: Domain scoring ---
      let selectedDomainId: string | null = null;
      if (crawledPage) {
        const scores = scoreDomainDetailed(allDomains, crawledPage, selectedEntity.governingBody);
        selectedDomainId = await pickDomain(rl, scores, allDomains);
      } else {
        const answer = (
          await rl.question("Enter domain ID (or Enter to skip): ")
        ).trim();
        if (answer) {
          const valid = allDomains.find((d) => d.id === answer);
          selectedDomainId = valid ? answer : null;
          if (!valid) console.log(`Unknown domain ID: ${answer}`);
        }
      }

      if (!selectedDomainId) {
        console.log("No domain selected — skipping.\n");
        continue;
      }

      // --- Step 5: Save files ---
      const timestamp = new Date().toISOString();

      if (isStatuteLib && crawledPage?.htmlContent) {
        // Statute library path: save as statute source into the domain/entity directory
        console.log(`Processing as ${ruleType} source for ${selectedEntity.id}/${selectedDomainId}...`);
        try {
          const { text, wordCount } = await processStatuteLibraryUrl(
            storage,
            selectedEntity.id,
            selectedDomainId,
            normalizedUrl,
            crawledPage.htmlContent,
            ruleType,
          );
          const textOk = await validateStatuteText(rl, text, wordCount);
          if (!textOk) {
            console.log(`Saved ${ruleType}.html and ${ruleType}.txt but text validation was declined — indexing and analysis may be unreliable.`);
          }
        } catch (err) {
          console.error(`Failed to process statute source: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
      } else {
        // Entity website document: save to EntityDownloads + update history.json
        if (!historyMap || !menuLinks) {
          await ensureEntityHistoryLayout(storage, selectedEntity.id);
          const loaded = await loadHistoryData(storage, selectedEntity.id);
          historyMap = loaded.historyMap;
          menuLinks = loaded.menuLinks;
        }

        let localFile: string | undefined;
        let localFileText: string | undefined;

        if (crawledPage) {
          const artifacts = await saveCrawledArtifacts(storage, selectedEntity.id, crawledPage, timestamp);
          localFile = artifacts.localFile;
          localFileText = artifacts.localFileText;
          const savedPath = localFileText ?? localFile;
          if (savedPath) console.log(`Saved: EntityDownloads/${selectedEntity.id}/${savedPath}`);
        }

        upsertHistoryEntry(historyMap, {
          url: normalizedUrl,
          title: crawledPage?.title ?? rawUrl,
          entityId: selectedEntity.id,
          matchedDomainIds: [selectedDomainId],
          status: "related",
          timestamp,
          ...(localFile ? { localFile } : {}),
          ...(localFileText ? { localFileText } : {}),
        });

        await saveHistoryData(storage, selectedEntity.id, historyMap!, menuLinks!);
        console.log(`history.json updated for ${selectedEntity.id}.`);
      }

      // --- Step 6: Confirm indexing ---
      const indexAnswer = (
        await rl.question(`Run indexEntity for ${selectedEntity.id} / ${selectedDomainId}? [y/N]: `)
      ).trim().toLowerCase();

      if (indexAnswer === "y" || indexAnswer === "yes") {
        console.log("Indexing...");
        try {
          await indexEntity(selectedEntity.id, {
            realm: args.realm,
            domain: selectedDomainId,
          });
          console.log("Indexed.");
        } catch (err) {
          console.error(`Index failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // --- Step 7: Confirm re-analysis + show diff ---
      const analyzeAnswer = (
        await rl.question(`Run analyzeStatutes for ${selectedEntity.id} / ${selectedDomainId}? [y/N]: `)
      ).trim().toLowerCase();

      if (analyzeAnswer === "y" || analyzeAnswer === "yes") {
        const analysisBefore = await storage.getAnalysis(selectedDomainId, selectedEntity.id).catch(() => null);
        console.log("Running analyzeStatutes...");
        try {
          await doAnalysis({
            realm: args.realm,
            entity: selectedEntity.id,
            domain: selectedDomainId,
            force: true,
          });
          const analysisAfter = await storage.getAnalysis(selectedDomainId, selectedEntity.id).catch(() => null);
          printDiff(diffAnalysis(analysisBefore, analysisAfter));
        } catch (err) {
          console.error(`Analysis failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      console.log();
    }
  } finally {
    rl.close();
  }

  console.log("Done.");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`
addUrl — interactive REPL for indexing URLs into the spider history

Usage:
  tsx addUrl.ts [options]

Options:
  --realm <realm-id>      Realm to use (or set CURRENT_REALM env var)
  --data-root <path>      Path to the data root directory (or set DATA_ROOT env var)
  --help                  Show this help message and exit

Interactive workflow:
  1. Enter a URL to index
  2. Entity is auto-detected by hostname (or prompted)
  3. If already in history, shows current status and asks whether to update
  4. If cached HTML exists, it is reused; otherwise the page is downloaded
  5. Domain is scored and selected interactively
  6. Entry is saved to history.json (or processed as a statute source for library URLs)
  7. Optionally runs indexEntity and analyzeStatutes

Supported URL types:
  - Municipal website pages (matched by hostname from websites.json)
  - Statute library pages (library.municode.com, ecode360.com, generalcode.com, etc.)

Type 'quit' or press Ctrl+C to exit the REPL.
`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  const { common } = parseCommonCliArgs(process.argv.slice(2));
  requireDataRootAndRealm(common);
  await runRepl({ realm: common.realm! });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
