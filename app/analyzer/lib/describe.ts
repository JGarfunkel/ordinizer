/**
 * describe.ts
 *
 * Prints a summary of what exists in the current data directory:
 *   - How many realms, domains, entities
 *   - Question and analysis coverage per domain
 *   - Suggested next steps
 *
 * Usage:
 *   ordinizer describe [--realm <id>] [--domain <id>]
 */

import { styleText } from "node:util";
import { Pinecone } from "@pinecone-database/pinecone";
import { getDefaultStorage, getRealmsFromStorage } from "@civillyengaged/ordinizer-servercore";
import { parseCommonCliArgs } from "./scriptArgs.js";
import { loadWebsitesFile } from "./spiderHistory.js";
import type { Entity } from "@civillyengaged/ordinizer-core";

function ok(s: string) { return styleText("green", s); }
function warn(s: string) { return styleText("yellow", s); }
function dim(s: string) { return styleText("dim", s); }
function bold(s: string) { return styleText("bold", s); }
function hint(s: string) { return styleText("cyan", s); }

function pct(n: number, total: number): string {
  if (total === 0) return "—";
  return `${Math.round((n / total) * 100)}%`;
}

interface IndexStatus {
  configured: boolean;   // PINECONE_API_KEY is set
  exists: boolean;       // index exists in Pinecone
  vectorCount: number | null;
  error?: string;
}

async function checkVectorIndex(realmId: string): Promise<IndexStatus> {
  if (!process.env.PINECONE_API_KEY) {
    return { configured: false, exists: false, vectorCount: null };
  }
  try {
    const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
    const indexName = `ordinizer-${realmId}`;
    const list = await pinecone.listIndexes();
    const exists = list.indexes?.some(i => i.name === indexName) ?? false;
    if (!exists) {
      return { configured: true, exists: false, vectorCount: null };
    }
    const stats = await pinecone.index(indexName).describeIndexStats();
    const vectorCount = (stats as any).totalRecordCount ?? (stats as any).totalVectorCount ?? null;
    return { configured: true, exists: true, vectorCount };
  } catch (err) {
    return { configured: true, exists: false, vectorCount: null, error: err instanceof Error ? err.message : String(err) };
  }
}

interface WebsiteStats {
  entities: number;
  hosts: number;
  withSelector: number;
  withHeader: number;
  withFooter: number;
}

async function describeWebsites(
  realmId: string,
  filterEntity?: string,
  missingOnly?: boolean,
): Promise<{ lines: string[]; stats: WebsiteStats }> {
  const storage = getDefaultStorage(realmId);
  const entities: Entity[] = await storage.getEntities().catch(() => []);
  const lines: string[] = [];
  const stats: WebsiteStats = { entities: 0, hosts: 0, withSelector: 0, withHeader: 0, withFooter: 0 };

  const filtered = filterEntity ? entities.filter((e) => e.id === filterEntity) : entities;

  for (const entity of filtered) {
    const websitesFile = await loadWebsitesFile(storage, entity.id);
    const hosts = Object.values(websitesFile.hosts);
    if (hosts.length === 0) continue;

    const relevant = missingOnly ? hosts.filter((h) => !h.contentSelector) : hosts;
    if (relevant.length === 0) continue;

    stats.entities++;
    lines.push(`  ${bold(entity.id)}  ${dim(`(${hosts.length} host${hosts.length !== 1 ? "s" : ""})`)}`);

    for (const host of relevant) {
      stats.hosts++;
      const obsLabel = `${host.observations} obs`;

      if (host.contentSelector) {
        stats.withSelector++;
        lines.push(`    ${ok("✓")} ${bold(host.hostname)}  ${dim(`(${obsLabel})`)}  selector: ${hint(host.contentSelector)}`);
      } else {
        lines.push(`    ${warn("✗")} ${bold(host.hostname)}  ${dim(`(${obsLabel})`)}  selector: ${warn("(missing)")}`);
      }

      // Header strip text
      if (host.activeHeader) {
        stats.withHeader++;
        const t = host.activeHeader.length > 72 ? host.activeHeader.slice(0, 72) + "…" : host.activeHeader;
        lines.push(`        header strip: ${dim(`"${t}"`)}`);
      } else {
        const count = Object.keys(host.headerCandidates ?? {}).length;
        if (count > 0) {
          lines.push(`        header strip: ${warn("(not promoted)")}  ${dim(`${count} candidate${count !== 1 ? "s" : ""} — need 2+ matches`)}`);
          for (const [text, n] of Object.entries(host.headerCandidates).slice(0, 2)) {
            const t = text.length > 64 ? text.slice(0, 64) + "…" : text;
            lines.push(`          ${dim(`[${n}x]`)} ${dim(t)}`);
          }
        } else {
          lines.push(`        header strip: ${dim("(none)")}`);
        }
      }

      // Footer strip text
      if (host.activeFooter) {
        stats.withFooter++;
        const t = host.activeFooter.length > 72 ? host.activeFooter.slice(0, 72) + "…" : host.activeFooter;
        lines.push(`        footer strip: ${dim(`"${t}"`)}`);
      } else {
        const count = Object.keys(host.footerCandidates ?? {}).length;
        if (count > 0) {
          lines.push(`        footer strip: ${warn("(not promoted)")}  ${dim(`${count} candidate${count !== 1 ? "s" : ""} — need 2+ matches`)}`);
          for (const [text, n] of Object.entries(host.footerCandidates).slice(0, 2)) {
            const t = text.length > 64 ? text.slice(0, 64) + "…" : text;
            lines.push(`          ${dim(`[${n}x]`)} ${dim(t)}`);
          }
        } else {
          lines.push(`        footer strip: ${dim("(none)")}`);
        }
      }
    }
    lines.push("");
  }

  return { lines, stats };
}

