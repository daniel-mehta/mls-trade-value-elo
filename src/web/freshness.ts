export interface DataFreshnessMetadata {
  season?: number;
  previousSeason?: number;
  generatedAt?: string;
  statisticsThrough?: string | null;
  rosterSnapshotDate?: string;
  rosterReleaseDate?: string;
  salaryReleaseDate?: string | null;
  salaryCurrency?: string;
}

function readableDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

/** Describes separate artifact, statistics, roster, and salary dates honestly. */
export function formatDataFreshnessNotice(metadata: DataFreshnessMetadata): string {
  const buildDate = readableDate(metadata.generatedAt);
  const coverageDate = readableDate(metadata.statisticsThrough);
  const rosterDate = readableDate(metadata.rosterSnapshotDate);
  const rosterReleaseDate = readableDate(metadata.rosterReleaseDate);
  const salaryDate = readableDate(metadata.salaryReleaseDate);
  const currency = typeof metadata.salaryCurrency === "string" && metadata.salaryCurrency.trim()
    ? metadata.salaryCurrency.trim()
    : null;
  return [
    buildDate ? `Dataset artifact built ${buildDate}.` : "Dataset artifact build date unavailable.",
    coverageDate ? `Verified statistics through ${coverageDate}.` : "Verified statistical coverage date not recorded.",
    rosterDate ? `Roster snapshot: ${rosterDate}.` : "Roster snapshot date unavailable.",
    rosterReleaseDate ? `Roster release file date: ${rosterReleaseDate}.` : "Roster release date unavailable.",
    salaryDate ? `Salary release: ${salaryDate}${currency ? ` (${currency})` : ""}.` : "Salary release date unavailable.",
    "Data remains static between successful scheduled refreshes.",
  ].join(" ");
}

export function formatSeasonContext(metadata: DataFreshnessMetadata): string {
  return Number.isInteger(metadata.season) && Number.isInteger(metadata.previousSeason)
    ? `${metadata.season} MLS statistics with selected ${metadata.previousSeason} context.`
    : "Static MLS statistics with prior-season context where available.";
}
