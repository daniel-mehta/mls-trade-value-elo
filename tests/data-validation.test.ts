import { describe, expect, it } from "vitest";
import { isEligible } from "../src/data/eligibility.js";
import { computePlayerDataVersion } from "../src/data/semanticVersion.js";
import { validateDataset } from "../src/data/validation.js";
import { playerDataset, staticPlayer } from "./data-fixtures.js";

describe("static player dataset validation", () => {
  it("accepts a fully versioned fixture", () => expect(validateDataset(playerDataset([staticPlayer()]))).toEqual([]));

  it("rejects empty versions, invalid timestamps, competition, seasons, and sources", () => {
    const cases = [
      ["dataVersion", "dataVersion must be a SHA-256 semantic version", (dataset: any) => { dataset.dataVersion = ""; }],
      ["generatedAt", "generatedAt must be a canonical ISO timestamp", (dataset: any) => { dataset.generatedAt = "yesterday"; }],
      ["competition", "competition must be MLS", (dataset: any) => { dataset.competition = "WRONG"; }],
      ["season", "previousSeason must be an earlier valid season", (dataset: any) => { dataset.previousSeason = 2026; }],
      ["sources", "sources must be non-empty", (dataset: any) => { dataset.sources = []; }],
    ] as const;
    for (const [, message, mutate] of cases) {
      const dataset = playerDataset([staticPlayer()]);
      mutate(dataset);
      expect(validateDataset(dataset)).toContain(message);
    }
  });

  it("rejects invalid checksums and impossible roster totals", () => {
    const checksum = playerDataset([staticPlayer()]);
    checksum.sources[0].contentSha256 = "bad";
    expect(validateDataset(checksum).join("\n")).toContain("requires a SHA-256 checksum");
    const totals = playerDataset([staticPlayer()]);
    totals.rosterSnapshot.rawRecordCount = 4;
    expect(validateDataset(totals)).toContain("roster record totals do not reconcile");
  });

  it("rejects unknown artifact and player record keys", () => {
    const artifact = playerDataset([staticPlayer()]) as any;
    artifact.extra = true;
    expect(validateDataset(artifact).join("\n")).toContain("dataset contains unsupported keys");
    const record = playerDataset([staticPlayer()]) as any;
    record.players[0].extra = true;
    expect(validateDataset(record).join("\n")).toContain("contains unsupported keys");
  });

  it("detects duplicate player IDs and inconsistent team tuples", () => {
    const duplicate = playerDataset([staticPlayer("a"), staticPlayer("a", { name: "Player b" })]);
    expect(validateDataset(duplicate).join("\n")).toContain("duplicate or empty player ID");
    const teams = playerDataset([
      staticPlayer("a"),
      staticPlayer("b", { teamName: "Different", teamAbbreviation: "D" }),
    ]);
    expect(validateDataset(teams).join("\n")).toContain("team ID maps to inconsistent name or abbreviation");
  });

  it("detects missing identity, negative numbers, and invalid groups", () => {
    const dataset = playerDataset([staticPlayer("a", {
      name: "",
      positionGroup: "BAD" as "MID",
      currentSeason: { season: 2026, minutes: -1 },
    })]);
    const errors = validateDataset(dataset).join("\n");
    expect(errors).toContain("missing name");
    expect(errors).toContain("invalid position group");
    expect(errors).toContain("invalid minutes");
  });

  it("rejects empty player records", () => expect(validateDataset(playerDataset([]))).toContain("players must be non-empty"));

  it("strictly validates goalkeeper metric shape, values, season, position, and omission semantics", () => {
    const invalidField = playerDataset([staticPlayer("gk", {
      positionGroup: "GK",
      goalkeeperMetrics: { currentSeason: { season: 2026, saves: 1, invented: 2 } as any },
    })]);
    expect(validateDataset(invalidField).join("\n")).toContain("unsupported keys: invented");

    const invalidNumber = playerDataset([staticPlayer("gk", {
      positionGroup: "GK",
      goalkeeperMetrics: { currentSeason: { season: 2026, saves: 1 } },
    })]);
    invalidNumber.players[0].goalkeeperMetrics!.currentSeason!.saves = Number.NaN;
    expect(validateDataset(invalidNumber).join("\n")).toContain("invalid saves");

    const wrongSeason = playerDataset([staticPlayer("gk", {
      positionGroup: "GK",
      goalkeeperMetrics: { currentSeason: { season: 2025, saves: 1 } },
    })]);
    expect(validateDataset(wrongSeason).join("\n")).toContain("season must be 2026");

    const outfield = playerDataset([staticPlayer("a", {
      goalkeeperMetrics: { currentSeason: { season: 2026, saves: 1 } },
    })]);
    expect(validateDataset(outfield).join("\n")).toContain("only be attached to goalkeepers");

    const zeroFilled = playerDataset([staticPlayer("gk", {
      positionGroup: "GK",
      goalkeeperMetrics: { currentSeason: { season: 2026, saves: 0, shotsFaced: 0 } },
    })]);
    expect(validateDataset(zeroFilled).join("\n")).toContain("zero-filled goalkeeper metric object");

    const validMissingOptional = playerDataset([staticPlayer("gk", {
      positionGroup: "GK",
      goalkeeperMetrics: { currentSeason: { season: 2026, saves: 1 } },
    })]);
    validMissingOptional.dataVersion = computePlayerDataVersion(validMissingOptional);
    expect(validateDataset(validMissingOptional)).toEqual([]);
  });

  it("requires complete, available goalkeeper provenance for publication", () => {
    const missing = playerDataset([staticPlayer()]);
    missing.sources = missing.sources.filter((source) => source.sourceId !== "asa-goalkeeper-xgoals-2026");
    delete missing.audit.sourceRowCounts["asa-goalkeeper-xgoals-2026"];
    delete missing.audit.goalkeeper.sources["asa-goalkeeper-xgoals-2026"];
    expect(validateDataset(missing).join("\n")).toContain("missing required source snapshot: asa-goalkeeper-xgoals-2026");

    const unavailable = playerDataset([staticPlayer()]);
    const source = unavailable.sources.find((entry) => entry.sourceId === "asa-goalkeeper-goals-added-2025")!;
    source.status = "optional-unavailable";
    source.contentSha256 = null;
    source.rowCount = 0;
    unavailable.audit.sourceRowCounts[source.sourceId] = 0;
    unavailable.audit.goalkeeper.sources[source.sourceId].rawRowCount = 0;
    expect(validateDataset(unavailable).join("\n")).toContain("required goalkeeper source must be available");
  });

  it("detects a stale semantic version after substantive mutation", () => {
    const dataset = playerDataset([staticPlayer()]);
    dataset.players[0].currentSeason.minutes = 99;
    expect(validateDataset(dataset).join("\n")).toContain("semantic dataVersion mismatch");
    dataset.dataVersion = computePlayerDataVersion(dataset);
    expect(validateDataset(dataset)).toEqual([]);
  });

  it("enforces normalized minutes-based eligibility", () => {
    expect(isEligible(staticPlayer("a", { currentSeason: { season: 2026 } }))).toBe(false);
    expect(isEligible(staticPlayer("a", { currentSeason: { season: 2026 }, previousSeason: { season: 2025, minutes: 1 } }))).toBe(true);
  });
});
