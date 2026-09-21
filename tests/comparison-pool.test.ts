import { describe, expect, it } from "vitest";
import {
  designationSelectionReason,
  eligible,
  participationScore,
  selectComparisonPool,
  validateComparisonPool,
  validateOverrides,
} from "../src/data/comparisonPool.js";
import type { StaticPlayer } from "../src/data/types.js";
import { playerDataset, staticPlayer } from "./data-fixtures.js";

const none = { schemaVersion: 1 as const, include: [], exclude: [] };
const p = (id: string, changes: Partial<StaticPlayer> = {}) => staticPlayer(id, changes);

function publicationDataset(extraPerTeam = 0) {
  return playerDataset([
    ...Array.from({ length: 30 }, (_, teamIndex) =>
    Array.from({ length: 6 }, (_, playerIndex) => p(`${teamIndex}-${playerIndex}`, {
      teamId: `t${teamIndex}`,
      teamName: `Team ${teamIndex}`,
      teamAbbreviation: `T${teamIndex}`,
      positionGroup: playerIndex === 5 ? "GK" : "MID",
      currentSeason: { season: 2026, minutes: 100 - playerIndex },
    })),
    ).flat(),
    ...Array.from({ length: 30 }, (_, teamIndex) =>
      Array.from({ length: extraPerTeam }, (_, extraIndex) => p(`extra-${teamIndex}-${extraIndex}`, {
        teamId: `t${teamIndex}`,
        teamName: `Team ${teamIndex}`,
        teamAbbreviation: `T${teamIndex}`,
        positionGroup: "FWD",
        currentSeason: { season: 2026, minutes: 1, goals: 3, assists: 2 },
      })),
    ).flat(),
  ]);
}

describe("comparison-pool rules", () => {
  it("accepts current minutes or snapshot-backed prior minutes only", () => {
    expect(eligible(p("now"))).toBe(true);
    expect(eligible(p("old", { currentSeason: { season: 2026 }, previousSeason: { season: 2025, minutes: 1 }, rosterProfile: { snapshotDate: "2026-02-26", listedInRosterSnapshot: true, activeAtRosterSnapshot: false, snapshotTeamId: "t", snapshotTeamName: "Team" } }))).toBe(true);
    expect(eligible(p("no", { currentSeason: { season: 2026 }, previousSeason: { season: 2025, minutes: 1 } }))).toBe(false);
  });

  it("weights previous minutes by one half", () => expect(participationScore(p("a", { currentSeason: { season: 2026, minutes: 10 }, previousSeason: { season: 2025, minutes: 100 } }))).toBe(60));

  it("takes five outfielders and one goalkeeper per team", () => {
    const players = [...Array.from({ length: 7 }, (_, index) => p(`m${index}`, { currentSeason: { season: 2026, minutes: 100 - index } })), p("g1", { positionGroup: "GK", currentSeason: { season: 2026, minutes: 1 } }), p("g2", { positionGroup: "GK", currentSeason: { season: 2026, minutes: 2 } })];
    const pool = selectComparisonPool(playerDataset(players), none);
    expect(pool.players.filter((player) => player.positionGroup !== "GK")).toHaveLength(5);
    expect(pool.players.filter((player) => player.positionGroup === "GK").map((player) => player.id)).toEqual(["g2"]);
  });

  it("uses deterministic participation tie-breakers", () => {
    const a = p("a", { currentSeason: { season: 2026, minutes: 20 } });
    const b = p("b", { currentSeason: { season: 2026, minutes: 20 } });
    expect(selectComparisonPool(playerDataset([b, a]), none).players.map((player) => player.id)).toEqual(["a", "b"]);
  });

  it("maps only exact observed DP and U22 labels", () => {
    expect(designationSelectionReason("Designated Player")).toBe("designated-player");
    expect(designationSelectionReason("U22 Initiative")).toBe("u22-initiative");
    expect(designationSelectionReason("TAM Player")).toBeUndefined();
  });

  it("adds designation and productive-player reasons outside base selection", () => {
    const base = Array.from({ length: 6 }, (_, index) => p(`b${index}`, { currentSeason: { season: 2026, minutes: 100 - index } }));
    const roster = (designation: string) => ({ snapshotDate: "2026-02-26", listedInRosterSnapshot: true as const, activeAtRosterSnapshot: true, snapshotTeamId: "t", snapshotTeamName: "Team", rosterDesignation: designation });
    const dp = p("dp", { currentSeason: { season: 2026, minutes: 1 }, rosterProfile: roster("Designated Player") });
    const u22 = p("u22", { currentSeason: { season: 2026, minutes: 1 }, rosterProfile: roster("U22 Initiative") });
    const goal = p("goal", { currentSeason: { season: 2026, minutes: 1, goals: 3, assists: 2 } });
    const ids = selectComparisonPool(playerDataset([...base, dp, u22, goal]), none).players.map((player) => player.id);
    expect(ids).toEqual(expect.arrayContaining(["dp", "u22", "goal"]));
  });

  it("keeps manual inclusion eligibility-bound and exclusion precedence", () => {
    const ineligible = p("old", { currentSeason: { season: 2026 }, previousSeason: { season: 2025, minutes: 100 } });
    expect(selectComparisonPool(playerDataset([ineligible]), { schemaVersion: 1, include: [{ playerId: "old", reason: "Documented", sourceNote: "Source" }], exclude: [] }).players).toEqual([]);
    const current = p("x");
    expect(selectComparisonPool(playerDataset([current]), { schemaVersion: 1, include: [], exclude: [{ playerId: "x", reason: "Documented", sourceNote: "Source" }] }).players).toEqual([]);
  });

  it("strictly rejects malformed and conflicting overrides", () => {
    const players = [p("x")];
    expect(() => validateOverrides({ schemaVersion: 1, include: [], exclude: [], extra: true }, players)).toThrow(/unsupported keys/);
    expect(() => validateOverrides({ schemaVersion: 1, include: [{ playerId: "x", reason: "r", sourceNote: "n", extra: true }], exclude: [] }, players)).toThrow(/unsupported keys/);
    expect(() => validateOverrides({ schemaVersion: 1, include: [{ playerId: "x", reason: "r", sourceNote: "n" }], exclude: [{ playerId: "x", reason: "r", sourceNote: "n" }] }, players)).toThrow(/duplicate|conflicting/);
  });

  it("does not mutate the source dataset", () => {
    const dataset = playerDataset([p("x")]);
    const before = structuredClone(dataset);
    selectComparisonPool(dataset, none);
    expect(dataset).toEqual(before);
  });
});