async function describeRealm(realmId: string, filterDomain?: string): Promise<string[]> {
  const storage = getDefaultStorage(realmId);
  const lines: string[] = [];

  const [realmConfig, entities, domains] = await Promise.all([
    storage.getRealmConfig().catch(() => null),
    storage.getEntities().catch(() => []),
    storage.getDomains().catch(() => []),
  ]);

  const ruleType = (realmConfig as any)?.ruleType ?? "unknown";
  const entityType = (realmConfig as any)?.entityType ?? "entities";
  const stateLabel = (realmConfig as any)?.stateProvince ? ` · ${(realmConfig as any).stateProvince}` : "";

  lines.push(`${bold(realmId)}  ${dim(`(${ruleType}${stateLabel})`)}`);
  lines.push(`  ${entityType}: ${bold(String(entities.length))}`);
  lines.push(`  Domains: ${bold(String(domains.length))}`);

  const visibleDomains = filterDomain ? domains.filter(d => d.id === filterDomain) : domains;
  if (filterDomain && visibleDomains.length === 0) {
    lines.push(`  ${warn(`Domain "${filterDomain}" not found in this realm`)}`);
    return lines;
  }

  const suggestions: string[] = [];

  // Vector index
  const indexStatus = await checkVectorIndex(realmId);
  lines.push("");
  if (!indexStatus.configured) {
    lines.push(`  ${dim("Vector index: not configured")}  ${dim("(PINECONE_API_KEY not set)")}`);
  } else if (indexStatus.error) {
    lines.push(`  ${warn("?")} Vector index: error checking  ${dim(`(${indexStatus.error})`)}`);
  } else if (!indexStatus.exists) {
    lines.push(`  ${warn("✗")} Vector index: not created`);
    suggestions.push(`  • No vector index — spider entities first, then index\n    ${hint(`→ ordinizer spider --realm ${realmId} --all`)}\n    ${hint(`→ ordinizer index  --realm ${realmId}`)}`);
  } else if (!indexStatus.vectorCount) {
    lines.push(`  ${warn("~")} Vector index: exists but empty`);
    suggestions.push(`  • Vector index is empty — spider entities to download documents, then index them\n    ${hint(`→ ordinizer spider --realm ${realmId} --all`)}\n    ${hint(`→ ordinizer index  --realm ${realmId}`)}`);
  } else {
    lines.push(`  ${ok("✓")} Vector index: ${indexStatus.vectorCount.toLocaleString()} vectors`);
  }

  for (const domain of visibleDomains) {
    lines.push("");
    lines.push(`  ${bold(domain.displayName || domain.id)}  ${dim(`(${domain.id})`)}`);

    const [questions, analyzedEntityIds] = await Promise.all([
      storage.getQuestionsByDomain(domain.id).catch(() => []),
      storage.listEntityIds(domain.id).catch(() => []),
    ]);

    const totalEntities = entities.length;
    const analyzedCount = analyzedEntityIds.length;

    if (questions.length === 0) {
      lines.push(`    ${warn("✗")} No questions.json`);
      suggestions.push(`  • ${domain.id}: create questions first\n    ${hint(`→ ordinizer analyze --realm ${realmId} --domain ${domain.id} --generate-questions`)}`);
    } else {
      lines.push(`    ${ok("✓")} ${questions.length} question${questions.length !== 1 ? "s" : ""}`);
    }

    if (totalEntities === 0) {
      lines.push(`    ${warn("—")} No entities in realm`);
    } else if (analyzedCount === 0) {
      lines.push(`    ${warn("✗")} No analyses  ${dim(`(0 / ${totalEntities})`)}`);
      if (questions.length > 0) {
        suggestions.push(`  • ${domain.id}: no analyses yet\n    ${hint(`→ ordinizer analyze --realm ${realmId} --domain ${domain.id}`)}`);
      }
    } else if (analyzedCount < totalEntities) {
      const missing = totalEntities - analyzedCount;
      lines.push(`    ${warn("~")} ${analyzedCount} / ${totalEntities} analyzed  ${dim(`(${pct(analyzedCount, totalEntities)} · ${missing} pending)`)}`);
      suggestions.push(`  • ${domain.id}: ${missing} ${entityType} pending\n    ${hint(`→ ordinizer analyze --realm ${realmId} --domain ${domain.id}`)}`);
    } else {
      lines.push(`    ${ok("✓")} ${analyzedCount} / ${totalEntities} analyzed  ${dim(`(${pct(analyzedCount, totalEntities)})`)}`);
    }
  }

  if (suggestions.length > 0) {
    lines.push("");
    lines.push(`  ${bold("Suggested next steps:")}`);
    for (const s of suggestions) lines.push(s);
  }

  return lines;
}

