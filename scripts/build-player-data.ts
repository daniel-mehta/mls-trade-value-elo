import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { aggregateSeasonStats, selectDisplayedTeam, stablePlayerSort } from "../src/data/aggregation.js";
import { asaEndpointUrl, fetchAsa, numberField, textField, type AsaDatasetName, type AsaFetchResult, type AsaRow } from "../src/data/asaClient.js";
import { isEligible } from "../src/data/eligibility.js";
import { attachGoalkeeperMetrics, goalkeeperSourceAudit, normalizeGoalkeeperSeason } from "../src/data/goalkeeper.js";
import { normalizePosition } from "../src/data/position.js";
import { ROSTER_REPOSITORY, attachRoster, fetchLatestRoster } from "../src/data/roster.js";
import { applyOverrides, loadOverrides } from "../src/data/rosterOverrides.js";
import { latestSalaryByPlayer, selectSalarySource } from "../src/data/salary.js";
import { canonicalStringify, computePlayerDataVersion, sha256Canonical } from "../src/data/semanticVersion.js";
import { assertUniquePlayerTeamSeasonRows } from "../src/data/sourceIdentity.js";
import {
  COMPETITION,
  CURRENT_SEASON,
  PLAYER_NORMALIZATION_RULES,
  PREVIOUS_SEASON,
  playerHumanReadableLabel,
  type PlayerDataset,
  type PlayerSeasonStats,
  type SourceSnapshot,
  type StaticPlayer,
} from "../src/data/types.js";
import { assertValidDataset } from "../src/data/validation.js";

const forceRefresh = process.argv.includes("--refresh");
const ID = (row: AsaRow) => textField(row, "player_id", "playerId");
const TEAM_ID = (row: AsaRow) => textField(row, "team_id", "teamId");
const NAME = (row: AsaRow) => textField(row, "player_name", "playerName", "name");

interface Team { id: string; name: string; abbreviation: string; }
interface PlayerInfo { name?: string; position?: string; age?: number; }
interface SeasonSources {
  xg: AsaFetchResult;
  xpass: AsaFetchResult;
  gplus: AsaFetchResult;
  goalkeeperXg: AsaFetchResult;
  goalkeeperGplus: AsaFetchResult;
  salaries: AsaFetchResult | null;
}

function statsFromRows(season: number, xg: AsaRow[], xpass: AsaRow[], gplus: AsaRow[]): Map<string, PlayerSeasonStats> {
  const collect = (rows: AsaRow[], convert: (row: AsaRow) => Partial<PlayerSeasonStats>) => {
    const groups = new Map<string, Partial<PlayerSeasonStats>[]>();
    for (const row of rows) {
      const id = ID(row);
      if (id) (groups.get(id) ?? groups.set(id, []).get(id)!).push(convert(row));
    }
    return new Map([...groups].map(([id, values]) => [id, aggregateSeasonStats(season, values)]));
  };
  const xgStats = collect(xg, (row) => ({
    appearances: numberField(row, "appearances", "games_played"),
    starts: numberField(row, "starts"),
    minutes: numberField(row, "minutes_played", "minutes"),
    goals: numberField(row, "goals"),
    assists: numberField(row, "primary_assists", "assists"),
    xGoals: numberField(row, "xgoals", "x_goals"),
    xAssists: numberField(row, "xassists", "x_assists"),
    keyPasses: numberField(row, "key_passes"),
  }));
  const passStats = collect(xpass, (row) => ({
    xAssists: numberField(row, "xassists", "x_assists"),
    keyPasses: numberField(row, "key_passes"),
  }));
  const gplusStats = collect(gplus, (row) => {
    const components = Array.isArray(row.data) ? row.data as AsaRow[] : [];
    const goalsAdded = components.map((component) => numberField(component, "goals_added_raw") ?? 0)
      .sort((a, b) => a - b)
      .reduce((sum, value) => sum + value, 0);
    return { goalsAdded: components.length ? goalsAdded : undefined };
  });
  const ids = new Set([...xgStats.keys(), ...passStats.keys(), ...gplusStats.keys()]);
  return new Map([...ids].map((id) => {
    const shooting = xgStats.get(id) ?? { season };
    const passing = passStats.get(id);
    const added = gplusStats.get(id);
    return [id, {
      ...shooting,
      xAssists: shooting.xAssists ?? passing?.xAssists,
      keyPasses: shooting.keyPasses ?? passing?.keyPasses,
      goalsAdded: added?.goalsAdded,
    }];
  }));
}

