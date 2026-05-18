#!/usr/bin/env tsx

import { getDefaultStorage } from "@civillyengaged/ordinizer-servercore";
import { parseCommonCliArgs, requireDataRootAndRealm } from "./scriptArgs.js";

type DeleteMode = "analysis" | "metadata" | "all";

interface Args {
    realm: string;
    domain?: string;
    entity?: string;
    delete: DeleteMode;
    keepLastPerDay: boolean;
}

interface Target {
    domainId: string;
    entityId: string;
}

const USAGE = `
Usage: cleanupBackups.cli.ts --realm <realm> --delete <mode> [options]

Required:
  --realm <realm>            Realm ID (e.g. "ny")
  --delete <mode>            What to delete: analysis | metadata | all

Filters (default: all domains and entities):
  --domain <domainId>        Limit to a single domain
  --entity <entityId>        Limit to a single entity

Options:
  --keep-last-per-day        Instead of deleting all backups, keep the last
                             backup for each calendar day and remove earlier
                             ones from the same day
  --help                     Show this help message

Examples:
  # Delete all analysis backups across the entire realm
  cleanupBackups.cli.ts --realm ny --delete analysis

  # Keep one backup per day for metadata in a specific domain
  cleanupBackups.cli.ts --realm ny --delete metadata --domain police-transparency --keep-last-per-day
`.trim();

function parseArgs(args: string[]): Args {
    if (args.includes("--help") || args.includes("-h")) {
        console.log(USAGE);
        process.exit(0);
    }

    const { common, rest } = parseCommonCliArgs(args);
    requireDataRootAndRealm(common);

    const options: Partial<Args> = {
        realm: common.realm,
        domain: common.domain,
        entity: common.entity,
        keepLastPerDay: false,
    };

    const consumed: number[] = [];
    for (let i = 0; i < rest.length; i += 1) {
        const arg = rest[i];
        if (arg === "--delete") {
            const value = rest[i + 1];
            if (value !== "analysis" && value !== "metadata" && value !== "all") {
                throw new Error("--delete must be one of: analysis, metadata, all");
            }
            options.delete = value;
            consumed.push(i, i + 1);
            i += 1;
        } else if (arg === "--keep-last-per-day") {
            options.keepLastPerDay = true;
            consumed.push(i);
        }
    }

    for (let i = 0; i < rest.length; i += 1) {
        if (!consumed.includes(i)) {
            throw new Error(`Unknown argument: ${rest[i]}`);
        }
    }

    if (!options.delete) {
        throw new Error("Missing required argument: --delete <analysis|metadata|all>");
    }

    return options as Args;
}

async function resolveTargets(storage: ReturnType<typeof getDefaultStorage>, options: Args): Promise<Target[]> {
    if (options.domain && options.entity) {
        return [{ domainId: options.domain, entityId: options.entity }];
    }

    if (options.domain && !options.entity) {
        const entityIds = await storage.listEntityIds(options.domain);
        return entityIds.map(entityId => ({ domainId: options.domain!, entityId }));
    }

    const domainIds = await storage.listDomainIds();
    if (!options.entity) {
        const targets: Target[] = [];
        for (const domainId of domainIds) {
            const entityIds = await storage.listEntityIds(domainId);
            for (const entityId of entityIds) {
                targets.push({ domainId, entityId });
            }
        }
        return targets;
    }

    return domainIds.map(domainId => ({ domainId, entityId: options.entity! }));
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const storage = getDefaultStorage(options.realm);
    const targets = await resolveTargets(storage, options);

    if (targets.length === 0) {
        console.log("No matching domain/entity targets found.");
        return;
    }

    let analysisTotal = 0;
    let metadataTotal = 0;

    const deleteVerb = options.keepLastPerDay ? "Pruned" : "Deleted";

    for (const target of targets) {
        if (options.delete === "analysis" || options.delete === "all") {
            const analysisDeleted = options.keepLastPerDay
                ? await storage.pruneAnalysisBackups(target.domainId, target.entityId)
                : await storage.deleteAnalysisBackups(target.domainId, target.entityId);
            analysisTotal += analysisDeleted;
            console.log(`${deleteVerb} ${analysisDeleted} analysis backup file${analysisDeleted === 1 ? "" : "s"} for ${options.realm}/${target.domainId}/${target.entityId}`);
        }
        if (options.delete === "metadata" || options.delete === "all") {
            const metadataDeleted = options.keepLastPerDay
                ? await storage.pruneMetadataBackups(target.domainId, target.entityId)
                : await storage.deleteMetadataBackups(target.domainId, target.entityId);
            metadataTotal += metadataDeleted;
            console.log(`${deleteVerb} ${metadataDeleted} metadata backup file${metadataDeleted === 1 ? "" : "s"} for ${options.realm}/${target.domainId}/${target.entityId}`);
        }
    }

    if (targets.length > 1) {
        console.log(`Processed ${targets.length} targets in realm ${options.realm}.`);
        if (options.delete === "analysis" || options.delete === "all") {
            console.log(`Total analysis backups deleted: ${analysisTotal}`);
        }
        if (options.delete === "metadata" || options.delete === "all") {
            console.log(`Total metadata backups deleted: ${metadataTotal}`);
        }
    }
}

main().catch(error => {
    console.error("Backup cleanup failed:", error);
    process.exit(1);
});