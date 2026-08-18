#!/usr/bin/env tsx
/**
 * Proof-of-concept CLI for querying the LOCUS-v1 local-ordinance dataset
 * (https://huggingface.co/datasets/LocalLaws/LOCUS-v1).
 *
 * Query-building and shard-download logic lives in ./locusClient.ts, shared
 * with lib/populateStatutesFromLocus.ts. This file is CLI-only: arg parsing,
 * help text, and text/JSON output formatting.
 */

import fs from "fs";

import {
  type LocusQueryArgs,
  countLocus,
  countLocusMany,
  ensureLocalShards,
  highlightMatches,
  normalizeLocusToken,
  queryLocus,
  snippet,
} from "./locusClient.js";

interface Args extends LocusQueryArgs {
  format: "text" | "json" | "csv" | "md";
  full: boolean;
  showScores: boolean;
  forceDownload: boolean;
  count: boolean;
  entitiesFile?: string;
  outFile?: string;
}

interface GovEntity {
  id: string;
  name: string;
  type: "County" | "City" | "Town" | "Village";
  county?: string;
  town?: string;
  parentIds: string[];
  swis: string;
  gnisId: string;
}

interface GovEntities {
  entities: GovEntity[];
  lastUpdated: string;
  totalEntities: number;
  source: string;
}

function printHelp() {
  console.log(`
Query the LOCUS-v1 local-ordinance dataset (downloads a local parquet cache on first run).

Usage:
  tsx lib/queryLocus.ts --state <name-or-abbr> --keywords <comma,separated,terms> [options]

Options:
  --state <state>          Filter by US state, e.g. "NY" or "New York"
  --county <name>          Filter by county (substring, case-insensitive)
  --city <name>            Filter by city (substring, case-insensitive)
  --jtype <type>            Filter by source_jurisdiction_type (substring, case-insensitive)
  --keywords <k1,k2,...>   Comma-separated terms to search in header/content (required
                              unless --count or --entities is given)
                              Matching is left-word-boundary, not exact: "tree" also matches
                              "trees"/"treehouse". Use --nostem for an exact whole-word match.
  --nostem                 Match keywords as exact whole words (no suffix matching), e.g.
                              "rat" won't also match "rate"/"ratify"/"rational"
  --match-all              Require every keyword to match (default: any keyword matches)
  --count                  Print only the count of matching rows (no rows fetched/printed).
                              Can be combined with --keywords, or used alone with just
                              --state/--county/--city to count all matches for those filters.
  --entities <path>        Path to a GovEntities JSON file ({ entities: [{ id, name, type,
                              county?, ... }] }). For each entity, counts matching LOCUS chunks
                              in that entity's jurisdiction (optionally filtered by --keywords)
                              instead of running a single query. State is inferred from each
                              entity's id prefix (e.g. "NY-Albany-County" -> state "NY").
                              Ignores --state/--county/--city; overrides --count/--limit.
  --out <path>              Write output to this file instead of stdout (used with --entities,
                              or any --format)
  --limit <n>              Max rows to return (default: 50, ignored with --count/--entities)
  --all-functions          Include non-substantive chunks (Context/Process); default is substantive-only
  --full                   Print full ordinance text instead of a snippet
  --scores                 Print the enforcement_discretion/opacity/paternalism/problem_salience scores
  --format <text|json|csv|md>  Output format (default: text). csv/md require --entities.
  --force-download         Re-download parquet shards even if already cached
  --help, -h               Show this help
`);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    keywords: [],
    matchAll: false,
    nostem: false,
    limit: 50,
    substantiveOnly: true,
    format: "text",
    full: false,
    showScores: false,
    forceDownload: false,
    count: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--state") {
      args.state = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--county") {
      args.county = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--city") {
      args.city = argv[i + 1];
      i += 1;
      continue;
    }
    // TODO add support for source_jurisdiction_type
    if (arg === "--source-type") {
      args.jtype = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--keywords") {
      args.keywords = (argv[i + 1] ?? "")
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k.length > 0);
      i += 1;
      continue;
    }
    if (arg === "--match-all") {
      args.matchAll = true;
      continue;
    }
    if (arg === "--count") {
      args.count = true;
      continue;
    }
    if (arg === "--nostem") {
      args.nostem = true;
      continue;
    }
    if (arg === "--limit") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value < 1) {
        throw new Error("--limit must be a positive integer");
      }
      args.limit = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === "--all-functions") {
      args.substantiveOnly = false;
      continue;
    }
    if (arg === "--full") {
      args.full = true;
      continue;
    }
    if (arg === "--scores") {
      args.showScores = true;
      continue;
    }
    if (arg === "--format") {
      const value = argv[i + 1];
      if (value !== "text" && value !== "json" && value !== "csv" && value !== "md") {
        throw new Error("--format must be one of 'text', 'json', 'csv', 'md'");
      }
      args.format = value;
      i += 1;
      continue;
    }
    if (arg === "--entities") {
      args.entitiesFile = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--out") {
      args.outFile = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--force-download") {
      args.forceDownload = true;
      continue;
    }
  }

  if (args.keywords.length === 0 && !args.count && !args.entitiesFile) {
    throw new Error("Missing required argument: --keywords <term1,term2,...> (or use --count/--entities)");
  }

  if ((args.format === "csv" || args.format === "md") && !args.entitiesFile) {
    throw new Error("--format csv/md is only supported together with --entities");
  }

  return args;
}

