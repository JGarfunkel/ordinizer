#!/usr/bin/env tsx
/**
 * ensureStatutes.ts
 *
 * Scans every ruleset (metadata.json) across all domains and entities in the
 * realm's data directory. For each entry, confirms that both the plain-text
 * statute file (<ruleType>.txt) and the source file (<ruleType>.html or
 * <ruleType>.pdf) are present. If either is missing, downloads from the URL
 * recorded in the ruleset and then indexes the entity in Pinecone.
 *
 * Usage:
 *   tsx app/analyzer/lib/ensureStatutes.ts --realm <realmId> [options]
 *
 * Options:
 *   --realm <id>    Realm to scan (or set CURRENT_REALM env var)
 *   --domain <id>   Limit scan to one domain
 *   --entity <id>   Limit scan to one entity
 *   --force         Re-download and re-index even when files already exist
 *   --dry-run       Report what would be downloaded without doing it
 *   --no-index      Skip indexing after download
 *   --verbose, -v   Also log entities that are skipped or already complete
 *   --help, -h      Show this help
 */

import dotenv from "dotenv";
dotenv.config();

import { pathToFileURL } from "node:url";
import path from "path";
import fs from "fs-extra";

import { getDefaultStorage, getRealmsFromStorage } from "@civillyengaged/ordinizer-servercore";
import type { Ruleset } from "@civillyengaged/ordinizer-core";
import { downloadAndProcessSource, convertExistingSourceToText } from "./sourceDownloader.js";
import { indexEntity } from "./indexDocumentService.js";
import { parseCommonCliArgs } from "./scriptArgs.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Options {
  realm: string;
  domain?: string;
  entity?: string;
  force: boolean;
  dryRun: boolean;
  noIndex: boolean;
  verbose: boolean;
  convertOnly: boolean;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function showHelp(): void {
  console.log(`
Scan rulesets and ensure statute source files are downloaded and indexed.

Usage:
  tsx app/analyzer/lib/ensureStatutes.ts --realm <realmId> [options]

Options:
  --realm <id>    Realm to scan (or set CURRENT_REALM)
  --domain <id>   Limit to one domain
  --entity <id>   Limit to one entity
  --force         Re-download even when files already exist
  --convert-only  Re-convert existing source file to statute.txt without re-downloading
  --dry-run       Report what would be downloaded, don't download
  --no-index      Skip indexing after download
  --verbose, -v   Show skipped and already-complete entries
  --help, -h      Show this help
`);
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

async function parseArgs(): Promise<Options> {
  const { common, rest } = parseCommonCliArgs(process.argv.slice(2));

  const options: Options = {
    realm: common.realm ?? "",
    domain: common.domain,
    entity: common.entity,
    force: common.force,
    dryRun: common.dryRun,
    noIndex: false,
    verbose: false,
    convertOnly: false,
  };

  for (let i = 0; i < rest.length; i++) {
    switch (rest[i]) {
      case "--no-index":
        options.noIndex = true;
        break;
      case "--convert-only":
        options.convertOnly = true;
        break;
      case "--verbose":
      case "-v":
        options.verbose = true;
        break;
      case "--help":
      case "-h":
        showHelp();
        process.exit(0);
      default:
        if (rest[i].startsWith("-")) {
          console.error(`Unknown option: ${rest[i]}`);
          showHelp();
          process.exit(1);
        }
    }
  }

  if (!options.realm) {
    try {
      const realms = await getRealmsFromStorage();
      const defaultRealm = realms.find((r: any) => r.isDefault);
      if (defaultRealm) {
        options.realm = defaultRealm.id;
        console.log(`Using default realm: ${defaultRealm.id}`);
      } else {
        console.error("No default realm found. Provide --realm <realm-id> or set CURRENT_REALM.");
        process.exit(1);
      }
    } catch {
      console.error("Missing --realm. Provide --realm <realm-id> or set CURRENT_REALM.");
      process.exit(1);
    }
  }

  return options;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the source URL from the first source whose type matches ruleType. */
function getSourceUrlForType(ruleset: Ruleset, ruleType: string): string | null {
  const source = (ruleset.sources ?? []).find((s) => s.type === ruleType);
  return source?.sourceUrl || null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = await parseArgs();

  const storage = getDefaultStorage(options.realm);
  const realmConfig = await storage.getRealmConfig();
  const ruleType = realmConfig.ruleType ?? "statute";
  const realmDir = storage.getRealmDir();

  const domainIds = options.domain
    ? [options.domain]
    : (await storage.listDomainIds()).filter((id) => id !== "EntityDownloads");

  let scanned = 0;
  let missingCount = 0;
  let downloaded = 0;
  let indexed = 0;
  let skippedCount = 0;
  let failed = 0;

  const prefix = options.dryRun ? "[DRY-RUN] " : "";
  console.log(`${prefix}Scanning realm: ${options.realm} — ${domainIds.length} domain(s)`);

  for (const domainId of domainIds) {
    const entityIds = options.entity
      ? [options.entity]
      : await storage.listEntityIds(domainId);

    if (entityIds.length === 0) continue;

    console.log(`\nDomain: ${domainId} (${entityIds.length} entities)`);

    for (const entityId of entityIds) {
      scanned++;

      const rulesetExists = await storage.rulesetExists(domainId, entityId);
      if (!rulesetExists) {
        if (options.verbose) console.log(`  SKIP  ${entityId}: no metadata.json`);
        skippedCount++;
        continue;
      }

      const ruleset = await storage.getRuleset(domainId, entityId);
      const sourceUrl = ruleset ? getSourceUrlForType(ruleset, ruleType) : null;

      if (!options.convertOnly && !sourceUrl) {
        if (options.verbose) console.log(`  SKIP  ${entityId}: no ${ruleType} source URL in ruleset`);
        skippedCount++;
        continue;
      }

      // Check for statute.txt (always present after a successful download)
      const entityDir = path.join(realmDir, domainId, entityId);
      const txtPath = path.join(entityDir, `${ruleType}.txt`);
      const htmlPath = path.join(entityDir, `${ruleType}.html`);
      const pdfPath = path.join(entityDir, `${ruleType}.pdf`);

      const [txtExists, htmlExists, pdfExists] = await Promise.all([
        fs.pathExists(txtPath),
        fs.pathExists(htmlPath),
        fs.pathExists(pdfPath),
      ]);
      const txtSize = txtExists ? (await fs.stat(txtPath)).size : 0;
      const txtValid = txtExists && txtSize >= 200;
      const sourceFileExists = htmlExists || pdfExists;
      const complete = txtValid && sourceFileExists;

      if (options.convertOnly) {
        if (!sourceFileExists) {
          if (options.verbose) console.log(`  SKIP  ${entityId}: no source file to convert`);
          skippedCount++;
          continue;
        }
        if (txtValid && !options.force) {
          if (options.verbose) console.log(`  OK    ${entityId}: statute.txt already exists`);
          continue;
        }

        const reason = options.force && txtValid
          ? "FORCE"
          : txtExists
            ? `SMALL ${ruleType}.txt (${txtSize} bytes)`
            : `MISSING ${ruleType}.txt`;
        missingCount++;

        if (options.dryRun) {
          console.log(`  [DRY-RUN] ${entityId}: ${reason} — would convert existing source`);
          continue;
        }

        console.log(`  ${entityId}: ${reason} — converting...`);
        try {
          await convertExistingSourceToText(options.realm, domainId, entityId);
          downloaded++;
          console.log(`    Converted ${entityId}/${domainId}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`    FAILED ${entityId} (convert): ${msg}`);
          failed++;
          continue;
        }
      } else {
        if (complete && !options.force) {
          if (options.verbose) console.log(`  OK    ${entityId}: files present`);
          continue;
        }

        // txt exists but is too small — conversion failure; re-convert without re-downloading
        if (txtExists && !txtValid && sourceFileExists) {
          const reason = options.force ? "FORCE" : `SMALL ${ruleType}.txt (${txtSize} bytes)`;
          missingCount++;

          if (options.dryRun) {
            console.log(`  [DRY-RUN] ${entityId}: ${reason} — would convert existing source`);
            continue;
          }

          console.log(`  ${entityId}: ${reason} — converting...`);
          try {
            await convertExistingSourceToText(options.realm, domainId, entityId);
            downloaded++;
            console.log(`    Converted ${entityId}/${domainId}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`    FAILED ${entityId} (convert): ${msg}`);
            failed++;
            continue;
          }
        } else {
          const missingFiles = [
            !txtValid && (txtExists ? `${ruleType}.txt (too small: ${txtSize}B)` : `${ruleType}.txt`),
            !sourceFileExists && `${ruleType}.html/.pdf`,
          ].filter(Boolean) as string[];

          const reason = options.force && complete
            ? "FORCE"
            : `MISSING ${missingFiles.join(", ")}`;

          missingCount++;

          if (options.dryRun) {
            console.log(`  [DRY-RUN] ${entityId}: ${reason} — would download from ${sourceUrl}`);
            continue;
          }

          console.log(`  ${entityId}: ${reason} — downloading...`);
          try {
            await downloadAndProcessSource(options.realm, domainId, entityId, sourceUrl!);
            downloaded++;
            console.log(`    Downloaded ${entityId}/${domainId}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`    FAILED ${entityId} (download): ${msg}`);
            failed++;
            continue;
          }
        }
      }

      const newTxtSize = (await fs.pathExists(txtPath)) ? (await fs.stat(txtPath)).size : 0;
      if (newTxtSize < 200) {
        console.error(`\x1b[31m    ERROR ${entityId}/${domainId}: statute.txt is only ${newTxtSize} bytes after conversion\x1b[0m`);
      }

      if (!options.noIndex) {
        try {
          await indexEntity(entityId, { realm: options.realm, domain: domainId, force: true });
          indexed++;
          console.log(`    Indexed  ${entityId}/${domainId}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`    FAILED ${entityId} (index): ${msg}`);
          failed++;
        }
      }
    }
  }

  const actionLabel = options.convertOnly ? "Converted" : "Downloaded";
  console.log(`
${prefix}Done.
  Scanned:    ${scanned}
  Missing:    ${missingCount}
  ${actionLabel}: ${downloaded}
  Indexed:    ${indexed}
  Skipped:    ${skippedCount}
  Failed:     ${failed}
`);
}

// ---------------------------------------------------------------------------
// Entrypoint guard
// ---------------------------------------------------------------------------

const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isEntrypoint) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
