# Market Intelligence

A local research workspace for US equity breadth, relative strength, screening, industry leadership, and historical market studies. This is a decision-support tool, not an automated trading system.

## Current state

The app runs as a Node 24 modular monolith with a browser UI and persistent SQLite warehouse. Its managed macOS preview is deployed at <http://127.0.0.1:4173> on data version 18,911 and calculation version `2-be44dec1f429`. The 2,990-session history, daily/weekly ranks, 315-session current standard/Monitor/SEC caches, and all-model velocity/ATH snapshots are verified, including lineage reuse for unaffected rows. The official Nasdaq Composite (`IXIC.INDX`) series is stored separately from equity constituents and ETF benchmarks. Broad market data coverage starts in 2016-11, with only five sample securities in the earliest 2015–2016 portion. The final compressed v18,911 backup passed SQLite `quick_check` and independent verification. See [docs/OPERATIONS.md](docs/OPERATIONS.md) for scope, quality review, and recovery steps. The `data/` directory is git-ignored local runtime state and persists across app restarts.

Primary UI workflows are implemented: market overview and health/regime views, a separate Market Monitor timeline, stock screening and detail, RS rankings/model authoring/comparison, industry/theme views, historical exploration, cohorts/event studies, saved screens/watchlists, alerts, Market Journal, settings/data quality, and CSV/Parquet exports. Breadth contributors now open with a same-drawer historical trend; selecting a date loads that session's qualifying, comparable, and excluded securities while retaining watchlist and CSV actions. Browser/API integration and visual review passed. Provider coverage and full PRD delivery remain separate constraints; see [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

RS Rankings provides independent split-adjusted return leader lists for 1W, 1M, 3M, 6M, and 1Y, each with its own comparable population and adjustable top-percent cutoff (default 2%). Separate model-driven lists cover Top RS, Fast Improvers, New Top-Decile Entries, Emerging Leaders, Industry Leaders, and Weakening Leaders. Rows link to TradingView. Selected securities can be carried across lists into watchlists. Saved screens in latest mode follow the latest completed prepared EOD publication; historical replay pins its date and data version.

## Run locally

Requirements: Node.js 24 or newer. The application has no npm runtime dependencies.

```sh
npm run dev
```

Open <http://127.0.0.1:4173>. The managed macOS launchd service keeps the preview running and restarts it if the process exits. Check or control it with:

```sh
npm run service -- status
npm run service -- restart
npm run service -- stop
npm run service -- start
```

The dev server watches backend files and serves browser modules directly. `npm start` runs without watch mode. The server uses `data/market.sqlite` by default; set `MARKET_DB` to choose another path. SQLite WAL keeps data persistent across app restarts and frontend refreshes. Service logs are under the private `data/logs/` directory.

## Data and calculations

Check local warehouse and materialization status:

```sh
npm run ingest -- status
npm run materialize -- status
```

Check provider access and ongoing bootstrap progress:

```sh
npm run ingest -- probe
npm run ingest -- status
```

The authenticated EODHD account provides daily prices, bulk history, split actions, and delisted listings. Capture completed for all 9,439 price and 9,439 action tasks across 15 ETF benchmarks; 96 tasks were no-history/invalid. Price and action captures alone do not guarantee clean per-security history. Seven reviewed corrections were applied in data versions 18,897–18,903. The latest strict core-universe receipt is partial: 5,151/5,258 expected securities received (97.965%), with 5,457/5,564 source IDs matched; the retained price snapshot has 5,155 traded and 4,046 ranked. Type verification remains partial, 307 known subtype exclusions were recorded (306 in that receipt roster), and historical float coverage is zero. EODHD fundamentals and symbol-rename endpoints returned HTTP 403. SEC enrichment contains 99,090 filing-dated classifications across 3,610 matched issues and 83,824 dated shares observations; no historical float was found. SEC joins through the current catalog and do not establish complete historical membership.

The CLI starts/resumes a full eligible US catalog bootstrap. Its default history is at least ten years, with benchmarks, delisted catalog/listing events, and actions; `--reference` requests current provider reference facts where available. The job is quota-aware and resumable:

```sh
npm run bootstrap -- --reference --max-calls 90000
```

This command can make many provider requests. Use `--symbols AAPL,MSFT` for a research subset. Configure `EODHD_API_KEY` in the private server-side `.env`; never put it in browser code, commit it, or paste it into logs. The configured account was verified for the price/catalog/action endpoints listed above; fundamentals and rename requests remain unavailable.

The direct import path is available for already captured provider data:

