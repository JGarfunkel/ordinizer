#!/usr/bin/env tsx
/**
 * Given one entity + one domain, search LOCUS-v1 for candidate ordinance
 * excerpts in that entity's jurisdiction, judge each candidate's relevance
 * to the domain with an LLM (gated by a cheap length/substantive filter
 * first), and persist accepted excerpts into metadata.json + statuteN.txt
 * files using the same Ruleset/RulesetSource read-modify-write pattern as
 * lib/addUrl.ts and lib/sourceDownloader.ts.
 *
 * LOCUS has no source URL, so accepted sources get a synthetic
 * `locus://state/county/city/<hash>` sourceUrl and `provenance: "locus"`,
 * distinguishing them from real spider-crawled sources. Ruleset.statuteNumber
 * (the single ruleset-level field the client renders) is never read or
 * written here — only the new per-source RulesetSource.statuteNumber is set.
 */

import dotenv from "dotenv";
dotenv.config();

import fs from "fs-extra";
import path from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { z } from "zod";

import type { Domain, Entity, Ruleset } from "@civillyengaged/ordinizer-core";
import { parseCommonCliArgs, requireDataRootAndRealm } from "./scriptArgs.js";
import { getDomainKeywords } from "./domainScoring.js";
import {
  type LocusQueryArgs,
  type LocusRow,
  ensureLocalShards,
  highlightMatches,
  normalizeLocusToken,
  queryLocus,
  snippet,
} from "./locusClient.js";
import {
  checkRateLimit,
  createResponseObjectWithAi,
  estimateTokens,
  recordTokenUsage,
  sleep,
  QUESTION_PAUSE_MS,
} from "../services/aiService.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StorageLike {
  getEntity(id: string): Promise<Entity | null | undefined>;
  getDomain(id: string): Promise<Domain | null | undefined>;
  getRulesetOrCreate(domainId: string, entityId: string): Promise<Ruleset>;
  saveRuleset(ruleset: Ruleset): Promise<Ruleset>;
  getRealmDir(): string;
}

interface PipelineArgs {
  dataRoot: string;
  realm: string;
  entityId: string;
  domainId: string;
  dryRun: boolean;
  force: boolean;
  limit: number;
  minConfidence: number;
  nostem: boolean;
  forceDownload: boolean;
  interactive: boolean;
}

const relevanceSchema = z.object({
  isRelevant: z.boolean(),
  confidence: z.number().int().min(0).max(100),
  reason: z.string(),
  suggestedStatuteNumber: z.string().optional(),
});

type RelevanceJudgment = z.infer<typeof relevanceSchema>;

interface AcceptedCandidate {
  row: LocusRow;
  judgment?: RelevanceJudgment;
}

class InteractiveAbort extends Error {}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`
populateStatutesFromLocus — search LOCUS-v1 for one entity+domain, judge
relevance with an LLM, and persist accepted excerpts into metadata.json +
statuteN.txt files.

Usage:
  tsx lib/populateStatutesFromLocus.ts --data-root <path> --realm <realm-id> --entity <entityId> --domain <domainId> [options]

Options:
  --data-root <path>        Path to the data root directory (or set DATA_ROOT env var)
  --realm <realm-id>        Realm to use (or set CURRENT_REALM env var)
  --entity <entityId>       Entity to search LOCUS for (required)
  --domain <domainId>       Domain whose keywords/description drive the LOCUS search (required)
  --dry-run                 Preview only. Without --interactive: tier-1 candidates only, no LLM
                                calls. With --interactive: runs the picker (LLM only if you use 'r'),
                                but never writes files or metadata.json.
  --force                   Re-run even if this ruleset already has LOCUS-sourced entries
  --limit <n>               Max LOCUS candidate rows to fetch (default: 50)
  --min-confidence <0-100>  LLM confidence floor required to persist a candidate (default: 60)
  --nostem                  Exact whole-word keyword matching (see lib/queryLocus.ts --nostem)
  --force-download          Re-download parquet shards even if already cached
  --interactive             Review tier-1 candidates by hand instead of auto-running the LLM
                                relevance check on all of them
  --help, -h                Show this help
`);
}

