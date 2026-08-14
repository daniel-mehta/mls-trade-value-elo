import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { selectLatestRosterCandidate, type RosterCandidate } from "../src/data/roster.js";
import {
  analyzeRefresh,
  assertRefreshSafety,
  buildRefreshStatus,
  captureRefreshBaseline,
  publicationIdentityErrors,
  refreshStatusErrors,
  shouldDispatchPages,
} from "../src/data/refreshAutomation.js";
import {
  SeasonResolutionError,
  formatSeasonResolutionFailure,
  resolvePublicationSeasons,
  seasonEvidenceFromGames,
} from "../src/data/seasonResolution.js";
import { selectSalarySource } from "../src/data/salary.js";
import { computePlayerDataVersion } from "../src/data/semanticVersion.js";
import { validateDataset } from "../src/data/validation.js";
import { publicationArtifactForSeason, seasonEvidence } from "./fixtures/season-rollover.js";

function baselineForSeason(season = 2026, previousSeason = 2025) {
  const artifact = publicationArtifactForSeason(season, previousSeason);
  return {
    ...artifact,
    baseline: captureRefreshBaseline("a".repeat(40), "players", "pool", artifact.dataset, artifact.pool),
  };
}

function source(rows: unknown[]) {
  return {
    rows: rows as Record<string, unknown>[],
    fromCache: false,
    url: "https://example.test/salaries",
    retrievedAt: "2027-03-01T00:00:00.000Z",
    contentSha256: "a".repeat(64),
  };
}

describe("authoritative ASA season resolution", () => {
  it("extracts ASA season_name strings from game rows and reports malformed rows", () => {
    const evidence = seasonEvidenceFromGames({
      rows: [{ season_name: "2025" }, { season_name: "2026" }, {}],
      fromCache: false,
      url: "https://app.americansocceranalysis.com/api/v1/mls/games",
      retrievedAt: "2026-08-14T00:00:00.000Z",
      contentSha256: "a".repeat(64),
    });
    expect(evidence).toMatchObject({ identifiers: ["2025", "2026"], invalidRowCount: 1, rowCount: 3 });
  });

  it("keeps the configured pair for an ordinary same-season refresh", () => {
    expect(resolvePublicationSeasons(2026, 2025, seasonEvidence(["2024", "2025", "2026"]))).toMatchObject({
      mode: "same-season",
      currentSeason: 2026,
      previousSeason: 2025,
    });
  });

  it("automatically advances to an unambiguous newer ASA season", () => {
    expect(resolvePublicationSeasons(2026, 2025, seasonEvidence(["2024", "2025", "2026", "2027"]))).toMatchObject({
      mode: "rollover",
      currentSeason: 2027,
      previousSeason: 2026,
      candidateSeason: "2027",
    });
  });

  it("chooses the actual preceding available identifier rather than subtracting one", () => {
    const resolution = resolvePublicationSeasons(2026, 2024, seasonEvidence(["2024", "2026", "2028"]));
    expect(resolution).toMatchObject({
      mode: "rollover",
      currentSeason: 2028,
      previousSeason: 2026,
    });
    expect(validateDataset(publicationArtifactForSeason(resolution.currentSeason, resolution.previousSeason).dataset)).toEqual([]);
  });

  it("fails closed for an unknown or ambiguous ASA representation", () => {
    expect(() => resolvePublicationSeasons(2026, 2025, seasonEvidence(["2025", "2026", "2027 Sprint", "2027-28"]))).toThrow(SeasonResolutionError);
    try {
      resolvePublicationSeasons(2026, 2025, seasonEvidence(["2025", "2026", "2027-28"]));
    } catch (error) {
      const summary = formatSeasonResolutionFailure((error as SeasonResolutionError).failure);
      expect(summary).toContain("Published data was not changed");
      expect(summary).toContain("Candidate season: 2027-28");
      expect(summary).toContain("numeric publication schema cannot represent safely");
    }
  });

  it("fails closed for missing season fields or a stale configured pair", () => {
    expect(() => resolvePublicationSeasons(2026, 2025, seasonEvidence(["2025", "2026"], { invalidRowCount: 1 }))).toThrow(/did not contain a usable season_name/);
    expect(() => resolvePublicationSeasons(2025, 2024, seasonEvidence(["2024", "2026"]))).toThrow(/absent from ASA games discovery/);
  });
});

