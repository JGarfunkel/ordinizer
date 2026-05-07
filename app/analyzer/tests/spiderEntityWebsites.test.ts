// Factory mocks prevent Jest from evaluating the real modules (which would
// trigger the module-level DOMAINS / DOMAIN_MAPPING initialisers in
// extractionConfig.ts and crash on the missing spreadsheetExtractionProperties
// data file).
jest.mock("../lib/extractionUtils", () => ({
  addOrUpdateSource: jest.fn(),
  delay: jest.fn(),
  downloadFromUrlAnyType: jest.fn(),
  pdfToText: jest.fn(),
  DELAY_BETWEEN_DOWNLOADS: 5000,
  verboseLog: jest.fn(),
  getProjectRootDir: jest.fn(() => process.cwd()),
  loadStatuteLibraryConfig: jest.fn(),
}));
jest.mock("../lib/scriptArgs", () => ({
  parseCommonCliArgs: jest.fn(() => ({ common: {}, rest: [] })),
  requireDataRootAndRealm: jest.fn(),
}));

import {
  applyActiveBoilerplate,
  canSkipStatus,
  detectBoilerplateCandidates,
  formatTxtArtifact,
  hasHighCapitalizedIndexDensity,
  isDomainScoreMatch,
  isLikelyIndexPage,
  migrateHistoryEntry,
  scoreDomainDetailed,
  updateWebsiteHostRecord,
} from "../lib/spiderEntityWebsites";

