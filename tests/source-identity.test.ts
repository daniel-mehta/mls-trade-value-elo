import { describe, expect, it } from "vitest";
import { asaEndpointUrl } from "../src/data/asaClient.js";
import { assertUniquePlayerTeamSeasonRows } from "../src/data/sourceIdentity.js";

const row = (playerId: string, teamId: string, changes: Record<string, unknown> = {}) => ({
  player_id: playerId,
  team_id: teamId,
  season_name: "2026",
  minutes_played: 90,
  ...changes,
});

describe("statistical source identity grain", () => {
  it("uses the official MLS games family for unfiltered season discovery", () => {
    expect(asaEndpointUrl("games")).toBe("https://app.americansocceranalysis.com/api/v1/mls/games");
  });

  it("allows one stable player ID to have multiple team rows", () => {
    expect(() => assertUniquePlayerTeamSeasonRows([row("player", "team-a"), row("player", "team-b")], 2026, "fixture")).not.toThrow();
  });

  it("rejects exact and conflicting duplicates at player/team/season grain", () => {
    expect(() => assertUniquePlayerTeamSeasonRows([row("player", "team"), row("player", "team")], 2026, "fixture")).toThrow(/duplicate player\/team\/season/);
    expect(() => assertUniquePlayerTeamSeasonRows([row("player", "team"), row("player", "team", { minutes_played: 45 })], 2026, "fixture")).toThrow(/conflicting duplicate/);
  });

  it("rejects empty sources and rows without stable join keys", () => {
    expect(() => assertUniquePlayerTeamSeasonRows([], 2026, "fixture")).toThrow(/contains no rows/);
    expect(() => assertUniquePlayerTeamSeasonRows([row("", "team")], 2026, "fixture")).toThrow(/missing stable ASA player ID/);
    expect(() => assertUniquePlayerTeamSeasonRows([row("player", "")], 2026, "fixture")).toThrow(/missing stable ASA team ID/);
    expect(() => assertUniquePlayerTeamSeasonRows([row("player", "team", { season_name: "2025" })], 2026, "fixture")).toThrow(/season must be 2026/);
  });
});
