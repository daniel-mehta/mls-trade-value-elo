import { createHash } from "node:crypto";
import type { ComparisonPool, ComparisonPoolPlayer, SelectionReason } from "./comparisonPool.js";
import type { PublicationSeasonResolution } from "./seasonResolution.js";
import { canonicalStringify } from "./semanticVersion.js";
import type { PlayerDataset, StaticPlayer } from "./types.js";

export const REFRESH_ALLOWED_PATHS = [
  "data/refresh-status.json",
  "public/data/comparison-pool.json",
  "public/data/players.json",
] as const;

export interface RefreshPlayerRecord {
  id: string;
  name: string;
  teamId: string;
  teamName: string;
  positionGroup: string;
  position?: string;
  hasSalary: boolean;
  hasRosterProfile: boolean;
  hasGoalkeeperMetrics: boolean;
}

export interface RefreshPoolRecord extends RefreshPlayerRecord {
  selectionReasons: SelectionReason[];
}

export interface RefreshBaseline {
  schemaVersion: 1;
  startingSha: string;
  playerByteHash: string;
  poolByteHash: string;
  playerVersion: string;
  poolVersion: string;
  currentSeason: number;
  previousSeason: number;
  playerCount: number;
  poolCount: number;
  players: RefreshPlayerRecord[];
  pool: RefreshPoolRecord[];
  salaryCoverage: number;
  rosterCoverage: number;
  goalkeeperCoverage: number;
  statisticalRosterDisagreementCount: number;
  provenance: {
    sources: PlayerDataset["sources"];
    salary: PlayerDataset["salary"];
    rosterSnapshot: PlayerDataset["rosterSnapshot"];
  };
}

export interface RefreshAnalysis {
  substantiveDataChanged: boolean;
  playersArtifactChanged: boolean;
  poolArtifactChanged: boolean;
  seasonChanged: boolean;
  addedPlayers: RefreshPlayerRecord[];
  removedPlayers: RefreshPlayerRecord[];
  addedPoolPlayers: RefreshPoolRecord[];
  removedPoolPlayers: RefreshPoolRecord[];
  teamChanges: Array<{ id: string; name: string; from: string; to: string }>;
  positionChanges: Array<{ id: string; name: string; from: string; to: string }>;
  selectionReasonCountChanges: Array<{ reason: string; from: number; to: number }>;
  salaryCoverage: { from: number; to: number };
  rosterCoverage: { from: number; to: number };
  goalkeeperCoverage: { from: number; to: number };
  statisticalRosterDisagreementCount: { from: number; to: number };
}

export interface RefreshStatus {
  schemaVersion: 1;
  lastSuccessfulRefresh: string | null;
  currentSeason: number;
  previousSeason: number;
  substantiveDataChanged: boolean;
  playerVersion: string;
  poolVersion: string;
  playerCount: number;
  poolCount: number;
}

