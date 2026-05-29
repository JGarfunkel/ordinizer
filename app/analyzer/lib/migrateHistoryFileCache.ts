#!/usr/bin/env tsx

/**
 * Patches history.json records to populate fileType and, when localFile is
 * missing, to re-download the source and save it to the local artifact cache.
 *
 * Rules per record (status "related" or "index" only):
 *   - localFile set   → read first bytes; if "%PDF" → fileType=PDF, else → fileType=HTML
 *   - localFile unset → download the URL; save binary (.pdf or .html); set localFile + fileType
 */

import dotenv from "dotenv";
dotenv.config();
import { pathToFileURL } from "node:url";
import fs from "fs-extra";
import { open as fsOpen } from "node:fs/promises";
import path from "path";
import { getDefaultStorage, getRealmsFromStorage } from "@civillyengaged/ordinizer-servercore";
import { parseCommonCliArgs } from "./scriptArgs.js";
import {
  loadHistoryData,
  saveHistoryData,
  getEntityDownloadsRoot,
  fromRelativeDownloadsPath,
  toRelativeDownloadsPath,
  sanitizeFileSlug,
  inferSlugFromUrl,
  getUniqueArtifactBaseName,
  formatTxtArtifact,
} from "./spiderHistory.js";
import { downloadFromUrlAnyType, pdfToText } from "./extractionUtils.js";

interface MigrateOptions {
  realm?: string;
  entity?: string;
  dryRun: boolean;
  verbose: boolean;
  force: boolean;
}

function log(msg: string, verbose: boolean) {
  if (verbose) console.log(`[VERBOSE] ${msg}`);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function detectFileType(firstBytes: Buffer): "PDF" | "HTML" {
  return firstBytes.slice(0, 4).toString("ascii") === "%PDF" ? "PDF" : "HTML";
}

async function migrateEntity(
  storage: any,
  entityId: string,
  options: MigrateOptions,
): Promise<{ patched: number; skipped: number; failed: number }> {
  const { historyMap } = await loadHistoryData(storage, entityId);
  const downloadsRoot = getEntityDownloadsRoot(storage);
  const entityDir = path.join(downloadsRoot, entityId);
  await fs.ensureDir(entityDir);

  let patched = 0;
  let skipped = 0;
  let failed = 0;

  for (const [url, entry] of historyMap.entries()) {
    if (entry.status !== "related" && entry.status !== "index") {
      log(`Skipping ${url} (status=${entry.status})`, options.verbose);
      continue;
    }

    if (entry.fileType && !options.force) {
      log(`Skipping ${url} (fileType already set to ${entry.fileType})`, options.verbose);
      skipped++;
      continue;
    }

    if (entry.localFile) {
      // Case: localFile already set — detect type from content
      const absPath = fromRelativeDownloadsPath(storage, entry.localFile);
      if (!(await fs.pathExists(absPath))) {
        console.log(`  ⚠️  ${url}: localFile missing on disk (${entry.localFile}), skipping`);
        skipped++;
        continue;
      }

      const handle = await fsOpen(absPath, "r");
      const firstBytes = Buffer.alloc(8);
      await handle.read(firstBytes, 0, 8, 0);
      await handle.close();

      const detectedType = detectFileType(firstBytes);
      if (entry.fileType === detectedType && !options.force) {
        log(`${url}: fileType already correct (${detectedType})`, options.verbose);
        skipped++;
        continue;
      }

      console.log(`  🔍  ${url}: localFile=${entry.localFile} → fileType=${detectedType}`);
      if (!options.dryRun) {
        historyMap.set(url, { ...entry, fileType: detectedType });
      }
      patched++;

    } else {
      // Case: localFile not set — download the source, save, set localFile + fileType
      console.log(`  ⬇️  ${url}: no localFile, downloading...`);
      if (options.dryRun) {
        console.log(`  🔍  [dry-run] would download and save artifact`);
        skipped++;
        continue;
      }

      try {
        const { data, isPdf } = await downloadFromUrlAnyType(url);
        const fileType: "PDF" | "HTML" = isPdf ? "PDF" : "HTML";

        const slugFromUrl = inferSlugFromUrl(url);
        const slugFromTitle = sanitizeFileSlug(entry.title || entry.url || "source");
        const baseSlug = await getUniqueArtifactBaseName(entityDir, slugFromUrl || slugFromTitle || "source");

        const ext = isPdf ? "pdf" : "html";
        const artifactPath = path.join(entityDir, `${baseSlug}.${ext}`);
        await fs.writeFile(artifactPath, data);
        const localFile = toRelativeDownloadsPath(storage, artifactPath);

        let localFileText = entry.localFileText;
        if (isPdf && !localFileText) {
          const title = entry.title || url;
          const text = (await pdfToText(data, title, false)).trim();
          if (text) {
            const txtPath = path.join(entityDir, `${baseSlug}.txt`);
            const timestamp = entry.timestamp || new Date().toISOString();
            await fs.writeFile(txtPath, formatTxtArtifact(url, timestamp, text), "utf-8");
            localFileText = toRelativeDownloadsPath(storage, txtPath);
            console.log(`    📄  Saved text: ${localFileText}`);
          }
        }

        console.log(`    💾  Saved ${fileType}: ${localFile}`);
        historyMap.set(url, {
          ...entry,
          fileType,
          localFile,
          ...(localFileText ? { localFileText } : {}),
        });
        patched++;
      } catch (err) {
        console.error(`  ❌  ${url}: download failed — ${errMsg(err)}`);
        failed++;
      }
    }
  }

  if (!options.dryRun && patched > 0) {
    await saveHistoryData(storage, entityId, historyMap);
  }

  return { patched, skipped, failed };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { common } = parseCommonCliArgs(args);

  const options: MigrateOptions = {
    realm: common.realm,
    entity: common.entity,
    dryRun: common.dryRun,
    verbose: false,
    force: common.force,
  };

  for (const arg of args) {
    if (arg === "--verbose" || arg === "-v") options.verbose = true;
  }

  if (!options.realm) {
    try {
      const available = await getRealmsFromStorage();
      const def = available.find((r: any) => r.isDefault);
      if (def) {
        options.realm = def.id;
        process.env.CURRENT_REALM = def.id;
        console.log(`🎯 Using default realm: ${def.id}`);
      } else {
        console.error("❌ No default realm. Use --realm.");
        process.exit(1);
      }
    } catch (err) {
      console.error("❌ Error loading realms:", errMsg(err));
      process.exit(1);
    }
  }

  const storage = getDefaultStorage(options.realm!);
  const entityIds: string[] = options.entity
    ? [options.entity]
    : await storage.getEntityIds();

  console.log(`\n📦 Migrating file cache for ${entityIds.length} ${options.entity ? "entity" : "entities"}${options.dryRun ? " [dry-run]" : ""}...\n`);

  let totalPatched = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const entityId of entityIds) {
    console.log(`\n── ${entityId} ──`);
    try {
      const { patched, skipped, failed } = await migrateEntity(storage, entityId, options);
      console.log(`   patched=${patched} skipped=${skipped} failed=${failed}`);
      totalPatched += patched;
      totalSkipped += skipped;
      totalFailed += failed;
    } catch (err) {
      console.error(`  ❌ ${entityId}: ${errMsg(err)}`);
      totalFailed++;
    }
  }

  console.log(`\n✅ Done — patched=${totalPatched} skipped=${totalSkipped} failed=${totalFailed}${options.dryRun ? " (dry-run, no writes)" : ""}`);
}

const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isEntrypoint) {
  main().catch((err) => {
    console.error("❌ Fatal:", err);
    process.exit(1);
  });
}
