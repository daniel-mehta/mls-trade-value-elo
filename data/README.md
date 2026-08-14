# MLS player data artifacts

`public/data/players.json` is the normalized source artifact.
`public/data/comparison-pool.json` is a generated, browser-facing subset. The
browser never calls American Soccer Analysis (ASA) or another player-data
service at runtime.

## Source commands

The player pipeline consumes the public ASA endpoints for player identities and
positions, teams, player xGoals, xPass, outfield Goals Added, goalkeeper xGoals,
goalkeeper Goals Added, and salaries. No API key or paid service is required.

```sh
npm run probe:data
npm run probe:rosters
npm run build:data
npm run validate:data
npm run audit:rosters
npm run build:pool
npm run validate:pool
npm run validate:refresh-status
npm run audit:pool
npm run check:publication
```

`-- --refresh` bypasses the ignored `.cache/asa/` and `.cache/rosters/`
responses. A publication check never refreshes a source and never rewrites an
artifact. Salary acquisition is optional: a salary request can fail while the
statistical build succeeds, but the source and salary metadata must explicitly
record the unavailable state. Required identity, team, statistical, or roster
acquisition failures remain fatal.

## Automated weekly refresh

`.github/workflows/refresh-data.yml` runs every Monday at 00:23 UTC and supports
manual `workflow_dispatch`. Before the synchronized publication-source refresh,
it reads the official ASA MLS games family once, using the same pagination as
ASA's maintained client, solely to enumerate ASA's available `season_name`
values. It then performs exactly one publication-source refresh with
`npm run build:data -- --refresh`, builds the pool, runs the existing validators,
roster/pool audits, complete test suite, publication gate, type check, and web
build, then repeats both artifact builds from the refreshed local caches. The
two builds must have identical semantic versions, membership, selection reasons,
ordering, and canonical substantive content after excluding only documented
observation timestamps.

The workflow fails closed on source, identity, duplicate, join, validation,
test, publication, determinism, allowlist, or default-branch race failures. A
stable-ID continuity guard requires at least half of the smaller old/new player
set to retain the same ASA IDs; this catches a broad identity-namespace
replacement while allowing ordinary roster turnover. Existing normalized and
pool uniqueness rules remain stricter record-level gates. An available baseline
with salary coverage cannot silently become a salary-free publication. A
required non-salary source also cannot fall below half its prior row count under
the same source ID during a same-season refresh; this catches a near-empty
response while allowing ordinary weekly movement. A confirmed rollover does not
compare a newly accumulating season to the mature prior current season. It
instead relies on the existing non-empty required-source, source-grain,
stable-ID, team-join, roster, normalized-artifact, pool, publication, and
determinism invariants. The stable-ID continuity guard still applies. These are
fixture-tested structural checks, not player-eligibility or pool-size rules.

Only `public/data/players.json`, `public/data/comparison-pool.json`, and
`data/refresh-status.json` may be committed. Every successful check updates the
status file and creates a direct default-branch maintenance commit. When only
the status changes, Pages is not dispatched. When either publication artifact
changes substantively, the workflow explicitly dispatches `deploy-pages.yml`
after the push because a `GITHUB_TOKEN` push does not reliably start a second
workflow. The refresh workflow itself contains no Pages deployment logic.

The workflow re-fetches the remote default branch immediately before committing
and aborts if its starting SHA changed; a concurrent update also makes the
non-force push fail safely. Normal successful changes need no approval. Failed
refreshes require owner investigation and leave production unchanged unless the
verified commit was already pushed and only the Pages dispatch failed. In that
special case, the job summary provides the manual deployment-dispatch command.

`data/refresh-status.json` uses schema version 1. Its additive `currentSeason`
and `previousSeason` fields record the actual resolved publication pair.
`lastSuccessfulRefresh` is
`null` only before the first automated run; afterward it is the actual UTC
completion timestamp. Versions and counts are parsed from the validated
artifacts, and `substantiveDataChanged` excludes the status file itself. The
browser and ranking persistence do not read this maintenance record.