function parseArgs(argv: string[]): PipelineArgs {
  const { common, rest } = parseCommonCliArgs(argv);
  requireDataRootAndRealm(common);

  if (!common.entity) {
    throw new Error("Missing required argument: --entity <entityId>");
  }
  if (!common.domain) {
    throw new Error("Missing required argument: --domain <domainId>");
  }

  const args: PipelineArgs = {
    dataRoot: common.dataRoot,
    realm: common.realm,
    entityId: common.entity,
    domainId: common.domain,
    dryRun: common.dryRun,
    force: common.force,
    limit: 50,
    minConfidence: 60,
    nostem: false,
    forceDownload: false,
    interactive: false,
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--limit") {
      const value = Number(rest[i + 1]);
      if (!Number.isFinite(value) || value < 1) {
        throw new Error("--limit must be a positive integer");
      }
      args.limit = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === "--min-confidence") {
      const value = Number(rest[i + 1]);
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        throw new Error("--min-confidence must be between 0 and 100");
      }
      args.minConfidence = value;
      i += 1;
      continue;
    }
    if (arg === "--nostem") {
      args.nostem = true;
      continue;
    }
    if (arg === "--force-download") {
      args.forceDownload = true;
      continue;
    }
    if (arg === "--interactive") {
      args.interactive = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function resolveDataRoot(inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}

// ---------------------------------------------------------------------------
// Entity/domain -> LOCUS query args
// ---------------------------------------------------------------------------

function buildEntityLocusArgs(entity: Entity, domain: Domain, args: PipelineArgs): LocusQueryArgs {
  const keywords = getDomainKeywords(domain).slice(0, 20);
  if (keywords.length === 0) {
    throw new Error(
      `Domain ${domain.id} has no usable keywords for a LOCUS search (id/name/displayName/description/keywords are all empty after tokenizing).`
    );
  }

  const county = entity.county
    ? normalizeLocusToken(entity.county.replace(/\bcounty\b/i, "")) || undefined
    : undefined;

  return {
    state: entity.state,
    county,
    city: normalizeLocusToken(entity.name),
    keywords,
    matchAll: false,
    nostem: args.nostem,
    limit: args.limit,
    substantiveOnly: true,
  };
}

// ---------------------------------------------------------------------------
// Tier 1: cheap heuristic filter (no LLM)
// ---------------------------------------------------------------------------

function tier1Filter(rows: LocusRow[]): LocusRow[] {
  // is_substantive and the keyword match are already enforced by buildQuery's
  // SQL WHERE clause; this is just the "is there enough text here to be worth
  // an LLM call" floor, matching the 200-byte threshold in ensureStatutes.ts.
  return rows.filter((row) => (row.content ?? "").length >= 200);
}

// ---------------------------------------------------------------------------
// Tier 2: LLM relevance judgment
// ---------------------------------------------------------------------------

async function judgeRelevance(row: LocusRow, domain: Domain): Promise<RelevanceJudgment> {
  const systemPrompt = "You are judging whether a candidate municipal ordinance excerpt is actually substantively about a given topic/domain for a municipality's code. LOCUS chunks are pulled by keyword match and may be near-topic without being on-point (e.g. a definitions section that only mentions the word in passing, or a cross-reference). Return isRelevant=true only if the excerpt imposes or describes actual rules, requirements, or prohibitions about the domain. If a statute/section number is visible in the header or text, extract it into suggestedStatuteNumber.";

  const content = (row.content ?? "").slice(0, 3000);
  const userPrompt = `Domain: ${domain.displayName || domain.name} (${domain.id})
Domain description: ${domain.description || "(none)"}

Candidate ordinance excerpt:
Jurisdiction: ${row.city || row.county || "?"}, ${row.state ?? "?"}
Function: ${row.function ?? "?"}   Topic: ${row.topic ?? "?"}
Header: ${row.header ?? "(none)"}

Content:
${content}`;

  const maxCompletionTokens = 300;
  const estimated = estimateTokens(systemPrompt + userPrompt) + maxCompletionTokens;
  await checkRateLimit(estimated);

  const result = await createResponseObjectWithAi(systemPrompt, userPrompt, relevanceSchema, {
    temperature: 0.1,
    maxCompletionTokens,
  });

  recordTokenUsage(result.usage.totalTokens);
  await sleep(QUESTION_PAUSE_MS);

  return result.object;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function buildSyntheticLocusUrl(row: LocusRow): string {
  const hash = createHash("sha256")
    .update(`${row.header ?? ""}${row.content ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  const state = normalizeLocusToken(row.state ?? "") || "na";
  const county = normalizeLocusToken(row.county ?? "") || "na";
  const city = normalizeLocusToken(row.city ?? "") || "na";
  return `locus://${state}/${county}/${city}/${hash}`;
}

type AddOrUpdateSource = (ruleset: Ruleset, source: Ruleset["sources"][number]) => void;

async function persistAccepted(
  storage: StorageLike,
  addOrUpdateSource: AddOrUpdateSource,
  ruleset: Ruleset,
  entityDir: string,
  accepted: AcceptedCandidate[]
): Promise<void> {
  await fs.ensureDir(entityDir);
  let n = ruleset.sources.filter((s) => s.provenance === "locus").length;

  for (const { row, judgment } of accepted) {
    const url = buildSyntheticLocusUrl(row);
    // Re-persisting a row already present (e.g. a --force re-run) must reuse
    // its existing statuteN.txt slot — addOrUpdateSource dedupes by sourceUrl
    // and updates the entry in place, so allocating a fresh number here would
    // leave the old file orphaned on disk with nothing in metadata.json pointing to it.
    const existing = ruleset.sources.find((s) => s.sourceUrl === url);
    let filename = existing?.downloadedFilename;
    if (!filename) {
      n += 1;
      filename = `statute${n}.txt`;
    }
    await fs.writeFile(path.join(entityDir, filename), row.content ?? "", "utf-8");

    addOrUpdateSource(ruleset, {
      sourceUrl: url,
      downloadedAt: new Date().toISOString(),
      contentLength: (row.content ?? "").length,
      title: row.header || row.topic || "LOCUS ordinance excerpt",
      type: "statute",
      statuteNumber: judgment?.suggestedStatuteNumber,
      provenance: "locus",
      downloadedFilename: filename,
    });
  }

  await storage.saveRuleset(ruleset);
}

// ---------------------------------------------------------------------------
// Interactive picker
// ---------------------------------------------------------------------------

function printCandidateList(
  rows: LocusRow[],
  keywords: string[],
  nostem: boolean,
  judgments: Map<number, RelevanceJudgment>
): void {
  console.log("\nCandidates:");
  rows.forEach((row, i) => {
    const judgment = judgments.get(i);
    const verdict = judgment ? `  [${judgment.isRelevant ? "✓" : "✗"} ${judgment.confidence}%]` : "";
    console.log(`\n[${i + 1}] ${row.state ?? "?"}/${row.county ?? "-"}/${row.city ?? "?"} — ${row.header ?? "(no header)"}${verdict}`);
    if (judgment) {
      const statuteNote = judgment.suggestedStatuteNumber ? `  statute#: ${judgment.suggestedStatuteNumber}` : "";
      console.log(`     reason: ${judgment.reason}${statuteNote}`);
    }
    const excerpt = snippet(row.content ?? "", keywords, nostem, false);
    console.log(`     ${highlightMatches(excerpt, keywords, nostem).replace(/\n/g, "\n     ")}`);
  });
}

function printFullContent(rows: LocusRow[]): void {
  rows.forEach((row, i) => {
    console.log(`\n[${i + 1}] FULL TEXT — ${row.header ?? "(no header)"}\n${row.content ?? ""}`);
  });
}

async function runInteractivePicker(
  rl: ReturnType<typeof createInterface>,
  rows: LocusRow[],
  domain: Domain,
  keywords: string[],
  nostem: boolean,
  minConfidence: number
): Promise<{ selected: number[]; judgments: Map<number, RelevanceJudgment> }> {
  const judgments = new Map<number, RelevanceJudgment>();
  let proposed: number[] | null = null;

  printCandidateList(rows, keywords, nostem, judgments);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const answer = (
      await rl.question(
        "\nSelect ordinances to keep — comma-separated numbers (e.g. 1,3), 'all', 'none', 'r' to let the engine recommend, 'h' for help, 'x' to exit: "
      )
    ).trim().toLowerCase();

    if (answer === "x") {
      throw new InteractiveAbort("User exited interactive review.");
    }
    if (answer === "h") {
      printFullContent(rows);
      continue;
    }
    if (answer === "all") {
      return { selected: rows.map((_, i) => i), judgments };
    }
    if (answer === "none") {
      return { selected: [], judgments };
    }
    if (answer === "r") {
      for (let i = 0; i < rows.length; i += 1) {
        if (judgments.has(i)) continue;
        console.log(`Judging candidate ${i + 1}/${rows.length}...`);
        judgments.set(i, await judgeRelevance(rows[i], domain));
      }
      proposed = rows
        .map((_, i) => i)
        .filter((i) => {
          const j = judgments.get(i);
          return Boolean(j?.isRelevant) && (j?.confidence ?? 0) >= minConfidence;
        });
      printCandidateList(rows, keywords, nostem, judgments);
      console.log(`\nRecommended: ${proposed.length > 0 ? proposed.map((i) => i + 1).join(", ") : "(none)"}`);
      continue;
    }
    if (answer === "") {
      if (proposed !== null) {
        return { selected: proposed, judgments };
      }
      console.log("No selection made yet — enter numbers, 'all', 'none', or 'r' first.");
      continue;
    }

    const numbers = answer.split(",").map((s) => Number(s.trim()));
    if (numbers.some((n) => !Number.isInteger(n) || n < 1 || n > rows.length)) {
      console.log(`Invalid selection. Enter numbers between 1 and ${rows.length}, 'all', 'none', 'r', 'h', or 'x'.`);
      continue;
    }
    return { selected: numbers.map((n) => n - 1), judgments };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const args = parseArgs(process.argv.slice(2));
  const dataRoot = resolveDataRoot(args.dataRoot);
  process.env.DATA_ROOT = dataRoot;

  // extractionUtils.js itself statically imports ordinizer-servercore, whose
  // DEFAULT_DATA_ROOT is a module-level const read from process.env.DATA_ROOT
  // at import time — both imports must stay dynamic and happen after the env
  // var above is set, or --data-root silently falls back to "./data".
  const { getDefaultStorage } = await import("@civillyengaged/ordinizer-servercore");
  const { addOrUpdateSource } = await import("./extractionUtils.js");
  const storage = getDefaultStorage(args.realm) as unknown as StorageLike;

  const entity = await storage.getEntity(args.entityId);
  if (!entity) {
    throw new Error(`Entity not found: ${args.entityId}`);
  }
  const domain = await storage.getDomain(args.domainId);
  if (!domain) {
    throw new Error(`Domain not found: ${args.domainId}`);
  }

  const ruleset = await storage.getRulesetOrCreate(args.domainId, args.entityId);
  const alreadyHasLocus = (ruleset.sources ?? []).some((s) => s.provenance === "locus");
  if (alreadyHasLocus && !args.force) {
    console.log("Ruleset already has LOCUS-sourced entries; use --force to re-run. Skipping.");
    return;
  }

  const queryArgs = buildEntityLocusArgs(entity, domain, args);
  console.log(
    `LOCUS query: state=${queryArgs.state ?? "-"} county=${queryArgs.county ?? "-"} city=${queryArgs.city ?? "-"} keywords=[${queryArgs.keywords.join(", ")}]`
  );

  await ensureLocalShards(args.forceDownload);
  const allRows = await queryLocus(queryArgs);
  console.log(`Fetched ${allRows.length} candidate row(s) from LOCUS.`);

  const tier1Rows = tier1Filter(allRows);
  console.log(`${tier1Rows.length} candidate(s) passed tier-1 filtering (substantive, keyword match, >=200 chars).`);

  if (tier1Rows.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  if (args.dryRun && !args.interactive) {
    printCandidateList(tier1Rows, queryArgs.keywords, args.nostem, new Map());
    console.log(`\n[DRY RUN] ${tier1Rows.length} candidate(s) found; no LLM calls made, nothing persisted.`);
    return;
  }

  let accepted: AcceptedCandidate[] = [];

  if (args.interactive) {
    const rl = createInterface({ input, output });
    try {
      const { selected, judgments } = await runInteractivePicker(
        rl, tier1Rows, domain, queryArgs.keywords, args.nostem, args.minConfidence
      );
      accepted = selected.map((i) => ({ row: tier1Rows[i], judgment: judgments.get(i) }));
    } catch (err) {
      if (err instanceof InteractiveAbort) {
        console.log("Aborted — nothing persisted.");
        return;
      }
      throw err;
    } finally {
      rl.close();
    }
  } else {
    for (const row of tier1Rows) {
      const judgment = await judgeRelevance(row, domain);
      if (judgment.isRelevant && judgment.confidence >= args.minConfidence) {
        accepted.push({ row, judgment });
      }
    }
  }

  console.log(`${accepted.length} candidate(s) accepted.`);

  if (accepted.length === 0) {
    console.log("Nothing to persist.");
    return;
  }

  if (args.dryRun) {
    console.log(`\n[DRY RUN] Would persist ${accepted.length} source(s):`);
    accepted.forEach(({ row, judgment }, i) => {
      const note = judgment ? `confidence ${judgment.confidence}` : "manually selected, no LLM judgment";
      console.log(`  statute${i + 1}.txt — ${row.header ?? "(no header)"} (${note})`);
    });
    return;
  }

  const entityDir = path.join(storage.getRealmDir(), args.domainId, args.entityId);
  await persistAccepted(storage, addOrUpdateSource, ruleset, entityDir, accepted);
  console.log(`Persisted ${accepted.length} source(s) to ${entityDir}`);
}

const entryFile = process.argv[1] ? process.argv[1].replace(/\\/g, "/") : "";
const isCliEntrypoint = /(^|\/)populateStatutesFromLocus\.(ts|js)$/.test(entryFile);
if (isCliEntrypoint) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Script failed: ${message}`, error instanceof Error ? error.stack : undefined);
    process.exit(1);
  });
}
