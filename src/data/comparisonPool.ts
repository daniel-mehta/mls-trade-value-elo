import type { PlayerDataset, PositionGroup, StaticPlayer } from "./types.js";
import { stablePlayerSort } from "./aggregation.js";
import { canonicalStringify, computePoolDataVersion, isSemanticVersion, sha256Canonical } from "./semanticVersion.js";
import { validateDataset } from "./validation.js";

export const SELECTION_REASONS = [
  "team-outfield-selection",
  "team-goalkeeper-selection",
  "designated-player",
  "u22-initiative",
  "current-season-five-goal-contributions",
  "manual-inclusion",
] as const;
export type SelectionReason = typeof SELECTION_REASONS[number];

export const MIN_COMPARISON_POOL_SIZE = 150;

export interface ComparisonPoolPlayer extends StaticPlayer { selectionReasons: SelectionReason[]; }

export interface ComparisonPoolRules {
  eligibilityCurrentSeasonMinutesGreaterThan: 0;
  previousSeasonFallbackRequiresRosterSnapshot: true;
  unavailablePlayersExcluded: false;
  baseOutfieldPlayersPerTeam: 5;
  baseGoalkeepersPerTeam: 1;
  previousSeasonMinutesWeight: 0.5;
  participationScoreFormula: "current-minutes + previous-minutes * 0.5";
  currentSeasonGoalContributionThreshold: 5;
  designationInclusions: readonly ["Designated Player", "U22 Initiative"];
  tieBreakers: readonly ["participation-score-desc", "current-minutes-desc", "previous-minutes-desc", "asa-player-id-asc"];
  manualInclusionsEligibilityBound: true;
  exclusionsTakePrecedence: true;
}

export interface ComparisonPoolProvenance {
  sourcePlayerDataVersion: string;
  sourcePlayerGeneratedAt: string;
  statisticsThrough: string | null;
  rosterSnapshotDate: string;
  rosterReleaseDate: string;
  salaryReleaseDate: string | null;
  salaryCurrency: "USD";
}

export interface ComparisonPoolOverrideProvenance {
  schemaVersion: 1;
  includeCount: number;
  excludeCount: number;
  contentSha256: string;
}

export interface ComparisonPoolAudit {
  eligiblePlayerCount: number;
  finalPoolSize: number;
  selectionReasonCounts: Record<SelectionReason, number>;
  positionDistribution: Record<PositionGroup, number>;
  teamRepresentation: { teamCount: number; minimum: number; maximum: number; median: number };
}

export interface ComparisonPool {
  schemaVersion: 3;
  humanReadableLabel: string;
  dataVersion: string;
  sourceDataVersion: string;
  season: number;
  previousSeason: number;
  generatedAt: string;
  provenance: ComparisonPoolProvenance;
  selectionRules: ComparisonPoolRules;
  overrides: ComparisonPoolOverrideProvenance;
  audit: ComparisonPoolAudit;
  players: ComparisonPoolPlayer[];
}

export interface ComparisonPoolOverride { playerId: string; reason: string; sourceNote: string; }
export interface ComparisonPoolOverrides { schemaVersion: 1; include: ComparisonPoolOverride[]; exclude: ComparisonPoolOverride[]; }

export const rules: ComparisonPoolRules = {
  eligibilityCurrentSeasonMinutesGreaterThan: 0,
  previousSeasonFallbackRequiresRosterSnapshot: true,
  unavailablePlayersExcluded: false,
  baseOutfieldPlayersPerTeam: 5,
  baseGoalkeepersPerTeam: 1,
  previousSeasonMinutesWeight: 0.5,
  participationScoreFormula: "current-minutes + previous-minutes * 0.5",
  currentSeasonGoalContributionThreshold: 5,
  designationInclusions: ["Designated Player", "U22 Initiative"],
  tieBreakers: ["participation-score-desc", "current-minutes-desc", "previous-minutes-desc", "asa-player-id-asc"],
  manualInclusionsEligibilityBound: true,
  exclusionsTakePrecedence: true,
};

const designationReason: Record<string, SelectionReason> = {
  "Designated Player": "designated-player",
  "U22 Initiative": "u22-initiative",
};

export function designationSelectionReason(value: string | undefined): SelectionReason | undefined {
  return value ? designationReason[value] : undefined;
}

export function eligible(player: StaticPlayer): boolean {
  return (player.currentSeason.minutes ?? 0) > rules.eligibilityCurrentSeasonMinutesGreaterThan ||
    (player.rosterProfile?.listedInRosterSnapshot === true && (player.previousSeason?.minutes ?? 0) > 0);
}

export function participationScore(player: StaticPlayer): number {
  return (player.currentSeason.minutes ?? 0) + (player.previousSeason?.minutes ?? 0) * rules.previousSeasonMinutesWeight;
}

function compareParticipation(a: StaticPlayer, b: StaticPlayer): number {
  return participationScore(b) - participationScore(a) ||
    (b.currentSeason.minutes ?? 0) - (a.currentSeason.minutes ?? 0) ||
    (b.previousSeason?.minutes ?? 0) - (a.previousSeason?.minutes ?? 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length) throw new Error(`${label} contains unsupported keys: ${unknown.sort().join(", ")}`);
}

