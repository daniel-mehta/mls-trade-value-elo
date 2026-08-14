import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { selectComparisonPool, type ComparisonPool } from "../src/data/comparisonPool.js";
import {
  analyzeRefresh,
  assertDeterministicArtifacts,
  assertRefreshSafety,
  assertUnchangedDefaultBranch,
  buildRefreshStatus,
  captureRefreshBaseline,
  formatRefreshSummary,
  publicationIdentityErrors,
  refreshStatusErrors,
  shouldDispatchPages,
  unexpectedRefreshPaths,
} from "../src/data/refreshAutomation.js";
import { computePlayerDataVersion } from "../src/data/semanticVersion.js";
import { playerDataset, staticPlayer } from "./data-fixtures.js";

const noOverrides = { schemaVersion: 1 as const, include: [], exclude: [] };

function artifact(ids = ["a", "b", "c"]) {
  const dataset = playerDataset(ids.map((id, index) => staticPlayer(id, {
    name: `Player ${id}`,
    currentSeason: { season: 2026, minutes: 100 - index },
  })));
  dataset.dataVersion = computePlayerDataVersion(dataset);
  return { dataset, pool: selectComparisonPool(dataset, noOverrides, "2026-08-01T00:00:00.000Z") };
}

function baselineArtifacts() {
  const prior = artifact();
  const baseline = captureRefreshBaseline("a".repeat(40), "player bytes", "pool bytes", prior.dataset, prior.pool);
  return { ...prior, baseline };
}

describe("refresh publication identity", () => {
  it("rejects duplicate normalized IDs, duplicate pool IDs, and unresolved pool IDs", () => {
    const { dataset, pool } = artifact();
    const duplicateDataset = structuredClone(dataset);
    duplicateDataset.players.push(structuredClone(duplicateDataset.players[0]));
    expect(publicationIdentityErrors(duplicateDataset, pool).join("\n")).toContain("Duplicate normalized stable ASA player ID");

    const duplicatePool = structuredClone(pool);
    duplicatePool.players.push(structuredClone(duplicatePool.players[0]));
    expect(publicationIdentityErrors(dataset, duplicatePool).join("\n")).toContain("Duplicate comparison-pool player ID");

    const missing = structuredClone(pool);
    missing.players[0].id = "missing";
    expect(publicationIdentityErrors(dataset, missing).join("\n")).toContain("missing from normalized players");
  });

  it("rejects conflicting embedded identity for one stable pool ID", () => {
    const { dataset, pool } = artifact();
    const conflicting = structuredClone(pool);
    conflicting.players[0].name = "Wrong player";
    expect(publicationIdentityErrors(dataset, conflicting).join("\n")).toContain("conflicts with normalized player");
  });
});