function printText(rows: Record<string, unknown>[], args: Args): void {
  if (rows.length === 0) {
    console.log("No matching ordinance chunks found.");
    return;
  }

  for (const row of rows) {
    console.log("─".repeat(70));
    console.log(`${row.state ?? "?"} / ${row.county ?? "?"} / ${row.city ?? "?"}  (${row.source_jurisdiction_type ?? "?"})`);
    console.log(`function: ${row.function}   topic: ${row.topic}   substantive: ${row.is_substantive}`);
    if (row.header) {
      console.log(`\n${highlightMatches(String(row.header), args.keywords, args.nostem)}`);
    }
    const excerpt = snippet(String(row.content ?? ""), args.keywords, args.nostem, args.full);
    console.log(`\n${highlightMatches(excerpt, args.keywords, args.nostem)}`);
    if (args.showScores) {
      console.log(
        `\nscores: enforcement_discretion=${row.enforcement_discretion} opacity=${row.opacity} paternalism=${row.paternalism} problem_salience=${row.problem_salience}`
      );
    }
  }
  console.log("─".repeat(70));
  console.log(`${rows.length} result(s).`);
}

interface EntityLawCount {
  id: string;
  name: string;
  type: GovEntity["type"];
  county?: string;
  lawCount: number;
}

// Entity ids are "<STATE>-<...>", e.g. "NY-Albany-County" -> "NY".
function stateFromEntityId(id: string): string | undefined {
  const match = /^([A-Za-z]{2})-/.exec(id);
  return match ? match[1] : undefined;
}

