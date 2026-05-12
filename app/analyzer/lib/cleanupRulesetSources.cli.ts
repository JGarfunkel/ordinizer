import { getDefaultStorage } from "@civillyengaged/ordinizer-servercore";
import { parseCommonCliArgs, requireDataRootAndRealm } from "./scriptArgs.js";

type SourceTypeToRemove = "general" | "guidance";

interface Args {
  realm: string;
  domain?: string;
  entity?: string;
  dryRun: boolean;
}

interface Target {
  domainId: string;
  entityId: string;
}

function parseArgs(args: string[]): Args {
  const { common, rest } = parseCommonCliArgs(args);
  requireDataRootAndRealm(common);

  if (rest.length > 0) {
    throw new Error(`Unknown argument: ${rest[0]}`);
  }

  return {
    realm: common.realm,
    domain: common.domain,
    entity: common.entity,
    dryRun: common.dryRun,
  };
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

function shouldRemoveType(type: string | undefined): type is SourceTypeToRemove {
  return type === "general" || type === "guidance";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const storage = getDefaultStorage(options.realm);
  const targets = await resolveTargets(storage, options);

  if (targets.length === 0) {
    console.log("No matching domain/entity targets found.");
    return;
  }

  let rulesetsScanned = 0;
  let rulesetsUpdated = 0;
  let sourcesRemovedTotal = 0;

  for (const target of targets) {
    const ruleset = await storage.getRuleset(target.domainId, target.entityId);
    if (!ruleset || !Array.isArray(ruleset.sources) || ruleset.sources.length === 0) {
      continue;
    }

    rulesetsScanned += 1;
    const before = ruleset.sources.length;
    const keptSources = ruleset.sources.filter(source => !shouldRemoveType(source.type));
    const removed = before - keptSources.length;

    if (removed <= 0) {
      continue;
    }

    ruleset.sources = keptSources;
    sourcesRemovedTotal += removed;
    rulesetsUpdated += 1;

    if (!options.dryRun) {
      await storage.saveRuleset(ruleset);
    }

    console.log(
      `${options.dryRun ? "[DRY-RUN] " : ""}Removed ${removed} source${removed === 1 ? "" : "s"} from ${options.realm}/${target.domainId}/${target.entityId}`,
    );
  }

  console.log(
    `${options.dryRun ? "[DRY-RUN] " : ""}Done. targets=${targets.length} rulesetsScanned=${rulesetsScanned} rulesetsUpdated=${rulesetsUpdated} sourcesRemoved=${sourcesRemovedTotal}`,
  );
}

main().catch(error => {
  console.error("Ruleset source cleanup failed:", error);
  process.exit(1);
});
