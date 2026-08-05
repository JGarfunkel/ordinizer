/**
 * Shared query/download internals for the LOCUS-v1 local-ordinance dataset
 * (https://huggingface.co/datasets/LocalLaws/LOCUS-v1).
 *
 * LOCUS-v1 ships as 8 parquet shards with no per-state split and no
 * hosted query API, so this module downloads the shards once to a local
 * cache (app/analyzer/tmp/locus-cache) and queries them with DuckDB.
 *
 * The dataset has no statute-number or source-URL column, so results are
 * jurisdiction + ordinance-text leads to cross-reference against the
 * existing entity list / spider pipeline, not citable statutes on their own.
 *
 * Pure data-access/query-building only — no CLI parsing, no console output.
 * Consumers: lib/queryLocus.ts (CLI) and lib/populateStatutesFromLocus.ts (pipeline).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import { DuckDBInstance } from "@duckdb/node-api";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const HF_DATASET = "LocalLaws/LOCUS-v1";
export const HF_BASE_URL = `https://huggingface.co/datasets/${HF_DATASET}/resolve/main/data`;
export const NUM_SHARDS = 8;
export const CACHE_DIR = path.join(__dirname, "..", "tmp", "locus-cache");

export const US_STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
  montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "district of columbia": "DC",
};

export interface LocusQueryArgs {
  state?: string;
  county?: string;
  city?: string;
  keywords: string[];
  matchAll: boolean;
  nostem: boolean;
  limit: number;
  substantiveOnly: boolean;
}

export interface LocusRow {
  state: string | null;
  county: string | null;
  city: string | null;
  source_jurisdiction_type: string | null;
  function: string | null;
  topic: string | null;
  is_substantive: boolean | null;
  header: string | null;
  content: string | null;
  enforcement_discretion: number | null;
  opacity: number | null;
  paternalism: number | null;
  problem_salience: number | null;
}

function shardUrl(index: number): string {
  const shard = String(index).padStart(5, "0");
  return `${HF_BASE_URL}/train-${shard}-of-00008.parquet`;
}

function shardPath(index: number): string {
  const shard = String(index).padStart(5, "0");
  return path.join(CACHE_DIR, `train-${shard}-of-00008.parquet`);
}

export async function ensureLocalShards(forceDownload: boolean): Promise<void> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  for (let i = 0; i < NUM_SHARDS; i += 1) {
    const dest = shardPath(i);
    if (!forceDownload && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      continue;
    }

    const url = shardUrl(i);
    console.log(`Downloading shard ${i + 1}/${NUM_SHARDS}: ${url}`);
    const response = await axios.get(url, { responseType: "stream" });
    const tmpDest = `${dest}.download`;
    await new Promise<void>((resolve, reject) => {
      const writer = fs.createWriteStream(tmpDest);
      response.data.pipe(writer);
      writer.on("finish", resolve);
      writer.on("error", reject);
      response.data.on("error", reject);
    });
    fs.renameSync(tmpDest, dest);
  }
}

export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Left word-boundary match by default ("tree" also matches "trees"/"treehouse");
// --nostem anchors the right side too for an exact whole-word match.
export function keywordPatternSource(kw: string, nostem: boolean): string {
  const rightBoundary = nostem ? "\\b" : "";
  return `\\b${escapeRegex(kw)}${rightBoundary}`;
}

export function buildKeywordRegex(keywords: string[], nostem: boolean): RegExp {
  const alternatives = keywords.map((kw) => keywordPatternSource(kw, nostem));
  return new RegExp(`(?:${alternatives.join("|")})`, "gi");
}

export function highlightMatches(text: string, keywords: string[], nostem: boolean): string {
  return text.replace(buildKeywordRegex(keywords, nostem), (match) => `**${match}**`);
}

export function resolveStateVariants(input: string): string[] {
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();
  const variants = new Set<string>([trimmed]);

  if (US_STATES[lower]) {
    variants.add(US_STATES[lower]);
  }
  for (const [name, abbr] of Object.entries(US_STATES)) {
    if (abbr.toLowerCase() === lower) {
      variants.add(name);
    }
  }

  return Array.from(variants);
}

// LOCUS's city/county columns are lowercase and punctuation/whitespace-stripped
// (e.g. "newyorkcity", "albany") — normalize free-text entity names to match.
export function normalizeLocusToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function buildWhereClause(args: LocusQueryArgs): string {
  const conditions: string[] = [];

  if (args.substantiveOnly) {
    conditions.push("is_substantive = true");
  }

  if (args.state) {
    const variants = resolveStateVariants(args.state)
      .map((v) => `upper(state) = upper('${escapeSqlLiteral(v)}')`)
      .join(" OR ");
    conditions.push(`(${variants})`);
  }

  if (args.county) {
    conditions.push(`county ILIKE '%${escapeSqlLiteral(args.county)}%'`);
  }

  if (args.city) {
    conditions.push(`city ILIKE '%${escapeSqlLiteral(args.city)}%'`);
  }

  // Left word-boundary match (\bterm) rather than plain substring: a bare
  // ILIKE '%tree%' also matches "street", '%rat%' also matches "narrate", etc.
  // --nostem anchors the right side too (\bterm\b) for an exact whole-word
  // match, since the default also lets "tree" match "trees" and "rat" match "rate".
  // Keywords are optional: a count with no --keywords just applies the other filters.
  if (args.keywords.length > 0) {
    const keywordClauses = args.keywords.map((kw) => {
      const pattern = escapeSqlLiteral(keywordPatternSource(kw, args.nostem));
      return `(regexp_matches(header, '${pattern}', 'i') OR regexp_matches(content, '${pattern}', 'i'))`;
    });
    conditions.push(`(${keywordClauses.join(args.matchAll ? " AND " : " OR ")})`);
  }

  return conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
}

export function buildQuery(args: LocusQueryArgs): string {
  const globPath = path.join(CACHE_DIR, "*.parquet").replace(/\\/g, "/");
  const whereClause = buildWhereClause(args);

  return `
    SELECT state, county, city, source_jurisdiction_type, function, topic,
           is_substantive, header, content,
           enforcement_discretion, opacity, paternalism, problem_salience
    FROM read_parquet('${globPath}')
    ${whereClause}
    LIMIT ${args.limit}
  `;
}

export function buildCountQuery(args: LocusQueryArgs): string {
  const globPath = path.join(CACHE_DIR, "*.parquet").replace(/\\/g, "/");
  const whereClause = buildWhereClause(args);

  return `
    SELECT COUNT(*) AS count
    FROM read_parquet('${globPath}')
    ${whereClause}
  `;
}

export async function queryLocus(args: LocusQueryArgs): Promise<LocusRow[]> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  const sql = buildQuery(args);
  const reader = await connection.runAndReadAll(sql);
  return reader.getRowObjects() as unknown as LocusRow[];
}

export async function countLocus(args: LocusQueryArgs): Promise<number> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  const sql = buildCountQuery(args);
  const reader = await connection.runAndReadAll(sql);
  const [row] = reader.getRowObjects() as unknown as { count: bigint | number }[];
  return Number(row?.count ?? 0);
}

// Centers the excerpt on the first keyword match (rather than always chars
// 0-400) so the snippet actually contains what it matched on; falls back to
// a leading excerpt if the match was only in the header, not the content.
export function snippet(content: string, keywords: string[], nostem: boolean, full: boolean): string {
  if (full) {
    return content;
  }
  if (content.length <= 400) {
    return content;
  }

  const match = buildKeywordRegex(keywords, nostem).exec(content);
  if (!match) {
    return `${content.slice(0, 400)}...`;
  }

  const start = Math.max(0, match.index - 150);
  const end = Math.min(content.length, match.index + match[0].length + 250);
  let excerpt = content.slice(start, end);
  if (start > 0) {
    excerpt = `...${excerpt}`;
  }
  if (end < content.length) {
    excerpt = `${excerpt}...`;
  }
  return excerpt;
}