export function validateOverrides(value: unknown, players: readonly StaticPlayer[]): ComparisonPoolOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pool overrides must be an object");
  const document = value as Record<string, unknown>;
  rejectUnknownKeys(document, ["schemaVersion", "include", "exclude"], "Pool override file");
  if (document.schemaVersion !== 1 || !Array.isArray(document.include) || !Array.isArray(document.exclude)) {
    throw new Error("Pool overrides require schemaVersion 1 plus include/exclude arrays");
  }
  const ids = new Set(players.map((player) => player.id));
  const used = new Set<string>();
  const validateEntries = (entries: unknown[], label: "include" | "exclude"): ComparisonPoolOverride[] => entries.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Invalid pool ${label} override ${index + 1}: must be an object`);
    const entry = raw as Record<string, unknown>;
    rejectUnknownKeys(entry, ["playerId", "reason", "sourceNote"], `Pool ${label} override ${index + 1}`);
    if (typeof entry.playerId !== "string" || !ids.has(entry.playerId) || used.has(entry.playerId)) {
      throw new Error(`Invalid, unknown, duplicate, or conflicting pool override: ${String(entry.playerId ?? "unknown")}`);
    }
    if (typeof entry.reason !== "string" || !entry.reason.trim() || typeof entry.sourceNote !== "string" || !entry.sourceNote.trim()) {
      throw new Error(`Invalid explanation for pool override: ${entry.playerId}`);
    }
    used.add(entry.playerId);
    return { playerId: entry.playerId, reason: entry.reason.trim(), sourceNote: entry.sourceNote.trim() };
  });
  return {
    schemaVersion: 1,
    include: validateEntries(document.include, "include"),
    exclude: validateEntries(document.exclude, "exclude"),
  };
}

function overrideProvenance(overrides: ComparisonPoolOverrides): ComparisonPoolOverrideProvenance {
  const canonicalOverrides = {
    schemaVersion: overrides.schemaVersion,
    include: [...overrides.include].sort((a, b) => a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0),
    exclude: [...overrides.exclude].sort((a, b) => a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0),
  };
  return {
    schemaVersion: 1,
    includeCount: overrides.include.length,
    excludeCount: overrides.exclude.length,
    contentSha256: sha256Canonical(canonicalOverrides),
  };
}

function countBy<T extends string>(values: readonly T[], all: readonly T[]): Record<T, number> {
  return Object.fromEntries(all.map((key) => [key, values.filter((value) => value === key).length])) as Record<T, number>;
}

function poolAudit(source: readonly StaticPlayer[], players: readonly ComparisonPoolPlayer[]): ComparisonPoolAudit {
  const teamCounts = [...players.reduce((counts, player) => counts.set(player.teamId, (counts.get(player.teamId) ?? 0) + 1), new Map<string, number>()).values()].sort((a, b) => a - b);
  const middle = Math.floor(teamCounts.length / 2);
  const median = teamCounts.length % 2 ? teamCounts[middle] : (teamCounts[middle - 1] + teamCounts[middle]) / 2;
  return {
    eligiblePlayerCount: source.filter(eligible).length,
    finalPoolSize: players.length,
    selectionReasonCounts: countBy(players.flatMap((player) => player.selectionReasons), SELECTION_REASONS),
    positionDistribution: countBy(players.map((player) => player.positionGroup), ["GK", "DEF", "MID", "FWD"] as const),
    teamRepresentation: {
      teamCount: teamCounts.length,
      minimum: Math.min(...teamCounts),
      maximum: Math.max(...teamCounts),
      median,
    },
  };
}

/** Participation is an involvement filter, never a trade-value score. */
export function selectComparisonPool(
  dataset: PlayerDataset,
  overridesInput: ComparisonPoolOverrides,
  generatedAt = new Date().toISOString(),
): ComparisonPool {
  const source = structuredClone(dataset.players);
  const overrides = validateOverrides(overridesInput, source);
  const selected = new Map<string, Set<SelectionReason>>();
  const add = (player: StaticPlayer, reason: SelectionReason) => {
    // Version 1 policy: even a documented manual inclusion remains eligibility-bound.
    if (eligible(player)) (selected.get(player.id) ?? selected.set(player.id, new Set()).get(player.id)!).add(reason);
  };
  for (const team of [...new Set(source.map((player) => player.teamId))].sort()) {
    const candidates = source.filter((player) => player.teamId === team && eligible(player)).sort(compareParticipation);
    candidates.filter((player) => player.positionGroup !== "GK").slice(0, rules.baseOutfieldPlayersPerTeam).forEach((player) => add(player, "team-outfield-selection"));
    candidates.filter((player) => player.positionGroup === "GK").slice(0, rules.baseGoalkeepersPerTeam).forEach((player) => add(player, "team-goalkeeper-selection"));
  }
  for (const player of source) {
    if (!eligible(player)) continue;
    const designation = designationSelectionReason(player.rosterProfile?.rosterDesignation);
    if (designation) add(player, designation);
    if ((player.currentSeason.goals ?? 0) + (player.currentSeason.assists ?? 0) >= rules.currentSeasonGoalContributionThreshold) {
      add(player, "current-season-five-goal-contributions");
    }
  }
  for (const entry of overrides.include) add(source.find((player) => player.id === entry.playerId)!, "manual-inclusion");
  for (const entry of overrides.exclude) selected.delete(entry.playerId);
  const players = stablePlayerSort(source.filter((player) => selected.has(player.id)).map((player) => ({
    ...player,
    selectionReasons: SELECTION_REASONS.filter((reason) => selected.get(player.id)!.has(reason)),
  })));
  const pool: ComparisonPool = {
    schemaVersion: 3,
    humanReadableLabel: `Comparison pool | ${dataset.humanReadableLabel}`,
    dataVersion: "",
    sourceDataVersion: dataset.dataVersion,
    season: dataset.season,
    previousSeason: dataset.previousSeason,
    generatedAt,
    provenance: {
      sourcePlayerDataVersion: dataset.dataVersion,
      sourcePlayerGeneratedAt: dataset.generatedAt,
      statisticsThrough: dataset.statisticsThrough,
      rosterSnapshotDate: dataset.rosterSnapshot.snapshotDate,
      rosterReleaseDate: dataset.rosterSnapshot.fileDate,
      salaryReleaseDate: dataset.salary.selectedRelease,
      salaryCurrency: dataset.salary.currency,
    },
    selectionRules: structuredClone(rules),
    overrides: overrideProvenance(overrides),
    audit: poolAudit(source, players),
    players,
  };
  pool.dataVersion = computePoolDataVersion(pool);
  return pool;
}

function exactObject(value: unknown, allowed: readonly string[], label: string, errors: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  const unknown = Object.keys(value as Record<string, unknown>).filter((key) => !allowed.includes(key));
  if (unknown.length) errors.push(`${label} contains unsupported keys: ${unknown.sort().join(", ")}`);
  return true;
}

export function validateComparisonPool(pool: ComparisonPool, dataset: PlayerDataset, overridesInput: ComparisonPoolOverrides): string[] {
  const errors = validateDataset(dataset).map((error) => `source player artifact: ${error}`);
  exactObject(pool, ["schemaVersion", "humanReadableLabel", "dataVersion", "sourceDataVersion", "season", "previousSeason", "generatedAt", "provenance", "selectionRules", "overrides", "audit", "players"], "pool", errors);
  if (pool.schemaVersion !== 3) errors.push("pool schemaVersion must be 3");
  if (!Array.isArray(pool.players) || pool.players.length < MIN_COMPARISON_POOL_SIZE) {
    errors.push(`pool size must be at least ${MIN_COMPARISON_POOL_SIZE} players`);
  }
  if (!isSemanticVersion(pool.dataVersion)) errors.push("pool dataVersion must be a SHA-256 semantic version");
  const generated = typeof pool.generatedAt === "string" ? new Date(pool.generatedAt) : null;
  if (!generated || !Number.isFinite(generated.valueOf()) || generated.toISOString() !== pool.generatedAt) errors.push("pool generatedAt must be a canonical ISO timestamp");
  if (pool.sourceDataVersion !== dataset.dataVersion || pool.provenance?.sourcePlayerDataVersion !== dataset.dataVersion) errors.push("pool source version does not match player artifact");
  if (pool.season !== dataset.season || pool.previousSeason !== dataset.previousSeason) errors.push("pool seasons do not match player artifact");
  let overrides: ComparisonPoolOverrides | undefined;
  try { overrides = validateOverrides(overridesInput, dataset.players); }
  catch (error) { errors.push((error as Error).message); }
  if (!overrides) return errors;
  try {
    const expected = selectComparisonPool(dataset, overrides, pool.generatedAt);
    const comparisons: Array<[string, unknown, unknown]> = [
      ["human-readable label", pool.humanReadableLabel, expected.humanReadableLabel],
      ["provenance", pool.provenance, expected.provenance],
      ["selection rules", pool.selectionRules, expected.selectionRules],
      ["override provenance", pool.overrides, expected.overrides],
      ["audit diagnostics", pool.audit, expected.audit],
      ["selected players, fields, membership, or reasons", pool.players, expected.players],
    ];
    for (const [label, actual, wanted] of comparisons) {
      if (canonicalStringify(actual) !== canonicalStringify(wanted)) errors.push(`pool ${label} does not match recomputed source data`);
    }
    const recomputedVersion = computePoolDataVersion(pool);
    if (pool.dataVersion !== recomputedVersion) errors.push(`pool semantic dataVersion mismatch: expected ${recomputedVersion}`);
    if (pool.dataVersion !== expected.dataVersion) errors.push("pool dataVersion does not match recomputed selection");
  } catch (error) {
    errors.push(`pool recomputation failed: ${(error as Error).message}`);
  }
  return [...new Set(errors)];
}