function sha256Bytes(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function playerRecord(player: StaticPlayer): RefreshPlayerRecord {
  return {
    id: player.id,
    name: player.name,
    teamId: player.teamId,
    teamName: player.teamName,
    positionGroup: player.positionGroup,
    ...(player.position ? { position: player.position } : {}),
    hasSalary: player.baseSalary !== undefined || player.guaranteedCompensation !== undefined,
    hasRosterProfile: player.rosterProfile !== undefined,
    hasGoalkeeperMetrics: player.goalkeeperMetrics !== undefined,
  };
}

function poolRecord(player: ComparisonPoolPlayer): RefreshPoolRecord {
  return { ...playerRecord(player), selectionReasons: [...player.selectionReasons] };
}

function compareId<T extends { id: string }>(left: T, right: T): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function captureRefreshBaseline(
  startingSha: string,
  playerBytes: string,
  poolBytes: string,
  dataset: PlayerDataset,
  pool: ComparisonPool,
): RefreshBaseline {
  return {
    schemaVersion: 1,
    startingSha,
    playerByteHash: sha256Bytes(playerBytes),
    poolByteHash: sha256Bytes(poolBytes),
    playerVersion: dataset.dataVersion,
    poolVersion: pool.dataVersion,
    currentSeason: dataset.season,
    previousSeason: dataset.previousSeason,
    playerCount: dataset.players.length,
    poolCount: pool.players.length,
    players: dataset.players.map(playerRecord).sort(compareId),
    pool: pool.players.map(poolRecord).sort(compareId),
    salaryCoverage: dataset.players.filter((player) => player.baseSalary !== undefined || player.guaranteedCompensation !== undefined).length,
    rosterCoverage: dataset.players.filter((player) => player.rosterProfile).length,
    goalkeeperCoverage: dataset.players.filter((player) => player.goalkeeperMetrics).length,
    statisticalRosterDisagreementCount: dataset.audit.statisticalSnapshotTeamDisagreementCount,
    provenance: {
      sources: structuredClone(dataset.sources),
      salary: structuredClone(dataset.salary),
      rosterSnapshot: structuredClone(dataset.rosterSnapshot),
    },
  };
}

function withoutSelectionReasons(player: ComparisonPoolPlayer): StaticPlayer {
  const { selectionReasons: _selectionReasons, ...normalized } = player;
  return normalized;
}

/** Explicit publication-critical identity checks, independent of pool reconstruction. */
export function publicationIdentityErrors(dataset: PlayerDataset, pool: ComparisonPool): string[] {
  const errors: string[] = [];
  const playersById = new Map<string, StaticPlayer>();
  for (const player of dataset.players) {
    if (!player.id.trim()) errors.push("Normalized player is missing a stable ASA player ID");
    else if (playersById.has(player.id)) errors.push(`Duplicate normalized stable ASA player ID: ${player.id}`);
    else playersById.set(player.id, player);
  }
  const poolIds = new Set<string>();
  for (const player of pool.players) {
    if (!player.id.trim()) errors.push("Comparison-pool player is missing a stable ASA player ID");
    else if (poolIds.has(player.id)) errors.push(`Duplicate comparison-pool player ID: ${player.id}`);
    poolIds.add(player.id);
    const normalized = playersById.get(player.id);
    if (!normalized) errors.push(`Comparison-pool player ID is missing from normalized players: ${player.id}`);
    else if (canonicalStringify(withoutSelectionReasons(player)) !== canonicalStringify(normalized)) {
      errors.push(`Comparison-pool identity conflicts with normalized player: ${player.id}`);
    }
  }
  return [...new Set(errors)].sort();
}

/** Excludes only build-observation timestamps already excluded from semantic identity. */
export function playerSubstantivePayload(dataset: PlayerDataset): unknown {
  return {
    ...dataset,
    generatedAt: undefined,
    sources: dataset.sources.map(({ retrievedAt: _retrievedAt, ...source }) => source),
  };
}

export function poolSubstantivePayload(pool: ComparisonPool): unknown {
  return {
    ...pool,
    generatedAt: undefined,
    provenance: { ...pool.provenance, sourcePlayerGeneratedAt: undefined },
  };
}

function mapById<T extends { id: string }>(records: readonly T[]): Map<string, T> {
  return new Map(records.map((record) => [record.id, record]));
}

function selectionReasonCounts(records: readonly RefreshPoolRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) for (const reason of record.selectionReasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return counts;
}

export function analyzeRefresh(
  baseline: RefreshBaseline,
  baselineDataset: PlayerDataset,
  baselinePool: ComparisonPool,
  dataset: PlayerDataset,
  pool: ComparisonPool,
): RefreshAnalysis {
  const currentPlayers = dataset.players.map(playerRecord).sort(compareId);
  const currentPool = pool.players.map(poolRecord).sort(compareId);
  const oldPlayers = mapById(baseline.players);
  const newPlayers = mapById(currentPlayers);
  const oldPool = mapById(baseline.pool);
  const newPool = mapById(currentPool);
  const returningIds = [...newPlayers.keys()].filter((id) => oldPlayers.has(id)).sort();
  const oldReasons = selectionReasonCounts(baseline.pool);
  const newReasons = selectionReasonCounts(currentPool);
  const reasons = [...new Set([...oldReasons.keys(), ...newReasons.keys()])].sort();
  const playersArtifactChanged = canonicalStringify(playerSubstantivePayload(baselineDataset)) !== canonicalStringify(playerSubstantivePayload(dataset));
  const poolArtifactChanged = canonicalStringify(poolSubstantivePayload(baselinePool)) !== canonicalStringify(poolSubstantivePayload(pool));
  return {
    substantiveDataChanged: playersArtifactChanged || poolArtifactChanged,
    playersArtifactChanged,
    poolArtifactChanged,
    seasonChanged: baseline.currentSeason !== dataset.season || baseline.previousSeason !== dataset.previousSeason,
    addedPlayers: currentPlayers.filter((record) => !oldPlayers.has(record.id)),
    removedPlayers: baseline.players.filter((record) => !newPlayers.has(record.id)),
    addedPoolPlayers: currentPool.filter((record) => !oldPool.has(record.id)),
    removedPoolPlayers: baseline.pool.filter((record) => !newPool.has(record.id)),
    teamChanges: returningIds
      .filter((id) => oldPlayers.get(id)!.teamId !== newPlayers.get(id)!.teamId)
      .map((id) => ({ id, name: newPlayers.get(id)!.name, from: oldPlayers.get(id)!.teamName, to: newPlayers.get(id)!.teamName })),
    positionChanges: returningIds
      .filter((id) => `${oldPlayers.get(id)!.positionGroup}/${oldPlayers.get(id)!.position ?? ""}` !== `${newPlayers.get(id)!.positionGroup}/${newPlayers.get(id)!.position ?? ""}`)
      .map((id) => ({
        id,
        name: newPlayers.get(id)!.name,
        from: `${oldPlayers.get(id)!.positionGroup}${oldPlayers.get(id)!.position ? ` (${oldPlayers.get(id)!.position})` : ""}`,
        to: `${newPlayers.get(id)!.positionGroup}${newPlayers.get(id)!.position ? ` (${newPlayers.get(id)!.position})` : ""}`,
      })),
    selectionReasonCountChanges: reasons
      .filter((reason) => (oldReasons.get(reason) ?? 0) !== (newReasons.get(reason) ?? 0))
      .map((reason) => ({ reason, from: oldReasons.get(reason) ?? 0, to: newReasons.get(reason) ?? 0 })),
    salaryCoverage: { from: baseline.salaryCoverage, to: currentPlayers.filter((player) => player.hasSalary).length },
    rosterCoverage: { from: baseline.rosterCoverage, to: currentPlayers.filter((player) => player.hasRosterProfile).length },
    goalkeeperCoverage: { from: baseline.goalkeeperCoverage, to: currentPlayers.filter((player) => player.hasGoalkeeperMetrics).length },
    statisticalRosterDisagreementCount: { from: baseline.statisticalRosterDisagreementCount, to: dataset.audit.statisticalSnapshotTeamDisagreementCount },
  };
}

export function assertRefreshSafety(
  baseline: RefreshBaseline,
  dataset: PlayerDataset,
  pool: ComparisonPool,
  resolution?: PublicationSeasonResolution,
): void {
  const identityErrors = publicationIdentityErrors(dataset, pool);
  if (identityErrors.length) throw new Error(`Publication identity validation failed:\n- ${identityErrors.join("\n- ")}`);
  if (resolution && (dataset.season !== resolution.currentSeason || dataset.previousSeason !== resolution.previousSeason)) {
    throw new Error(`Resolved season pair ${resolution.currentSeason}/${resolution.previousSeason} does not match built artifacts ${dataset.season}/${dataset.previousSeason}`);
  }
  if (baseline.salaryCoverage > 0 && !dataset.players.some((player) => player.baseSalary !== undefined || player.guaranteedCompensation !== undefined)) {
    throw new Error("Refreshed dataset unexpectedly lost all salary coverage");
  }
  const oldIds = new Set(baseline.players.map((player) => player.id));
  const retained = dataset.players.filter((player) => oldIds.has(player.id)).length;
  const continuityBase = Math.min(oldIds.size, dataset.players.length);
  if (continuityBase > 0 && retained * 2 < continuityBase) {
    throw new Error(`Stable ASA player-ID continuity check failed: retained ${retained} of ${continuityBase} comparable IDs`);
  }
  const sameSeason = baseline.currentSeason === dataset.season && baseline.previousSeason === dataset.previousSeason;
  if (sameSeason) {
    for (const prior of baseline.provenance.sources.filter((source) => !source.sourceId.startsWith("asa-salaries-") && source.rowCount > 0)) {
      const current = dataset.sources.find((source) => source.sourceId === prior.sourceId);
      if (current && current.rowCount * 2 < prior.rowCount) {
        throw new Error(`Required source row-count continuity check failed for ${prior.sourceId}: ${prior.rowCount} -> ${current.rowCount}`);
      }
    }
  }
}

export function assertDeterministicArtifacts(
  firstDataset: PlayerDataset,
  firstPool: ComparisonPool,
  secondDataset: PlayerDataset,
  secondPool: ComparisonPool,
): void {
  const errors = publicationIdentityErrors(secondDataset, secondPool);
  if (firstDataset.dataVersion !== secondDataset.dataVersion) errors.push("Player semantic versions differ between rebuilds");
  if (firstPool.dataVersion !== secondPool.dataVersion) errors.push("Pool semantic versions differ between rebuilds");
  if (canonicalStringify(playerSubstantivePayload(firstDataset)) !== canonicalStringify(playerSubstantivePayload(secondDataset))) {
    errors.push("Player artifacts differ substantively or in deterministic ordering between rebuilds");
  }
  if (canonicalStringify(poolSubstantivePayload(firstPool)) !== canonicalStringify(poolSubstantivePayload(secondPool))) {
    errors.push("Pool artifacts differ substantively or in deterministic ordering between rebuilds");
  }
  if (errors.length) throw new Error(`Determinism validation failed:\n- ${[...new Set(errors)].join("\n- ")}`);
}

export function buildRefreshStatus(timestamp: string | null, analysis: RefreshAnalysis, dataset: PlayerDataset, pool: ComparisonPool): RefreshStatus {
  if (timestamp !== null) {
    const parsed = new Date(timestamp);
    if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== timestamp) throw new Error("Successful refresh timestamp must be canonical UTC ISO-8601");
  }
  return {
    schemaVersion: 1,
    lastSuccessfulRefresh: timestamp,
    currentSeason: dataset.season,
    previousSeason: dataset.previousSeason,
    substantiveDataChanged: analysis.substantiveDataChanged,
    playerVersion: dataset.dataVersion,
    poolVersion: pool.dataVersion,
    playerCount: dataset.players.length,
    poolCount: pool.players.length,
  };
}

