# MLS Trade Value Elo

MLS Trade Value Elo is a static browser application for making a personal MLS player trade-value ranking through pairwise comparisons. Pick the player you would value more in each matchup and the app updates both players' Elo ratings. The result stays in your browser: it is not a consensus ranking, a predictive valuation model, or an official MLS ranking.

The application is deployed as static files, with no application backend or runtime football-data API.

## Live demo

[Open MLS Trade Value Elo](https://danielmehta.com/mls-trade-value-elo/)

## Key features

- Pairwise Elo ranking that reflects your own choices
- Adaptive matchmaking designed to improve pool coverage and reduce repetition
- A personal Top 25 for players you have compared
- Role-specific goalkeeper context alongside outfield context
- Browser-local persistence, reset controls, and no accounts
- Local CSV, TXT, and JSON ranking exports
- Committed data artifacts with reproducible validation and a publication gate

## How it works

Every player begins at 1500 Elo. A completed choice updates both players using the same Elo calculation with a K-factor of 32. Only players with at least one completed comparison receive a personal rank; skips advance to another matchup without changing Elo.

Early rankings are provisional because most players have not yet been compared, or have only a small number of comparisons. When records otherwise tie, the ranking uses Elo, completed comparisons, wins, and player name in that order.

## Comparison pool

The comparison pool is an eligibility and involvement filter, not a trade-value ranking. It includes players with current-season minutes, plus a previous-season fallback for players who remain eligible in a dated roster snapshot. For each statistical team, it selects five outfield players and one goalkeeper by participation score: current-season minutes plus half of previous-season minutes.

Eligible Designated Players, U22 Initiative players, and players with at least five current-season goals plus primary assists are also included. Selection is deterministic. A manual inclusion is still eligibility-bound, so it cannot add a player who fails the minute-and-roster rule.

See [data/README.md](data/README.md) for the complete methodology and validation rules.

## Adaptive matchmaking

The scheduler prioritizes under-compared players and avoids recently repeated pairs and players. A temporary, documented prominence preference can improve the quality of early matchups using player metadata only, then fades out. After enough comparisons, Elo similarity gradually becomes another preference while occasional broader matchups preserve ranking connectivity.

Scheduling determines which two players appear next. It does not alter the Elo calculation or ranking rules.

## Data

American Soccer Analysis (ASA) is the primary data source. Player, team, statistical, salary, and goalkeeper data are normalized into committed static artifacts; dated roster metadata comes from ASA's [mls-roster-profiles](https://github.com/American-Soccer-Analysis/mls-roster-profiles) repository. The browser loads the committed comparison pool rather than calling those sources at runtime.

Approved source data is refreshed automatically each Monday at 00:23 UTC and can also be refreshed manually. A preflight reads official ASA MLS game-season identifiers, keeps the current pair when it is still authoritative, and automatically advances an unambiguous numeric season plus its preceding available ASA season through the complete publication gate. It does not use the wall clock as the season source. A successful run validates and publishes without a PR or owner approval; structural failures such as duplicate stable IDs stop publication and leave the existing snapshot untouched. New players, transfers, and departures flow through the existing deterministic source and eligibility rules. Data remains static between successful refreshes.

If ASA exposes a newer season label or ordering that the numeric artifact schema cannot safely represent, the refresh fails closed instead of guessing or continuing to report the old season as current. The Actions summary identifies the configured pair, candidate, ASA evidence, and failed check. This is the explicit exceptional-rollover maintenance boundary for the 2027 calendar transition; no representation for a future ASA season label is assumed in advance.

`data/refresh-status.json` records the most recent successful source check and resolved current/previous publication seasons. A status-only maintenance commit does not redeploy Pages; substantive publication-artifact changes, including a validated season rollover, explicitly dispatch the existing Pages workflow. Artifact build time is not the same as verified statistical coverage, and `statisticsThrough` remains `null` unless consumed source metadata proves a defensible through-date.

For artifact details, provenance, and refresh safeguards, see [data/README.md](data/README.md) and [data_notice.md](data_notice.md).

## Goalkeepers

Goalkeeper cards use role-appropriate context from the official ASA goalkeeper xGoals and Goalkeeper Goals Added source families. When available, this includes saves, shots faced, xG faced, goals minus xG faced, and Goalkeeper Goals Added. Missing goalkeeper fields are omitted rather than shown as zero.

These metrics help users make a choice; they do not directly determine Elo or pool membership.

## Privacy and persistence

Your ranking uses browser `localStorage`. There are no accounts or cloud ranking storage. Your player choices are never uploaded, nor are rankings, Elo values, matchup history, or export contents. Browser state is tied to that browser and site origin, so clearing storage or moving to another device does not transfer a ranking.

The site uses GoatCounter for privacy-preserving aggregate usage analytics. It receives page visits and only fixed feature-event names for votes, skips, exports, and resets. It receives no player names, IDs, choices, rankings, Elo values, matchup data, or export contents. GoatCounter does not use cookies or persistent analytics identifiers, and the application suppresses its page visits and events when the browser reports Do Not Track.

For technical transparency, the optional analytics integration uses `https://gc.zgo.at/count.js` and `https://danielmehta.goatcounter.com/count`. Analytics failure does not affect ranking use.

## Exports

Exports are generated locally in the browser.

- **CSV**: the full compared-player ranking with player, team, position, Elo, and record fields
- **TXT**: a compact personal Top 25
- **JSON**: the structured compared-player ranking with dataset and export metadata

Uncompared players are not exported. Exports are not import files; review personal rankings before sharing them.

## Technical architecture

The application uses TypeScript and Vite, deployed as a static GitHub Pages site. A pure Elo domain layer, browser scheduler, `localStorage` persistence, and browser-only exports operate on committed JSON artifacts. No application backend or runtime football-data API is required.

The data pipeline and publication checks validate schemas, semantic data versions, provenance, deterministic pool reconstruction, and consistency between source and browser artifacts. Vitest covers the domain logic, data pipeline, browser modules, documentation claims, and publication-facing behavior. GitHub Actions runs the full test suite and production build before Pages deployment.

## Running locally

```sh
npm ci
npm run dev:web
```

For the full local validation and production build:

```sh
npm test
npm run check:publication
npm run build:web
```

`npm run build:web` runs the publication checks, builds the production subpath, and verifies the deployment output. Use `npm run preview:web` to inspect that build locally.

## Testing and publication integrity

The current suite contains 287 automated tests. `npm run check:publication` validates committed artifacts without refreshing sources or rewriting data, including schema, semantic-version, provenance, roster, pool, and refresh-automation consistency checks. The production web build runs that gate before Vite builds the site.

## Limitations

- Rankings are subjective and personal, not a market, consensus, predictive, or official valuation.
- Early Elo results are provisional.
- Pool membership is an eligibility/involvement filter, not objective trade value.
- Static statistics, roster metadata, and salary information can become stale and use different source dates.
- Browser-local state is device- and origin-specific, with no sync or recovery.
- The project's MIT licence does not settle rights to third-party data.

## Attribution and licence

Player and team statistics, salaries, and goalkeeper data are attributed to [American Soccer Analysis](https://www.americansocceranalysis.com/). Dated roster metadata comes from ASA's [mls-roster-profiles](https://github.com/American-Soccer-Analysis/mls-roster-profiles) repository, which parses club roster-profile sources.

This independent project is not affiliated with or endorsed by MLS, MLSPA, American Soccer Analysis, any club, or any player. The repository's [MIT licence](LICENSE) applies to its code and documentation; it does not establish ownership, redistribution rights, legal approval, or a licence for underlying third-party data. Review current source terms and attribution requirements before redistributing data artifacts.