describe("season-aware rollover publication safety", () => {
  it("preserves same-season row-collapse protection", () => {
    const prior = baselineForSeason();
    prior.dataset.sources.find((entry) => entry.sourceId === "asa-players")!.rowCount = 100;
    prior.baseline = captureRefreshBaseline("a".repeat(40), "players", "pool", prior.dataset, prior.pool);
    const current = publicationArtifactForSeason(2026, 2025);
    current.dataset.sources.find((entry) => entry.sourceId === "asa-players")!.rowCount = 49;
    expect(() => assertRefreshSafety(prior.baseline, current.dataset, current.pool)).toThrow(/row-count continuity check failed/);
  });

  it("uses structural invariants instead of mature-season volume for a confirmed rollover", () => {
    const prior = baselineForSeason();
    for (const sourceSnapshot of prior.dataset.sources) sourceSnapshot.rowCount = 100;
    prior.baseline = captureRefreshBaseline("a".repeat(40), "players", "pool", prior.dataset, prior.pool);
    const current = publicationArtifactForSeason(2027, 2026);
    for (const sourceSnapshot of current.dataset.sources) sourceSnapshot.rowCount = 1;
    const resolution = resolvePublicationSeasons(2026, 2025, seasonEvidence(["2025", "2026", "2027"]));
    expect(() => assertRefreshSafety(prior.baseline, current.dataset, current.pool, resolution)).not.toThrow();
  });

  it("rejects duplicate stable IDs and invalid pool joins during rollover", () => {
    const current = publicationArtifactForSeason(2027, 2026);
    const duplicate = structuredClone(current.dataset);
    duplicate.players.push(structuredClone(duplicate.players[0]));
    expect(publicationIdentityErrors(duplicate, current.pool).join("\n")).toContain("Duplicate normalized stable ASA player ID");
    const invalidJoin = structuredClone(current.pool);
    invalidJoin.players[0].id = "missing";
    expect(publicationIdentityErrors(current.dataset, invalidJoin).join("\n")).toContain("missing from normalized players");
  });

  it("rejects an incomplete required source set for a new season", () => {
    const current = publicationArtifactForSeason(2027, 2026);
    current.dataset.sources = current.dataset.sources.filter((entry) => entry.sourceId !== "asa-xpass-2027");
    delete current.dataset.audit.sourceRowCounts["asa-xpass-2027"];
    current.dataset.dataVersion = computePlayerDataVersion(current.dataset);
    expect(validateDataset(current.dataset).join("\n")).toContain("missing required source snapshot: asa-xpass-2027");
  });

  it("cannot finalize stale artifacts after discovery selected a rollover", () => {
    const prior = baselineForSeason();
    const resolution = resolvePublicationSeasons(2026, 2025, seasonEvidence(["2025", "2026", "2027"]));
    expect(() => assertRefreshSafety(prior.baseline, prior.dataset, prior.pool, resolution)).toThrow(/does not match built artifacts/);
  });

  it("marks a validated rollover substantive, records seasons, and dispatches normal Pages", () => {
    const prior = baselineForSeason();
    const current = publicationArtifactForSeason(2027, 2026);
    const analysis = analyzeRefresh(prior.baseline, prior.dataset, prior.pool, current.dataset, current.pool);
    const status = buildRefreshStatus("2027-03-01T00:30:00.000Z", analysis, current.dataset, current.pool);
    expect(analysis).toMatchObject({ substantiveDataChanged: true, seasonChanged: true });
    expect(status).toMatchObject({ currentSeason: 2027, previousSeason: 2026 });
    expect(refreshStatusErrors(status, current.dataset, current.pool)).toEqual([]);
    expect(shouldDispatchPages(["public/data/players.json", "public/data/comparison-pool.json"])).toBe(true);
  });
});

describe("salary and roster rollover selection", () => {
  it("keeps previous-season salary until a current-season release appears", () => {
    const priorSalary = source([{ player_id: "a", mlspa_release: "2026-10-01" }]);
    expect(selectSalarySource(2027, null, 2026, priorSalary)?.season).toBe(2026);
    const currentSalary = source([{ player_id: "a", mlspa_release: "2027-04-15" }]);
    expect(selectSalarySource(2027, currentSalary, 2026, priorSalary)?.season).toBe(2027);
  });

  it("selects only a target-season roster and rejects prior-season fallback", () => {
    const candidate = (filename: string, releaseDate: string): RosterCandidate => ({
      filename,
      fileDate: filename.slice(0, 10),
      release: { release_date: releaseDate, teams: [] },
      contentSha256: "a".repeat(64),
      retrievedAt: null,
      cached: true,
    });
    expect(selectLatestRosterCandidate([candidate("2027-03-01.json", "2027-02-28")], 2027).filename).toBe("2027-03-01.json");
    expect(() => selectLatestRosterCandidate([candidate("2026-03-01.json", "2026-02-28")], 2027)).toThrow(/filename is invalid/);
  });
});

describe("failed rollover workflow boundary", () => {
  const workflow = readFileSync(new URL("../.github/workflows/refresh-data.yml", import.meta.url), "utf8");

  it("resolves seasons before refresh and leaves commit/deployment unreachable after failure", () => {
    expect(workflow.indexOf("resolve-season")).toBeLessThan(workflow.indexOf("build:data -- --refresh"));
    expect(workflow.indexOf("build:data -- --refresh")).toBeLessThan(workflow.indexOf("Commit and push verified refresh"));
    expect(workflow.indexOf("Commit and push verified refresh")).toBeLessThan(workflow.indexOf("Dispatch Pages deployment"));
    expect(workflow).not.toContain("continue-on-error");
    expect(workflow).toContain("failure-summary");
  });
});