export function refreshStatusErrors(status: RefreshStatus, dataset: PlayerDataset, pool: ComparisonPool): string[] {
  const errors: string[] = [];
  const allowed = ["schemaVersion", "lastSuccessfulRefresh", "currentSeason", "previousSeason", "substantiveDataChanged", "playerVersion", "poolVersion", "playerCount", "poolCount"];
  const unknown = Object.keys(status as unknown as Record<string, unknown>).filter((key) => !allowed.includes(key));
  if (unknown.length) errors.push(`Refresh status contains unsupported keys: ${unknown.sort().join(", ")}`);
  if (status.schemaVersion !== 1) errors.push("Refresh status schemaVersion must be 1");
  if (status.lastSuccessfulRefresh !== null) {
    const parsed = new Date(status.lastSuccessfulRefresh);
    if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== status.lastSuccessfulRefresh) errors.push("Refresh status timestamp must be canonical UTC ISO-8601 or null");
  }
  if (status.currentSeason !== dataset.season) errors.push("Refresh status currentSeason does not match players artifact");
  if (status.previousSeason !== dataset.previousSeason) errors.push("Refresh status previousSeason does not match players artifact");
  if (typeof status.substantiveDataChanged !== "boolean") errors.push("Refresh status substantiveDataChanged must be boolean");
  if (status.playerVersion !== dataset.dataVersion) errors.push("Refresh status playerVersion does not match players artifact");
  if (status.poolVersion !== pool.dataVersion) errors.push("Refresh status poolVersion does not match pool artifact");
  if (status.playerCount !== dataset.players.length) errors.push("Refresh status playerCount does not match players artifact");
  if (status.poolCount !== pool.players.length) errors.push("Refresh status poolCount does not match pool artifact");
  return errors;
}

