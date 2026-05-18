import fs from "fs-extra";
import os from "os";
import path from "path";

import {
  extractDocumentTitleWithCache,
  normalizeUrlForMatch,
  type SpiderDownloadRecord,
} from "../lib/spiderHistory";

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