GitHub may disable scheduled workflows after extended inactivity in a public
repository. The status update is a real weekly maintenance record and recurring
history, not a keepalive guarantee. `workflow_dispatch` remains the recovery
path if the schedule is disabled. If the project is otherwise ignored for
months, successful runs continue updating the status and changed data while
failures remain visible in Actions for owner investigation.

Local builds default to the known 2026/2025 publication pair. If environment
configuration is used, `MLS_CURRENT_SEASON` and `MLS_PREVIOUS_SEASON` must be
provided together; the code no longer derives one by subtracting from the
other. Weekly automation uses the ordered season identifiers actually present
in official ASA MLS games. It stays on the same pair when that pair is current,
or selects the latest identifier and its immediately preceding available ASA
identifier when both are canonical numeric values compatible with the current
publication schema. The wall clock does not select the season.

An unknown label, missing configured season, ambiguous ordering, malformed game
season field, incomplete required source, incompatible identity/team join,
missing target-season roster, or any later publication check stops the job
before commit and deployment. The Actions summary reports the configured pair,
candidate label, ASA games evidence, and failed compatibility check. The old
season is not silently treated as current and no successful status is written.

The numeric artifact schema is intentionally unchanged because ASA currently
exposes canonical four-digit `season_name` values and provides no evidence yet
for a later summer-to-spring label. A future range or other non-numeric ASA
identifier is detected but not interpreted. That exceptional transition
requires maintenance rather than a guessed schema mapping.

Roster candidate filenames are selected only for the resolved current season;
a prior-season file cannot be substituted. Parsed embedded snapshot dates, not
filename ordering, determine the latest release. Distinct candidates with the
same latest embedded date and different content fail as ambiguous. Roster file
date, embedded snapshot date, and statistical team assignment remain separate.

Salary remains optional under the existing publication policy. At rollover,
current-season salary is selected if ASA has published non-empty rows; otherwise
the resolved previous-season salary release remains the explicit fallback. A
later non-empty current-season release replaces that fallback on the next valid
refresh. Salaries are never invented, summed across releases, or silently
erased; total loss of previously available salary coverage still fails.

## Semantic artifact identity

Schema version and semantic data version are separate concepts. Each artifact
contains:

```text
schemaVersion
humanReadableLabel
dataVersion
generatedAt
```

`humanReadableLabel` is descriptive. `dataVersion` is `sha256:` followed by a
SHA-256 digest of canonical substantive content. Canonical JSON sorts object
keys. Normalized records, source snapshots, and overrides are sorted by stable
identifiers before hashing; source row checksums sort canonical rows so API
response order and object-key order do not change identity.

The player digest includes schema, competition, seasons, normalized players,
canonical source checksums, salary and roster provenance, applied overrides,
normalization/team-selection policy, and deterministic audit metadata. The pool
digest includes the player version, pool schema, all eligibility/selection
rules and tie-breakers, manual overrides, final membership, embedded player
fields, and selection reasons.

`generatedAt`, source observation/retrieval timestamps, JSON indentation, cache
paths, local paths, logs, browser state, Elo values, and export times are
excluded. Changing only build time therefore preserves both semantic versions;
changing substantive source content, normalized data, an applied override,
pool rules, membership, or reasons changes the relevant version.

## Structured provenance

The player artifact records each consumed source separately with:

- Stable source ID and source type
- Endpoint or repository identity
- Season, where applicable
- Canonical SHA-256 content checksum
- Row count
- `available` or `optional-unavailable` status
- Retrieval time only when the cache has a trustworthy recorded acquisition
  time

Legacy caches have no trustworthy acquisition timestamp. They deliberately use
`retrievedAt: null`; artifact build time is not substituted.

Goalkeeper xGoals and Goalkeeper Goals Added are separate source snapshots for
each configured season. Their provenance entries retain the official endpoint,
season, canonical content checksum, row count, availability, and trustworthy
cache retrieval time when recorded. A publication-ready artifact requires both
goalkeeper source families for both configured seasons; missing or malformed
provenance does not silently become a playing-time-only publication artifact.

