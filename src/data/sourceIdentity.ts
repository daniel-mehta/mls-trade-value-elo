import { canonicalStringify } from "./semanticVersion.js";
import { textField, type AsaRow } from "./asaClient.js";

/**
 * Statistical endpoints are expected at player/team/season grain. Multi-team
 * players are valid, but a repeated grain would otherwise be summed twice.
 */
export function assertUniquePlayerTeamSeasonRows(
  rows: readonly AsaRow[],
  season: number,
  sourceName: string,
): void {
  if (!rows.length) throw new Error(`${sourceName}: required source contains no rows`);
  const grains = new Map<string, string>();
  for (const [index, row] of rows.entries()) {
    const label = `${sourceName} row ${index + 1}`;
    const playerId = textField(row, "player_id", "playerId");
    const teamId = textField(row, "team_id", "teamId");
    const sourceSeason = textField(row, "season_name", "season");
    if (!playerId) throw new Error(`${label}: missing stable ASA player ID`);
    if (!teamId) throw new Error(`${label}: missing stable ASA team ID`);
    if (sourceSeason !== String(season)) throw new Error(`${label}: season must be ${season}`);
    const grain = `${playerId}\u0000${teamId}\u0000${season}`;
    const prior = grains.get(grain);
    if (prior !== undefined) {
      const kind = prior === canonicalStringify(row) ? "duplicate" : "conflicting duplicate";
      throw new Error(`${sourceName}: ${kind} player/team/season row for ${playerId}/${teamId}/${season}`);
    }
    grains.set(grain, canonicalStringify(row));
  }
}
