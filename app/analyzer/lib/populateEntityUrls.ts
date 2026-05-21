#!/usr/bin/env tsx

import dotenv from "dotenv";
dotenv.config();
import fs from "fs-extra";
import path from "path";
import axios from "axios";
import { parseCommonCliArgs, requireDataRootAndRealm } from "./scriptArgs.js";
import { createChatCompletion } from "../services/aiService.js";
import { type Realm, Entity} from "@civillyengaged/ordinizer-core";


// confirm that it read process.env.DATA_ROOT and process.env.CURRENT_REALM correctly
console.log(`Using data root: ${process.env.DATA_ROOT}`);
console.log(`Using current realm: ${process.env.CURRENT_REALM}`);
console.log(`using openai key: ${process.env.OPENAI_API_KEY?.substring(0,10) }...`);

type UrlField = "mainUrl" | "governingUrl" | "authorityUrl";

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID || process.env.GOOGLE_SEARCH_ENGINE_ID;

interface UrlSuggestion {
  mainUrl: string | null;
  governingUrl: string | null;
  authorityUrl: string | null;
  notes?: string;
}

interface ParsedArgs {
  dataRoot: string;
  realm: string;
  domain?: string;
  entity?: string;
  dryRun: boolean;
  limit?: number;
  force: boolean;
  entityFile?: string;
}

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

