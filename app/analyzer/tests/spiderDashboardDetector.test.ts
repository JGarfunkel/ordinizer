import {
  detectDashboards,
  mergeDashboardCandidate,
  type DashboardCandidate,
  type DashboardRecord,
} from "../lib/spiderDashboardDetector";

function base64UrlEncode(json: unknown): string {
  return Buffer.from(JSON.stringify(json), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("spiderDashboardDetector", () => {
  describe("platform registry", () => {
    it("detects a Power BI gov report and decodes the ?r= token (padding stripped)", () => {
      const reportGuid = "8c6b1f2a-1111-2222-3333-444455556666";
      const tenantGuid = "9d7c2f3b-aaaa-bbbb-cccc-ddddeeeeffff";
      const token = base64UrlEncode({ k: reportGuid, t: tenantGuid });
      const html = `<html><body><a href="https://app.powerbigov.us/view?r=${token}">Traffic Volumes Dashboard</a></body></html>`;

      const candidates = detectDashboards(html, "https://www.nyc.gov/html/dot/html/about/datafeeds.shtml");
      expect(candidates).toHaveLength(1);
      const [candidate] = candidates;
      expect(candidate.platform).toBe("powerbi_gov");
      expect(candidate.confidence).toBe("high");
      expect(candidate.reportGuid).toBe(reportGuid);
      expect(candidate.tenantGuid).toBe(tenantGuid);
      expect(candidate.name).toBe("Traffic Volumes Dashboard");
      expect(candidate.nameSource).toBe("anchor_text");
    });

    it("strips Tableau display params from canonicalUrl and keys on host+path", () => {
      const html = `<html><body><a href="https://public.tableau.com/views/PublicSafety/Overview?:embed=y&:toolbar=no&utm_source=newsletter">Public Safety Overview</a></body></html>`;
      const candidates = detectDashboards(html, "https://example.gov/reports");
      expect(candidates).toHaveLength(1);
      const [candidate] = candidates;
      expect(candidate.platform).toBe("tableau");
      expect(candidate.canonicalUrl).not.toContain(":embed");
      expect(candidate.canonicalUrl).not.toContain(":toolbar");
      expect(candidate.canonicalUrl).not.toContain("utm_source");
      expect(candidate.key).toBe("public.tableau.com/views/PublicSafety/Overview");
    });

    it("keeps only the ArcGIS identity params (id/appid/webmap) in the key", () => {
      const html = `<html><body><a href="https://storymaps.arcgis.com/stories/abc123?webmap=XYZ&extent=1,2,3,4&center=0,0">City Story Map</a></body></html>`;
      const candidates = detectDashboards(html, "https://example.gov/maps");
      expect(candidates).toHaveLength(1);
      const [candidate] = candidates;
      expect(candidate.platform).toBe("arcgis");
      expect(candidate.canonicalUrl).toContain("webmap=XYZ");
      expect(candidate.canonicalUrl).not.toContain("extent");
      expect(candidate.canonicalUrl).not.toContain("center");
    });

    it("extracts the Socrata 4x4 id from a rendered view URL", () => {
      const html = `<html><body><a href="https://data.cityofnewyork.us/view/h9gi-nx95">Motor Vehicle Collisions View</a></body></html>`;
      const candidates = detectDashboards(html, "https://example.gov/data");
      expect(candidates).toHaveLength(1);
      expect(candidates[0].platform).toBe("socrata_view");
      expect(candidates[0].key).toBe("h9gi-nx95");
    });

    it("does not treat a bare Socrata dataset landing page as a dashboard", () => {
      const html = `<html><body><a href="https://data.cityofnewyork.us/Public-Safety/Motor-Vehicle-Collisions-Crashes/h9gi-nx95">Motor Vehicle Collisions - Crashes dataset</a></body></html>`;
      const candidates = detectDashboards(html, "https://example.gov/data");
      expect(candidates).toHaveLength(0);
    });
  });

  describe("lexical fallback", () => {
    it("emits a review-confidence candidate for an unrecognized host with dashboard-smelling anchor text", () => {
      const html = `<html><body><a href="https://random-agency.example.gov/tools/crime-tracker">Crime Tracker</a></body></html>`;
      const candidates = detectDashboards(html, "https://example.gov/tools");
      expect(candidates).toHaveLength(1);
      expect(candidates[0].platform).toBeNull();
      expect(candidates[0].confidence).toBe("review");
    });

    it("suppresses a lexical match when the URL points at a PDF", () => {
      const html = `<html><body><a href="https://random-agency.example.gov/reports/compstat-2024.pdf">Compstat Report</a></body></html>`;
      const candidates = detectDashboards(html, "https://example.gov/reports");
      expect(candidates).toHaveLength(0);
    });
  });

  describe("name extraction cascade", () => {
    it("prefers iframe title over a misleading nearby heading", () => {
      const html = `<html><body>
        <h2>Wrong Heading</h2>
        <iframe src="https://public.tableau.com/views/PublicSafety/Overview2" title="Crime Explorer Iframe"></iframe>
      </body></html>`;
      const candidates = detectDashboards(html, "https://example.gov/reports");
      expect(candidates).toHaveLength(1);
      expect(candidates[0].name).toBe("Crime Explorer Iframe");
      expect(candidates[0].nameSource).toBe("iframe_title");
    });

    it("rejects generic anchor text and falls back to the nearest preceding heading", () => {
      const html = `<html><head><title>Reports</title></head><body>
        <h2>Public Safety Explorer</h2>
        <p><a href="https://public.tableau.com/views/PublicSafety/Overview">Click Here</a></p>
      </body></html>`;
      const candidates = detectDashboards(html, "https://example.gov/reports");
      expect(candidates).toHaveLength(1);
      expect(candidates[0].name).toBe("Public Safety Explorer");
      expect(candidates[0].nameSource).toBe("heading");
    });
  });

  describe("mergeDashboardCandidate", () => {
    it("merges two occurrences of the same key across pages into one record with both source pages", () => {
      const map = new Map<string, DashboardRecord>();
      const candidate: DashboardCandidate = {
        url: "https://app.powerbigov.us/view?r=aaa",
        canonicalUrl: "https://app.powerbigov.us/view?r=aaa",
        key: "report-guid-123",
        platform: "powerbi_gov",
        label: "Power BI (US Gov cloud)",
        confidence: "high",
        discoveryMethod: "anchor",
        name: "Traffic Dashboard",
        nameSource: "anchor_text",
        reportGuid: "report-guid-123",
      };
      const candidateFromOtherPage: DashboardCandidate = {
        ...candidate,
        url: "https://app.powerbigov.us/view?r=bbb",
        canonicalUrl: "https://app.powerbigov.us/view?r=bbb",
        name: null,
        nameSource: null,
      };

      mergeDashboardCandidate(map, candidate, "https://www.nyc.gov/page-one", "2026-01-01T00:00:00.000Z");
      mergeDashboardCandidate(map, candidateFromOtherPage, "https://www.nyc.gov/page-two", "2026-02-01T00:00:00.000Z");

      expect(map.size).toBe(1);
      const record = map.get("report-guid-123")!;
      expect(record.sourcePages).toEqual(["https://www.nyc.gov/page-one", "https://www.nyc.gov/page-two"]);
      expect(record.sourcePageCount).toBe(2);
      expect(record.firstSeen).toBe("2026-01-01T00:00:00.000Z");
      expect(record.lastSeen).toBe("2026-02-01T00:00:00.000Z");
      expect(record.name).toBe("Traffic Dashboard");
    });
  });
});
