import { selectComparisonPool } from "../../src/data/comparisonPool.js";
import { computePlayerDataVersion } from "../../src/data/semanticVersion.js";
import type { AsaSeasonEvidence } from "../../src/data/seasonResolution.js";
import { playerDataset, staticPlayer } from "../data-fixtures.js";

const noOverrides = { schemaVersion: 1 as const, include: [], exclude: [] };

export function seasonEvidence(identifiers: readonly string[], changes: Partial<AsaSeasonEvidence> = {}): AsaSeasonEvidence {
  return {
    source: "ASA MLS games",
    endpoint: "https://app.americansocceranalysis.com/api/v1/mls/games",
    rowCount: Math.max(identifiers.length, 1),
    contentSha256: "a".repeat(64),
    identifiers: [...identifiers],
    invalidRowCount: 0,
    ...changes,
  };
}

export function publicationArtifactForSeason(
  season: number,
  previousSeason: number,
  ids: readonly string[] = ["a", "b", "c"],
) {
  const players = ids.map((id, index) => staticPlayer(id, {
    currentSeason: { season, minutes: 20 - index },
    previousSeason: { season: previousSeason, minutes: 100 - index },
  }));
  const dataset = playerDataset(players, { season, previousSeason });
  dataset.dataVersion = computePlayerDataVersion(dataset);
  const pool = selectComparisonPool(dataset, noOverrides, "2027-03-01T00:00:00.000Z");
  return { dataset, pool };
}
