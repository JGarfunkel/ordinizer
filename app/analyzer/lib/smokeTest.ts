/**
 * smokeTest.ts — CLI smoke-test script.
 *
 * Hits a running Ordinizer server, fetches realms, entities, domains,
 * questions, analyses, and scores for the first N entities × M domains
 * in each realm, then writes the collected results to STDOUT or a file.
 *
 * Usage:
 *   npx tsx app/analyzer/lib/smokeTest.ts [options]
 *
 * Options:
 *   --base-url <url>   Server base URL  (default: http://localhost:5000/ordinizer)
 *   --entities  <n>    Max entities per realm  (default: 3)
 *   --domains   <n>    Max domains per realm   (default: 2)
 *   --out       <path> Output file path; omit to write to STDOUT
 */

import fs from "fs-extra";
import path from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function argValue(flag: string, fallback: string): string {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const BASE_URL = argValue("--base-url", "http://localhost:5000/api/ordinizer");
const MAX_ENTITIES = parseInt(argValue("--entities", "3"), 10);
const MAX_DOMAINS = parseInt(argValue("--domains", "2"), 10);
const OUT_FILE = argValue("--out", "");

const API = `${BASE_URL}`;

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function get<T = unknown>(url: string): Promise<{ ok: boolean; status: number; url: string; data: T | null; error?: string }> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, url, data: null, error: text || res.statusText };
    }
    const data = await res.json() as T;
    return { ok: true, status: res.status, url, data };
  } catch (err: any) {
    return { ok: false, status: 0, url, data: null, error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------------
// Types (minimal, matches server responses)
// ---------------------------------------------------------------------------

interface Realm { id: string; displayName: string; [k: string]: unknown }
interface Entity { id: string; displayName: string; [k: string]: unknown }
interface Domain { id: string; displayName: string; [k: string]: unknown }
interface Question { id: number | string; question: string; weight?: number; [k: string]: unknown }

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  const report: Record<string, unknown> = { baseUrl: BASE_URL, timestamp: new Date().toISOString(), realms: [] };
  const realmResults: unknown[] = [];
  report.realms = realmResults;

  // ------------------------------------------------------------------
  // 1. Realms
  // ------------------------------------------------------------------
  log(`→ GET ${API}/realms`);
  const realmsResp = await get<Realm[]>(`${API}/realms`);
  if (!realmsResp.ok || !realmsResp.data) {
    log(`ERROR fetching realms: ${realmsResp.error}`);
    await output(report);
    process.exit(1);
  }

  const realms = realmsResp.data;
  log(`  Found ${realms.length} realm(s): ${realms.map(r => r.id).join(", ")}`);

  for (const realm of realms) {
    const realmResult: Record<string, unknown> = { id: realm.id, displayName: realm.displayName, entities: [], domains: [] };
    realmResults.push(realmResult);

    // ----------------------------------------------------------------
    // 2. Map boundaries
    // ----------------------------------------------------------------
    log(`[${realm.id}] → GET map-boundaries`);
    const boundaryResp = await get<{ features?: unknown[] }>(`${API}/map-boundaries?realm=${realm.id}`);
    if (!boundaryResp.ok) {
      realmResult.mapBoundaries = { error: boundaryResp.error, status: boundaryResp.status, url: boundaryResp.url };
      log(`  ERROR: ${boundaryResp.status} ${boundaryResp.error}`);
      warn(`[${realm.id}] map-boundaries FAILED (${boundaryResp.status}): ${boundaryResp.url}`);
    } else {
      const featuresCount = (boundaryResp.data as any)?.features?.length ?? null;
      realmResult.mapBoundaries = { featuresCount };
      log(`  features.length=${featuresCount ?? "n/a"}`);
      if (!featuresCount) warn(`[${realm.id}] map-boundaries returned 0 features: ${boundaryResp.url}`);
    }

    // ----------------------------------------------------------------
    // 3. Entities
    // ----------------------------------------------------------------
    log(`\n[${realm.id}] → GET entities`);
    const entitiesResp = await get<Entity[]>(`${API}/realms/${realm.id}/entities`);
    if (!entitiesResp.ok) warn(`[${realm.id}] entities FAILED (${entitiesResp.status}): ${entitiesResp.url}`);
    const allEntities = entitiesResp.ok && entitiesResp.data ? entitiesResp.data : [];
    if (entitiesResp.ok && allEntities.length === 0) warn(`[${realm.id}] entities returned 0 results: ${entitiesResp.url}`);
    const entities = allEntities.slice(0, MAX_ENTITIES);
    log(`  ${allEntities.length} entities total, testing first ${entities.length}`);
    (realmResult.entities as unknown[]).push(...entities.map(e => ({ id: e.id, displayName: e.displayName })));

    // ----------------------------------------------------------------
    // 3. Domains
    // ----------------------------------------------------------------
    log(`[${realm.id}] → GET domains`);
    const domainsResp = await get<Domain[]>(`${API}/realms/${realm.id}/domains`);
    if (!domainsResp.ok) warn(`[${realm.id}] domains FAILED (${domainsResp.status}): ${domainsResp.url}`);
    const allDomains = domainsResp.ok && domainsResp.data ? domainsResp.data : [];
    if (domainsResp.ok && allDomains.length === 0) warn(`[${realm.id}] domains returned 0 results: ${domainsResp.url}`);
    const domains = allDomains.slice(0, MAX_DOMAINS);
    log(`  ${allDomains.length} domains total, testing first ${domains.length}`);
    (realmResult.domains as unknown[]).push(...domains.map(d => ({ id: d.id, displayName: d.displayName })));

    // ----------------------------------------------------------------
    // 4. Questions per domain
    // ----------------------------------------------------------------
    const questionsResult: Record<string, unknown> = {};
    realmResult.questions = questionsResult;

    for (const domain of domains) {
      log(`[${realm.id}/${domain.id}] → GET questions`);
      const qResp = await get<{ questions?: Question[] } | Question[]>(
        `${API}/realms/${realm.id}/domains/${domain.id}/questions`
      );
      if (!qResp.ok) {
        questionsResult[domain.id] = { error: qResp.error, status: qResp.status, url: qResp.url };
        log(`  ERROR: ${qResp.error}`);
        warn(`[${realm.id}/${domain.id}] questions FAILED (${qResp.status}): ${qResp.url}`);
      } else {
        const raw = qResp.data;
        const questions: Question[] = Array.isArray(raw)
          ? raw
          : ((raw as any)?.questions ?? []);
        log(`  ${questions.length} question(s)`);
        if (questions.length === 0) warn(`[${realm.id}/${domain.id}] questions returned 0 results: ${qResp.url}`);
        questionsResult[domain.id] = questions;
      }
    }

    // ----------------------------------------------------------------
    // 5. Per entity × domain: analysis, scores, jurisdictions
    // ----------------------------------------------------------------
    const entityResults: Record<string, unknown>[] = [];
    realmResult.entityData = entityResults;

    for (const entity of entities) {
      const entityData: Record<string, unknown> = { id: entity.id, displayName: entity.displayName, domains: {} };
      entityResults.push(entityData);
      const domainData = entityData.domains as Record<string, unknown>;

      // Jurisdictions / available domains for this entity
      log(`[${realm.id}/${entity.id}] → GET jurisdiction domains`);
      const jResp = await get(`${API}/realms/${realm.id}/jurisdictions/${entity.id}/domains`);
      if (!jResp.ok) warn(`[${realm.id}/${entity.id}] jurisdiction domains FAILED (${jResp.status}): ${jResp.url}`);
      else if (Array.isArray(jResp.data) && jResp.data.length === 0) warn(`[${realm.id}/${entity.id}] jurisdiction domains returned 0 results: ${jResp.url}`);
      entityData.jurisdictionDomains = jResp.ok ? jResp.data : { error: jResp.error, status: jResp.status, url: jResp.url };

      for (const domain of domains) {
        const cell: Record<string, unknown> = {};
        domainData[domain.id] = cell;

        // Analysis
        log(`[${realm.id}/${entity.id}/${domain.id}] → GET analysis`);
        const aResp = await get(`${API}/analyses/${realm.id}/${entity.id}/${domain.id}`);
        if (!aResp.ok) {
          cell.analysis = { error: aResp.error, status: aResp.status, url: aResp.url };
          log(`  analysis: ${aResp.status} ${aResp.error}`);
          warn(`[${realm.id}/${entity.id}/${domain.id}] analysis FAILED (${aResp.status}): ${aResp.url}`);
        } else {
          const analysisPayload = aResp.data as any;
          const analysis = analysisPayload?.analysis ?? analysisPayload;
          cell.analysis = {
            questionsCount: analysis?.questions?.length ?? null,
            grade: analysis?.domain?.grade ?? analysis?.grade ?? null,
            overallScore: analysis?.overallScore ?? null,
          };
          log(`  analysis: ${analysis?.questions?.length ?? "?"} questions, grade=${analysis?.domain?.grade ?? analysis?.grade ?? "?"}`);
        }

        // Analysis versions
        log(`[${realm.id}/${entity.id}/${domain.id}] → GET analysis versions`);
        const vResp = await get<{ versions: unknown[] }>(`${API}/analyses/${realm.id}/${entity.id}/${domain.id}/versions`);
        const versionCount = vResp.ok ? ((vResp.data as any)?.versions?.length ?? 0) : null;
        if (!vResp.ok) warn(`[${realm.id}/${entity.id}/${domain.id}] analysis versions FAILED (${vResp.status}): ${vResp.url}`);
        else if (versionCount === 0) warn(`[${realm.id}/${entity.id}/${domain.id}] analysis versions returned 0 results: ${vResp.url}`);
        cell.analysisVersions = vResp.ok ? versionCount : { error: vResp.error, status: vResp.status, url: vResp.url };

        // Scores
        log(`[${realm.id}/${entity.id}/${domain.id}] → GET scores`);
        const sResp = await get(`${API}/scores/${realm.id}/${entity.id}/${domain.id}`);
        if (!sResp.ok) {
          cell.scores = { error: sResp.error, status: sResp.status, url: sResp.url };
          log(`  scores: ${sResp.status} ${sResp.error}`);
          warn(`[${realm.id}/${entity.id}/${domain.id}] scores FAILED (${sResp.status}): ${sResp.url}`);
        } else {
          const scores = sResp.data as any;
          cell.scores = {
            overallScore: scores?.overallScore ?? null,
            normalizedScore: scores?.normalizedScore ?? null,
            scoreColor: scores?.scoreColor ?? null,
          };
          log(`  scores: overall=${scores?.overallScore ?? "?"}`);
        }
      }
    }
  }

  await output(report);
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  process.stderr.write(msg + "\n");
}

function warn(msg: string) {
  process.stdout.write("WARN: " + msg + "\n");
}

async function output(data: unknown) {
  const json = JSON.stringify(data, null, 2);
  if (OUT_FILE) {
    const outPath = path.resolve(OUT_FILE);
    await fs.ensureDir(path.dirname(outPath));
    await fs.writeFile(outPath, json, "utf-8");
    log(`\n✓ Results written to ${outPath}`);
  } else {
    process.stdout.write(json + "\n");
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

run().catch(err => {
  process.stderr.write(`Fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
