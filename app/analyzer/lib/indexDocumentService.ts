import dotenv from "dotenv";
dotenv.config();
import { getDefaultStorage, getRealmsFromStorage, IStorageReadOnly } from "@civillyengaged/ordinizer-servercore";
import { getVectorService } from "../services/vectorService.js";

export interface IndexOptions {
  entity?: string;
  domain?: string;
  realm?: string;
  verbose?: boolean;
  force?: boolean;
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
  const storage = getDefaultStorage(options.realm || "");
  const vectorService = getVectorService();

  await vectorService.initializeIndex();

  // --- Statute files (one per domain) ---
  const domains = options.domain
    ? [options.domain]
    : await storage.listDomainIds(options.realm);

  for (const domain of domains) {
    const statute = await storage.getDocumentText(domain, entityId, options.realm);
    if (!statute) {
      log(`No statute found for ${entityId}/${domain}, skipping`);
      continue;
    }

    if (!options.force) {
      const already = await vectorService.hasIndexedDocument(entityId, domain, "statute");
      if (already) {
        log(`Statute vectors already exist for ${entityId}/${domain}, skipping (use --force to reindex)`);
        continue;
      }
    }

    console.log(`📄 ${entityId}/${domain}: Indexing statute...`);
    await vectorService.indexDocumentInPinecone(statute, entityId, domain, "statute");
    console.log(`✅ ${entityId}/${domain}: Statute indexed`);
  }

  // --- EntityDocuments downloads (multi-domain, from spider history) ---
  let downloadCount = 0;
  await storage.processEntityDownloads(entityId, async (content, id, matchedDomainIds) => {
    // If scoped to a domain, only process docs that match it
    if (options.domain && !matchedDomainIds.includes(options.domain)) {
      log(`Skipping download for ${id} — domains ${matchedDomainIds.join(",")} don't include ${options.domain}`);
      return;
    }

    // Index once per matched domain so vector filter queries work per domain.
    // The domainIds array is also stored in metadata for future multi-domain queries.
    for (const domain of matchedDomainIds) {
      if (options.domain && domain !== options.domain) continue;

      if (!options.force) {
        const already = await vectorService.hasIndexedDocument(id, domain, "guidance");
        if (already) {
          log(`Guidance vectors already exist for ${id}/${domain}, skipping`);
          continue;
        }
      }

      console.log(`📎 ${id}/${domain}: Indexing downloaded document (matched domains: ${matchedDomainIds.join(", ")})...`);
      await vectorService.indexDocumentInPinecone(content, id, domain, "guidance", matchedDomainIds);
      downloadCount++;
    }
  });

  if (downloadCount > 0) {
    console.log(`✅ ${entityId}: Indexed ${downloadCount} downloaded document chunk(s) from EntityDocuments`);
  } else {
    log(`${entityId}: No EntityDocuments downloads found`);
  }
}

/**
 * Index all entities in the realm, optionally scoped to one domain or entity.
 */
export async function indexAll(options: IndexOptions = {}): Promise<void> {
  VERBOSE = options.verbose ?? VERBOSE;
  const storage = getDefaultStorage(options.realm || "");
  const vectorService = getVectorService();

  await vectorService.initializeIndex();
  console.log(`🗂️  Starting document indexing for realm: ${options.realm || "default"}`);

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

function showHelp(): void {
  console.log(`
📦 Index documents into the Pinecone vector database

Reads statute files and EntityDocuments spider downloads, then upserts embeddings
into the ordinizer-statutes Pinecone index. Downloads are indexed with their
matchedDomainIds array, supporting multi-domain document mapping.

Usage:
  tsx app/analyzer/lib/indexDocumentService.ts [options]

Options:
  --entity <id>     Index a single entity only (e.g., "NY-Bedford-Town")
  --domain <id>     Scope indexing to one domain (e.g., "trees")
  --realm <id>      Realm to use (defaults to CURRENT_REALM env var or default realm)
  --force           Re-index even if vectors already exist
  --verbose, -v     Enable detailed logging
  --help, -h        Show this help message

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

  if (process.env.CURRENT_REALM) {
    options.realm = process.env.CURRENT_REALM;
    console.log(`📖 Using CURRENT_REALM: ${options.realm}`);
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help":
      case "-h":
        showHelp();
        process.exit(0);
        break;
      case "--entity":
        options.entity = args[++i];
        break;
      case "--domain":
        options.domain = args[++i];
        break;
      case "--realm":
        options.realm = args[++i];
        process.env.CURRENT_REALM = options.realm;
        console.log(`💾 Set CURRENT_REALM: ${options.realm}`);
        break;
      case "--force":
        options.force = true;
        break;
      case "--verbose":
      case "-v":
        options.verbose = true;
        break;
      default:
        if (args[i].startsWith("-")) {
          console.error(`Unknown option: ${args[i]}`);
          showHelp();
          process.exit(1);
        }
    }
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

if (require.main === module) {
  (async () => {
    const options = await parseArgs();
    await indexAll(options);
  })().catch((error) => {
    console.error("❌ Fatal error:", error);
    process.exit(1);
  });
}