function teamMinutes(rows: readonly AsaRow[], playerId: string): Map<string, number> {
  const output = new Map<string, number>();
  for (const row of rows) {
    if (ID(row) !== playerId) continue;
    const teamId = TEAM_ID(row);
    if (!teamId) continue;
    output.set(teamId, Math.max(output.get(teamId) ?? 0, numberField(row, "minutes_played", "minutes") ?? 0));
  }
  return output;
}

function deterministicSourceRow(playerId: string, teamId: string, sourceGroups: readonly AsaRow[][]): AsaRow | undefined {
  for (const rows of sourceGroups) {
    const candidates = rows.filter((row) => ID(row) === playerId && TEAM_ID(row) === teamId)
      .sort((a, b) => canonicalStringify(a) < canonicalStringify(b) ? -1 : canonicalStringify(a) > canonicalStringify(b) ? 1 : 0);
    if (candidates.length) return candidates[0];
  }
  return undefined;
}

function displayedRow(
  playerId: string,
  currentGroups: readonly AsaRow[][],
  previousGroups: readonly AsaRow[][],
): AsaRow | undefined {
  const currentRows = currentGroups.flat();
  const previousRows = previousGroups.flat();
  const current = teamMinutes(currentRows, playerId);
  const previous = teamMinutes(previousRows, playerId);
  const candidateIds = current.size ? [...current.keys()] : [...previous.keys()];
  const selected = selectDisplayedTeam(candidateIds.map((teamId) => ({
    teamId,
    currentSeasonMinutes: current.get(teamId) ?? 0,
    previousSeasonMinutes: previous.get(teamId) ?? 0,
  })));
  if (!selected) return undefined;
  return deterministicSourceRow(playerId, selected.teamId, current.size ? currentGroups : previousGroups);
}

function availableSource(sourceId: string, result: AsaFetchResult, season: number | null): SourceSnapshot {
  return {
    sourceId,
    sourceType: "api",
    endpointOrRepository: result.url,
    season,
    retrievedAt: result.retrievedAt,
    contentSha256: result.contentSha256,
    status: "available",
    rowCount: result.rows.length,
  };
}

function unavailableSalarySource(season: number): SourceSnapshot {
  return {
    sourceId: `asa-salaries-${season}`,
    sourceType: "api",
    endpointOrRepository: asaEndpointUrl("salaries", season),
    season,
    retrievedAt: null,
    contentSha256: null,
    status: "optional-unavailable",
    rowCount: 0,
  };
}

async function loadSource(name: AsaDatasetName, season: number): Promise<AsaFetchResult> {
  const response = await fetchAsa(name, season, forceRefresh);
  console.log(`${name} ${season}: ${response.rows.length} rows from ${response.fromCache ? "cache" : "API"}`);
  return response;
}

async function loadSeason(season: number): Promise<SeasonSources> {
  const [xg, xpass, gplus, goalkeeperXg, goalkeeperGplus] = await Promise.all([
    loadSource("xgoals", season),
    loadSource("xpass", season),
    loadSource("goals-added", season),
    loadSource("goalkeeper-xgoals", season),
    loadSource("goalkeeper-goals-added", season),
  ]);
  let salaries: AsaFetchResult | null = null;
  try { salaries = await loadSource("salaries", season); }
  catch (error) { console.warn(`Salary data unavailable for ${season}: ${(error as Error).message}`); }
  assertUniquePlayerTeamSeasonRows(xg.rows, season, `ASA xGoals ${season}`);
  assertUniquePlayerTeamSeasonRows(xpass.rows, season, `ASA xPass ${season}`);
  assertUniquePlayerTeamSeasonRows(gplus.rows, season, `ASA Goals Added ${season}`);
  return { xg, xpass, gplus, goalkeeperXg, goalkeeperGplus, salaries };
}

