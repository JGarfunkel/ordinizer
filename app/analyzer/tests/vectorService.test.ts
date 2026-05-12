import { describe, expect, it } from "@jest/globals";
import { extractSectionReferences, getDocumentKey } from "../services/vectorService.js";

describe("extractSectionReferences", () => {
  it("extracts unique section references and limits to 3", () => {
    const text = [
      "See Section 12.1 for requirements.",
      "Also refer to § 12.1 and Section 4-2.",
      "Additional rules are in SECTION 7A and Section 9.",
      "Finally, see § 10.",
    ].join(" ");

    const refs = extractSectionReferences(text);

    expect(refs).toEqual(["Section 12.1", "§ 12.1", "Section 4-2"]);
  });

  it("returns empty array when no section markers are present", () => {
    const text = "This ordinance has no explicit numbered section references.";

    const refs = extractSectionReferences(text);

    expect(refs).toEqual([]);
  });

  it("matches both Section and paragraph-symbol forms", () => {
    const text = "References: § 101.3, Section 22-4, and § 11A.";

    const refs = extractSectionReferences(text);

    expect(refs).toEqual(["§ 101.3", "Section 22-4", "§ 11A"]);
  });
});

describe("getDocumentKey", () => {
  it("returns shared fallback when domains are missing", () => {
    const key = getDocumentKey("entity-123");
    expect(key).toBe("entity-123-shared/");
  });

  it("builds non-shared document key from first domain and type", () => {
    const key = getDocumentKey("entityA", ["trees", "noise"], "policy");
    expect(key).toBe("entityA-trees/policy");
  });

  it("builds shared key with filename when document type is shared", () => {
    const key = getDocumentKey("entityA", ["ignored-domain"], "shared", "codes.md");
    expect(key).toBe("entityA-shared/codes.md");
  });

  it("builds key for documentType statute with domain", () => {
    const key = getDocumentKey("entityB", ["zoning"], "statute");
    expect(key).toBe("entityB-zoning/statute");
  });
});
