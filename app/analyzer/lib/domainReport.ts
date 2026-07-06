#!/usr/bin/env tsx
/**
 * domainReport.ts
 *
 * Generates a markdown report for a given domain:
 *   - Answer matrix (entities × questions, shortAnswer + confidence)
 *   - Score distribution tables
 *   - All domain questions (with weight/category)
 *   - For each entity with data: analyzed questions (score, confidence, gap, answer)
 *
 * Sources are pulled from both analysis.sources and EntityDownloads/{entity}/history.json.
 * Any history sources not yet present in analysis.sources are copied into analysis.json and saved.
 *
 * Output: <cwd>/local/report-<domainId>.md
 *
 * Usage:
 *   tsx app/analyzer/lib/domainReport.ts --realm <realmId> --domain <domainId>
 */

import dotenv from "dotenv";
dotenv.config();

import { pathToFileURL } from "node:url";
import fs from "fs-extra";
import path from "path";
import { getDefaultStorage } from "@civillyengaged/ordinizer-servercore";
import type { Analysis, AnalyzedQuestion, Question, Ruleset } from "@civillyengaged/ordinizer-core";
import { parseCommonCliArgs } from "./scriptArgs.js";
import { NO_SOURCES_AVAILABLE, NOT_SPECIFIED } from "./analyzeQuestions.js";
import type { SpiderHistoryFile, SpiderDownloadRecord } from "./spiderHistory.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SourceLink {
  url: string;
  title: string;
  localFilePath?: string; // absolute path to downloaded artifact (txt preferred)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scoreBar(score: number | undefined): string {
  if (score === undefined || score === null) return "n/a";
  return `${Math.round(score * 10)}%`;
}

function confidenceLabel(conf: number | undefined): string {
  if (conf === undefined || conf === null) return "n/a";
  const pct = conf > 1 ? Math.round(conf) : Math.round(conf * 100);
  return `${pct}%`;
}

function getQuestionId(q: AnalyzedQuestion): string | number {
  return (q as any).id ?? (q as any).questionId ?? "";
}

/** Compute a forward-slash relative path from a base directory to a target file (for markdown links). */
function relLink(fromDir: string, toFile: string): string {
  return path.relative(fromDir, toFile).replace(/\\/g, "/");
}

/** Sanitize a string for use inside a markdown table cell. */
function tableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

/** Read history.json for an entity and return records relevant to a domain. */
async function loadDomainHistorySources(
  realmDir: string,
  entityId: string,
  domainId: string,
): Promise<SourceLink[]> {
  const entityDir = path.join(realmDir, "EntityDownloads", entityId);
  const historyFile = path.join(entityDir, "history.json");
  if (!await fs.pathExists(historyFile)) return [];

  let history: SpiderHistoryFile;
  try {
    history = await fs.readJson(historyFile);
  } catch {
    return [];
  }

  return (history.records ?? [])
    .filter(
      (r: SpiderDownloadRecord) =>
        (r.status === "related" || r.status === "index") &&
        Array.isArray(r.matchedDomainIds) &&
        r.matchedDomainIds.includes(domainId),
    )
    .map((r: SpiderDownloadRecord) => {
      const artifactRelative = r.localFileText ?? r.localFile;
      const localFilePath = artifactRelative
        ? path.join(entityDir, path.basename(artifactRelative))
        : undefined;
      return { url: r.url, title: r.title ?? r.url, localFilePath };
    });
}

/** Merge history sources into analysis.sources; returns the merged list and whether anything changed. */
function mergeSources(
  existing: SourceLink[],
  fromHistory: SourceLink[],
): { merged: SourceLink[]; changed: boolean } {
  const seen = new Set(existing.map((s) => s.url));
  const toAdd = fromHistory.filter((s) => !seen.has(s.url));
  if (toAdd.length === 0) return { merged: existing, changed: false };
  return { merged: [...existing, ...toAdd], changed: true };
}