```sh
npm run ingest -- file path/to/dataset.json
npm run ingest -- eodhd --symbols AAPL.US,SPY.US --from 2024-01-01 --to 2026-11-20
```

## Reference data status

- EODHD: bulk/daily prices, splits, and delisted listings are accessible with the configured account. All 9,439 price tasks and 9,439 corporate-action tasks completed; 96 tasks were marked no-history/invalid. Fifteen benchmarks were captured. The 13.62M raw-bar snapshot has seven evidence-based corrections applied and verified archives; unresolved price windows remain quarantined. EODHD fundamentals and ticker-rename endpoints return 403.
- SEC: 47 quarterly filing datasets (2015 Q1–2026 Q3) and 5,321 valid CompanyFacts inputs have been imported. The latest import contains 99,090 filing-dated classification observations for 3,610 positively matched issues, 83,824 dated shares observations, and no float observations. Of 5,388 CIK requests, 5,324 returned successfully and 64 returned upstream 404; three HTTP 200 payloads without a CIK were quarantined. SEC classifications bridge through the current catalog and do not prove a complete historical US universe.
- Nasdaq: the latest typed-reference import contains 4,493 classifications and 4,344 cap observations, matched to 4,632 identities. A separate official Nasdaq Composite (`IXIC.INDX`) series with 2,990 daily bars was imported as an index reference, not as a constituent or ETF benchmark. Typed classification/cap values are current-capture values, not historical series.
- Delisted records are present, but terminal-date/return completeness and ticker-reuse resolution are not established. Latest provider status showed 4,298 delisted records with no known terminal dates. Historical float is not available in current source loads.