describe("spiderEntityWebsites helpers", () => {
  it("derives skip semantics from status", () => {
    expect(canSkipStatus("related")).toBe(false);
    expect(canSkipStatus("index")).toBe(false);
    expect(canSkipStatus("unrelated")).toBe(true);
    expect(canSkipStatus("timeout")).toBe(true);
  });

  it("migrates legacy history entry and drops legacy-only fields", () => {
    const migrated = migrateHistoryEntry({
      url: "https://example.org/policies#top",
      status: "good",
      entityId: "NY-Test-Town",
      matchedDomainIds: ["wetlands", 1, null],
      skip: true,
    });

    expect(migrated).toBeTruthy();
    expect(migrated?.url).toBe("https://example.org/policies");
    expect(migrated?.matchedDomainIds).toEqual(["wetlands"]);
    expect(migrated?.status).toBe("related");
    expect((migrated as any)?.skip).toBeUndefined();
  });

  it("formats txt artifacts with URL/timestamp header", () => {
    const output = formatTxtArtifact(
      "https://example.org/code",
      "2026-05-03T10:00:00.000Z",
      "  Ordinance content body.  ",
    );

    expect(output.startsWith("# https://example.org/code downloaded at 2026-05-03T10:00:00.000Z")).toBe(true);
    expect(output.endsWith("Ordinance content body.")).toBe(true);
  });

  it("promotes repeated boilerplate candidates and trims active header/footer", () => {
    const websitesFile = { hosts: [] as any[] };
    const body = [
      "Village of Example Public Works",
      "Official Policy Portal",
      "Main content starts here",
      "Section details continue",
      "Copyright 2026 Example Village",
      "Contact us",
    ].join("\n");

    updateWebsiteHostRecord(websitesFile as any, "example.org", body, "2026-05-03T10:00:00.000Z");
    const hostAfterSecond = updateWebsiteHostRecord(websitesFile as any, "example.org", body, "2026-05-03T11:00:00.000Z");

    expect(hostAfterSecond?.activeHeader).toBeTruthy();
    expect(hostAfterSecond?.activeFooter).toBeTruthy();

    const trimmed = applyActiveBoilerplate(body, hostAfterSecond as any);
    expect(trimmed).toContain("Main content starts here");
    expect(trimmed).not.toContain("Village of Example Public Works");
  });

  it("detects likely index pages by title or link volume", () => {
    const byTitle = isLikelyIndexPage({
      url: "https://example.org/code",
      title: "Table of Contents",
      links: ["https://example.org/a"],
      plainText: "",
      textSample: "",
      depth: 0,
      isPdf: false,
    } as any);
    const byLinks = isLikelyIndexPage({
      url: "https://example.org/code",
      title: "Municipal Code",
      links: Array.from({ length: 45 }).map((_, i) => `https://example.org/${i}`),
      plainText: "",
      textSample: "",
      depth: 0,
      isPdf: false,
    } as any);

    expect(byTitle).toBe(true);
    expect(byLinks).toBe(true);
  });

  it("detects index-like pages by high capitalization density with navigation context", () => {
    const noisyIndexLikeText = [
      "Skip to Main Content Alert 5/1 Court Office Closure Read On",
      "Create a Website Account Sign In Government Community Doing Business How Do I",
      "Home Quick Links Permitting Land Use Boards Conservation Board",
      "Categories All Categories Assessor Bedford Economic Alliance Bedford Village Historic District",
      "Building Department Finance Department Highway Division Planning Department Police Department",
      "Public Meetings Public Works Recreation and Parks Recycling Site Links Supervisor Sustainability",
      "Town Board Town Clerk Town Historian Traffic Safety Working Group Tree Advisory Board",
      "Wetlands Control Commission Zoning Board of Appeals Meeting Agendas Subscribe for Updates",
      "Quick Links Court Police Town Clerk Staff Directory Site Map Accessibility",
    ].join("\n");

    expect(hasHighCapitalizedIndexDensity(noisyIndexLikeText)).toBe(true);

    const byCapitalization = isLikelyIndexPage({
      url: "https://example.org/home",
      title: "Town Home",
      links: Array.from({ length: 8 }).map((_, i) => `https://example.org/${i}`),
      plainText: noisyIndexLikeText,
      textSample: noisyIndexLikeText.slice(0, 500),
      depth: 0,
      isPdf: false,
    } as any);

    expect(byCapitalization).toBe(true);
  });

  it("does not classify personnel pages as index from capitalization alone", () => {
    const personnelPage = [
      "Town Board Members",
      "John Carter Chair",
      "Maria Davis Vice Chair",
      "Daniel Green Member",
      "Sophia Hill Member",
      "Planning Board Members",
      "Ethan Turner Chair",
      "Olivia Brooks Member",
      "Contact Board Members",
      "Staff Directory and Contact Information",
    ].join("\n");

    const looksIndex = isLikelyIndexPage({
      url: "https://example.org/government/board-members",
      title: "Board Members",
      links: Array.from({ length: 6 }).map((_, i) => `https://example.org/member-${i}`),
      plainText: personnelPage,
      textSample: personnelPage,
      depth: 0,
      isPdf: false,
    } as any);

    expect(looksIndex).toBe(false);
  });

  it("weights title and Hn headers more strongly for domain matching", () => {
    const domains = [
      {
        id: "wetlands",
        name: "Wetlands",
        displayName: "Wetlands",
        description: "wetlands conservation and protection",
        type: "policy",
        keywords: ["wetlands", "conservation", "permitting"],
      },
      {
        id: "parking",
        name: "Parking",
        displayName: "Parking",
        description: "parking permits and violations",
        type: "general",
        keywords: ["parking", "meter", "violation"],
      },
    ] as any;

    const page = {
      url: "https://example.org/departments/environment",
      title: "Wetlands Conservation Permitting Guide",
      headers: ["Wetlands Permitting", "Conservation Review Checklist"],
      plainText: "Application details and filing instructions.",
      textSample: "Application details and filing instructions.",
      links: ["https://example.org/forms"],
      depth: 0,
      isPdf: false,
    } as any;

    const scores = scoreDomainDetailed(domains, page);
    const wetlands = scores.find((s) => s.domainId === "wetlands");
    const parking = scores.find((s) => s.domainId === "parking");

    expect(wetlands).toBeTruthy();
    expect(parking).toBeTruthy();
    expect(wetlands?.headerHits).toBeGreaterThan(0);
    expect(wetlands?.titleHits).toBeGreaterThan(0);
    expect(isDomainScoreMatch(wetlands as any)).toBe(true);
    expect(isDomainScoreMatch(parking as any)).toBe(false);
  });

  it("only matches boards domain for conservation board phrases", () => {
    const domains = [
      {
        id: "boards",
        name: "boards",
        displayName: "Governing Boards & Committees",
        description: "Governance structure, authority, public access, and decision-making for boards and committees",
        type: "general",
        keywords: ["meeting", "committee", "agenda", "minutes", "public notice"],
      },
    ] as any;

    const genericBoardPage = {
      url: "https://example.org/government/town-board",
      title: "Town Board Meeting Minutes",
      headers: ["Agenda and Minutes"],
      plainText: "View meeting agendas, minutes, committee assignments, and public notices for the Town Board.",
      textSample: "View meeting agendas, minutes, committee assignments, and public notices for the Town Board.",
      links: [],
      depth: 0,
      isPdf: false,
    } as any;

    const conservationBoardPage = {
      url: "https://example.org/boards/conservation-board",
      title: "Conservation Board",
      headers: ["Conservation Board Members", "Conservation Board Meeting Schedule"],
      plainText: "The Conservation Board advises the town on environmental matters.",
      textSample: "The Conservation Board advises the town on environmental matters.",
      links: [],
      depth: 0,
      isPdf: false,
    } as any;

    const genericScore = scoreDomainDetailed(domains, genericBoardPage, "Conservation Board")[0];
    const conservationScore = scoreDomainDetailed(domains, conservationBoardPage, "Conservation Board")[0];

    expect(isDomainScoreMatch(genericScore)).toBe(false);
    expect(genericScore.matchedKeywords).toEqual([]);
    expect(isDomainScoreMatch(conservationScore)).toBe(true);
    expect(conservationScore.matchedKeywords).toContain("conservation board");
  });

  it("does not match boards domain when governingBody is not conservation-specific", () => {
    const domains = [
      {
        id: "boards",
        name: "boards",
        displayName: "Governing Boards & Committees",
        type: "general",
        keywords: ["meeting", "committee", "agenda", "minutes"],
      },
    ] as any;

    const page = {
      url: "https://example.org/boards/town-board",
      title: "Town Board",
      headers: ["Board Meetings"],
      plainText: "Town Board agendas and minutes.",
      textSample: "Town Board agendas and minutes.",
      links: [],
      depth: 0,
      isPdf: false,
    } as any;

    const score = scoreDomainDetailed(domains, page, "Town Board")[0];

    expect(isDomainScoreMatch(score)).toBe(false);
    expect(score.matchedKeywords).toEqual([]);
  });

  it("extracts boilerplate candidates from top and bottom lines", () => {
    const candidates = detectBoilerplateCandidates([
      "Village of Example Public Works",
      "Official Policy Portal",
      "Main body sentence one.",
      "Main body sentence two.",
      "Copyright 2026 Example Village",
      "Contact us",
    ].join("\n"));

    expect(candidates.header).toContain("village of example public works");
    expect(candidates.footer).toContain("copyright 2026 example village");
  });
});
