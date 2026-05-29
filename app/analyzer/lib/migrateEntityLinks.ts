#!/usr/bin/env tsx

/**
 * Migrates entity files from flat URL fields (mainUrl, governingUrl, hubUrl, authorityUrl)
 * to the new `links` array structure.
 *
 * Usage:
 *   tsx app/analyzer/lib/migrateEntityLinks.ts --file /path/to/municipalities.json
 *   tsx app/analyzer/lib/migrateEntityLinks.ts --file /path/to/municipalities.json --dry-run
 */

import fs from "fs-extra";
import type { EntityLink, EntityLinkType } from "@civillyengaged/ordinizer-core";

const FIELD_TO_TYPE: Array<{ field: string; type: EntityLinkType }> = [
  { field: "mainUrl", type: "main" },
  { field: "governingUrl", type: "governing" },
  { field: "hubUrl", type: "hub" },
  { field: "authorityUrl", type: "authority" },
];

function parseArgs(args: string[]): { file: string; dryRun: boolean } {
  let file = "";
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) file = args[++i];
    if (args[i] === "--dry-run") dryRun = true;
  }
  if (!file) {
    console.error("Usage: migrateEntityLinks.ts --file <path> [--dry-run]");
    process.exit(1);
  }
  return { file, dryRun };
}

async function main() {
  const { file, dryRun } = parseArgs(process.argv.slice(2));

  if (!await fs.pathExists(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  const data = await fs.readJson(file);
  if (!Array.isArray(data.entities)) {
    console.error("Expected { entities: [...] } structure");
    process.exit(1);
  }

  let migrated = 0;
  let skipped = 0;

  for (const entity of data.entities) {
    const existing: EntityLink[] = Array.isArray(entity.links) ? entity.links : [];
    const existingTypes = new Set(existing.map((l: EntityLink) => l.type));
    const toAdd: EntityLink[] = [];

    for (const { field, type } of FIELD_TO_TYPE) {
      const url: string | undefined = entity[field];
      if (url && !existingTypes.has(type)) {
        toAdd.push({ type, url });
      }
    }

    if (toAdd.length === 0) {
      skipped++;
      continue;
    }

    entity.links = [...existing, ...toAdd];
    console.log(`[MIGRATE] ${entity.id}: added ${toAdd.map((l) => l.type).join(", ")}`);
    migrated++;
  }

  console.log(`\nDone. migrated=${migrated} skipped=${skipped}`);

  if (!dryRun) {
    await fs.writeJson(file, data, { spaces: 2 });
    console.log(`Written: ${file}`);
  } else {
    console.log("Dry run — no changes written.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
