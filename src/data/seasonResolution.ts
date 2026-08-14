import { fetchAsa, textField, type AsaFetchResult } from "./asaClient.js";

export interface AsaSeasonEvidence {
  source: "ASA MLS games";
  endpoint: string;
  rowCount: number;
  contentSha256: string;
  identifiers: string[];
  invalidRowCount: number;
}

export interface PublicationSeasonResolution {
  schemaVersion: 1;
  mode: "same-season" | "rollover";
  configuredCurrentSeason: number;
  configuredPreviousSeason: number;
  currentSeason: number;
  previousSeason: number;
  candidateSeason: string;
  evidence: AsaSeasonEvidence;
}

export interface SeasonResolutionFailure {
  configuredCurrentSeason: number;
  configuredPreviousSeason: number;
  candidateSeason: string;
  sourceEvidence: string;
  compatibilityCheck: string;
}

export class SeasonResolutionError extends Error {
  constructor(public readonly failure: SeasonResolutionFailure) {
    super(failure.compatibilityCheck);
    this.name = "SeasonResolutionError";
  }
}

function evidenceDescription(evidence: AsaSeasonEvidence): string {
  return `${evidence.source} ${evidence.endpoint} returned ${evidence.rowCount} games and season identifiers: ${evidence.identifiers.join(", ") || "none"}`;
}

function markdown(value: string): string {
  return value.replace(/[\\`|<>]/g, (character) => `\\${character}`).replace(/[\r\n]+/g, " ");
}

function fail(
  configuredCurrentSeason: number,
  configuredPreviousSeason: number,
  candidateSeason: string,
  evidence: AsaSeasonEvidence,
  compatibilityCheck: string,
): never {
  throw new SeasonResolutionError({
    configuredCurrentSeason,
    configuredPreviousSeason,
    candidateSeason,
    sourceEvidence: evidenceDescription(evidence),
    compatibilityCheck,
  });
}

/** The official ASA games family is the narrow discovery source because every
 * game carries ASA's own season_name. Publication data still comes from the
 * existing player/team/statistical/salary/roster sources. */
export function seasonEvidenceFromGames(result: AsaFetchResult): AsaSeasonEvidence {
  const identifiers = new Set<string>();
  let invalidRowCount = 0;
  for (const row of result.rows) {
    const identifier = textField(row, "season_name");
    if (identifier) identifiers.add(identifier);
    else invalidRowCount++;
  }
  return {
    source: "ASA MLS games",
    endpoint: result.url,
    rowCount: result.rows.length,
    contentSha256: result.contentSha256,
    identifiers: [...identifiers].sort(),
    invalidRowCount,
  };
}

export function resolvePublicationSeasons(
  configuredCurrentSeason: number,
  configuredPreviousSeason: number,
  evidence: AsaSeasonEvidence,
): PublicationSeasonResolution {
  const fallbackCandidate = evidence.identifiers.at(-1) ?? "unavailable";
  if (!Number.isInteger(configuredCurrentSeason) || !Number.isInteger(configuredPreviousSeason) || configuredPreviousSeason >= configuredCurrentSeason) {
    fail(configuredCurrentSeason, configuredPreviousSeason, fallbackCandidate, evidence, "Configured publication seasons are not a valid ordered numeric pair");
  }
  if (!evidence.rowCount || !evidence.identifiers.length) {
    fail(configuredCurrentSeason, configuredPreviousSeason, "unavailable", evidence, "ASA games discovery returned no usable MLS season evidence");
  }
  if (evidence.invalidRowCount) {
    fail(configuredCurrentSeason, configuredPreviousSeason, fallbackCandidate, evidence, `${evidence.invalidRowCount} ASA game rows did not contain a usable season_name`);
  }

  const incompatible = evidence.identifiers.filter((identifier) => !/^\d{4}$/.test(identifier));
  if (incompatible.length) {
    fail(
      configuredCurrentSeason,
      configuredPreviousSeason,
      incompatible.join(", "),
      evidence,
      `ASA exposed season identifier(s) that the numeric publication schema cannot represent safely: ${incompatible.join(", ")}`,
    );
  }

  const available = evidence.identifiers.map(Number).sort((left, right) => left - right);
  const currentIndex = available.indexOf(configuredCurrentSeason);
  if (currentIndex < 0) {
    fail(configuredCurrentSeason, configuredPreviousSeason, String(available.at(-1)), evidence, `Configured current season ${configuredCurrentSeason} is absent from ASA games discovery`);
  }
  if (currentIndex === 0 || available[currentIndex - 1] !== configuredPreviousSeason) {
    fail(
      configuredCurrentSeason,
      configuredPreviousSeason,
      String(available.at(-1)),
      evidence,
      `Configured previous season ${configuredPreviousSeason} is not the immediately preceding available ASA season for ${configuredCurrentSeason}`,
    );
  }

  const currentSeason = available.at(-1)!;
  if (currentSeason < configuredCurrentSeason) {
    fail(configuredCurrentSeason, configuredPreviousSeason, String(currentSeason), evidence, "ASA games discovery is older than the configured publication season");
  }
  const previousSeason = available.at(-2);
  if (previousSeason === undefined || previousSeason >= currentSeason) {
    fail(configuredCurrentSeason, configuredPreviousSeason, String(currentSeason), evidence, "The previous available ASA season cannot be determined unambiguously");
  }

  return {
    schemaVersion: 1,
    mode: currentSeason === configuredCurrentSeason ? "same-season" : "rollover",
    configuredCurrentSeason,
    configuredPreviousSeason,
    currentSeason,
    previousSeason,
    candidateSeason: String(currentSeason),
    evidence,
  };
}

export async function discoverPublicationSeasons(
  configuredCurrentSeason: number,
  configuredPreviousSeason: number,
): Promise<PublicationSeasonResolution> {
  const games = await fetchAsa("games", undefined, true);
  return resolvePublicationSeasons(configuredCurrentSeason, configuredPreviousSeason, seasonEvidenceFromGames(games));
}

export function formatSeasonResolutionFailure(failure: SeasonResolutionFailure): string {
  const headline = failure.candidateSeason === "unavailable"
    ? "**The pipeline could not safely confirm the current ASA MLS season.**"
    : "**A newer or incompatible ASA MLS season is available, but the pipeline cannot safely resolve its season semantics.**";
  return [
    "## MLS data refresh stopped",
    "",
    headline,
    "",
    "Published data was not changed.",
    "",
    "Review season configuration/source representation before re-running.",
    "",
    `- Configured current/previous season: ${failure.configuredCurrentSeason}/${failure.configuredPreviousSeason}`,
    `- Candidate season: ${markdown(failure.candidateSeason)}`,
    `- Source evidence: ${markdown(failure.sourceEvidence)}`,
    `- Failed compatibility check: ${markdown(failure.compatibilityCheck)}`,
    "",
  ].join("\n");
}

export function formatSeasonResolutionSummary(resolution: PublicationSeasonResolution): string {
  return [
    "## MLS season resolution",
    "",
    `- Mode: ${resolution.mode}`,
    `- Configured current/previous season: ${resolution.configuredCurrentSeason}/${resolution.configuredPreviousSeason}`,
    `- Resolved current/previous publication season: ${resolution.currentSeason}/${resolution.previousSeason}`,
    `- Source evidence: ${markdown(evidenceDescription(resolution.evidence))}`,
    "",
  ].join("\n");
}
