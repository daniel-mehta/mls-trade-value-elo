import { execFileSync } from "node:child_process";
import { appendFile, copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateComparisonPool, type ComparisonPool, type ComparisonPoolOverrides } from "../src/data/comparisonPool.js";
import {
  analyzeRefresh,
  assertDeterministicArtifacts,
  assertRefreshSafety,
  assertUnchangedDefaultBranch,
  buildRefreshStatus,
  captureRefreshBaseline,
  formatRefreshSummary,
  publicationIdentityErrors,
  shouldDispatchPages,
  unexpectedRefreshPaths,
  type RefreshBaseline,
} from "../src/data/refreshAutomation.js";
import {
  SeasonResolutionError,
  discoverPublicationSeasons,
  formatSeasonResolutionFailure,
  formatSeasonResolutionSummary,
  type PublicationSeasonResolution,
  type SeasonResolutionFailure,
} from "../src/data/seasonResolution.js";
import type { PlayerDataset } from "../src/data/types.js";
import { assertValidDataset } from "../src/data/validation.js";

function argumentsMap(values: readonly string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error(`Expected --name value arguments; received ${name ?? "end of input"}`);
    options.set(name.slice(2), value);
  }
  return options;
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`Missing required --${name}`);
  return value;
}

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as T;
}

async function publicationArtifacts(playerPath: string, poolPath: string): Promise<{ dataset: PlayerDataset; pool: ComparisonPool }> {
  const [dataset, pool, overrides] = await Promise.all([
    json<PlayerDataset>(playerPath),
    json<ComparisonPool>(poolPath),
    json<ComparisonPoolOverrides>("data/comparison-pool-overrides.json"),
  ]);
  assertValidDataset(dataset);
  const poolErrors = validateComparisonPool(pool, dataset, overrides);
  if (poolErrors.length) throw new Error(`Comparison-pool validation failed:\n- ${poolErrors.join("\n- ")}`);
  const identityErrors = publicationIdentityErrors(dataset, pool);
  if (identityErrors.length) throw new Error(`Publication identity validation failed:\n- ${identityErrors.join("\n- ")}`);
  return { dataset, pool };
}

async function capture(options: Map<string, string>): Promise<void> {
  const playerPath = options.get("players") ?? "public/data/players.json";
  const poolPath = options.get("pool") ?? "public/data/comparison-pool.json";
  const [playerBytes, poolBytes, artifacts] = await Promise.all([
    readFile(resolve(playerPath), "utf8"),
    readFile(resolve(poolPath), "utf8"),
    publicationArtifacts(playerPath, poolPath),
  ]);
  const baseline = captureRefreshBaseline(required(options, "starting-sha"), playerBytes, poolBytes, artifacts.dataset, artifacts.pool);
  await Promise.all([
    writeFile(resolve(required(options, "output")), `${JSON.stringify(baseline, null, 2)}\n`),
    copyFile(resolve(playerPath), resolve(required(options, "players-copy"))),
    copyFile(resolve(poolPath), resolve(required(options, "pool-copy"))),
  ]);
  console.log(`Captured baseline ${baseline.startingSha}: ${baseline.playerCount} players, ${baseline.poolCount} pool players`);
}

async function resolveSeason(options: Map<string, string>): Promise<void> {
  const baseline = await json<RefreshBaseline>(required(options, "baseline"));
  try {
    const resolution = await discoverPublicationSeasons(baseline.currentSeason, baseline.previousSeason);
    await writeFile(resolve(required(options, "output")), `${JSON.stringify(resolution, null, 2)}\n`);
    if (options.has("summary")) await appendFile(resolve(required(options, "summary")), formatSeasonResolutionSummary(resolution));
    if (options.has("github-output")) {
      await appendFile(resolve(required(options, "github-output")), [
        `mode=${resolution.mode}`,
        `current_season=${resolution.currentSeason}`,
        `previous_season=${resolution.previousSeason}`,
      ].join("\n") + "\n");
    }
    if (options.has("github-env")) {
      await appendFile(resolve(required(options, "github-env")), [
        `MLS_CURRENT_SEASON=${resolution.currentSeason}`,
        `MLS_PREVIOUS_SEASON=${resolution.previousSeason}`,
      ].join("\n") + "\n");
    }
    console.log(`Resolved MLS publication seasons ${resolution.currentSeason}/${resolution.previousSeason} (${resolution.mode})`);
  } catch (error) {
    const failure: SeasonResolutionFailure = error instanceof SeasonResolutionError
      ? error.failure
      : {
        configuredCurrentSeason: baseline.currentSeason,
        configuredPreviousSeason: baseline.previousSeason,
        candidateSeason: "unavailable",
        sourceEvidence: `ASA MLS games discovery failed: ${(error as Error).message}`,
        compatibilityCheck: "Official ASA season discovery could not be completed",
      };
    if (options.has("summary")) await appendFile(resolve(required(options, "summary")), formatSeasonResolutionFailure(failure));
    throw error;
  }
}

function vitestCount(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Record<string, unknown>;
  for (const key of ["numTotalTests", "numPassedTests"]) {
    if (typeof result[key] === "number" && Number.isInteger(result[key])) return result[key] as number;
  }
  return null;
}