describe("source-to-pool semantic validation", () => {
  it("accepts the rule-derived publication fixture", () => {
    const dataset = publicationDataset();
    expect(validateComparisonPool(selectComparisonPool(dataset, none), dataset, none)).toEqual([]);
  });

  it("accepts legitimate rule-derived growth above the retired fixed maximum", () => {
    const dataset = publicationDataset(5);
    const pool = selectComparisonPool(dataset, none);
    expect(pool.players).toHaveLength(330);
    expect(validateComparisonPool(pool, dataset, none)).toEqual([]);
  });

  it.each([
    ["altered embedded player", (pool: any) => { pool.players[0].teamName = "Wrong"; }, "selected players"],
    ["stale embedded goalkeeper field", (pool: any) => {
      const goalkeeper = pool.players.find((player: StaticPlayer) => player.positionGroup === "GK");
      goalkeeper.goalkeeperMetrics = { currentSeason: { season: 2026, saves: 999 } };
    }, "selected players"],
    ["missing expected player", (pool: any) => { pool.players.pop(); }, "selected players"],
    ["extra player", (pool: any) => { pool.players.push(structuredClone(pool.players[0])); }, "selected players"],
    ["wrong reason", (pool: any) => { pool.players[0].selectionReasons = ["manual-inclusion"]; }, "selected players"],
    ["wrong rule", (pool: any) => { pool.selectionRules.baseOutfieldPlayersPerTeam = 4; }, "selection rules"],
    ["wrong source version", (pool: any) => { pool.sourceDataVersion = `sha256:${"b".repeat(64)}`; }, "source version"],
    ["wrong semantic version", (pool: any) => { pool.dataVersion = `sha256:${"b".repeat(64)}`; }, "semantic dataVersion"],
    ["empty semantic version", (pool: any) => { pool.dataVersion = ""; }, "SHA-256 semantic version"],
    ["invalid generation time", (pool: any) => { pool.generatedAt = "yesterday"; }, "canonical ISO timestamp"],
  ])("rejects %s", (_label, mutate, expected) => {
    const dataset = publicationDataset();
    const pool = selectComparisonPool(dataset, none);
    mutate(pool);
    expect(validateComparisonPool(pool, dataset, none).join("\n")).toContain(expected);
  });
});