describe("refresh change analysis", () => {
  it("reports added/removed players, pool membership, team, position, and reason changes in stable ID order", () => {
    const prior = baselineArtifacts();
    const current = artifact(["b", "c", "d"]);
    current.dataset.players.find((player) => player.id === "b")!.teamId = "team-2";
    current.dataset.players.find((player) => player.id === "b")!.teamName = "Second Team";
    current.dataset.players.find((player) => player.id === "b")!.teamAbbreviation = "T2";
    current.dataset.players.find((player) => player.id === "c")!.positionGroup = "DEF";
    current.dataset.players.find((player) => player.id === "c")!.position = "CB";
    current.dataset.dataVersion = computePlayerDataVersion(current.dataset);
    current.pool = selectComparisonPool(current.dataset, noOverrides, "2026-08-02T00:00:00.000Z");
    current.pool.players.find((player) => player.id === "b")!.selectionReasons.push("manual-inclusion");

    const analysis = analyzeRefresh(prior.baseline, prior.dataset, prior.pool, current.dataset, current.pool);
    expect(analysis).toMatchObject({
      substantiveDataChanged: true,
      playersArtifactChanged: true,
      poolArtifactChanged: true,
      addedPlayers: [{ id: "d" }],
      removedPlayers: [{ id: "a" }],
      addedPoolPlayers: [{ id: "d" }],
      removedPoolPlayers: [{ id: "a" }],
    });
    expect(analysis.teamChanges.map((change) => change.id)).toEqual(["b"]);
    expect(analysis.positionChanges.map((change) => change.id)).toEqual(["c"]);
    expect(analysis.selectionReasonCountChanges).toContainEqual({ reason: "manual-inclusion", from: 0, to: 1 });
  });

  it("excludes only documented observation timestamps from substantive change", () => {
    const prior = baselineArtifacts();
    const currentDataset = structuredClone(prior.dataset);
    const currentPool = structuredClone(prior.pool);
    currentDataset.generatedAt = "2026-08-02T00:00:00.000Z";
    currentDataset.sources[0].retrievedAt = "2026-08-02T00:00:00.000Z";
    currentPool.generatedAt = "2026-08-02T00:00:00.000Z";
    currentPool.provenance.sourcePlayerGeneratedAt = currentDataset.generatedAt;
    const analysis = analyzeRefresh(prior.baseline, prior.dataset, prior.pool, currentDataset, currentPool);
    expect(analysis.substantiveDataChanged).toBe(false);
    const status = buildRefreshStatus("2026-08-17T00:25:41.000Z", analysis, currentDataset, currentPool);
    expect(status).toMatchObject({ substantiveDataChanged: false, playerCount: 3, poolCount: 3 });
    expect(refreshStatusErrors(status, currentDataset, currentPool)).toEqual([]);
    expect(refreshStatusErrors({ ...status, playerCount: 4 }, currentDataset, currentPool)).toContain("Refresh status playerCount does not match players artifact");
    expect(currentDataset.dataVersion).toBe(prior.dataset.dataVersion);
  });

  it("produces deterministically ordered and Markdown-escaped reports", () => {
    const prior = baselineArtifacts();
    const current = artifact(["c", "d", "b"]);
    current.dataset.players.find((player) => player.id === "d")!.name = "Unsafe | <name>\nline";
    current.dataset.dataVersion = computePlayerDataVersion(current.dataset);
    current.pool = selectComparisonPool(current.dataset, noOverrides);
    const analysis = analyzeRefresh(prior.baseline, prior.dataset, prior.pool, current.dataset, current.pool);
    const status = buildRefreshStatus("2026-08-17T00:25:41.000Z", analysis, current.dataset, current.pool);
    const summary = formatRefreshSummary(prior.baseline, analysis, status, 12);
    expect(summary).toContain("Complete test suite: passed (12 tests)");
    expect(summary).toContain("Unsafe \\| \\<name\\> line");
    expect(analysis.addedPlayers.map((player) => player.id)).toEqual(["d"]);
  });
});

describe("refresh safety decisions", () => {
  it("accepts timestamp-only rebuild differences and rejects substantive nondeterminism", () => {
    const first = artifact();
    const secondDataset = structuredClone(first.dataset);
    const secondPool = structuredClone(first.pool);
    secondDataset.generatedAt = "2026-08-02T00:00:00.000Z";
    secondPool.generatedAt = "2026-08-02T00:00:00.000Z";
    secondPool.provenance.sourcePlayerGeneratedAt = secondDataset.generatedAt;
    expect(() => assertDeterministicArtifacts(first.dataset, first.pool, secondDataset, secondPool)).not.toThrow();
    secondPool.players.reverse();
    expect(() => assertDeterministicArtifacts(first.dataset, first.pool, secondDataset, secondPool)).toThrow(/deterministic ordering/);
  });

  it("rejects total salary loss and broad replacement of stable IDs", () => {
    const salaryPrior = artifact();
    salaryPrior.dataset.players[0].baseSalary = 1;
    const salaryBaseline = captureRefreshBaseline("a".repeat(40), "p", "q", salaryPrior.dataset, salaryPrior.pool);
    expect(() => assertRefreshSafety(salaryBaseline, artifact().dataset, artifact().pool)).toThrow(/lost all salary coverage/);

    const prior = artifact(["a", "b", "c", "d"]);
    const baseline = captureRefreshBaseline("a".repeat(40), "p", "q", prior.dataset, prior.pool);
    const replaced = artifact(["a", "w", "x", "y"]);
    expect(() => assertRefreshSafety(baseline, replaced.dataset, replaced.pool)).toThrow(/continuity check failed/);
  });

  it("rejects a required source row-count collapse against the baseline", () => {
    const prior = artifact();
    const source = prior.dataset.sources.find((entry) => entry.sourceId === "asa-players")!;
    source.rowCount = 100;
    prior.dataset.audit.sourceRowCounts[source.sourceId] = 100;
    const baseline = captureRefreshBaseline("a".repeat(40), "p", "q", prior.dataset, prior.pool);
    const current = artifact();
    current.dataset.sources.find((entry) => entry.sourceId === "asa-players")!.rowCount = 49;
    expect(() => assertRefreshSafety(baseline, current.dataset, current.pool)).toThrow(/row-count continuity check failed/);
  });

  it("enforces the tracked-file allowlist and Pages decision", () => {
    expect(unexpectedRefreshPaths(["data/refresh-status.json", "src/web/main.ts", "README.md"])).toEqual(["README.md", "src/web/main.ts"]);
    expect(shouldDispatchPages(["data/refresh-status.json"])).toBe(false);
    expect(shouldDispatchPages(["data/refresh-status.json", "public/data/players.json"])).toBe(true);
    expect(shouldDispatchPages(["public/data/comparison-pool.json"])).toBe(true);
  });

  it("fails a main-branch race and malformed SHA", () => {
    expect(() => assertUnchangedDefaultBranch("a".repeat(40), "a".repeat(40))).not.toThrow();
    expect(() => assertUnchangedDefaultBranch("a".repeat(40), "b".repeat(40))).toThrow(/changed during refresh/);
    expect(() => assertUnchangedDefaultBranch("main", "b".repeat(40))).toThrow(/full Git commit SHAs/);
  });
});

