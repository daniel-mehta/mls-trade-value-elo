import { stablePlayerSort } from "./aggregation.js";
import { canonicalStringify, computePlayerDataVersion, isSemanticVersion, isSha256 } from "./semanticVersion.js";
import {
  GOALKEEPER_GOALS_ADDED_ACTIONS,
  PLAYER_NORMALIZATION_RULES,
  playerHumanReadableLabel,
  type GoalkeeperSeasonMetrics,
  type PlayerDataset,
  type PlayerRosterProfile,
  type PlayerSeasonStats,
  type PositionGroup,
  type StaticPlayer,
} from "./types.js";

const GROUPS: PositionGroup[] = ["GK", "DEF", "MID", "FWD"];
const DATASET_KEYS = ["schemaVersion", "humanReadableLabel", "dataVersion", "competition", "season", "previousSeason", "generatedAt", "statisticsThrough", "sources", "salary", "rosterSnapshot", "overrides", "normalization", "audit", "players"];
const SOURCE_KEYS = ["sourceId", "sourceType", "endpointOrRepository", "season", "retrievedAt", "contentSha256", "status", "rowCount"];
const PLAYER_KEYS = ["id", "name", "teamId", "teamName", "teamAbbreviation", "positionGroup", "position", "age", "baseSalary", "guaranteedCompensation", "currentSeason", "previousSeason", "goalkeeperMetrics", "rosterProfile"];
const STATS_KEYS = ["season", "appearances", "starts", "minutes", "goals", "assists", "xGoals", "xAssists", "keyPasses", "goalsAdded"];
const GOALKEEPER_CONTAINER_KEYS = ["currentSeason", "previousSeason"];
const GOALKEEPER_METRIC_KEYS = ["season", "shotsFaced", "goalsConceded", "saves", "xGoalsFaced", "goalsMinusXGoalsFaced", "goalsAdded", "goalsAddedByAction"];
const ROSTER_KEYS = ["snapshotDate", "listedInRosterSnapshot", "activeAtRosterSnapshot", "snapshotTeamId", "snapshotTeamName", "rosterSlot", "rosterDesignation", "currentStatus", "contractThrough", "optionYears", "permanentTransferOption", "internationalSlot", "convertibleWithTam", "unavailable", "canadianInternationalSlotExemption", "rosterConstructionModel"];
const NON_NEGATIVE_STATS: Array<Exclude<keyof PlayerSeasonStats, "season" | "goalsAdded">> = ["appearances", "starts", "minutes", "goals", "assists", "xGoals", "xAssists", "keyPasses"];

function exactKeys(value: unknown, allowed: readonly string[], label: string, errors: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  const unknown = Object.keys(value as Record<string, unknown>).filter((key) => !allowed.includes(key));
  if (unknown.length) errors.push(`${label} contains unsupported keys: ${unknown.sort().join(", ")}`);
  return true;
}

function realDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function containsNull(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.some(containsNull);
  return Boolean(value && typeof value === "object" && Object.values(value as Record<string, unknown>).some(containsNull));
}

function validateStats(stats: PlayerSeasonStats, expectedSeason: number, label: string, errors: string[]): void {
  if (!exactKeys(stats, STATS_KEYS, label, errors)) return;
  if (stats.season !== expectedSeason) errors.push(`${label}: season must be ${expectedSeason}`);
  for (const field of NON_NEGATIVE_STATS) {
    const value = stats[field];
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) errors.push(`${label}: invalid ${field}`);
  }
  for (const field of ["goalsAdded"] as const) {
    const value = stats[field];
    if (value !== undefined && !Number.isFinite(value)) errors.push(`${label}: invalid ${field}`);
  }
}