// LOCUS never populates county and city on the same row: county is only
// set on source_jurisdiction_type="counties" rows (city is null there),
// city only on "cities" rows (county is null there). So a County entity is
// looked up by --county alone, and City/Town/Village entities by --city
// alone — filtering by both would always yield zero rows. LOCUS has no
// "town" column, so a Village's own `town` field (its parent town) isn't
// used here either.
function buildEntityLocusArgs(entity: GovEntity, args: Args): LocusQueryArgs {
  const isCounty = entity.type === "County";
  return {
    state: stateFromEntityId(entity.id),
    county: isCounty ? normalizeLocusToken(entity.name) : undefined,
    city: isCounty ? undefined : normalizeLocusToken(entity.name),
    jtype: args.jtype,
    keywords: args.keywords,
    matchAll: args.matchAll,
    nostem: args.nostem,
    limit: args.limit,
    substantiveOnly: args.substantiveOnly,
  };
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function formatEntityResults(results: EntityLawCount[], format: Args["format"]): string {
  if (format === "json") {
    return JSON.stringify(results, null, 2);
  }

  if (format === "csv") {
    const header = "id,name,type,county,lawCount";
    const rows = results.map((r) =>
      [r.id, r.name, r.type, r.county ?? "", String(r.lawCount)].map(csvEscape).join(",")
    );
    return [header, ...rows].join("\n");
  }

  if (format === "md") {
    const header = "| ID | Name | Type | County | Law Count |";
    const sep = "| --- | --- | --- | --- | --- |";
    const rows = results.map((r) => `| ${r.id} | ${r.name} | ${r.type} | ${r.county ?? ""} | ${r.lawCount} |`);
    return [header, sep, ...rows].join("\n");
  }

  const lines = results.map(
    (r) => `${String(r.lawCount).padStart(6)}  ${r.id}  (${r.name}, ${r.type}${r.county ? `, ${r.county} County` : ""})`
  );
  const total = results.reduce((sum, r) => sum + r.lawCount, 0);
  lines.push("─".repeat(50));
  lines.push(`${results.length} entities, ${total} total law(s).`);
  return lines.join("\n");
}

const ENTITY_TYPES: GovEntity["type"][] = ["County", "City", "Town", "Village"];

function printEntitySummary(results: EntityLawCount[]): void {
  console.log("\nSummary — entities with LOCUS law(s) found:");
  for (const type of ENTITY_TYPES) {
    const ofType = results.filter((r) => r.type === type);
    if (ofType.length === 0) continue;
    const withLaws = ofType.filter((r) => r.lawCount > 0).length;
    console.log(`  ${type}: ${withLaws}/${ofType.length}`);
  }
  const withLaws = results.filter((r) => r.lawCount > 0).length;
  console.log(`  Total: ${withLaws}/${results.length}`);
}

async function runEntities(args: Args): Promise<void> {
  const raw = fs.readFileSync(args.entitiesFile!, "utf-8");
  const data = JSON.parse(raw) as GovEntities;

  const queryArgsList = data.entities.map((entity) => buildEntityLocusArgs(entity, args));
  const onProgress = args.outFile
    ? (completed: number, count: number) => {
        if (completed % 100 === 0 || completed === count) {
          console.log(`Progress: ${completed}/${count} entities analyzed...`);
        }
      }
    : undefined;
  const counts = await countLocusMany(queryArgsList, onProgress);

  const results: EntityLawCount[] = data.entities.map((entity, i) => ({
    id: entity.id,
    name: entity.name,
    type: entity.type,
    county: entity.county,
    lawCount: counts[i],
  }));

  const output = formatEntityResults(results, args.format);
  if (args.outFile) {
    fs.writeFileSync(args.outFile, output, "utf-8");
    console.log(`Wrote ${results.length} entit${results.length === 1 ? "y" : "ies"} to ${args.outFile}`);
  } else {
    console.log(output);
  }

  printEntitySummary(results);
}

export async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const args = parseArgs(process.argv.slice(2));

  await ensureLocalShards(args.forceDownload);

  if (args.entitiesFile) {
    await runEntities(args);
    return;
  }

  if (args.count) {
    const count = await countLocus(args);
    if (args.format === "json") {
      console.log(JSON.stringify({ count }, null, 2));
    } else {
      console.log(`${count} matching ordinance chunk(s).`);
    }
    return;
  }

  const rows = await queryLocus(args);

  if (args.format === "json") {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    printText(rows as unknown as Record<string, unknown>[], args);
  }
}

const entryFile = process.argv[1] ? process.argv[1].replace(/\\/g, "/") : "";
const isCliEntrypoint = /(^|\/)queryLocus\.(ts|js)$/.test(entryFile);
if (isCliEntrypoint) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Script failed: ${message}`, error instanceof Error ? error.stack : undefined);
    process.exit(1);
  });
}
