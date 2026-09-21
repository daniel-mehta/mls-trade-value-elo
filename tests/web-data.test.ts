import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { loadComparisonPool, PoolDataError, validateBrowserPool } from "../src/web/data.js";
import { mapPoolPlayersToEloPlayers } from "../src/web/session.js";
import { comparisonPoolFixture, poolPlayer } from "./web-fixtures.js";

const validPool = (players: ReturnType<typeof poolPlayer>[]) => comparisonPoolFixture(players);

describe("browser comparison-pool loading", () => {
  it("loads the committed static comparison pool", async () => {
    const raw = await readFile("public/data/comparison-pool.json", "utf8");
    const pool = validateBrowserPool(JSON.parse(raw));
    expect(pool.players.length).toBeGreaterThanOrEqual(150);
    expect(pool.audit.finalPoolSize).toBe(pool.players.length);
    expect(pool.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("requests comparison-pool.json from the configured static base", async () => {
    const body = validPool([poolPlayer("a"), poolPlayer("b")]);
    const fetcher = vi.fn(async () => new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const pool = await loadComparisonPool(fetcher, "/project/");
    expect(fetcher).toHaveBeenCalledWith("/project/data/comparison-pool.json");
    expect(pool.players.map((player) => player.id)).toEqual(["a", "b"]);
  });

  it("maps one Elo player per unique pool player", () => {
    expect(mapPoolPlayersToEloPlayers([poolPlayer("a"), poolPlayer("b")])).toHaveLength(2);
  });

  it("uses stable ASA player IDs without deriving keys from names", () => {
    const mapped = mapPoolPlayersToEloPlayers([
      poolPlayer("asa-123", { name: "Same Name" }),
      poolPlayer("asa-456", { name: "Same Name" }),
    ]);
    expect(mapped.map((player) => player.id)).toEqual(["asa-123", "asa-456"]);
  });

  it("rejects duplicate player IDs", () => {
    expect(() => validateBrowserPool(validPool([poolPlayer("a"), poolPlayer("a")]))).toThrow(
      "Duplicate ASA player ID: a",
    );
  });

  it("rejects an empty player pool with a distinct error state", () => {
    expect(() => validateBrowserPool(validPool([]))).toThrow(
      expect.objectContaining<Partial<PoolDataError>>({ reason: "empty" }),
    );
  });

  it("rejects a pool with fewer than two players", () => {
    expect(() => validateBrowserPool(validPool([poolPlayer("a")]))).toThrow(
      expect.objectContaining<Partial<PoolDataError>>({ reason: "too-small" }),
    );
  });

  it("rejects invalid required player data", () => {
    expect(() => validateBrowserPool(validPool([poolPlayer("a"), { ...poolPlayer("b"), name: "" }]))).toThrow(
      "missing a required field",
    );
  });

  it("rejects missing or invalid provenance instead of using a hard-coded fallback", () => {
    const pool = validPool([poolPlayer("a"), poolPlayer("b")]);
    (pool.provenance as any).rosterSnapshotDate = "not-a-date";
    expect(() => validateBrowserPool(pool)).toThrow("provenance is invalid");
  });

  it("rejects malformed or outfield goalkeeper metrics", () => {
    const invalidMetric = validPool([
      poolPlayer("gk", {
        positionGroup: "GK",
        goalkeeperMetrics: { currentSeason: { season: 2025, saves: 1 } },
      }),
      poolPlayer("b"),
    ]);
    expect(() => validateBrowserPool(invalidMetric)).toThrow("invalid goalkeeper metrics");

    const outfield = validPool([
      poolPlayer("a", { goalkeeperMetrics: { currentSeason: { season: 2026, saves: 1 } } }),
      poolPlayer("b"),
    ]);
    expect(() => validateBrowserPool(outfield)).toThrow("invalid goalkeeper metrics");

    const zeroFilled = validPool([
      poolPlayer("gk", {
        positionGroup: "GK",
        goalkeeperMetrics: { currentSeason: { season: 2026, saves: 0, shotsFaced: 0 } },
      }),
      poolPlayer("b"),
    ]);
    expect(() => validateBrowserPool(zeroFilled)).toThrow("invalid goalkeeper metrics");

    const inconsistentTotal = validPool([
      poolPlayer("gk", {
        positionGroup: "GK",
        goalkeeperMetrics: {
          currentSeason: {
            season: 2026,
            goalsAdded: 2,
            goalsAddedByAction: { passing: 0.5, shotstopping: 1 },
          },
        },
      }),
      poolPlayer("b"),
    ]);
    expect(() => validateBrowserPool(inconsistentTotal)).toThrow("invalid goalkeeper metrics");
  });
});