// ---------------------------------------------------------------------------
// Markdown builders
// ---------------------------------------------------------------------------

function renderQuestions(questions: Question[], questionsFilePath: string, localDir: string): string {
  const lines: string[] = [`## Domain Questions — [questions.json](${relLink(localDir, questionsFilePath)})\n`];
  for (const q of questions) {
    const weight = q.weight !== undefined ? ` (weight: ${q.weight})` : "";
    const category = q.category ? ` — _${q.category}_` : "";
    lines.push(`**Q${q.id}**${category}${weight}`);
    lines.push(q.question);
    if (q.scoreInstructions) {
      lines.push(`> Scoring: ${q.scoreInstructions}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

interface EntityAnswerData {
  displayName: string;
  answers: Map<string, { shortAnswer: string; confidence: number }>;
}

function renderAnswerMatrix(questions: Question[], entityData: EntityAnswerData[]): string {
  if (questions.length === 0 || entityData.length === 0) return "";

  const lines: string[] = ["---\n", "## Answer Matrix\n"];

  const headers = questions.map((q) => q.category || `Q${q.id}`);
  lines.push(`| Entity | ${headers.join(" | ")} |`);
  lines.push(`|--------|${headers.map(() => "--------").join("|")}|`);

  for (const ed of entityData) {
    const cells = questions.map((q) => {
      const qid = String(q.id);
      const a = ed.answers.get(qid);
      if (!a || !a.shortAnswer) return "—";
      return `${a.shortAnswer} (${confidenceLabel(a.confidence)})`;
    });
    lines.push(`| ${ed.displayName} | ${cells.join(" | ")} |`);
  }
  lines.push("");

  return lines.join("\n");
}

function renderEntitySection(
  entityId: string,
  entityDisplayName: string,
  _sources: SourceLink[],
  analysis: Analysis | null,
  questions: Question[],
  _ruleset: Ruleset | null,
  analysisFilePath: string,
  metadataFilePath: string,
  localDir: string,
): string {
  const lines: string[] = [];
  lines.push(`---\n`);
  lines.push(`## ${entityDisplayName}\n`);
  lines.push(`**Entity ID:** \`${entityId}\`  `);
  lines.push(`**Files:** [analysis.json](${relLink(localDir, analysisFilePath)}) · [metadata.json](${relLink(localDir, metadataFilePath)})\n`);

  /*
  // Statute sources from ruleset (metadata.json)
  lines.push("### Statute Sources\n");
  if (!ruleset || ruleset.sources.length === 0) {
    lines.push("_No statute sources found._\n");
  } else {
    if (ruleset.homePage) lines.push(`**Home page:** [${ruleset.homePage}](${ruleset.homePage})  `);
    if (ruleset.statuteNumber) lines.push(`**Statute number:** ${ruleset.statuteNumber}  `);
    lines.push("");
    for (const s of ruleset.sources) {
      const typeTag = s.type ? ` \`${s.type}\`` : "";
      const label = s.title || s.sourceUrl;
      const localPart = s.downloadedFilename
        ? ` — [local](${relLink(localDir, path.join(path.dirname(metadataFilePath), s.downloadedFilename))})` : "";
      lines.push(`- [${label}](${s.sourceUrl})${typeTag}${localPart}`);
    }
    lines.push("");
  }

  // Crawled sources from analysis + history
  lines.push("### Sources\n");
  if (sources.length === 0) {
    lines.push("_No sources found._\n");
  } else {
    for (const s of sources) {
      const localPart = s.localFilePath ? ` — [local](${relLink(localDir, s.localFilePath)})` : "";
      lines.push(`- [${s.title || s.url}](${s.url})${localPart}`);
    }
    lines.push("");
  }
  */

  // Analysis
  if (!analysis) {
    lines.push("### Analysis\n");
    lines.push("_No analysis available._\n");
    return lines.join("\n");
  }

  const overallScore =
    analysis.overallScore ?? analysis.scores?.overallScore ?? analysis.normalizedScore ?? null;
  const analyzedAt = analysis.metadata?.analysisDate ?? analysis.lastUpdated ?? null;

  lines.push("### Analysis\n");
  if (overallScore !== null) {
    lines.push(`**Overall score:** ${scoreBar(overallScore)}`);
  }
  if (analyzedAt) {
    lines.push(`**Analyzed at:** ${analyzedAt}`);
  }
  lines.push("");

  // Build a lookup so we can match questions by id
  const questionMap = new Map(questions.map((q) => [q.id, q]));

  for (const aq of analysis.questions ?? []) {
    const qid = getQuestionId(aq);
    const baseQ = qid ? questionMap.get(Number(qid)) : undefined;
    const category = baseQ?.category || `Q${qid}`;

    lines.push(`#### ${category}\n`);

    const score = (aq as any).score;
    const conf = aq.confidence;
    const gap = aq.gap ?? (aq as any).gapAnalysis;

    const answerCell = tableCell(aq.answer || "—");
    const sourcesCell = Array.isArray(aq.sourceRefs) && aq.sourceRefs.length > 0
      ? tableCell(aq.sourceRefs.map((r) => (typeof r === "string" ? r : (r as any).name ?? JSON.stringify(r))).join("; "))
      : tableCell(aq.sourceReference || "—");

    lines.push(`| Score | Confidence | Answer | Sources |`);
    lines.push(`|-------|------------|--------|---------|`);
    lines.push(`| ${scoreBar(score)} | ${confidenceLabel(conf)} | ${answerCell} | ${sourcesCell} |\n`);

    if (gap) {
      lines.push(`**Gap:** ${tableCell(gap)}\n`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Score distribution summary
// ---------------------------------------------------------------------------

interface QuestionScoreData {
  text: string;
  category?: string;
  scores: number[];
  naCount: number;
  bestEntity: { displayName: string; score: number } | null;
}

function renderScoreDistribution(
  questions: Question[],
  questionScores: Map<string, QuestionScoreData>,
  entityScores: Array<{ displayName: string; score: number; lowConfidence: boolean }>,
  noDataCount: number,
): string {
  const lines: string[] = ["---\n", "## Score Distribution\n"];

  // Overall scores across entities
  if (entityScores.length > 0) {
    lines.push("### Overall Scores by Entity\n");
    const sorted = [...entityScores].sort((a, b) => b.score - a.score);
    const hasLowConf = sorted.some((e) => e.lowConfidence);
    lines.push("| Entity | Score |");
    lines.push("|--------|-------|");
    for (const e of sorted) {
      const label = e.lowConfidence ? `${e.displayName} \\*` : e.displayName;
      lines.push(`| ${label} | ${scoreBar(e.score)} |`);
    }
    const avg = entityScores.reduce((s, e) => s + e.score, 0) / entityScores.length;
    const min = Math.min(...entityScores.map((e) => e.score));
    const max = Math.max(...entityScores.map((e) => e.score));
    lines.push(`\n**Avg:** ${scoreBar(avg)} · **Min:** ${scoreBar(min)} · **Max:** ${scoreBar(max)}\n`);
    if (hasLowConf) lines.push("\\* Score > 0 but average confidence ≤ 10% — treat with caution.\n");
  }

  // Per-question distribution table (quartile buckets)
  const orderedQIds: string[] = [];
  {
    const seenIds = new Set<string>();
    for (const qid of [...questions.map((q) => String(q.id)), ...questionScores.keys()]) {
      if (!seenIds.has(qid) && questionScores.get(qid)?.scores.length) {
        seenIds.add(qid);
        orderedQIds.push(qid);
      }
    }
  }

  if (orderedQIds.length > 0) {
    lines.push("### Per-Question Score Distribution\n");
    lines.push("| Q# | Category | Count | Avg | Min | Max | 0–25% | 25–50% | 50–75% | 75–100% | n/a |");
    lines.push("|----|----------|-------|-----|-----|-----|-------|--------|--------|---------|-----|");

    for (const qid of orderedQIds) {
      const { text, category, scores, naCount } = questionScores.get(qid)!;
      const label = category || text;
      const avg = scores.length > 0 ? scores.reduce((s, n) => s + n, 0) / scores.length : 0;
      const min = scores.length > 0 ? Math.min(...scores) : 0;
      const max = scores.length > 0 ? Math.max(...scores) : 0;
      const b0 = scores.filter((s) => s < 2.5).length;
      const b1 = scores.filter((s) => s >= 2.5 && s < 5.0).length;
      const b2 = scores.filter((s) => s >= 5.0 && s < 7.5).length;
      const b3 = scores.filter((s) => s >= 7.5).length;
      const shortText = label.length > 60 ? label.slice(0, 57) + "…" : label;
      lines.push(`| ${qid} | ${shortText} | ${scores.length} | ${scoreBar(avg)} | ${scoreBar(min)} | ${scoreBar(max)} | ${b0} | ${b1} | ${b2} | ${b3} | ${naCount} |`);
    }
    lines.push("");
  }

  // Decile distribution table — rows = Overall + each question, columns = decile buckets
  if (orderedQIds.length > 0 || entityScores.length > 0) {
    lines.push("### Decile Distribution\n");

    const decileLabels = ["0–10%", "10–20%", "20–30%", "30–40%", "40–50%",
                          "50–60%", "60–70%", "70–80%", "80–90%", "90–100%"];

    const bucketCount = (scores: number[], d: number) => {
      const lo = d;
      const hi = d === 9 ? 10.001 : d + 1;
      return scores.filter((s) => s >= lo && s < hi).length;
    };

    lines.push(`| Question | ${decileLabels.join(" | ")} | No data | Best |`);
    lines.push(`|----------|${decileLabels.map(() => "------").join("|")}|---------|------|`);

    // Overall row
    if (entityScores.length > 0) {
      const overallScores = entityScores.map((e) => e.score);
      const deciles = Array.from({ length: 10 }, (_, d) => bucketCount(overallScores, d));
      const best = entityScores.reduce((a, b) => b.score > a.score ? b : a);
      lines.push(`| **Overall** | ${deciles.join(" | ")} | ${noDataCount} | ${best.displayName} (${scoreBar(best.score)}) |`);
    }

    // Per-question rows
    for (const qid of orderedQIds) {
      const { text, category, scores, naCount, bestEntity } = questionScores.get(qid)!;
      const label = category || text;
      const deciles = Array.from({ length: 10 }, (_, d) => bucketCount(scores, d));
      const shortText = label.length > 50 ? label.slice(0, 47) + "…" : label;
      const bestCell = bestEntity ? `${bestEntity.displayName} (${scoreBar(bestEntity.score)})` : "—";
      lines.push(`| Q${qid}: ${shortText} | ${deciles.join(" | ")} | ${naCount} | ${bestCell} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Per-domain report generation
// ---------------------------------------------------------------------------

async function generateDomainReport(
  realmId: string,
  domainId: string,
  entityById: Map<string, any>,
  realmDir: string,
  localDir: string,
  storage: ReturnType<typeof getDefaultStorage>,
  realm: any,
): Promise<void> {
  const [domain, questions] = await Promise.all([
    storage.getDomain(domainId),
    storage.getQuestionsByDomain(domainId),
  ]);

  if (!domain) {
    console.warn(`  Domain not found in storage: ${domainId} — skipping`);
    return;
  }

  console.log(`\nDomain: ${domain.displayName} (${domainId})`);
  console.log(`  Questions: ${questions.length}`);

  // --- Collect entity IDs that have analysis data for this domain ---
  const analysisEntityIds = new Set(await storage.listEntityIds(domainId));

  // --- Also collect entity IDs that have history records for this domain ---
  const entityDownloadsDir = path.join(realmDir, "EntityDownloads");
  const historyEntityIds = new Set<string>();
  if (await fs.pathExists(entityDownloadsDir)) {
    const entries = await fs.readdir(entityDownloadsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const histSources = await loadDomainHistorySources(realmDir, entry.name, domainId);
      if (histSources.length > 0) historyEntityIds.add(entry.name);
    }
  }

  const allEntityIds = new Set([...analysisEntityIds, ...historyEntityIds]);

  if (allEntityIds.size === 0) {
    console.warn(`  No entities with data — skipping report`);
    return;
  }

  console.log(`  Entities with data: ${allEntityIds.size}`);

  // Build question lookup for category resolution
  const questionByIdMap = new Map(questions.map((q) => [String(q.id), q]));

  // --- Build report ---
  const reportLines: string[] = [];
  reportLines.push(`# Domain Report: ${domain.displayName}\n`);
  reportLines.push(`**Domain ID:** \`${domainId}\`  `);
  reportLines.push(`**Realm:** \`${realmId}\`  `);
  reportLines.push(`**Generated:** ${new Date().toLocaleString()}  `);
  if (domain.description) {
    reportLines.push(`\n${domain.description}\n`);
  }
  reportLines.push("");

  const questionsFilePath = path.join(realmDir, domainId, "questions.json");

  // --- Per-entity sections ---
  let entitiesUpdated = 0;
  let noDataCount = 0;
  const questionScores = new Map<string, QuestionScoreData>();
  const entityScores: Array<{ displayName: string; score: number; lowConfidence: boolean }> = [];
  const entitySections: string[] = [];
  const allEntityAnswerData: EntityAnswerData[] = [];

  for (const entityId of [...allEntityIds].sort()) {
    const entity = entityById.get(entityId);
    const displayName = entity?.displayName ?? entityId;

    const [analysis, historySources, ruleset] = await Promise.all([
      storage.getAnalysis(domainId, entityId),
      loadDomainHistorySources(realmDir, entityId, domainId),
      storage.getRuleset(domainId, entityId),
    ]);

    if (analysis) {
      const fixes: string[] = [];

      if (!analysis.entityId && !analysis.municipality?.id && !analysis.entity?.id) {
        if (!analysis.questions?.length) {
          console.log(`  Skipping ${entityId}: analysis.json has no entityId and no questions`);
          continue;
        }
        analysis.entityId = entityId;
        fixes.push("entityId");
      }

      if (!analysis.domainId) {
        analysis.domainId = domainId;
        fixes.push("domainId");
      }

      if (fixes.length > 0) {
        console.log(`  Fixing ${entityId}: backfilling ${fixes.join(", ")}`);
        try {
          await storage.saveAnalysis(analysis as any);
        } catch (err) {
          console.error(`  Failed to save fixed analysis for ${entityId}:`, err);
        }
      }
    }

    const analysisSources: SourceLink[] = (analysis?.sources ?? []).map((s) => ({
      url: (s as any).url ?? (s as any).sourceUrl ?? "",
      title: (s as any).title ?? "",
    }));

    const { merged: mergedSources, changed } = mergeSources(analysisSources, historySources);

    if (changed && analysis) {
      const updated: Analysis = { ...analysis, sources: mergedSources };
      try {
        await storage.saveAnalysis(updated as any);
        entitiesUpdated++;
        console.log(`  Updated sources for ${entityId} (+${mergedSources.length - analysisSources.length} from history)`);
      } catch (error) {
        console.error(`  Failed to update sources for ${entityId}:`, error);
      }
    }

    // Collect answer matrix data
    if (analysis) {
      const answers = new Map<string, { shortAnswer: string; confidence: number }>();
      for (const aq of analysis.questions ?? []) {
        const qid = String(getQuestionId(aq));
        answers.set(qid, {
          shortAnswer: (aq as any).shortAnswer ?? "",
          confidence: aq.confidence ?? 0,
        });
      }
      allEntityAnswerData.push({ displayName, answers });
    }

    // Collect scores for distribution summary
    if (!analysis) {
      noDataCount++;
    } else {
      const overall = analysis.overallScore ?? analysis.scores?.overallScore ?? analysis.normalizedScore;
      if (overall !== undefined && overall !== null) {
        const avgConf = analysis.scores?.averageConfidence ?? null;
        const lowConfidence = overall > 0 && avgConf !== null && avgConf <= 10;
        entityScores.push({ displayName, score: overall, lowConfidence });
      } else {
        noDataCount++;
      }
      for (const aq of analysis.questions ?? []) {
        const qid = String(getQuestionId(aq));
        const raw = (aq as any).score;
        if (!questionScores.has(qid)) {
          const baseQ = questionByIdMap.get(qid);
          questionScores.set(qid, { text: aq.question, category: baseQ?.category, scores: [], naCount: 0, bestEntity: null });
        }
        const entry = questionScores.get(qid)!;
        if (aq.answer === NO_SOURCES_AVAILABLE || aq.answer === NOT_SPECIFIED) {
          entry.naCount++;
        } else {
          const normalised = (raw ?? 0) * 10;
          entry.scores.push(normalised);
          if (!entry.bestEntity || normalised > entry.bestEntity.score) {
            entry.bestEntity = { displayName, score: normalised };
          }
        }
      }
    }

    const sourcesForReport = mergedSources.length > 0 ? mergedSources : historySources;

    const analysisFilePath = path.join(realmDir, domainId, entityId, "analysis.json");
    const metadataFilePath = path.join(realmDir, domainId, entityId, "metadata.json");
    entitySections.push(
      renderEntitySection(entityId, displayName, sourcesForReport, analysis, questions, ruleset, analysisFilePath, metadataFilePath, localDir),
    );
  }

  reportLines.push(renderAnswerMatrix(questions, allEntityAnswerData));
  reportLines.push(renderScoreDistribution(questions, questionScores, entityScores, noDataCount));
  reportLines.push(renderQuestions(questions, questionsFilePath, localDir));

  const entityTypeLabel = realm?.entityType ?? "Entities";
  reportLines.push(`---\n`);
  reportLines.push(`## ${entityTypeLabel} details\n`);
  reportLines.push(...entitySections);

  const reportPath = path.join(localDir, `report-${domainId}.md`);
  await fs.writeFile(reportPath, reportLines.join("\n"), "utf-8");

  console.log(`  Report written to: ${reportPath}`);
  if (entitiesUpdated > 0) {
    console.log(`  Sources copied from history.json into analysis.json for ${entitiesUpdated} entities.`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const { common } = parseCommonCliArgs(process.argv.slice(2));

  if (!common.realm) {
    console.error("Missing required argument: --realm <realmId>  (or set CURRENT_REALM)");
    process.exit(1);
  }

  const realmId = common.realm;
  const storage = getDefaultStorage(realmId);
  const realmDir = storage.getRealmDir();

  const localDir = path.join(process.cwd(), "local");
  await fs.mkdir(localDir, { recursive: true });

  const [entities, realm] = await Promise.all([
    storage.getEntities(),
    storage.getRealm(realmId),
  ]);
  const entityById = new Map(entities.map((e) => [e.id, e]));

  if (common.domain) {
    // Single domain mode
    await generateDomainReport(realmId, common.domain, entityById, realmDir, localDir, storage, realm);
  } else {
    // All-domains mode
    const domainIds = await storage.listDomainIds();
    const reportable = domainIds.filter((id) => id !== "EntityDownloads");
    console.log(`No domain specified — generating reports for ${reportable.length} domain(s): ${reportable.join(", ")}`);
    for (const domainId of reportable) {
      await generateDomainReport(realmId, domainId, entityById, realmDir, localDir, storage, realm);
    }
    console.log(`\nDone. Reports written to: ${localDir}`);
  }
}

const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isEntrypoint) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
