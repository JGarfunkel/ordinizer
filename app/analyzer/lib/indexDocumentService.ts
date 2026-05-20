#!/usr/bin/env tsx

import dotenv from "dotenv";
dotenv.config();
import { pathToFileURL } from "node:url";
import { getDefaultStorage, getRealmsFromStorage, IStorageReadOnly } from "@civillyengaged/ordinizer-servercore";
import { getVectorService, getDocumentKey } from "../services/vectorService.js";
import { parseCommonCliArgs } from "./scriptArgs.js";
import { loadHistoryData, saveHistoryData, getEntityDownloadsRoot, normalizeUrlForMatch } from "./spiderHistory.js";

export interface IndexOptions {
  entity?: string;
  domain?: string;
  realm?: string;
  verbose?: boolean;
  force?: boolean;
  list?: boolean;
  limit?: number;
  dryRun?: boolean;
  only?: string;
  prune?: boolean;
  removeUrl?: string;
}

let VERBOSE = false;

function log(message: string, ...args: any[]) {
  if (VERBOSE) {
    console.log(`[VERBOSE] ${message}`, ...args);
  }
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Index all documents (statute + EntityDocuments downloads) for a single entity,
 * optionally scoped to one domain.
 *
 * Statute files are indexed with a single domainId (scalar).
 * EntityDocuments downloads are indexed with domainIds (array) as returned by
 * the spider's matchedDomainIds field, supporting multi-domain mapping natively.
 */
export async function indexEntity(
  entityId: string,
  options: IndexOptions = {},
): Promise<void> {
  VERBOSE = options.verbose ?? VERBOSE;
  if (!options.realm) {
    throw new Error("Realm is required to index documents");
  }
  const storage = getDefaultStorage(options.realm);
  const vectorService = getVectorService(options.realm);

  await vectorService.initializeIndex();

  if (!options.only || options.only === "ruleset") {
    const domains = options.domain
        ? [options.domain]
        : await storage.listDomainIds(options.realm);

    for (const domain of domains) {
      const statute = await storage.getDocumentText(domain, entityId, options.realm);
      if (!statute) {
        log(`No statute found for ${entityId}/${domain}, skipping`);
        continue;
      }

      // Fetch Ruleset metadata for provenance
      let url = undefined;
      let fetchedAt = undefined;
      try {
        const ruleset = await storage.getRuleset(domain, entityId);
        if (ruleset && Array.isArray(ruleset.sources) && ruleset.sources.length > 0) {
          url = ruleset.sources[0].sourceUrl;
          fetchedAt = ruleset.sources[0].downloadedAt;
        }
      } catch (e) {
        log(`Warning: Could not load ruleset for ${entityId}/${domain}: ${errMsg(e)}`);
      }

      const prefix = getDocumentKey(entityId, [domain], "statute");
      if (!options.force) {
        const already = await vectorService.hasIndexedDocument(prefix);
        if (already) {
          log(`Statute vectors already exist for ${entityId}/${domain}, skipping (use --force to reindex)`);
          continue;
        }
      }

      console.log(`📄 ${entityId}/${domain}: Indexing statute...`);
      await vectorService.indexDocumentInPinecone(
        statute,
        entityId,
        domain,
        "statute",
        { url: url || "", fileName: "statute.txt", fetchedAt: fetchedAt || "" },
        { verbose: options.verbose, dryRun: options.dryRun }
      );
      console.log(`✅ ${entityId}/${domain}: Statute indexed`);
    }
  }

  if (!options.only || options.only === "general") {
    // --- EntityDocuments downloads (multi-domain, from spider history) ---
    let downloadCount = 0;
    // Load history data once for this entity
    const { historyMap } = await loadHistoryData(storage, entityId);
    await storage.processEntityDownloads(entityId, async (content, entityId, matchedDomainIds, filename) => {
      // If scoped to a domain, only process docs that match it
      if (options.domain && !matchedDomainIds.includes(options.domain)) {
        log(`Skipping download for ${entityId} — domains ${matchedDomainIds.join(",")} don't include ${options.domain}`);
        return;
      }

      // Scope to the requested domain if provided, then index the document once
      // with all matching domains so a single set of vectors serves all of them.
      const domainsToIndex = options.domain
        ? matchedDomainIds.filter(d => d === options.domain)
        : matchedDomainIds;

      if (domainsToIndex.length === 0) {
        log(`Skipping download for ${entityId} — no matching domains after filtering`);
        return;
      }

      if (!options.force) {
        const prefix = getDocumentKey(entityId, ["shared"], "shared");
        const already = await vectorService.hasIndexedDocument(prefix);
        if (already) {
          log(`Guidance vectors already exist for ${entityId}/"shared", skipping`);
          return;
        }
      }

      // Find the matching SpiderHistoryEntry for provenance
      let url = undefined;
      let fetchedAt = undefined;
      if (historyMap) {
        for (const entry of historyMap.values()) {
          const fileMatch = entry.localFileText || entry.localFile;
          if (fileMatch && fileMatch.split("/").pop() === filename) {
            url = entry.url;
            fetchedAt = entry.timestamp;
            break;
          }
        }
      }

      console.log(`📎 ${entityId}: Indexing downloaded document (domains: ${domainsToIndex.join(", ")})...`);
      await vectorService.indexDocumentInPinecone(
        content,
        entityId,
        domainsToIndex,
        "shared",
        { url: url || "", fileName: filename, fetchedAt: fetchedAt || "" },
        { verbose: options.verbose, dryRun: options.dryRun }
      );
      downloadCount++;
    });

    if (downloadCount > 0) {
        console.log(`✅ ${entityId}: Indexed ${downloadCount} downloaded document chunk(s) from EntityDownloads`);
    } else {
        log(`${entityId}: No EntityDocuments downloads found`);
    }
  }
}

/**
 * Prune vector chunks for history entries with status "unrelated" or "index".
 * These entries should not be in the vector database.
 */
export async function pruneUnrelatedDocuments(options: IndexOptions = {}): Promise<void> {
  VERBOSE = options.verbose ?? VERBOSE;
  if (!options.realm) {
    throw new Error("Realm is required to prune documents");
  }
  const storage = getDefaultStorage(options.realm);
  const vectorService = getVectorService(options.realm);

  await vectorService.initializeIndex();

  const entityIds = options.entity
    ? [options.entity]
    : await storage.getEntityIds(options.domain);

  console.log(`🔍 Scanning ${entityIds.length} entities for unrelated/index entries to prune...`);

  let totalPruned = 0;
  let totalSkipped = 0;

  for (const entityId of entityIds) {
    const { historyMap } = await loadHistoryData(storage, entityId);
    const entriesToPrune = [...historyMap.values()].filter(
      (entry) => entry.status === "unrelated" || entry.status === "index"
    );

    if (entriesToPrune.length === 0) {
      log(`${entityId}: No unrelated/index entries found`);
      continue;
    }

    for (const entry of entriesToPrune) {
      const rawFile = entry.localFileText ?? entry.localFile;
      const filename = rawFile ? rawFile.split("/").pop() : undefined;
      if (!filename) {
        log(`${entityId}: Entry ${entry.url} has no localFileText/localFile, skipping`);
        totalSkipped++;
        continue;
      }

      const prefix = getDocumentKey(entityId, ["shared"], "shared", filename);
      log(`${entityId}: Checking prefix "${prefix}" (status=${entry.status})`);

      if (options.dryRun) {
        console.log(`🔍 [dry-run] Would delete chunks for ${entityId} — ${filename} (status=${entry.status})`);
        totalPruned++;
      } else {
        console.log(`🗑️  ${entityId}: Deleting chunks for ${filename} (status=${entry.status})...`);
        await vectorService.deleteIndexedChunksForDocument(prefix);
        totalPruned++;
      }
    }
  }

  console.log(`\n✅ Prune complete: ${totalPruned} document(s) pruned, ${totalSkipped} skipped (no filename).`);
}

/**
 * Mark a URL as "unrelated" in the entity's history file and delete its vector
 * chunks from the Pinecone index.
 */
export async function removeUrlFromIndex(entityId: string, url: string, options: IndexOptions = {}): Promise<void> {
  VERBOSE = options.verbose ?? VERBOSE;
  if (!options.realm) {
    throw new Error("Realm is required to remove a URL from the index");
  }
  const storage = getDefaultStorage(options.realm);
  const vectorService = getVectorService(options.realm);
  await vectorService.initializeIndex();

  const { historyMap, menuLinks } = await loadHistoryData(storage, entityId);
  const normalizedUrl = normalizeUrlForMatch(url);

  const entry = historyMap.get(normalizedUrl);
  if (!entry) {
    console.error(`❌ URL not found in history for entity "${entityId}": ${url}`);
    console.error(`   (searched as: ${normalizedUrl})`);
    process.exit(1);
  }

  console.log(`🔍 Found history entry for: ${url} (status=${entry.status})`);
  entry.status = "unrelated";
  historyMap.set(normalizedUrl, entry);

  if (options.dryRun) {
    console.log(`🔍 [dry-run] Would mark URL as unrelated in history`);
  } else {
    await saveHistoryData(storage, entityId, historyMap, menuLinks);
    console.log(`✅ Marked as unrelated in history`);
  }

  const rawFile = entry.localFileText ?? entry.localFile;
  const filename = rawFile ? rawFile.split("/").pop() : undefined;
  if (!filename) {
    console.log(`⚠️  No local file recorded for this URL — nothing to remove from index`);
    return;
  }

  const prefix = getDocumentKey(entityId, ["shared"], "shared", filename);
  log(`Derived index prefix: "${prefix}"`);

  if (options.dryRun) {
    console.log(`🔍 [dry-run] Would delete index chunks with prefix: ${prefix}`);
  } else {
    console.log(`🗑️  Deleting index chunks for: ${filename}`);
    await vectorService.deleteIndexedChunksForDocument(prefix);
    console.log(`✅ Removed from index: ${url}`);
  }
}

/**
 * Index all entities in the realm, optionally scoped to one domain or entity.
 */
export async function indexAll(options: IndexOptions = {}): Promise<void> {
  VERBOSE = options.verbose ?? VERBOSE;
  if (!options.realm) {
    throw new Error("Realm is required to index documents");
  }
  const storage = getDefaultStorage(options.realm);
  const vectorService = getVectorService(options.realm);

  await vectorService.initializeIndex();
  console.log(`🗂️  Starting document indexing for realm: ${options.realm}`);

  const entityIds = options.entity
    ? [options.entity]
    : await storage.getEntityIds(options.domain);

  console.log(`📋 ${entityIds.length} entities to index`);

  let indexed = 0;
  let failed = 0;

  for (const entityId of entityIds) {
    try {
      await indexEntity(entityId, options);
      indexed++;
    } catch (error) {
      console.error(`❌ ${entityId}: Failed to index — ${errMsg(error)}`);
      failed++;
    }
  }

  console.log(`\n🎉 Indexing complete: ${indexed} succeeded, ${failed} failed`);
}

// ─── CLI ───────────────────────────────────────────────────────────────────

/**
 * List documents currently in the Pinecone index, up to options.limit (default 100).
 */
export async function listDocuments(options: IndexOptions = {}): Promise<void> {
    if (!options.realm) {
        throw new Error("Realm is required to list indexed documents");
    }
    const vectorService = getVectorService(options.realm);
    const limit = options.limit ?? 100;
    const entityFilter = options.entity ? ` for entity "${options.entity}"` : "";
    console.log(`📋 Listing up to ${limit} indexed documents${entityFilter}...\n`);

    const prefix = options.entity ? options.entity : undefined;
    const docs = await vectorService.listIndexedDocuments(limit, prefix);

    if (docs.length === 0) {
        console.log("No indexed documents found.");
        return;
    }

    for (const doc of docs) {
        const domains = doc.domainIds.join(", ");
        const indexed = doc.indexedAt ? new Date(doc.indexedAt).toLocaleString() : "(unknown)";
        console.log(`  ${doc.id}  [${doc.documentType}]  domains: ${domains}  indexed: ${indexed}`);
    }

    console.log(`\nTotal: ${docs.length} document(s)`);
}

// ─── CLI ───────────────────────────────────────────────────────────────────

function showHelp(): void {
  console.log(`
📦 Index documents into the Pinecone vector database

Reads statute files and EntityDocuments spider downloads, then upserts embeddings
into the ordinizer-statutes Pinecone index. Downloads are indexed with their
matchedDomainIds array, supporting multi-domain document mapping.

Usage:
  tsx app/analyzer/lib/indexDocumentService.ts [options]

Options:
  --entity <id>          Index a single entity only (e.g., "NY-Bedford-Town")
  --domain <id>          Scope indexing to one domain (e.g., "trees")
  --realm <id>           Realm to use (defaults to CURRENT_REALM env var or default realm)
  --force                Re-index even if vectors already exist
  --prune                Delete vector chunks for history entries with status=unrelated or status=index
  --removeUrl <url>      Mark a URL as "unrelated" in the entity's history and delete its index chunks
                         Requires --entity <entityId>
  --verbose, -v          Enable detailed logging
  --help, -h             Show this help message

Examples:
  # Index all entities in the default realm
  tsx app/analyzer/lib/indexDocumentService.ts

  # Index one entity across all its domains
  tsx app/analyzer/lib/indexDocumentService.ts --entity NY-Bedford-Town

  # Index one entity for a specific domain, forcing reindex
  tsx app/analyzer/lib/indexDocumentService.ts --entity NY-Bedford-Town --domain trees --force

  # Index all entities for a domain in a specific realm
  tsx app/analyzer/lib/indexDocumentService.ts --domain trees --realm westchester-municipal-environmental

Environment Variables Required:
  OPENAI_API_KEY     OpenAI API key for embeddings
  PINECONE_API_KEY   Pinecone API key
`);
}

async function parseArgs(): Promise<IndexOptions> {
  const args = process.argv.slice(2);
  const options: IndexOptions = {};

  const { common, rest } = parseCommonCliArgs(args);
  options.entity = common.entity;
  options.domain = common.domain;
  options.realm = common.realm;
  options.force = common.force;
  options.dryRun = common.dryRun;

  for (let i = 0; i < rest.length; i++) {
    switch (rest[i]) {
      case "--help":
      case "-h":
        showHelp();
        process.exit(0);
        break;
      case "--verbose":
      case "-v":
        options.verbose = true;
        break;
      case "--list":
        options.list = true;
        break;
      case "--limit":
        options.limit = parseInt(rest[++i], 10);
        break;
      case "--only":
        options.only = rest[++i];
        break;
      case "--prune":
        options.prune = true;
        break;
      case "--removeUrl":
      case "--remove-url":
        options.removeUrl = rest[++i];
        break;
      default:
        if (rest[i].startsWith("-")) {
          console.error(`Unknown option: ${rest[i]}`);
          showHelp();
          process.exit(1);
        }
    }
  }

  if (options.realm) {
    process.env.CURRENT_REALM = options.realm;
  }

  if (!options.realm) {
    try {
      const availableRealms = await getRealmsFromStorage();
      const defaultRealm = availableRealms.find((r: any) => r.isDefault);
      if (defaultRealm) {
        options.realm = defaultRealm.id;
        process.env.CURRENT_REALM = defaultRealm.id;
        console.log(`🎯 Using default realm: ${defaultRealm.id}`);
      } else {
        console.error("❌ No default realm found. Use --realm or set CURRENT_REALM.");
        process.exit(1);
      }
    } catch (error) {
      console.error("❌ Error loading realms:", errMsg(error));
      process.exit(1);
    }
  }

  return options;
}

export async function main(): Promise<void> {
  const options = await parseArgs();
  if (options.list) {
    await listDocuments(options);
  } else if (options.prune) {
    await pruneUnrelatedDocuments(options);
  } else if (options.removeUrl) {
    if (!options.entity) {
      console.error("❌ --entity <entityId> is required when using --removeUrl");
      process.exit(1);
    }
    await removeUrlFromIndex(options.entity, options.removeUrl, options);
  } else {
    await indexAll(options);
  }
}

const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isEntrypoint) {
  main().catch((error) => {
    console.error("❌ Fatal error:", error);
    process.exit(1);
  });
}