function teamSetsByPlayer(rows: readonly AsaRow[]): Map<string, Set<string>> {
  const output = new Map<string, Set<string>>();
  for (const row of rows) {
    const id = ID(row);
    const teamId = TEAM_ID(row);
    if (id && teamId) (output.get(id) ?? output.set(id, new Set()).get(id)!).add(teamId);
  }
  return output;
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const [playersResult, teamsResult] = await Promise.all([
    fetchAsa("players", undefined, forceRefresh),
    fetchAsa("teams", undefined, forceRefresh),
  ]);
  const teams = new Map<string, Team>();
  for (const row of [...teamsResult.rows].sort((a, b) => canonicalStringify(a) < canonicalStringify(b) ? -1 : canonicalStringify(a) > canonicalStringify(b) ? 1 : 0)) {
    const id = TEAM_ID(row) ?? textField(row, "team_id", "id");
    const name = textField(row, "team_name", "name");
    const abbreviation = textField(row, "team_abbreviation", "abbreviation", "team_short_name", "short_name");
    if (id && name && abbreviation) {
      const next = { id, name, abbreviation };
      const existing = teams.get(id);
      if (existing && canonicalStringify(existing) !== canonicalStringify(next)) throw new Error(`Conflicting ASA team records for ${id}`);
      teams.set(id, next);
    }
  }
  const playerInfo = new Map<string, PlayerInfo>();
  for (const row of [...playersResult.rows].sort((a, b) => canonicalStringify(a) < canonicalStringify(b) ? -1 : canonicalStringify(a) > canonicalStringify(b) ? 1 : 0)) {
    const id = ID(row);
    if (id) {
      const next = { name: NAME(row), position: textField(row, "general_position", "position"), age: numberField(row, "age") };
      const existing = playerInfo.get(id);
      if (existing && canonicalStringify(existing) !== canonicalStringify(next)) throw new Error(`Conflicting ASA player identity records for ${id}`);
      playerInfo.set(id, next);
    }
  }

  const [current, previous] = await Promise.all([loadSeason(CURRENT_SEASON), loadSeason(PREVIOUS_SEASON)]);
  const currentGroups: [AsaRow[], AsaRow[], AsaRow[]] = [current.xg.rows, current.xpass.rows, current.gplus.rows];
  const previousGroups: [AsaRow[], AsaRow[], AsaRow[]] = [previous.xg.rows, previous.xpass.rows, previous.gplus.rows];
  const allCurrentRows = currentGroups.flat();
  const allPreviousRows = previousGroups.flat();
  const currentStats = statsFromRows(CURRENT_SEASON, ...currentGroups);
  const previousStats = statsFromRows(PREVIOUS_SEASON, ...previousGroups);
  const currentGoalkeepers = normalizeGoalkeeperSeason(
    CURRENT_SEASON,
    current.goalkeeperXg.rows,
    current.goalkeeperGplus.rows,
  );
  const previousGoalkeepers = normalizeGoalkeeperSeason(
    PREVIOUS_SEASON,
    previous.goalkeeperXg.rows,
    previous.goalkeeperGplus.rows,
  );

  const selectedSalarySource = selectSalarySource(
    CURRENT_SEASON,
    current.salaries,
    PREVIOUS_SEASON,
    previous.salaries,
  );
  const salaryByPlayer = latestSalaryByPlayer(selectedSalarySource?.result.rows ?? []);
  const selectedReleases = new Set([...salaryByPlayer.values()].map((row) => textField(row, "mlspa_release")).filter((value): value is string => Boolean(value)));
  if (selectedReleases.size > 1) throw new Error(`Selected salary records contain multiple latest releases: ${[...selectedReleases].sort().join(", ")}`);
  const selectedSalaryRelease = [...selectedReleases][0] ?? null;

  const ids = new Set([...currentStats.keys(), ...previousStats.keys()]);
  const currentTeamsByPlayer = teamSetsByPlayer(allCurrentRows);
  const allTeamsByPlayer = teamSetsByPlayer([...allCurrentRows, ...allPreviousRows]);
  const unknownPositions = new Set<string>();
  let unknownPositionExclusionCount = 0;
  const players: StaticPlayer[] = [];
  for (const id of [...ids].sort()) {
    const sourceRow = displayedRow(id, currentGroups, previousGroups);
    if (!sourceRow) continue;
    const info = playerInfo.get(id);
    const position = textField(sourceRow, "general_position", "position") ?? info?.position;
    const positionGroup = normalizePosition(position);
    if (!positionGroup) {
      unknownPositionExclusionCount++;
      if (position) unknownPositions.add(position);
      continue;
    }
    const teamId = TEAM_ID(sourceRow);
    const team = teamId ? teams.get(teamId) : undefined;
    if (!team) continue;
    const salary = salaryByPlayer.get(id);
    const player: StaticPlayer = {
      id,
      name: NAME(sourceRow) ?? info?.name ?? "",
      teamId: team.id,
      teamName: team.name,
      teamAbbreviation: team.abbreviation,
      positionGroup,
      ...(position ? { position } : {}),
      ...(info?.age !== undefined ? { age: info.age } : {}),
      ...(salary && numberField(salary, "base_salary", "baseSalary") !== undefined ? { baseSalary: numberField(salary, "base_salary", "baseSalary") } : {}),
      ...(salary && numberField(salary, "guaranteed_compensation", "guaranteedCompensation") !== undefined ? { guaranteedCompensation: numberField(salary, "guaranteed_compensation", "guaranteedCompensation") } : {}),
      currentSeason: currentStats.get(id) ?? { season: CURRENT_SEASON },
      ...(previousStats.has(id) ? { previousSeason: previousStats.get(id) } : {}),
    };
    if (isEligible(player)) players.push(player);
  }
  attachGoalkeeperMetrics(players, currentGoalkeepers, previousGoalkeepers);

  let unmatchedSalaryRows = 0;
  for (const salaryId of salaryByPlayer.keys()) if (!ids.has(salaryId)) unmatchedSalaryRows++;
  if (unknownPositions.size) console.warn(`Unrecognized ASA positions excluded: ${[...unknownPositions].sort().join(", ")}`);

  const roster = await fetchLatestRoster(forceRefresh, CURRENT_SEASON);
  const rosterAudit = attachRoster(players, roster.release);
  const overridePath = join(process.cwd(), "data", "roster-overrides.json");
  const overrides = await loadOverrides(overridePath, players, teams);
  const overridesApplied = applyOverrides(players, overrides);
  const finalPlayers = stablePlayerSort(players);
  const finalDisagreements = finalPlayers.filter((player) => player.rosterProfile && player.teamId !== player.rosterProfile.snapshotTeamId).length;

  const sources: SourceSnapshot[] = [
    availableSource("asa-players", playersResult, null),
    availableSource("asa-teams", teamsResult, null),
    availableSource(`asa-xgoals-${CURRENT_SEASON}`, current.xg, CURRENT_SEASON),
    availableSource(`asa-xpass-${CURRENT_SEASON}`, current.xpass, CURRENT_SEASON),
    availableSource(`asa-goals-added-${CURRENT_SEASON}`, current.gplus, CURRENT_SEASON),
    availableSource(`asa-goalkeeper-xgoals-${CURRENT_SEASON}`, current.goalkeeperXg, CURRENT_SEASON),
    availableSource(`asa-goalkeeper-goals-added-${CURRENT_SEASON}`, current.goalkeeperGplus, CURRENT_SEASON),
    current.salaries ? availableSource(`asa-salaries-${CURRENT_SEASON}`, current.salaries, CURRENT_SEASON) : unavailableSalarySource(CURRENT_SEASON),
    availableSource(`asa-xgoals-${PREVIOUS_SEASON}`, previous.xg, PREVIOUS_SEASON),
    availableSource(`asa-xpass-${PREVIOUS_SEASON}`, previous.xpass, PREVIOUS_SEASON),
    availableSource(`asa-goals-added-${PREVIOUS_SEASON}`, previous.gplus, PREVIOUS_SEASON),
    availableSource(`asa-goalkeeper-xgoals-${PREVIOUS_SEASON}`, previous.goalkeeperXg, PREVIOUS_SEASON),
    availableSource(`asa-goalkeeper-goals-added-${PREVIOUS_SEASON}`, previous.goalkeeperGplus, PREVIOUS_SEASON),
    previous.salaries ? availableSource(`asa-salaries-${PREVIOUS_SEASON}`, previous.salaries, PREVIOUS_SEASON) : unavailableSalarySource(PREVIOUS_SEASON),
    {
      sourceId: "asa-roster-profiles",
      sourceType: "repository",
      endpointOrRepository: ROSTER_REPOSITORY,
      season: CURRENT_SEASON,
      retrievedAt: roster.retrievedAt,
      contentSha256: roster.contentSha256,
      status: "available",
      rowCount: rosterAudit.total,
    } satisfies SourceSnapshot,
  ].sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);

  const overrideDocument = {
    schemaVersion: 1,
    overrides: [...overrides].sort((a, b) => a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0),
  };
  const positionDistribution = Object.fromEntries(["GK", "DEF", "MID", "FWD"].map((group) => [group, finalPlayers.filter((player) => player.positionGroup === group).length])) as PlayerDataset["audit"]["positionDistribution"];
  const dataset: PlayerDataset = {
    schemaVersion: 4,
    humanReadableLabel: playerHumanReadableLabel(CURRENT_SEASON, PREVIOUS_SEASON, roster.release.release_date),
    dataVersion: "",
    competition: "MLS",
    season: CURRENT_SEASON,
    previousSeason: PREVIOUS_SEASON,
    generatedAt,
    statisticsThrough: null,
    sources,
    salary: {
      status: current.salaries || previous.salaries ? "available" : "optional-unavailable",
      selectedSeason: selectedSalarySource?.season ?? null,
      selectedRelease: selectedSalaryRelease,
      currency: "USD",
      selectedRecordCount: salaryByPlayer.size,
    },
    rosterSnapshot: {
      sourceId: "asa-roster-profiles",
      repository: ROSTER_REPOSITORY,
      releaseFilename: roster.filename,
      fileDate: roster.fileDate,
      snapshotDate: roster.release.release_date,
      contentSha256: roster.contentSha256,
      isLive: false,
      teamCount: roster.release.teams.length,
      rawRecordCount: rosterAudit.total,
      matchedRecords: finalPlayers.filter((player) => player.rosterProfile).length,
      unmatchedRecords: rosterAudit.unmatched,
      duplicateRecordsIgnored: rosterAudit.duplicates,
      missingPlayerIds: rosterAudit.missingIds,
    },
    overrides: {
      schemaVersion: 1,
      appliedCount: overridesApplied,
      contentSha256: sha256Canonical(overrideDocument),
    },
    normalization: PLAYER_NORMALIZATION_RULES,
    audit: {
      sourceRowCounts: Object.fromEntries(sources.map((source) => [source.sourceId, source.rowCount])),
      playerCount: finalPlayers.length,
      teamCount: new Set(finalPlayers.map((player) => player.teamId)).size,
      positionDistribution,
      currentSeasonMultiTeamCount: [...currentTeamsByPlayer.values()].filter((teamIds) => teamIds.size > 1).length,
      crossSeasonMultiTeamCount: [...allTeamsByPlayer.values()].filter((teamIds) => teamIds.size > 1).length,
      unmatchedSalaryCount: unmatchedSalaryRows,
      unknownPositionExclusionCount,
      rosterMatchedCount: finalPlayers.filter((player) => player.rosterProfile).length,
      rosterUnmatchedCount: rosterAudit.unmatched,
      ignoredRosterDuplicateCount: rosterAudit.duplicates,
      statisticalSnapshotTeamDisagreementCount: finalDisagreements,
      appliedRosterOverrideCount: overridesApplied,
      goalkeeper: {
        sources: {
          [`asa-goalkeeper-xgoals-${CURRENT_SEASON}`]: goalkeeperSourceAudit(currentGoalkeepers.xGoals, finalPlayers),
          [`asa-goalkeeper-goals-added-${CURRENT_SEASON}`]: goalkeeperSourceAudit(currentGoalkeepers.goalsAdded, finalPlayers),
          [`asa-goalkeeper-xgoals-${PREVIOUS_SEASON}`]: goalkeeperSourceAudit(previousGoalkeepers.xGoals, finalPlayers),
          [`asa-goalkeeper-goals-added-${PREVIOUS_SEASON}`]: goalkeeperSourceAudit(previousGoalkeepers.goalsAdded, finalPlayers),
        },
        goalkeepersWithCurrentSeasonMetrics: finalPlayers.filter((player) => player.positionGroup === "GK" && player.goalkeeperMetrics?.currentSeason).length,
        goalkeepersWithPreviousSeasonMetrics: finalPlayers.filter((player) => player.positionGroup === "GK" && player.goalkeeperMetrics?.previousSeason).length,
        goalkeepersWithPlayingTimeButNoMetrics: finalPlayers.filter((player) => player.positionGroup === "GK" && !player.goalkeeperMetrics).length,
      },
    },
    players: finalPlayers,
  };
  dataset.dataVersion = computePlayerDataVersion(dataset);
  assertValidDataset(dataset);
  await mkdir(join(process.cwd(), "public", "data"), { recursive: true });
  await writeFile(join(process.cwd(), "public", "data", "players.json"), `${JSON.stringify(dataset, null, 2)}\n`);
  console.log(`Roster ${roster.release.release_date} (${roster.filename}): ${roster.release.teams.length} teams from ${roster.cached ? "cache" : "network"}; ${CURRENT_SEASON} files: ${roster.available.join(", ")}`);
  if (rosterAudit.optionFormats.length) console.warn(`Option-year values with no year token: ${rosterAudit.optionFormats.join("; ")}`);
  console.log(`\nMLS player dataset generated\n\nHuman-readable label: ${dataset.humanReadableLabel}\nSemantic version: ${dataset.dataVersion}\nCurrent season: ${CURRENT_SEASON}\nPlayers written: ${finalPlayers.length}\nRoster records: ${rosterAudit.total}\nRoster matched by ASA ID: ${dataset.rosterSnapshot.matchedRecords}\nUnmatched roster players: ${rosterAudit.unmatched}\nManual overrides applied: ${overridesApplied}\nStatistical players outside snapshot: ${finalPlayers.filter((player) => !player.rosterProfile).length}\nTeam disagreements: ${finalDisagreements}\nVerified statistics-through date: not recorded\nOutput: public/data/players.json`);
}

main().catch((error) => {
  console.error(`Dataset build failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