function parseArgs(args: string[]): ParsedArgs {
  const { common, rest } = parseCommonCliArgs(args);
  requireDataRootAndRealm(common);

  const options: ParsedArgs = {
    dataRoot: common.dataRoot,
    realm: common.realm,
    domain: common.domain,
    entity: common.entity,
    dryRun: common.dryRun,
    force: common.force,
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--limit") {
      const value = Number(rest[i + 1]);
      if (!Number.isFinite(value) || value < 1) {
        throw new Error("--limit must be a positive integer");
      }
      options.limit = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === "--entity-file") {
      options.entityFile = rest[i + 1];
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function resolveDataRoot(inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}

function normalizeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

function hasRequiredUrls(entity: Entity): boolean {
  // authorityUrl is optional for smaller municipalities; main/governing are the minimum.
  return Boolean(entity.mainUrl && entity.governingUrl);
}

async function resolveEntityFile(storage: any, realm: Realm, options: ParsedArgs): Promise<string> {

  if (options.entityFile) {
    const absolute = path.isAbsolute(options.entityFile)
      ? options.entityFile
      : path.resolve(process.cwd(), options.entityFile);
    return absolute;
  }

  const fileName = realm.entityFile || "municipalities.json";
  const realmPath = path.join(storage.getRealmDir(), fileName);
  if (await fs.pathExists(realmPath)) return realmPath;

  throw new Error(`Could not locate entity file at ${realmPath}`);
}

async function fetchSuggestedUrls(
  entity: Entity,
  realm: Realm,
  domainContext?: string,
): Promise<UrlSuggestion> {

  const aiSuggestion = await fetchSuggestedUrlsFromAi(entity, realm, domainContext);

  return {
    mainUrl: aiSuggestion?.mainUrl || "",
    governingUrl: aiSuggestion?.governingUrl || "",
    authorityUrl: aiSuggestion?.authorityUrl || "",
    notes: aiSuggestion?.notes || "",
  };
}

async function fetchSuggestedUrlsFromAi(
  entity: Entity,
  realm: Realm,
  domainContext?: string,
): Promise<UrlSuggestion | null> {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  const geography = [realm.county, realm.stateProvince || entity.state].filter(Boolean).join(", ");
  const boardContext = domainContext
    ? `${domainContext} board or ${domainContext} advisory committee`
    : "advisory committee or board page relevant to this organization's governance";

  const prompt = `Return only JSON.
Given the ${entity.type} of ${entity.name} in ${geography || "the configured region"}, provide best-guess official URLs for:
1) mainUrl: official municipality homepage
2) governingUrl: ${boardContext}
3) authorityUrl: professional department page aligned to the domain if one exists, otherwise null

Output shape:
{
  "mainUrl": "https://...",
  "governingUrl": "https://...",
  "authorityUrl": "https://... or null",
  "notes": "optional short note"
}

Do not invent non-existent paths if uncertain; prefer higher-level official pages.`;

  console.debug(prompt);

  const response = await createChatCompletion(prompt);

  const content = response.text;
  if (!content) {
    return null;
  }

  const parsed = JSON.parse(content) as UrlSuggestion;
  return {
    mainUrl: normalizeUrl(parsed.mainUrl),
    governingUrl: normalizeUrl(parsed.governingUrl),
    authorityUrl: normalizeUrl(parsed.authorityUrl),
    notes: parsed.notes,
  };
}

async function validateUrl(url: string | null): Promise<boolean> {
  if (!url) return false;

  try {
    const headResponse = await axios.head(url, {
      maxRedirects: 5,
      timeout: 8000,
      headers: { "User-Agent": USER_AGENT },
      validateStatus: () => true,
    });

    if (headResponse.status >= 200 && headResponse.status < 400) {
      return true;
    }

    if (headResponse.status === 405) {
      const getResponse = await axios.get(url, {
        maxRedirects: 5,
        timeout: 8000,
        headers: { "User-Agent": USER_AGENT },
        validateStatus: () => true,
      });
      return getResponse.status >= 200 && getResponse.status < 400;
    }

    return false;
  } catch {
    return false;
  }
}

function pickUpdateValue(
  existing: string | undefined,
  suggested: string | null,
  validated: boolean,
  force: boolean,
): string | undefined {
  if (!suggested) return existing;
  if (!force && existing && existing.trim()) return existing;
  if (!validated) return existing;
  return suggested;
}

async function main() {
  const hasGoogleSearch = Boolean(GOOGLE_API_KEY && GOOGLE_CSE_ID);
  const hasOpenAi = Boolean(process.env.OPENAI_API_KEY);
  if (!hasGoogleSearch && !hasOpenAi) {
    throw new Error("Provide Google search credentials (GOOGLE_API_KEY + GOOGLE_CSE_ID) or OPENAI_API_KEY");
  }

  const options = parseArgs(process.argv.slice(2));
  const dataRoot = resolveDataRoot(options.dataRoot);
  process.env.DATA_ROOT = dataRoot;

  const { getDefaultStorage } = await import("@civillyengaged/ordinizer-servercore");
  const storage = getDefaultStorage(options.realm);
  const realm = (await storage.getRealmConfig()) as Realm;
  const entitiesPath = await resolveEntityFile(storage, realm, options);

  const payload = (await fs.readJson(entitiesPath)) as { entities?: Entity[] };
  const entities = (payload.entities || []) as Entity[];

  if (entities.length === 0) {
    throw new Error(`No entities found in ${entitiesPath}`);
  }

  let candidates = entities;
  if (options.entity) {
    candidates = candidates.filter((e) => e.id === options.entity);
  }

  if (!options.force) {
    candidates = candidates.filter((e) => !hasRequiredUrls(e));
  }

  if (options.limit) {
    candidates = candidates.slice(0, options.limit);
  }

  console.log(`Entity file: ${entitiesPath}`);
  console.log(`Total entities: ${entities.length}`);
  console.log(`Candidates: ${candidates.length}`);

  let updatedCount = 0;
  let skippedCount = 0;

  for (const entity of candidates) {
    try {
      console.log(`\n[PROCESS] ${entity.id} (${entity.displayName || entity.name})`);
      const suggestion = await fetchSuggestedUrls(entity, realm, options.domain);

      const validation: Record<UrlField, boolean> = {
        mainUrl: await validateUrl(suggestion.mainUrl),
        governingUrl: await validateUrl(suggestion.governingUrl),
        authorityUrl: suggestion.authorityUrl ? await validateUrl(suggestion.authorityUrl) : false,
      };

      const nextMain = pickUpdateValue(entity.mainUrl, suggestion.mainUrl, validation.mainUrl, options.force);
      const nextGoverning = pickUpdateValue(entity.governingUrl, suggestion.governingUrl, validation.governingUrl, options.force);
      const nextAuthority = pickUpdateValue(entity.authorityUrl, suggestion.authorityUrl, validation.authorityUrl, options.force);

      const changed = nextMain !== entity.mainUrl || nextGoverning !== entity.governingUrl || nextAuthority !== entity.authorityUrl;

      console.log(`  mainUrl:      ${entity.mainUrl || "(empty)"} -> ${nextMain || "(empty)"} [${validation.mainUrl ? "validated" : "not validated"}]`);
      console.log(`  governingUrl: ${entity.governingUrl || "(empty)"} -> ${nextGoverning || "(empty)"} [${validation.governingUrl ? "validated" : "not validated"}]`);
      console.log(`  authorityUrl: ${entity.authorityUrl || "(empty)"} -> ${nextAuthority || "(empty)"} [${validation.authorityUrl ? "validated" : "not validated or null"}]`);
      if (suggestion.notes) {
        console.log(`  notes: ${suggestion.notes}`);
      }

      if (!changed) {
        skippedCount += 1;
        console.log("  [SKIPPED] No validated updates applied.");
        continue;
      }

      entity.mainUrl = nextMain || "";
      entity.governingUrl = nextGoverning || "";
      entity.authorityUrl = nextAuthority || "";
      updatedCount += 1;
      console.log("  [UPDATED]");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      skippedCount += 1;
      console.log(`  [FAILED] ${message}`);
    }
  }

  if (options.dryRun) {
    console.log("\nDRY RUN: changes were not written.");
    console.log(`Updated candidates: ${updatedCount}`);
    console.log(`Skipped/failed: ${skippedCount}`);
    return;
  }

  await fs.writeJson(entitiesPath, payload, { spaces: 2 });
  console.log("\nSaved updates to entities file.");
  console.log(`Updated candidates: ${updatedCount}`);
  console.log(`Skipped/failed: ${skippedCount}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Script failed: ${message}`);
  process.exit(1);
});
