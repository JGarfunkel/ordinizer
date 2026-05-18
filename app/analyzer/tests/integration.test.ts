import path from "path";
import { downloadAndProcessSource, extractAndCleanHtmlContent } from "../lib/sourceDownloader";
import { setVerboseMode } from "../lib/extractionConfig";
import { getDefaultStorage } from "@civillyengaged/ordinizer-servercore";
import fs from "fs-extra";
import { discoverContentSelector } from "../lib/spiderPageAnalysis";

// Integration test for downloadAndProcessSource
// Run with: npx jest tests/integration.downloadAndProcessSource.test.ts

const realmId = "westchester-municipal-environmental";

describe("return sourcemap", () => {
  it("should return a source map for a realm", async () => {
    const storage = getDefaultStorage(realmId);
    const sourceMap = await storage.getSourceMap();
    console.log("Source map:", sourceMap);
    expect(sourceMap).toBeTruthy();
    expect(sourceMap?.get("NY-Bedford-Town")).toBeTruthy();
    const entitySources = await storage.getSourcesForEntity("NY-Bedford-Town");
    expect(entitySources).toBeTruthy();
    expect(entitySources?.domains).toBeTruthy();
    expect(entitySources?.domains["trees"]).toBeTruthy();
  });
});

describe('Download and Process Source', () => {
  setVerboseMode(true); // Enable verbose logging for this test suite
  xit('should download and process source for a specific entity', async () => {

    await downloadAndProcessSource("westchester-municipal-environmental", "wetland-protection", "NY-Bedford-Town");

  }, 60000); // Set timeout to 60 seconds for this test

  xit('should read an html statute source and extract text content', async () => {
    const storage = getDefaultStorage(realmId);
    const dirpath = path.join(await storage.getRealmDir(), "wetland-protection", "NY-Bedford-Town");
    const sourcePath = path.join(dirpath, "statute-source.html");
    const htmlContent = await fs.readFile(sourcePath, 'utf-8');
    await extractAndCleanHtmlContent(htmlContent).then(async ({ textContent, title }) => {
      expect(textContent).toBeTruthy();
      // check that textContent has less than 3 '}' characters, which would indicate that it's not just the raw HTML
      const numClosingBraces = (textContent.match(/}/g) || []).length;
      expect(numClosingBraces).toBeLessThan(3);
      await fs.writeFile(path.join(dirpath, "statute.txt"), textContent, { encoding: 'utf-8' });
    });


  }, 60000);

  xit('analysis', async () => {
    expect(process.env.OPENAI_API_KEY).toBeTruthy();
    const { analyzeStatutes } = await import("../lib/analyzeStatutes");
    const analyzeOptions = {
      verbose: true,
      entity: "NY-Bedford-Town",
      domain: "wetland-protection",
      realm: realmId,
      force: true
    }
    await analyzeStatutes(analyzeOptions);
    // Check that the output file exists and has content
    const storage = getDefaultStorage(realmId);
    const analysis = await storage.getAnalysis("wetland-protection", "NY-Bedford-Town");
    expect(analysis).toBeTruthy();
    expect(analysis?.lastUpdated).toBeTruthy();
    if (analysis?.lastUpdated) {
      // check that analysis.lastUpdate is from the last 5 minutes
      const lastUpdatedDate = new Date(analysis.lastUpdated);
      const now = new Date();
      const timeDiff = now.getTime() - lastUpdatedDate.getTime();
      expect(timeDiff).toBeLessThan(5 * 60 * 1000); // less than 5 minutes
    }
    expect(analysis?.questions).toBeTruthy();
    expect(analysis?.questions.length).toBeGreaterThan(0);
  }, 120000); // Set timeout to 120 seconds for this test

});

describe("spiderPageAnalysis with real mock HTML files", () => {
  xit("discovers a selector from same-template living-here fixtures", async () => {
    const fixturesDir = path.join(__dirname, "__mocks__");
    const secondaryOne = await fs.readFile(path.join(fixturesDir, "living-here.html"), "utf-8");
    const secondaryTwo = await fs.readFile(path.join(fixturesDir, "conservation-board.html"), "utf-8");

    const selector = discoverContentSelector(
      { name: "Bedford", type: "Town", state: "NY" },
      secondaryOne,
      "https://example.org/living-here.html",
      secondaryTwo,
      "https://example.org/conservation-board.html",
    );

    expect(selector).toBeDefined();
    expect(["#moduleContent", "#page", "[data-cprole='mainContentContainer']"]).toContain(selector);
  });

  it('discovers a selector from different-template fixtures using title-based fallback', async () => {
    const fixturesDir = path.join(__dirname, "__mocks__");
    const secondaryOne = await fs.readFile(path.join(fixturesDir, "conservation-advisory-council.html"), "utf-8");
    const selector = discoverContentSelector(
      { name: "Bedford", type: "Town", state: "NY" },
      secondaryOne,
      "https://example.org/conservation-advisory-council.html");

    expect(selector).toBeDefined();
    // selector should not be ""#freeform-slider"
    expect(selector).not.toBe("#freeform-slider");

  });
});