export function unexpectedRefreshPaths(paths: readonly string[]): string[] {
  const allowed = new Set<string>(REFRESH_ALLOWED_PATHS);
  return [...new Set(paths.filter((path) => path && !allowed.has(path)))].sort();
}

export function shouldDispatchPages(changedPaths: readonly string[]): boolean {
  return changedPaths.includes("public/data/players.json") || changedPaths.includes("public/data/comparison-pool.json");
}

export function assertUnchangedDefaultBranch(startingSha: string, remoteSha: string): void {
  if (!/^[a-f0-9]{40}$/.test(startingSha) || !/^[a-f0-9]{40}$/.test(remoteSha)) throw new Error("Default-branch race check requires full Git commit SHAs");
  if (startingSha !== remoteSha) throw new Error(`Default branch changed during refresh (${startingSha} -> ${remoteSha}); rerun against the newer state`);
}

function markdown(value: string): string {
  return value.replace(/[\\`|<>]/g, (character) => `\\${character}`).replace(/[\r\n]+/g, " ");
}

function recordLine(record: RefreshPlayerRecord, reasons?: readonly string[]): string {
  const reasonText = reasons?.length ? `; reasons: ${reasons.map(markdown).join(", ")}` : "";
  return `- ${markdown(record.id)} | ${markdown(record.name)} | ${markdown(record.teamName)} | ${markdown(record.positionGroup)}${reasonText}`;
}

function sectionRecords(title: string, records: readonly RefreshPlayerRecord[], reasonRecords = false): string[] {
  return [
    `### ${title} (${records.length})`,
    ...(records.length ? records.map((record) => recordLine(record, reasonRecords ? (record as RefreshPoolRecord).selectionReasons : undefined)) : ["- None"]),
  ];
}

export function formatRefreshSummary(
  baseline: RefreshBaseline,
  analysis: RefreshAnalysis,
  status: RefreshStatus,
  testCount: number | null,
): string {
  const lines = [
    "## MLS data refresh",
    "",
    `- Successful refresh: ${status.lastSuccessfulRefresh ?? "not yet run"}`,
    `- Resolved current/previous publication season: ${status.currentSeason}/${status.previousSeason}`,
    `- Season rollover: ${analysis.seasonChanged}`,
    `- Players: ${baseline.playerCount} -> ${status.playerCount}`,
    `- Comparison pool: ${baseline.poolCount} -> ${status.poolCount}`,
    `- Player semantic version: ${status.playerVersion}`,
    `- Pool semantic version: ${status.poolVersion}`,
    `- Substantive data changed: ${analysis.substantiveDataChanged}`,
    `- Players artifact changed: ${analysis.playersArtifactChanged}`,
    `- Pool artifact changed: ${analysis.poolArtifactChanged}`,
    `- Duplicate-ID and cross-artifact identity checks: passed`,
    `- Complete test suite: passed${testCount === null ? "" : ` (${testCount} tests)`}`,
    `- Publication check: passed`,
    `- Determinism check: passed`,
    "",
    ...sectionRecords("Added normalized players", analysis.addedPlayers),
    "",
    ...sectionRecords("Removed normalized players", analysis.removedPlayers),
    "",
    ...sectionRecords("Added comparison-pool players", analysis.addedPoolPlayers, true),
    "",
    ...sectionRecords("Removed comparison-pool players", analysis.removedPoolPlayers, true),
    "",
    `### Context changes`,
    `- Displayed team changes: ${analysis.teamChanges.length}`,
    ...analysis.teamChanges.map((change) => `  - ${markdown(change.id)} | ${markdown(change.name)} | ${markdown(change.from)} -> ${markdown(change.to)}`),
    `- Broad/detailed position changes: ${analysis.positionChanges.length}`,
    ...analysis.positionChanges.map((change) => `  - ${markdown(change.id)} | ${markdown(change.name)} | ${markdown(change.from)} -> ${markdown(change.to)}`),
    `- Selection-reason count changes: ${analysis.selectionReasonCountChanges.length}`,
    ...analysis.selectionReasonCountChanges.map((change) => `  - ${markdown(change.reason)}: ${change.from} -> ${change.to}`),
    `- Salary coverage: ${analysis.salaryCoverage.from} -> ${analysis.salaryCoverage.to}`,
    `- Roster-profile coverage: ${analysis.rosterCoverage.from} -> ${analysis.rosterCoverage.to}`,
    `- Goalkeeper coverage: ${analysis.goalkeeperCoverage.from} -> ${analysis.goalkeeperCoverage.to}`,
    `- Statistical/roster disagreements: ${analysis.statisticalRosterDisagreementCount.from} -> ${analysis.statisticalRosterDisagreementCount.to}`,
    "",
  ];
  return `${lines.join("\n")}\n`;
}