function validateGoalkeeperSeason(
  metrics: GoalkeeperSeasonMetrics,
  expectedSeason: number,
  label: string,
  errors: string[],
): void {
  if (!exactKeys(metrics, GOALKEEPER_METRIC_KEYS, label, errors)) return;
  if (metrics.season !== expectedSeason) errors.push(`${label}: season must be ${expectedSeason}`);
  for (const field of ["shotsFaced", "goalsConceded", "saves", "xGoalsFaced"] as const) {
    const value = metrics[field];
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) errors.push(`${label}: invalid ${field}`);
  }
  for (const field of ["goalsMinusXGoalsFaced", "goalsAdded"] as const) {
    const value = metrics[field];
    if (value !== undefined && !Number.isFinite(value)) errors.push(`${label}: invalid ${field}`);
  }
  if (metrics.goalsAddedByAction !== undefined) {
    if (!exactKeys(metrics.goalsAddedByAction, GOALKEEPER_GOALS_ADDED_ACTIONS, `${label} goalsAddedByAction`, errors)) return;
    if (!Object.keys(metrics.goalsAddedByAction).length) errors.push(`${label}: goalsAddedByAction must not be empty`);
    for (const [action, value] of Object.entries(metrics.goalsAddedByAction)) {
      if (!Number.isFinite(value)) errors.push(`${label}: invalid Goals Added action ${action}`);
    }
    const total = GOALKEEPER_GOALS_ADDED_ACTIONS
      .map((action) => metrics.goalsAddedByAction?.[action])
      .filter((value): value is number => value !== undefined)
      .reduce((sum, value) => sum + value, 0);
    if (metrics.goalsAdded === undefined || Math.abs(metrics.goalsAdded - total) > 1e-9) {
      errors.push(`${label}: goalsAdded does not equal the documented action-component total`);
    }
  } else if (metrics.goalsAdded !== undefined) {
    errors.push(`${label}: goalsAdded requires goalsAddedByAction`);
  }
  if (metrics.goalsConceded !== undefined && metrics.xGoalsFaced !== undefined && metrics.goalsMinusXGoalsFaced !== undefined &&
      Math.abs(metrics.goalsConceded - metrics.xGoalsFaced - metrics.goalsMinusXGoalsFaced) > 0.001) {
    errors.push(`${label}: goalsMinusXGoalsFaced is inconsistent with goals conceded and xGoals faced`);
  }
  const values = [
    metrics.shotsFaced,
    metrics.goalsConceded,
    metrics.saves,
    metrics.xGoalsFaced,
    metrics.goalsMinusXGoalsFaced,
    metrics.goalsAdded,
    ...Object.values(metrics.goalsAddedByAction ?? {}),
  ].filter((value): value is number => value !== undefined);
  if (!values.length) errors.push(`${label}: goalkeeper metric object is empty`);
  else if (values.every((value) => value === 0)) errors.push(`${label}: zero-filled goalkeeper metric object is not allowed`);
}

function validateRoster(profile: PlayerRosterProfile, snapshotDate: string, label: string, errors: string[]): void {
  if (!exactKeys(profile, ROSTER_KEYS, label, errors)) return;
  if (profile.snapshotDate !== snapshotDate) errors.push(`${label}: snapshotDate does not match artifact roster snapshot`);
  if (profile.listedInRosterSnapshot !== true) errors.push(`${label}: listedInRosterSnapshot must be true`);
  if (typeof profile.activeAtRosterSnapshot !== "boolean") errors.push(`${label}: activeAtRosterSnapshot must be boolean`);
  if (!nonEmpty(profile.snapshotTeamId) || !nonEmpty(profile.snapshotTeamName)) errors.push(`${label}: snapshot team identity is incomplete`);
  for (const field of ["permanentTransferOption", "internationalSlot", "convertibleWithTam", "unavailable", "canadianInternationalSlotExemption"] as const) {
    if (profile[field] !== undefined && typeof profile[field] !== "boolean") errors.push(`${label}: ${field} must be boolean when present`);
  }
  if (profile.optionYears !== undefined) {
    if (!Array.isArray(profile.optionYears) || !profile.optionYears.length || profile.optionYears.some((year) => !/^\d{4}$/.test(year)) || new Set(profile.optionYears).size !== profile.optionYears.length) {
      errors.push(`${label}: invalid optionYears`);
    }
  }
}