Salary provenance records acquisition status, selected season, selected MLSPA
release, USD currency, and selected-record count. It does not claim complete
salary coverage. Roster provenance separately records the repository, release
filename, file date, embedded snapshot date, checksum, team/raw record counts,
and matched/unmatched/ignored-duplicate accounting.

`statisticsThrough` is a separate nullable field. It remains `null` unless a
date is directly defensible from the source rows consumed by the build. Current
public copy therefore says: **Verified statistical coverage date not recorded.**

## Player normalization

- ASA player ID, team ID, and season are the only identity/join keys. Names are
  never silent fallback identifiers.
- Split player-team-season statistical components are additive and are summed.
- For a multi-team current season, displayed team is selected by current-season
  minutes, then previous-season minutes for the tied teams, then normalized ASA
  team ID. Source response order never decides.
- Observed general positions map explicitly: `GK` to GK; `CB`/`FB` to DEF;
  `AM`/`CM`/`DM` to MID; and `ST`/`W` to FWD. Unknown values are excluded and
  counted rather than guessed.
- Normalized-dataset eligibility requires complete identity/team/position plus
  at least one current- or previous-season minute. Salary is not required.
- Base salary and average guaranteed compensation remain distinct optional
  numeric fields. Multiple MLSPA releases are never summed. The latest valid
  player release is selected and conflicting rows at that release fail.
- Goalkeeper rows join only by ASA player ID and retain their season dimension.
  Additive xGoals-source totals are combined across team rows. Goalkeeper Goals
  Added is the exact sum of ASA's raw Claiming, Fielding, Handling, Passing,
  Shotstopping, and Sweeping components. Rates, shares, above-average values,
  and action counts are not summed or substituted into the player artifact.
  Missing components remain omitted, and goalkeeper metrics never replace the
  general displayed-team or playing-time policy.

Audit metadata persists source row counts, current- and cross-season multi-team
counts, unmatched salaries, unknown-position exclusions, roster accounting,
final statistical/snapshot team disagreements, applied overrides, player/team
counts, position distribution, and deterministic goalkeeper join/coverage
diagnostics. Goalkeeper diagnostics include raw rows by endpoint and season,
matched and unmatched IDs, duplicate rows, non-goalkeeper conflicts, seasonal
coverage, and playing-time-only counts. The disagreement count is recomputed
from the final attached and overridden players, so transient loan-pair
processing cannot alter it.

## Roster snapshot