export async function main(): Promise<void> {
  const { common, rest } = parseCommonCliArgs(process.argv.slice(2));
  const showWebsites = rest.includes("--websites");
  const missingOnly = rest.includes("--missing");

  const allRealms = await getRealmsFromStorage();

  if (allRealms.length === 0) {
    console.log(warn("No realms found. Is DATA_ROOT set correctly?"));
    console.log(dim(`  DATA_ROOT=${process.env.DATA_ROOT ?? "(not set, defaults to ./data)"}`));
    return;
  }

  const realmsToDescribe = common.realm
    ? allRealms.filter(r => r.id === common.realm)
    : allRealms;

  if (realmsToDescribe.length === 0) {
    console.log(warn(`Realm "${common.realm}" not found.`));
    console.log(`Available: ${allRealms.map(r => r.id).join(", ")}`);
    return;
  }

  if (showWebsites) {
    console.log(`${bold("Website boilerplate / selector review")}${missingOnly ? dim("  (--missing: selector gaps only)") : ""}\n`);
    const totals: WebsiteStats = { entities: 0, hosts: 0, withSelector: 0, withHeader: 0, withFooter: 0 };
    for (const realm of realmsToDescribe) {
      console.log(`${bold(realm.id)}`);
      const { lines, stats } = await describeWebsites(realm.id, common.entity, missingOnly);
      if (lines.length === 0) {
        console.log(`  ${dim("No websites.json data found")}\n`);
      } else {
        console.log(lines.join("\n"));
      }
      totals.entities += stats.entities;
      totals.hosts += stats.hosts;
      totals.withSelector += stats.withSelector;
      totals.withHeader += stats.withHeader;
      totals.withFooter += stats.withFooter;
    }
    const missing = totals.hosts - totals.withSelector;
    console.log(`${bold("Totals:")} ${totals.entities} entities · ${totals.hosts} hosts`);
    console.log(`  contentSelector: ${totals.withSelector}/${totals.hosts}${missing > 0 ? "  " + warn(`(${missing} missing)`) : "  " + ok("all set")}`);
    console.log(`  header strip:    ${totals.withHeader}/${totals.hosts}`);
    console.log(`  footer strip:    ${totals.withFooter}/${totals.hosts}`);
    return;
  }

  console.log(`${bold("Realms:")} ${allRealms.length}  ${dim(`(showing ${realmsToDescribe.length})`)}\n`);

  for (const realm of realmsToDescribe) {
    const lines = await describeRealm(realm.id, common.domain);
    console.log(lines.join("\n"));
    console.log("");
  }
}