function validatePlayer(
  player: StaticPlayer,
  dataset: PlayerDataset,
  ids: Set<string>,
  teamTuples: Map<string, string>,
  errors: string[],
): void {
  const label = `player ${String(player?.id ?? "unknown")}`;
  if (!exactKeys(player, PLAYER_KEYS, label, errors)) return;
  if (!nonEmpty(player.id) || ids.has(player.id)) errors.push(`${label}: duplicate or empty player ID`);
  ids.add(player.id);
  for (const field of ["name", "teamId", "teamName", "teamAbbreviation"] as const) {
    if (!nonEmpty(player[field])) errors.push(`${label}: missing ${field}`);
  }
  if (!GROUPS.includes(player.positionGroup)) errors.push(`${label}: invalid position group`);
  const teamTuple = `${player.teamName}\u0000${player.teamAbbreviation}`;
  const priorTuple = teamTuples.get(player.teamId);
  if (priorTuple !== undefined && priorTuple !== teamTuple) errors.push(`${label}: team ID maps to inconsistent name or abbreviation`);
  teamTuples.set(player.teamId, teamTuple);
  if (player.age !== undefined && (!Number.isFinite(player.age) || player.age < 0)) errors.push(`${label}: invalid age`);
  for (const field of ["baseSalary", "guaranteedCompensation"] as const) {
    if (player[field] !== undefined && (!Number.isFinite(player[field]) || player[field]! < 0)) errors.push(`${label}: invalid ${field}`);
  }
  validateStats(player.currentSeason, dataset.season, `${label} currentSeason`, errors);
  if (player.previousSeason) validateStats(player.previousSeason, dataset.previousSeason, `${label} previousSeason`, errors);
  if (player.goalkeeperMetrics) {
    if (player.positionGroup !== "GK") errors.push(`${label}: goalkeeperMetrics may only be attached to goalkeepers`);
    if (exactKeys(player.goalkeeperMetrics, GOALKEEPER_CONTAINER_KEYS, `${label} goalkeeperMetrics`, errors)) {
      if (!player.goalkeeperMetrics.currentSeason && !player.goalkeeperMetrics.previousSeason) errors.push(`${label}: goalkeeperMetrics must not be empty`);
      if (player.goalkeeperMetrics.currentSeason) validateGoalkeeperSeason(player.goalkeeperMetrics.currentSeason as GoalkeeperSeasonMetrics, dataset.season, `${label} goalkeeperMetrics currentSeason`, errors);
      if (player.goalkeeperMetrics.previousSeason) validateGoalkeeperSeason(player.goalkeeperMetrics.previousSeason as GoalkeeperSeasonMetrics, dataset.previousSeason, `${label} goalkeeperMetrics previousSeason`, errors);
    }
  }
  if (player.rosterProfile) validateRoster(player.rosterProfile, dataset.rosterSnapshot.snapshotDate, `${label} rosterProfile`, errors);
  if (containsNull(player)) errors.push(`${label}: null is not allowed; omit optional player fields`);
}

function requiredSourceIds(dataset: PlayerDataset): string[] {
  return [
    "asa-players", "asa-teams",
    `asa-xgoals-${dataset.season}`, `asa-xpass-${dataset.season}`, `asa-goals-added-${dataset.season}`, `asa-salaries-${dataset.season}`,
    `asa-goalkeeper-xgoals-${dataset.season}`, `asa-goalkeeper-goals-added-${dataset.season}`,
    `asa-xgoals-${dataset.previousSeason}`, `asa-xpass-${dataset.previousSeason}`, `asa-goals-added-${dataset.previousSeason}`, `asa-salaries-${dataset.previousSeason}`,
    `asa-goalkeeper-xgoals-${dataset.previousSeason}`, `asa-goalkeeper-goals-added-${dataset.previousSeason}`,
  ];
}

