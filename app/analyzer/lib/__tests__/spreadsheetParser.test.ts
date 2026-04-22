import { DefaultSpreadsheetParser, loadSpreadsheetExtractionProperties } from "../spreadsheetParser.js";
import { describe, expect, it } from '@jest/globals';

// ─── parseName ───────────────────────────────────────────────────────────────

describe("DefaultSpreadsheetParser.parseName", () => {
  const sp = new DefaultSpreadsheetParser();

  it("parses 'Name (Type)' format into cleaned id", () => {
    expect(sp.parseName("Dobbs Ferry (Village)")).toBe("DobbsFerry-Village");
    expect(sp.parseName("New Rochelle (City)")).toBe("NewRochelle-City");
    expect(sp.parseName("Mount Kisco (Town/Village)")).toBe("MountKisco-Town");
    expect(sp.parseName("Hastings-on-Hudson (Village)")).toBe("Hastings-on-Hudson-Village");
    expect(sp.parseName("   ")).toBeNull();
  });

});

// ─── parseGradeFromCell ──────────────────────────────────────────────────────

describe("DefaultSpreadsheetParser.parseGradeFromCell", () => {
  const sp = new DefaultSpreadsheetParser();

  it("parses a single-letter grade code", () => {
    expect(sp.parseGradeFromCell("G-Some note")).toBe("Good");
  });

  it("parses a multi-letter grade code (GG before G)", () => {
    expect(sp.parseGradeFromCell("GG-Excellent")).toBe("Very Good");
  });

  it("parses grade with space separator", () => {
    expect(sp.parseGradeFromCell("Y some text")).toBe("Yellow");
  });

  it("parses R grade", () => {
    expect(sp.parseGradeFromCell("R-Bad stuff")).toBe("Red");
  });

  it("returns null when no grade prefix matches", () => {
    expect(sp.parseGradeFromCell("No grade here")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(sp.parseGradeFromCell("")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(sp.parseGradeFromCell(undefined)).toBeNull();
  });

  it("returns null for null", () => {
    expect(sp.parseGradeFromCell(null)).toBeNull();
  });
});

// ─── getEntityPrefix / getStateCode ──────────────────────────────────────────

describe("DefaultSpreadsheetParser realm-based methods", () => {
  it("getEntityPrefix returns realm state prefix when realm provided", () => {
    const sp = new DefaultSpreadsheetParser({ state: "CT" } as any);
    expect(sp.getEntityPrefix()).toBe("CT-");
  });

  it("getStateCode returns realm state when realm provided", () => {
    const sp = new DefaultSpreadsheetParser({ state: "CT" } as any);
    expect(sp.getStateCode()).toBe("CT");
  });

  it("getEntityPrefix falls back to config state without realm", () => {
    const sp = new DefaultSpreadsheetParser();
    const conf = loadSpreadsheetExtractionProperties();
    expect(sp.getEntityPrefix()).toBe(`${conf.state}-`);
  });

  it("getStateCode falls back to config state without realm", () => {
    const sp = new DefaultSpreadsheetParser();
    const conf = loadSpreadsheetExtractionProperties();
    expect(sp.getStateCode()).toBe(conf.state);
  });
});

// ─── getColumnMap ────────────────────────────────────────────────────────────

describe("DefaultSpreadsheetParser.getColumnMap", () => {
  const sp = new DefaultSpreadsheetParser();

  it("returns an object with domain name keys and column index values", () => {
    const map = sp.getColumnMap();
    expect(typeof map).toBe("object");
    // All values should be numbers
    for (const v of Object.values(map)) {
      expect(typeof v).toBe("number");
    }
  });

  it("includes domains from spreadsheetExtractionProperties that have columnIndex", () => {
    const conf = loadSpreadsheetExtractionProperties();
    const map = sp.getColumnMap();
    for (const d of conf.domains) {
      if (d.columnIndex != null) {
        expect(map[d.name]).toBe(d.columnIndex);
      }
    }
  });

  it("includes additionalColumnIndices entries", () => {
    const conf = loadSpreadsheetExtractionProperties();
    const map = sp.getColumnMap();
    for (const [slug, index] of Object.entries(conf.additionalColumnIndices)) {
      expect(map[slug]).toBe(index);
    }
  });
});

// ─── loadSpreadsheetExtractionProperties ─────────────────────────────────────

describe("loadSpreadsheetExtractionProperties", () => {
  it("returns an object with required fields", () => {
    const conf = loadSpreadsheetExtractionProperties();
    expect(conf.url).toBeDefined();
    expect(conf.state).toBeDefined();
    expect(conf.county).toBeDefined();
    expect(Array.isArray(conf.domains)).toBe(true);
    expect(typeof conf.domainMapping).toBe("object");
    expect(typeof conf.additionalColumnIndices).toBe("object");
    expect(typeof conf.suppliedGrades).toBe("object");
  });

  it("returns the same cached instance on subsequent calls", () => {
    const a = loadSpreadsheetExtractionProperties();
    const b = loadSpreadsheetExtractionProperties();
    expect(a).toBe(b);
  });
});
