import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { addOrUpdateSource, shouldUseCurlForUrl } from "../lib/extractionUtils.js";
import type { Ruleset } from "@civillyengaged/ordinizer-core";
import * as extractionConfig from "../lib/extractionConfig.js";
import * as servercore from "@civillyengaged/ordinizer-servercore";

function createRuleset(): Ruleset {
  return {
    entityId: "NY-Test-City",
    domain: "Test Domain",
    domainId: "test-domain",
    homePage: "https://example.org",
    metadataCreated: new Date().toISOString(),
    sources: [],
  };
}

describe("addOrUpdateSource", () => {
  it("updates an existing source when URL differs only by trailing slash and fragment", () => {
    const ruleset = createRuleset();

    addOrUpdateSource(ruleset, {
      sourceUrl: "https://example.org/policies#section-1",
      title: "Original",
      type: "general",
    });

    addOrUpdateSource(ruleset, {
      sourceUrl: "https://example.org/policies/",
      title: "Updated",
      type: "policy",
    });

    expect(ruleset.sources).toHaveLength(1);
    expect(ruleset.sources[0].title).toBe("Updated");
    expect(ruleset.sources[0].type).toBe("policy");
  });

  it("prepends a new source when normalized URL does not match", () => {
    const ruleset = createRuleset();

    addOrUpdateSource(ruleset, {
      sourceUrl: "https://example.org/alpha",
      title: "Alpha",
      type: "general",
    });

    addOrUpdateSource(ruleset, {
      sourceUrl: "https://example.org/beta",
      title: "Beta",
      type: "general",
    });

    expect(ruleset.sources).toHaveLength(2);
    expect(ruleset.sources[0].sourceUrl).toBe("https://example.org/beta");
    expect(ruleset.sources[1].sourceUrl).toBe("https://example.org/alpha");
  });
});

describe("shouldUseCurlForUrl", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("uses per-library config to enable curl for matching URLs", async () => {
    jest.spyOn(servercore, "getDefaultStorage").mockReturnValue({} as any);
    jest.spyOn(extractionConfig, "loadStatuteLibraryConfig").mockResolvedValue({
      defaultLibrary: "default-lib",
      libraries: [
        {
          id: "default-lib",
          urlPatterns: ["example.org"],
          useCurl: false,
        },
        {
          id: "municode",
          urlPatterns: ["library.municode.com"],
          useCurl: true,
        },
      ],
    } as any);

    const result = await shouldUseCurlForUrl("https://library.municode.com/ny/example/codes/code_of_ordinances");

    expect(result).toBe(true);
    expect(extractionConfig.loadStatuteLibraryConfig).toHaveBeenCalledTimes(1);
  });
});