export function validateDataset(dataset: PlayerDataset): string[] {
  const errors: string[] = [];
  if (!exactKeys(dataset, DATASET_KEYS, "dataset", errors)) return errors;
  if (dataset.schemaVersion !== 4) errors.push("schemaVersion must be 4");
  if (!isSemanticVersion(dataset.dataVersion)) errors.push("dataVersion must be a SHA-256 semantic version");
  if (dataset.competition !== "MLS") errors.push("competition must be MLS");
  if (!Number.isInteger(dataset.season) || dataset.season < 1996) errors.push("invalid dataset season");
  if (!Number.isInteger(dataset.previousSeason) || dataset.previousSeason < 1996 || dataset.previousSeason >= dataset.season) {
    errors.push("previousSeason must be an earlier valid season");
  }
  if (!isoTimestamp(dataset.generatedAt)) errors.push("generatedAt must be a canonical ISO timestamp");
  if (dataset.statisticsThrough !== null && !realDate(dataset.statisticsThrough)) errors.push("statisticsThrough must be a real date or null");

  if (!Array.isArray(dataset.sources) || !dataset.sources.length) {
    errors.push("sources must be non-empty");
  } else {
    const sourceIds = new Set<string>();
    for (const [index, source] of dataset.sources.entries()) {
      const label = `source ${index + 1}`;
      if (!exactKeys(source, SOURCE_KEYS, label, errors)) continue;
      if (!nonEmpty(source.sourceId) || sourceIds.has(source.sourceId)) errors.push(`${label}: duplicate or empty sourceId`);
      sourceIds.add(source.sourceId);
      if (source.sourceType !== "api" && source.sourceType !== "repository") errors.push(`${label}: invalid sourceType`);
      if (!nonEmpty(source.endpointOrRepository)) errors.push(`${label}: endpointOrRepository is required`);
      if (source.season !== null && !Number.isInteger(source.season)) errors.push(`${label}: invalid season`);
      if (source.retrievedAt !== null && !isoTimestamp(source.retrievedAt)) errors.push(`${label}: invalid retrievedAt`);
      if (!nonNegativeInteger(source.rowCount)) errors.push(`${label}: invalid rowCount`);
      if (source.status === "available") {
        if (!isSha256(source.contentSha256)) errors.push(`${label}: available source requires a SHA-256 checksum`);
      } else if (source.status === "optional-unavailable") {
        if (!source.sourceId.startsWith("asa-salaries-") || source.contentSha256 !== null || source.rowCount !== 0) errors.push(`${label}: invalid optional-unavailable source`);
      } else {
        errors.push(`${label}: invalid status`);
      }
    }
    for (const sourceId of requiredSourceIds(dataset)) {
      if (!sourceIds.has(sourceId)) errors.push(`missing required source snapshot: ${sourceId}`);
      const source = dataset.sources.find((entry) => entry.sourceId === sourceId);
      if (source && !sourceId.startsWith("asa-salaries-") && source.rowCount === 0) errors.push(`required source contains no rows: ${sourceId}`);
    }
    for (const season of [dataset.season, dataset.previousSeason]) {
      for (const family of ["xgoals", "goals-added"] as const) {
        const sourceId = `asa-goalkeeper-${family}-${season}`;
        const source = dataset.sources.find((entry) => entry.sourceId === sourceId);
        const endpoint = family === "xgoals" ? "/goalkeepers/xgoals" : "/goalkeepers/goals-added";
        if (!source || source.status !== "available") errors.push(`required goalkeeper source must be available: ${sourceId}`);
        else {
          if (source.season !== season || !source.endpointOrRepository.includes(endpoint)) errors.push(`goalkeeper source endpoint or season is invalid: ${sourceId}`);
          if (source.rowCount === 0) errors.push(`required goalkeeper source contains no rows: ${sourceId}`);
        }
      }
    }
  }

  if (exactKeys(dataset.salary, ["status", "selectedSeason", "selectedRelease", "currency", "selectedRecordCount"], "salary provenance", errors)) {
    if (dataset.salary.status !== "available" && dataset.salary.status !== "optional-unavailable") errors.push("salary provenance has invalid status");
    if (dataset.salary.currency !== "USD") errors.push("salary currency must be USD");
    if (!nonNegativeInteger(dataset.salary.selectedRecordCount)) errors.push("salary selectedRecordCount is invalid");
    if (dataset.salary.selectedRecordCount > 0) {
      if (![dataset.season, dataset.previousSeason].includes(dataset.salary.selectedSeason ?? -1) || !realDate(dataset.salary.selectedRelease)) errors.push("selected salary season or release is invalid");
      const source = dataset.sources.find((entry) => entry.sourceId === `asa-salaries-${dataset.salary.selectedSeason}`);
      if (!source || source.status !== "available") errors.push("selected salary source is unavailable");
    } else if (dataset.salary.selectedSeason !== null || dataset.salary.selectedRelease !== null) {
      errors.push("empty salary selection must have null season and release");
    }
  }

  const roster = dataset.rosterSnapshot;
  if (exactKeys(roster, ["sourceId", "repository", "releaseFilename", "fileDate", "snapshotDate", "contentSha256", "isLive", "teamCount", "rawRecordCount", "matchedRecords", "unmatchedRecords", "duplicateRecordsIgnored", "missingPlayerIds"], "roster provenance", errors)) {
    if (!nonEmpty(roster.sourceId) || !nonEmpty(roster.repository)) errors.push("roster source identity is required");
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(roster.releaseFilename) || roster.releaseFilename.slice(0, 10) !== roster.fileDate) errors.push("roster filename and fileDate are inconsistent");
    if (!realDate(roster.fileDate) || !realDate(roster.snapshotDate) || roster.fileDate < roster.snapshotDate) errors.push("roster dates are invalid or inconsistent");
    if (!isSha256(roster.contentSha256)) errors.push("roster contentSha256 is invalid");
    if (roster.isLive !== false) errors.push("roster snapshot must not be live");
    for (const field of ["teamCount", "rawRecordCount", "matchedRecords", "unmatchedRecords", "duplicateRecordsIgnored", "missingPlayerIds"] as const) {
      if (!nonNegativeInteger(roster[field])) errors.push(`roster ${field} is invalid`);
    }
    if (roster.matchedRecords + roster.unmatchedRecords + roster.duplicateRecordsIgnored !== roster.rawRecordCount) errors.push("roster record totals do not reconcile");
    if (roster.missingPlayerIds > roster.unmatchedRecords) errors.push("roster missing IDs exceed unmatched records");
    const rosterSource = dataset.sources.find((source) => source.sourceId === roster.sourceId);
    if (!rosterSource || rosterSource.sourceType !== "repository" || rosterSource.contentSha256 !== roster.contentSha256 || rosterSource.rowCount !== roster.rawRecordCount) errors.push("roster source snapshot does not match roster provenance");
  }

  if (exactKeys(dataset.overrides, ["schemaVersion", "appliedCount", "contentSha256"], "override provenance", errors)) {
    if (dataset.overrides.schemaVersion !== 1 || !nonNegativeInteger(dataset.overrides.appliedCount) || !isSha256(dataset.overrides.contentSha256)) errors.push("override provenance is invalid");
  }
  if (canonicalStringify(dataset.normalization) !== canonicalStringify(PLAYER_NORMALIZATION_RULES)) errors.push("normalization rules do not match the supported policy");
  if (!Array.isArray(dataset.players) || !dataset.players.length) errors.push("players must be non-empty");

  const ids = new Set<string>();
  const teamTuples = new Map<string, string>();
  for (const player of dataset.players ?? []) validatePlayer(player, dataset, ids, teamTuples, errors);
  const sorted = stablePlayerSort(dataset.players ?? []);
  if (sorted.some((player, index) => player.id !== dataset.players[index]?.id)) errors.push("players are not deterministically sorted");

  const audit = dataset.audit;
  if (exactKeys(audit, ["sourceRowCounts", "playerCount", "teamCount", "positionDistribution", "currentSeasonMultiTeamCount", "crossSeasonMultiTeamCount", "unmatchedSalaryCount", "unknownPositionExclusionCount", "rosterMatchedCount", "rosterUnmatchedCount", "ignoredRosterDuplicateCount", "statisticalSnapshotTeamDisagreementCount", "appliedRosterOverrideCount", "goalkeeper"], "dataset audit", errors)) {
    const positionDistribution = Object.fromEntries(GROUPS.map((group) => [group, dataset.players.filter((player) => player.positionGroup === group).length]));
    const expectedSourceRows = Object.fromEntries(dataset.sources.map((source) => [source.sourceId, source.rowCount]));
    const matched = dataset.players.filter((player) => player.rosterProfile).length;
    const disagreements = dataset.players.filter((player) => player.rosterProfile && player.teamId !== player.rosterProfile.snapshotTeamId).length;
    if (canonicalStringify(audit.sourceRowCounts) !== canonicalStringify(expectedSourceRows)) errors.push("audit source row counts do not match provenance");
    if (audit.playerCount !== dataset.players.length) errors.push("audit player count is inconsistent");
    if (audit.teamCount !== teamTuples.size || audit.teamCount !== roster.teamCount) errors.push("audit team count is inconsistent");
    if (canonicalStringify(audit.positionDistribution) !== canonicalStringify(positionDistribution)) errors.push("audit position distribution is inconsistent");
    if (audit.rosterMatchedCount !== matched || audit.rosterMatchedCount !== roster.matchedRecords) errors.push("audit roster matched count is inconsistent");
    if (audit.rosterUnmatchedCount !== roster.unmatchedRecords || audit.ignoredRosterDuplicateCount !== roster.duplicateRecordsIgnored) errors.push("audit roster accounting is inconsistent");
    if (audit.statisticalSnapshotTeamDisagreementCount !== disagreements) errors.push("audit team disagreement count is inconsistent");
    if (audit.appliedRosterOverrideCount !== dataset.overrides.appliedCount) errors.push("audit override count is inconsistent");
    for (const field of ["currentSeasonMultiTeamCount", "crossSeasonMultiTeamCount", "unmatchedSalaryCount", "unknownPositionExclusionCount"] as const) {
      if (!nonNegativeInteger(audit[field])) errors.push(`audit ${field} is invalid`);
    }
    const goalkeeper = audit.goalkeeper;
    if (exactKeys(goalkeeper, ["sources", "goalkeepersWithCurrentSeasonMetrics", "goalkeepersWithPreviousSeasonMetrics", "goalkeepersWithPlayingTimeButNoMetrics"], "goalkeeper audit", errors)) {
      const expectedSourceIds = requiredSourceIds(dataset).filter((sourceId) => sourceId.startsWith("asa-goalkeeper-"));
      exactKeys(goalkeeper.sources, expectedSourceIds, "goalkeeper source audits", errors);
      for (const sourceId of expectedSourceIds) {
        if (!Object.prototype.hasOwnProperty.call(goalkeeper.sources, sourceId)) errors.push(`missing goalkeeper source audit: ${sourceId}`);
      }
      for (const sourceId of expectedSourceIds) {
        const sourceAudit = goalkeeper.sources[sourceId];
        if (!sourceAudit || !exactKeys(sourceAudit, ["rawRowCount", "matchedGoalkeeperIds", "unmatchedPlayerIds", "duplicateRows", "nonGoalkeeperJoinConflicts", "malformedRows"], `goalkeeper audit ${sourceId}`, errors)) continue;
        for (const field of ["rawRowCount", "matchedGoalkeeperIds", "unmatchedPlayerIds", "duplicateRows", "nonGoalkeeperJoinConflicts", "malformedRows"] as const) {
          if (!nonNegativeInteger(sourceAudit[field])) errors.push(`goalkeeper audit ${sourceId}: invalid ${field}`);
        }
        const source = dataset.sources.find((entry) => entry.sourceId === sourceId);
        if (!source || sourceAudit.rawRowCount !== source.rowCount) errors.push(`goalkeeper audit ${sourceId}: raw row count does not match provenance`);
        if (sourceAudit.malformedRows !== 0) errors.push(`goalkeeper audit ${sourceId}: malformed rows cannot be publication-ready`);
        if (sourceAudit.duplicateRows !== 0) errors.push(`goalkeeper audit ${sourceId}: duplicate player/team/season rows cannot be publication-ready`);
        if (sourceAudit.nonGoalkeeperJoinConflicts !== 0) errors.push(`goalkeeper audit ${sourceId}: non-goalkeeper join conflicts cannot be publication-ready`);
      }
      const goalkeepers = dataset.players.filter((player) => player.positionGroup === "GK");
      const currentCount = goalkeepers.filter((player) => player.goalkeeperMetrics?.currentSeason).length;
      const previousCount = goalkeepers.filter((player) => player.goalkeeperMetrics?.previousSeason).length;
      const playingTimeOnly = goalkeepers.filter((player) => !player.goalkeeperMetrics).length;
      if (goalkeeper.goalkeepersWithCurrentSeasonMetrics !== currentCount) errors.push("goalkeeper current-season coverage audit is inconsistent");
      if (goalkeeper.goalkeepersWithPreviousSeasonMetrics !== previousCount) errors.push("goalkeeper previous-season coverage audit is inconsistent");
      if (goalkeeper.goalkeepersWithPlayingTimeButNoMetrics !== playingTimeOnly) errors.push("goalkeeper playing-time-only audit is inconsistent");
    }
  }

  const expectedLabel = playerHumanReadableLabel(dataset.season, dataset.previousSeason, roster.snapshotDate);
  if (dataset.humanReadableLabel !== expectedLabel) errors.push(`humanReadableLabel must be ${expectedLabel}`);
  try {
    const expectedVersion = computePlayerDataVersion(dataset);
    if (dataset.dataVersion !== expectedVersion) errors.push(`semantic dataVersion mismatch: expected ${expectedVersion}`);
  } catch (error) {
    errors.push(`semantic dataVersion could not be recomputed: ${(error as Error).message}`);
  }
  return [...new Set(errors)];
}

export function assertValidDataset(dataset: PlayerDataset): void {
  const errors = validateDataset(dataset);
  if (errors.length) throw new Error(`Dataset validation failed:\n- ${errors.join("\n- ")}`);
}