Roster data comes from ASA's
[`mls-roster-profiles`](https://github.com/American-Soccer-Analysis/mls-roster-profiles)
repository. These are ASA-parsed roster-profile records whose upstream parser
maps source names to ASA IDs; downstream joins use only those ASA IDs. They are
not a live roster and should not be described as official current-team data.

Statistical team ID/name/abbreviation and snapshot team ID/name remain separate.
`activeAtRosterSnapshot` means listed, not marked unavailable, and not in the
explicit `Off-Roster (Unavailable)` slot. Available optional fields include
slot, designation, status, contract-through, option years, permanent-transfer
option, international status, TAM convertibility, unavailability, Canadian
exemption, and team roster-construction model. Missing booleans are omitted,
not converted to false.

Duplicate roster IDs are resolved only for a recognizable loan pair with
exactly one record matching the normalized statistical team. Any other
normalized duplicate fails rather than depending on response order.

## Strict roster overrides

`data/roster-overrides.json` remains an empty, checked-in correction mechanism.
Entries require a known ASA player ID, real calendar date, nonblank reason and
source note, and a non-empty supported `fields` object. Unknown top-level,
entry, or field keys fail. Player IDs must be unique.

Statistical team replacement requires the complete known `teamId`, `teamName`,
and `teamAbbreviation` tuple. Snapshot team replacement requires both the known
`snapshotTeamId` and matching `snapshotTeamName`. Invalid booleans, impossible
dates, unknown teams, malformed option-year arrays, and empty fields fail.
Omitted optional booleans remain omitted. Validated applied override content and
count participate in player semantic identity.

No override should be added merely to make a static artifact look current.

## Comparison-pool rules

The comparison pool is an eligibility and involvement filter, not a trade-value
model or ranking. Its rules remain:

- Eligible with a current-season minute, or with a previous-season minute when
  listed in the roster snapshot.
- Unavailable snapshot players are not automatically excluded.
- Per statistical team, include the top five eligible outfield players and top
  eligible goalkeeper by `current minutes + previous minutes * 0.5`.
- Participation ties use total score, current minutes, previous minutes, then
  ASA player ID.
- Include every eligible exact `Designated Player` and `U22 Initiative` record.
- Include every eligible player with at least five current-season goals plus
  primary assists.
- Exclusions take precedence.

`data/comparison-pool-overrides.json` has strict `include` and `exclude` arrays
of `{ playerId, reason, sourceNote }`. Unknown or duplicate IDs, include/exclude
conflicts, blank explanations, and extra properties fail. A manual inclusion is
still eligibility-bound: it can add a selection reason to an eligible player,
but cannot bypass the minute/roster eligibility rule for a no-minute signing.

Pool audit metadata records eligible count, final size, all non-exclusive reason
counts, position distribution, and team representation range. Pool validation
always loads the player artifact and then:

1. Validates the source artifact and semantic version.
2. Recomputes eligibility, selection, reasons, audit metadata, and pool version.
3. Compares every embedded selected record with its normalized source player.
4. Rejects missing/extra players, altered fields, rule drift, reason drift,
   source-version drift, and semantic-version drift.

## Browser, persistence, and exports

The browser validates schema version 3 pool metadata and consumes artifact
provenance rather than hard-coded dates. It separately labels pool build time,
unverified or verified statistical coverage, roster snapshot and release-file
dates, and salary release/currency. Missing metadata uses field-specific honest
fallbacks.

Personal ranking state remains in one browser `localStorage` key at schema
version 2. Only stable IDs, ratings, records, totals, matchup state, and bounded
scheduler history are stored. A semantic data-version change preserves ratings
and records for returning IDs, adds new IDs unranked, drops removed IDs, filters
history, and repairs invalid matchups. Elo and scheduler policy are unchanged.

The browser makes no runtime requests to ASA, MLS, salary, roster, goalkeeper,
backend, or cloud-ranking services. The only intentional external runtime
requests are optional GoatCounter aggregate analytics at
`https://gc.zgo.at/count.js` and `https://danielmehta.goatcounter.com/count`.
They do not send player choices, IDs, rankings, Elo values, or export contents.

CSV ranking rows are unchanged. TXT and JSON exports distinguish export time,
player and pool artifact build times and versions, verified coverage, roster
dates, and salary release/currency. JSON export format version 2 reflects this
incompatible public metadata-schema change. Exports remain browser-only and are
not import files.

Goalkeeper cards use the official ASA goalkeeper xGoals and Goalkeeper Goals
Added source families. The normalized goalkeeper structure keeps current and
previous seasons separate and may contain shots faced, goals conceded, saves,
xG faced, goals minus xG faced, raw Goalkeeper Goals Added, and its six raw
action components. The compact card shows at most minutes, saves, shots faced,
xG faced, goals minus xG faced, and total Goalkeeper Goals Added. Availability
varies by season and player; missing fields are omitted, and no metrics are
fabricated or zero-filled.

These are static source snapshots. Artifact build time is not a verified
statistics-through date, and the artifact continues to record
`statisticsThrough: null` where direct source evidence is absent. Goalkeeper
metrics do not directly affect Elo or comparison-pool selection. Pool rules are
unchanged, and Elo continues to reflect the user's pairwise choices rather than
any ASA performance metric.

## Publication and attribution

`npm run check:publication` validates both artifacts without rebuilding them or
refreshing any source. The production web build runs this command before Vite.
`.github/workflows/deploy-pages.yml` runs the full test suite and publication
check, builds `dist`, uploads that directory as the Pages artifact, and deploys
it only after the build job succeeds. That deployment workflow never refreshes
source data; the separate refresh workflow conditionally dispatches it.

This project is independent and is not affiliated with or endorsed by MLS,
MLSPA, ASA, any club, or any player. Repository code licences do not establish a
licence or legal approval to redistribute underlying source data. Review current
terms and attribution requirements before publishing an artifact.
