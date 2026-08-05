#!/usr/bin/env tsx
/**
 * Proof-of-concept CLI for querying the LOCUS-v1 local-ordinance dataset
 * (https://huggingface.co/datasets/LocalLaws/LOCUS-v1).
 *
 * Query-building and shard-download logic lives in ./locusClient.ts, shared
 * with lib/populateStatutesFromLocus.ts. This file is CLI-only: arg parsing,
 * help text, and text/JSON output formatting.
 */

import {
  type LocusQueryArgs,
  countLocus,
  ensureLocalShards,
  highlightMatches,
  queryLocus,
  snippet,
} from "./locusClient.js";

interface Args extends LocusQueryArgs {
  format: "text" | "json";
  full: boolean;
  showScores: boolean;
  forceDownload: boolean;
  count: boolean;
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
  --keywords <k1,k2,...>   Comma-separated terms to search in header/content (required
                              unless --count is given)
                              Matching is left-word-boundary, not exact: "tree" also matches
                              "trees"/"treehouse". Use --nostem for an exact whole-word match.
  --nostem                 Match keywords as exact whole words (no suffix matching), e.g.
                              "rat" won't also match "rate"/"ratify"/"rational"
  --match-all              Require every keyword to match (default: any keyword matches)
  --count                  Print only the count of matching rows (no rows fetched/printed).
                              Can be combined with --keywords, or used alone with just
                              --state/--county/--city to count all matches for those filters.
  --limit <n>              Max rows to return (default: 50, ignored with --count)
  --all-functions          Include non-substantive chunks (Context/Process); default is substantive-only
  --full                   Print full ordinance text instead of a snippet
  --scores                 Print the enforcement_discretion/opacity/paternalism/problem_salience scores
  --format <text|json>     Output format (default: text)
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
      if (value !== "text" && value !== "json") {
        throw new Error("--format must be 'text' or 'json'");
      }
      args.format = value;
      i += 1;
      continue;
    }
    if (arg === "--force-download") {
      args.forceDownload = true;
      continue;
    }
  }

  if (args.keywords.length === 0 && !args.count) {
    throw new Error("Missing required argument: --keywords <term1,term2,...> (or use --count)");
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

export async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const args = parseArgs(process.argv.slice(2));

  await ensureLocalShards(args.forceDownload);

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