async function finalize(options: Map<string, string>): Promise<void> {
  const [baseline, resolution, baselineArtifacts, firstArtifacts, currentArtifacts] = await Promise.all([
    json<RefreshBaseline>(required(options, "baseline")),
    json<PublicationSeasonResolution>(required(options, "season-resolution")),
    publicationArtifacts(required(options, "baseline-players"), required(options, "baseline-pool")),
    publicationArtifacts(required(options, "first-players"), required(options, "first-pool")),
    publicationArtifacts("public/data/players.json", "public/data/comparison-pool.json"),
  ]);
  if (baseline.schemaVersion !== 1) throw new Error("Unsupported refresh baseline schema");
  assertRefreshSafety(baseline, currentArtifacts.dataset, currentArtifacts.pool, resolution);
  assertDeterministicArtifacts(firstArtifacts.dataset, firstArtifacts.pool, currentArtifacts.dataset, currentArtifacts.pool);
  const analysis = analyzeRefresh(
    baseline,
    baselineArtifacts.dataset,
    baselineArtifacts.pool,
    currentArtifacts.dataset,
    currentArtifacts.pool,
  );
  if (resolution.mode === "rollover" && !analysis.substantiveDataChanged) {
    throw new Error("A resolved season rollover must be treated as a substantive publication change");
  }
  const status = buildRefreshStatus(required(options, "timestamp"), analysis, currentArtifacts.dataset, currentArtifacts.pool);
  const testCount = options.has("test-results") ? vitestCount(await json<unknown>(required(options, "test-results"))) : null;
  const result = { schemaVersion: 1, baseline, analysis, status, testCount };
  await Promise.all([
    writeFile(resolve("data/refresh-status.json"), `${JSON.stringify(status, null, 2)}\n`),
    writeFile(resolve(required(options, "result")), `${JSON.stringify(result, null, 2)}\n`),
    ...(!analysis.substantiveDataChanged ? [
      copyFile(resolve(required(options, "baseline-players")), resolve("public/data/players.json")),
      copyFile(resolve(required(options, "baseline-pool")), resolve("public/data/comparison-pool.json")),
    ] : []),
  ]);
  if (options.has("summary")) await appendFile(resolve(required(options, "summary")), formatRefreshSummary(baseline, analysis, status, testCount));
  if (options.has("github-output")) {
    const commitDate = status.lastSuccessfulRefresh!.slice(0, 10);
    const commitMessage = analysis.substantiveDataChanged
      ? `data: refresh MLS snapshot ${commitDate}`
      : `chore(data): record successful MLS refresh ${commitDate}`;
    const output = [
      `substantive_data_changed=${analysis.substantiveDataChanged}`,
      `players_changed=${analysis.playersArtifactChanged}`,
      `pool_changed=${analysis.poolArtifactChanged}`,
      `dispatch_pages=${shouldDispatchPages([
        ...(analysis.playersArtifactChanged ? ["public/data/players.json"] : []),
        ...(analysis.poolArtifactChanged ? ["public/data/comparison-pool.json"] : []),
      ])}`,
      `commit_message=${commitMessage}`,
      `refresh_timestamp=${status.lastSuccessfulRefresh}`,
      `current_season=${status.currentSeason}`,
      `previous_season=${status.previousSeason}`,
      `player_count=${status.playerCount}`,
      `pool_count=${status.poolCount}`,
      `player_version=${status.playerVersion}`,
      `pool_version=${status.poolVersion}`,
    ].join("\n");
    await appendFile(resolve(required(options, "github-output")), `${output}\n`);
  }
  console.log(`Deterministic refresh verified: substantive data changed=${analysis.substantiveDataChanged}`);
}

async function failureSummary(options: Map<string, string>): Promise<void> {
  const resolution = await json<PublicationSeasonResolution>(required(options, "season-resolution"));
  const check = required(options, "failed-check");
  const failure: SeasonResolutionFailure = {
    configuredCurrentSeason: resolution.configuredCurrentSeason,
    configuredPreviousSeason: resolution.configuredPreviousSeason,
    candidateSeason: resolution.candidateSeason,
    sourceEvidence: `${resolution.evidence.source} ${resolution.evidence.endpoint} returned ${resolution.evidence.rowCount} games and season identifiers: ${resolution.evidence.identifiers.join(", ")}`,
    compatibilityCheck: check,
  };
  await appendFile(resolve(required(options, "summary")), formatSeasonResolutionFailure(failure));
}

function nulPaths(command: string, args: string[]): string[] {
  const output = execFileSync(command, args, { encoding: "buffer" });
  return output.toString("utf8").split("\0").filter(Boolean);
}

function checkAllowlist(): void {
  const paths = [
    ...nulPaths("git", ["diff", "HEAD", "--name-only", "-z", "--"]),
    ...nulPaths("git", ["ls-files", "--others", "--exclude-standard", "-z", "--"]),
  ];
  const unexpected = unexpectedRefreshPaths(paths);
  if (unexpected.length) throw new Error(`Refresh modified files outside the allowlist:\n- ${unexpected.join("\n- ")}`);
  if (!paths.includes("data/refresh-status.json")) throw new Error("Successful refresh did not update data/refresh-status.json");
  console.log(`Refresh tracked-file allowlist passed: ${[...new Set(paths)].sort().join(", ")}`);
}

async function main(): Promise<void> {
  const [command, ...rawOptions] = process.argv.slice(2);
  const options = argumentsMap(rawOptions);
  if (command === "capture") await capture(options);
  else if (command === "resolve-season") await resolveSeason(options);
  else if (command === "finalize") await finalize(options);
  else if (command === "failure-summary") await failureSummary(options);
  else if (command === "check-allowlist") checkAllowlist();
  else if (command === "race-check") assertUnchangedDefaultBranch(required(options, "starting-sha"), required(options, "remote-sha"));
  else throw new Error(`Unknown refresh-data command: ${command ?? "none"}`);
}

main().catch((error) => {
  console.error(`Refresh automation failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
