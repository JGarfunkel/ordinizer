import fs from "fs-extra";
import os from "os";
import path from "path";

import {
  extractDocumentTitleWithCache,
  normalizeUrlForMatch,
  ensureEntityHistoryLayout,
  loadHistoryData,
  saveHistoryData,
  type SpiderDownloadRecord,
} from "../lib/spiderHistory";
import type { DashboardRecord } from "../lib/spiderDashboardDetector";

describe("spiderHistory title extraction", () => {
  let realmDir: string;
  let storage: { getRealmDir: () => string };

  beforeEach(async () => {
    realmDir = await fs.mkdtemp(path.join(os.tmpdir(), "ordinizer-spider-history-"));
    storage = {
      getRealmDir: () => realmDir,
    };
  });

  afterEach(async () => {
    await fs.remove(realmDir);
  });

  it("returns existing title without reading artifacts", async () => {
    const url = "https://example.org/code";
    const historyMap = new Map<string, SpiderDownloadRecord>();
    historyMap.set(normalizeUrlForMatch(url), {
      url: normalizeUrlForMatch(url),
      title: "legacy title",
      matchedDomainIds: [],
      timestamp: new Date().toISOString(),
      status: "related",
    });

    const title = await extractDocumentTitleWithCache(storage, historyMap, url);
    expect(title).toBe("legacy title");
  });

  it("extracts title from cached HTML when current title is blank", async () => {
    const url = "https://example.org/code";
    const normalizedUrl = normalizeUrlForMatch(url);

    const relHtml = "NY-Test-Town/code.html";
    const absHtml = path.join(realmDir, "EntityDownloads", "NY-Test-Town", "code.html");
    await fs.ensureDir(path.dirname(absHtml));
    await fs.writeFile(absHtml, "<html><head><title>Town Environmental Code</title></head><body>...</body></html>", "utf-8");

    const historyMap = new Map<string, SpiderDownloadRecord>();
    historyMap.set(normalizedUrl, {
      url: normalizedUrl,
      title: "",
      matchedDomainIds: [],
      timestamp: new Date().toISOString(),
      status: "related",
      localFile: relHtml,
    });

    const title = await extractDocumentTitleWithCache(storage, historyMap, url);
    expect(title).toBe("Town Environmental Code");
  });
});

describe("spiderHistory dashboards persistence", () => {
  let realmDir: string;
  let storage: { getRealmDir: () => string };
  const entityId = "NY-Test-Town";

  beforeEach(async () => {
    realmDir = await fs.mkdtemp(path.join(os.tmpdir(), "ordinizer-spider-history-dashboards-"));
    storage = {
      getRealmDir: () => realmDir,
    };
  });

  afterEach(async () => {
    await fs.remove(realmDir);
  });

  function makeDashboardRecord(overrides: Partial<DashboardRecord> = {}): DashboardRecord {
    return {
      url: "https://app.powerbigov.us/view?r=aaa",
      canonicalUrl: "https://app.powerbigov.us/view?r=aaa",
      key: "report-guid-123",
      platform: "powerbi_gov",
      confidence: "high",
      discoveryMethod: "anchor",
      name: "Traffic Dashboard",
      nameSource: "anchor_text",
      sourcePages: ["https://www.nyc.gov/page-one"],
      sourcePageCount: 1,
      firstSeen: "2026-01-01T00:00:00.000Z",
      lastSeen: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  it("round-trips a saved dashboardMap through loadHistoryData", async () => {
    await ensureEntityHistoryLayout(storage, entityId);
    const { historyMap, menuLinks } = await loadHistoryData(storage, entityId);

    const dashboardMap = new Map<string, DashboardRecord>();
    dashboardMap.set("report-guid-123", makeDashboardRecord());
    await saveHistoryData(storage, entityId, historyMap, menuLinks, dashboardMap);

    const reloaded = await loadHistoryData(storage, entityId);
    expect(reloaded.dashboardMap.size).toBe(1);
    expect(reloaded.dashboardMap.get("report-guid-123")).toEqual(makeDashboardRecord());
  });

  it("preserves an existing dashboards array when saveHistoryData is called without a dashboardMap", async () => {
    await ensureEntityHistoryLayout(storage, entityId);
    const { historyMap, menuLinks } = await loadHistoryData(storage, entityId);

    const dashboardMap = new Map<string, DashboardRecord>();
    dashboardMap.set("report-guid-123", makeDashboardRecord());
    await saveHistoryData(storage, entityId, historyMap, menuLinks, dashboardMap);

    // Simulate an unrelated code path (e.g. cleanup) that loads/saves history
    // without ever knowing about dashboards.
    const { historyMap: reloadedHistoryMap, menuLinks: reloadedMenuLinks } = await loadHistoryData(storage, entityId);
    await saveHistoryData(storage, entityId, reloadedHistoryMap, reloadedMenuLinks);

    const finalState = await loadHistoryData(storage, entityId);
    expect(finalState.dashboardMap.size).toBe(1);
    expect(finalState.dashboardMap.get("report-guid-123")).toEqual(makeDashboardRecord());
  });
});
