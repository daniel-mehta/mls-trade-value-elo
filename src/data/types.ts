export type PositionGroup = "GK" | "DEF" | "MID" | "FWD";

export interface PlayerSeasonStats {
  season: number;
  appearances?: number;
  starts?: number;
  minutes?: number;
  goals?: number;
  assists?: number;
  xGoals?: number;
  xAssists?: number;
  keyPasses?: number;
  goalsAdded?: number;
}

export const GOALKEEPER_GOALS_ADDED_ACTIONS = [
  "claiming",
  "fielding",
  "handling",
  "passing",
  "shotstopping",
  "sweeping",
] as const;
export type GoalkeeperGoalsAddedAction = typeof GOALKEEPER_GOALS_ADDED_ACTIONS[number];

/** Direct ASA goalkeeper totals. General player minutes remain authoritative. */
export interface GoalkeeperSeasonMetrics {
  season: number;
  shotsFaced?: number;
  goalsConceded?: number;
  saves?: number;
  xGoalsFaced?: number;
  goalsMinusXGoalsFaced?: number;
  goalsAdded?: number;
  goalsAddedByAction?: Partial<Record<GoalkeeperGoalsAddedAction, number>>;
}

export interface GoalkeeperMetrics {
  currentSeason?: GoalkeeperSeasonMetrics;
  previousSeason?: GoalkeeperSeasonMetrics;
}

export interface StaticPlayer {
  id: string;
  name: string;
  teamId: string;
  teamName: string;
  teamAbbreviation: string;
  positionGroup: PositionGroup;
  position?: string;
  age?: number;
  baseSalary?: number;
  guaranteedCompensation?: number;
  currentSeason: PlayerSeasonStats;
  previousSeason?: PlayerSeasonStats;
  goalkeeperMetrics?: GoalkeeperMetrics;
  rosterProfile?: PlayerRosterProfile;
}

/** MLS roster profiles are historical compliance snapshots, never live rosters. */
export interface PlayerRosterProfile {
  snapshotDate: string;
  listedInRosterSnapshot: boolean;
  activeAtRosterSnapshot: boolean;
  snapshotTeamId: string;
  snapshotTeamName: string;
  rosterSlot?: string;
  rosterDesignation?: string;
  currentStatus?: string;
  contractThrough?: string;
  optionYears?: string[];
  permanentTransferOption?: boolean;
  internationalSlot?: boolean;
  convertibleWithTam?: boolean;
  unavailable?: boolean;
  canadianInternationalSlotExemption?: boolean;
  rosterConstructionModel?: string;
}

export type SourceSnapshotStatus = "available" | "optional-unavailable";
export type SourceSnapshotType = "api" | "repository";

/** A checksum identifies canonical parsed source content, not byte formatting. */
export interface SourceSnapshot {
  sourceId: string;
  sourceType: SourceSnapshotType;
  endpointOrRepository: string;
  season: number | null;
  retrievedAt: string | null;
  contentSha256: string | null;
  status: SourceSnapshotStatus;
  rowCount: number;
}

export interface SalaryProvenance {
  status: SourceSnapshotStatus;
  selectedSeason: number | null;
  selectedRelease: string | null;
  currency: "USD";
  selectedRecordCount: number;
}

export interface RosterSnapshotProvenance {
  sourceId: string;
  repository: string;
  releaseFilename: string;
  fileDate: string;
  snapshotDate: string;
  contentSha256: string;
  isLive: false;
  teamCount: number;
  rawRecordCount: number;
  matchedRecords: number;
  unmatchedRecords: number;
  duplicateRecordsIgnored: number;
  missingPlayerIds: number;
}

export interface OverrideProvenance {
  schemaVersion: 1;
  appliedCount: number;
  contentSha256: string;
}