See `npm run ingest -- status` and Settings → Data Quality for changing import and coverage state. Current prices retain 5,155 traded securities and 4,046 ranked; the latest strict receipt is partial at 5,151/5,258 expected (97.965%), with 5,457/5,564 source IDs matched. Type verification is partial, 307 known subtype exclusions are recorded (306 in that receipt's roster), and float observations are unavailable. The native UI verified historical `above_50d` counts of 2,469/4,732 on 2026-08-25 and 969/4,409 on 2026-11-20. These are context-specific readings, not full-market guarantees. Do not interpret a near-complete received count or partial breadth as whole-market health.

## Market Journal

The Market Journal route supports saved daily reports, revisioned Markdown prompts/skills, custom numeric factors, sentiment, health/risk scores, and factor charts/backtests. User notes are stored separately as dated revisions; including a note in a Claude request requires an explicit opt-in for that generation. Reports record the actual availability time and next eligible session, so historical factor studies do not treat a report as known before publication. Retrospective reports are labeled and excluded from backtests by default.

Configure the Anthropic API key in Settings → Journal. It is encrypted with AES-256-GCM and stored locally using a private 32-byte vault file (`data/.journal-key`, mode 0600); the database stores encrypted key material. The current workspace has no Anthropic key configured and no generated reports or notes, so live Claude generation has not been exercised. Browser integration used a mock Claude client. Never put API keys in prompts, notes, browser code, or documentation.

The optional CLI is `node scripts/journal.mjs status|generate|daily|series|prompt`; see `node scripts/journal.mjs --help`. The app can schedule one generation after a complete published market session when Journal scheduling is enabled.

The current verified materialization uses data version 18,911 and calculation version `2-be44dec1f429`. All 2,990 daily and 621 weekly SEC/as-of/SPY rank dates are complete; Nasdaq/latest standard and Monitor and SEC/as-of caches each cover 315 sessions, and all three models have current velocity/ATH snapshots. Unaffected results were reused through archive lineage. Check exact cache state with:

```sh
npm run materialize -- status --classification nasdaq --reference latest --benchmark SPY --data-version 18911 --limit 315
npm run materialize -- status --classification sec-sic --reference as-of --benchmark SPY --data-version 18911 --limit 315
npm run materialize -- workspace --classification nasdaq --reference latest --benchmark SPY --data-version 18911 --all-models --daily-tail 1
```

The SEC-classification historical context contains 2,990 sessions from 2015-01-02 to 2026-11-20, with daily ranks 2,990/2,990 and weekly ranks 621/621. The earliest ~2015–2016 dates contain only five original sample securities; broad market capture starts in 2016-11, so full date coverage is not full-market membership coverage for the entire period. Check the exact historical context, separately from Nasdaq/latest:

```sh
npm run materialize -- status --classification sec-sic --reference as-of --benchmark SPY --data-version 18911 --limit 7560
npm run materialize -- status --classification sec-sic --reference as-of --benchmark SPY --model composite --data-version 18911 --limit 7560 --ranks
npm run materialize -- status --classification sec-sic --reference as-of --benchmark SPY --model composite --data-version 18911 --limit 7560 --cadence weekly --ranks
```

Current Nasdaq/latest and historical SEC/as-of archives are different contexts. The CLI default classification is `provider`, so leaving out these selectors checks a different cache. Standard rank archive status can be checked separately with `--ranks`; custom monitor metrics use comma-separated `--metrics`:

```sh
npm run materialize -- status --classification nasdaq --reference latest --benchmark SPY --data-version 18911 --limit 315 --ranks
npm run materialize -- status --classification nasdaq --reference latest --benchmark SPY --data-version 18911 --limit 315 --metrics up_13pct_34d,down_13pct_34d
```

The `--metrics` option accepts comma-separated breadth keys such as `up_13pct_34d,down_13pct_34d`. A cold history request for a large catalog queues context-pinned background work; the UI shows progress and loads the completed series. `--with-ranks` stores breadth and ranking outputs together. Materializations are versioned by data and calculation context; check status before relying on a series.

For a large uncached history request, the API may respond with `materialization.pending`, `jobId`, status, progress, and missing dates. The app polls the job endpoint and reloads the requested series after completion. The API also offers `POST /api/v1/data/materialize` with `{"kind":"rankings", ...context/options}` for rank-archive jobs and `POST /api/v1/data/bootstrap` for a resumable provider-bootstrap job; poll the returned job ID. Use `npm run bootstrap -- --help`, `npm run ingest -- --help`, and `npm run materialize -- --help` for CLI options. The live warehouse may be overwritten or extended by imports; take a backup before changing the source dataset.

## Refresh and backup

Frontend files are served without browser caching. The UI checks `/api/v1/build` every 30 seconds and shows a **Reload build** action when app assets change; reloading picks up the new version while data remains in SQLite. This supports the requested 15–30-minute app update cadence without resetting the database. Refreshing the application does not clear `data/market.sqlite`.

The managed service is deployed on the frozen v18,911 build. Scheduled price sync, Nasdaq refresh, precompute, and compressed backup are enabled with backup retention set to one; price sync waits until 20:30 America/New_York and checks recent expected-session coverage. Provider fundamentals remain off because those endpoints are not available under the current account. Development runs do not inherit the managed service schedule unless configured. A scheduled-refresh run published the latest complete session while two older sessions remained pending for incomplete coverage.

For a compressed SQLite backup, use `node scripts/backup.mjs create`; verify a specific bundle with `node scripts/backup.mjs verify <bundle-directory>`. The final v18,911 bundle is `data/backups/market-sqlite-gzip-2026-11-21T20-01-30-219Z-86f7c6cc-25ba-445b-a5aa-7c441544456d`. It contains 13,623,872 daily prices and 13,634,462 price revisions (9,865 securities); compressed size is 2,878,210,438 bytes from 10,747,887,616 raw bytes. Its SHA-256 is `7ae0e4b8898f5c97e3114792e94995158e726ba30e50538848383666f9d7e0df`; SQLite `quick_check` and independent second verification passed. Earlier SQLite and Parquet artifacts were from a five-symbol sample and are not recovery points for the expanded warehouse. Optional Parquet backup uses the app's authenticated `POST /api/v1/data/backup` with `{"format":"parquet"}` and the configured DuckDB CLI. The local DuckDB v2.0.1 binary is macOS arm64 and is not suitable for the Linux Docker image. Docker build/runtime have not been verified. See [docs/OPERATIONS.md](docs/OPERATIONS.md) for backup verification and derived-archive recovery commands.

## Development checks

```sh
npm run check
npm test
```

Current frozen build: `npm run check` passed and 152/152 tests passed, including 209 real handler/browser requests. The managed launchd service runs plain Node; a SIGTERM recovery test restored HTTP service in 10.489 seconds. Native Chrome verified the promoted build and Monitor controls. Archives and the independent full-backup verification passed. Docker build/runtime remain unverified.

jsdom is a development dependency, not a runtime dependency. Install project development dependencies before running the browser integration:

```sh
npm install
npm test
```

For Parquet tests, set `MARKET_DUCKDB_BIN="$(pwd)/data/bin/duckdb"` on macOS arm64; another OS needs a matching DuckDB CLI. Live HTTP is verified on the managed host; Docker and full-universe bootstrap completion are separate checks.

## Documentation

- [Requirements and implementation status](docs/REQUIREMENTS.md)
- [Architecture and data flow](docs/ARCHITECTURE.md)
- [Operations and recovery](docs/OPERATIONS.md)
- [Original product requirements](PRD.md)