describe("scheduled workflow contract", () => {
  const workflow = readFileSync(new URL("../.github/workflows/refresh-data.yml", import.meta.url), "utf8");

  it("runs only Monday at 00:23 UTC or by manual dispatch", () => {
    expect(workflow).toContain('cron: "23 0 * * 1"');
    expect(workflow).toMatch(/on:\n  schedule:[\s\S]*?  workflow_dispatch:\n\nconcurrency:/);
    expect(workflow).not.toMatch(/\n  (push|pull_request):/);
  });

  it("uses minimum write permissions, serialized refreshes, one live refresh, and explicit conditional deployment", () => {
    expect(workflow).toMatch(/permissions:\n  contents: write\n  actions: write/);
    expect(workflow).not.toMatch(/pages: write|id-token: write|pull-requests: write|issues: write|write-all/);
    expect(workflow).toMatch(/group: mls-data-refresh\n  cancel-in-progress: false/);
    expect(workflow.match(/build:data -- --refresh/g)).toHaveLength(1);
    expect(workflow).toContain("npm run build:data\n          npm run build:pool");
    expect(workflow).toContain("gh workflow run deploy-pages.yml");
    expect(workflow).toContain("if: steps.refreshed.outputs.dispatch_pages == 'true'");
  });

  it("contains no PR, PAT, force-push, merge, or Pages deployment implementation", () => {
    expect(workflow).not.toMatch(/create-pull-request|pull request|\bPAT\b|force-with-lease|force-push|git push --force|auto-merge|deploy-pages@|upload-pages-artifact@/i);
  });

  it("enforces correct refresh lifecycle ordering", () => {
    expect(workflow.match(/build:data -- --refresh/g)).toHaveLength(1);
    expect(workflow).toContain("npm run build:data\n          npm run build:pool");

    const steps = workflow.split(/^      - name: /m).slice(1);
    const stepNames = steps.map((step) => step.split("\n")[0]);

    const refreshIndex = stepNames.findIndex((name) => name.includes("Refresh all approved external sources once"));
    const finalizeIndex = stepNames.findIndex((name) => name.includes("Verify determinism and finalize refresh status"));
    const publicationIndex = stepNames.findIndex((name) => name.includes("Run publication gate"));
    const buildWebIndex = stepNames.findIndex((name) => name.includes("Build and verify production site"));
    const deterministicRebuildIndex = stepNames.findIndex((name) => name.includes("Rebuild from refreshed caches only"));
    const commitIndex = stepNames.findIndex((name) => name.includes("Commit and push verified refresh"));

    expect(refreshIndex).toBeGreaterThanOrEqual(0);
    expect(finalizeIndex).toBeGreaterThanOrEqual(0);
    expect(publicationIndex).toBeGreaterThanOrEqual(0);
    expect(buildWebIndex).toBeGreaterThanOrEqual(0);
    expect(deterministicRebuildIndex).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeGreaterThanOrEqual(0);

    expect(deterministicRebuildIndex).toBeLessThan(finalizeIndex);
    expect(finalizeIndex).toBeLessThan(publicationIndex);
    expect(finalizeIndex).toBeLessThan(buildWebIndex);
    expect(publicationIndex).toBeLessThan(commitIndex);
    expect(buildWebIndex).toBeLessThan(commitIndex);

    expect(workflow).toContain("npm run check:publication");
    expect(workflow).toContain("npm run build:web");
  });

  it("prevents pre-finalization refresh-status validation", () => {
    const workflow = readFileSync(new URL("../.github/workflows/refresh-data.yml", import.meta.url), "utf8");
    const steps = workflow.split(/^      - name: /m).slice(1);
    const finalizeIndex = steps.findIndex((step) => step.includes("Verify determinism and finalize refresh status"));

    const preFinalizeSteps = steps.slice(0, finalizeIndex);
    const preFinalizeContent = preFinalizeSteps.join("\n");

    expect(preFinalizeContent).not.toContain("check:publication");
    expect(preFinalizeContent).not.toContain("build:web");
    expect(preFinalizeContent).not.toContain("validate:refresh-status");
  });
});