export interface PlayerNormalizationRules {
  rulesVersion: "player-normalization-v2";
  displayedTeamPolicy: "current-minutes-then-previous-minutes-then-team-id";
  playerIdentityKey: "asa-player-id";
  teamIdentityKey: "asa-team-id";
  salarySelectionPolicy: "latest-valid-player-release-no-sum";
  unknownPositionPolicy: "exclude-and-report";
  goalkeeperAggregationPolicy: "additive-source-totals-by-player-season";
}

export interface GoalkeeperSourceAudit {
  rawRowCount: number;
  matchedGoalkeeperIds: number;
  unmatchedPlayerIds: number;
  duplicateRows: number;
  nonGoalkeeperJoinConflicts: number;
  malformedRows: 0;
}

export interface GoalkeeperAudit {
  sources: Record<string, GoalkeeperSourceAudit>;
  goalkeepersWithCurrentSeasonMetrics: number;
  goalkeepersWithPreviousSeasonMetrics: number;
  goalkeepersWithPlayingTimeButNoMetrics: number;
}

export interface PlayerDatasetAudit {
  sourceRowCounts: Record<string, number>;
  playerCount: number;
  teamCount: number;
  positionDistribution: Record<PositionGroup, number>;
  currentSeasonMultiTeamCount: number;
  crossSeasonMultiTeamCount: number;
  unmatchedSalaryCount: number;
  unknownPositionExclusionCount: number;
  rosterMatchedCount: number;
  rosterUnmatchedCount: number;
  ignoredRosterDuplicateCount: number;
  statisticalSnapshotTeamDisagreementCount: number;
  appliedRosterOverrideCount: number;
  goalkeeper: GoalkeeperAudit;
}

export interface PlayerDataset {
  schemaVersion: 4;
  humanReadableLabel: string;
  dataVersion: string;
  competition: "MLS";
  season: number;
  previousSeason: number;
  generatedAt: string;
  statisticsThrough: string | null;
  sources: SourceSnapshot[];
  salary: SalaryProvenance;
  rosterSnapshot: RosterSnapshotProvenance;
  overrides: OverrideProvenance;
  normalization: PlayerNormalizationRules;
  audit: PlayerDatasetAudit;
  players: StaticPlayer[];
}

function configuredPublicationSeasons(): { current: number; previous: number } {
  const currentValue = process.env.MLS_CURRENT_SEASON;
  const previousValue = process.env.MLS_PREVIOUS_SEASON;
  if ((currentValue === undefined) !== (previousValue === undefined)) {
    throw new Error("MLS_CURRENT_SEASON and MLS_PREVIOUS_SEASON must be configured together");
  }
  const current = Number(currentValue ?? 2026);
  const previous = Number(previousValue ?? 2025);
  if (!Number.isInteger(current) || !Number.isInteger(previous) || previous >= current) {
    throw new Error(`Invalid MLS publication season pair: ${String(currentValue ?? 2026)}/${String(previousValue ?? 2025)}`);
  }
  return { current, previous };
}

const CONFIGURED_PUBLICATION_SEASONS = configuredPublicationSeasons();
export const CURRENT_SEASON = CONFIGURED_PUBLICATION_SEASONS.current;
export const PREVIOUS_SEASON = CONFIGURED_PUBLICATION_SEASONS.previous;
export const COMPETITION = "mls" as const;

export const PLAYER_NORMALIZATION_RULES: PlayerNormalizationRules = {
  rulesVersion: "player-normalization-v2",
  displayedTeamPolicy: "current-minutes-then-previous-minutes-then-team-id",
  playerIdentityKey: "asa-player-id",
  teamIdentityKey: "asa-team-id",
  salarySelectionPolicy: "latest-valid-player-release-no-sum",
  unknownPositionPolicy: "exclude-and-report",
  goalkeeperAggregationPolicy: "additive-source-totals-by-player-season",
};

export function playerHumanReadableLabel(season: number, previousSeason: number, rosterSnapshotDate: string): string {
  return `MLS ${season}/${previousSeason} | roster snapshot ${rosterSnapshotDate}`;
}
