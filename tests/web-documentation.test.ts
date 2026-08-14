import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const publicDocumentation = ["../README.md", "../data/README.md", "../data_notice.md"]
  .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
  .join("\n");

describe("balanced matchup selection documentation", () => {
  it("does not expose the internal work label", () => {
    expect(publicDocumentation).not.toContain("Phase 5");
    expect(publicDocumentation).not.toMatch(/Phase 7(?:A)?/i);
  });

  it("explains coverage, variety, prominence, Elo timing, browser-only operation, and bounded state", () => {
    expect(publicDocumentation).toMatch(/under-compared/i);
    expect(publicDocumentation).toMatch(/recently repeated pairs and players|recent repeated pairs and players/i);
    expect(publicDocumentation).toMatch(/prominence preference/i);
    expect(publicDocumentation).toMatch(/Elo similarity/i);
    expect(publicDocumentation).toMatch(/does not change Elo\s+calculations|does not alter the Elo\s+calculation/i);
    expect(publicDocumentation).toMatch(/browser/i);
    expect(publicDocumentation).toMatch(/bounded/i);
  });

  it("documents publication provenance and eligibility-bound manual inclusion honestly", () => {
    expect(publicDocumentation).toMatch(/build time is not a statistics-through date/i);
    expect(publicDocumentation).toMatch(/manual inclusion is\s+still eligibility-bound/i);
    expect(publicDocumentation).toMatch(/salary acquisition is optional/i);
    expect(publicDocumentation).toMatch(/not affiliated with or endorsed/i);
    expect(publicDocumentation).toMatch(/official ASA goalkeeper xGoals/i);
    expect(publicDocumentation).toMatch(/missing goalkeeper fields are omitted/i);
    expect(publicDocumentation).toMatch(/official ASA MLS game-season identifiers/i);
    expect(publicDocumentation).toMatch(/fails closed instead of guessing/i);
    expect(publicDocumentation).toMatch(/previous-season salary release remains the explicit fallback/i);
  });

  it("contains no internal goalkeeper work label or hard-coded source metric values", () => {
    expect(publicDocumentation).not.toMatch(/goalkeeper phase|7B/i);
    const rendering = ["../src/web/display.ts", "../src/web/render.ts"]
      .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
      .join("\n");
    expect(rendering).not.toMatch(/24\.9003|1\.0997|1830/);
  });

  it("documents the sole optional external analytics service without weakening local ranking privacy", () => {
    expect(publicDocumentation).toContain("https://gc.zgo.at/count.js");
    expect(publicDocumentation).toContain("https://danielmehta.goatcounter.com/count");
    expect(publicDocumentation).toMatch(/GoatCounter.*cookies|cookies.*GoatCounter/is);
    expect(publicDocumentation).toMatch(/player-choice.*never uploaded|never uploaded.*player choices/is);
  });
});
