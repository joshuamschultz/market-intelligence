# Market Intelligence

A local research workspace for US equity breadth, relative strength, screening, industry leadership, and historical market studies. This is a decision-support tool, not an automated trading system.

## Current state

The app is a Node 24 modular monolith with a browser UI and persistent SQLite warehouse. The managed preview remains available at <http://127.0.0.1:4173>. The warehouse now contains imported data version 18,914: 14,060,949 daily price rows, 14,073,659 price revisions, and 10,094 securities. This import adds reviewed listed-issue history; preparation for the new revision is underway, so previously verified archives at v18,911 do not establish current v18,914 cache readiness. The v18,914 compressed SQLite backup now passes SQLite integrity and independent stream readback. The prior v18,911 managed backup was pruned by the configured retain-one policy. Broad-market history still starts in 2016-11, and early dates remain sparse. See [docs/OPERATIONS.md](docs/OPERATIONS.md) for source scope, readiness, and recovery steps. The `data/` directory is git-ignored local runtime state and persists across app restarts.

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

EODHD daily prices, bulk history, split actions, and delisted listings are accessible with the configured account. The prior core capture included 9,439 price and 9,439 action tasks across 15 ETF benchmarks; 96 tasks had no history or invalid input. The v18,914 import added 14,060,949 daily price rows, 14,073,659 revisions, and 10,094 securities, including a reviewed 233-ticker listed-issue expansion. These capture/import totals do not establish complete historical market membership. A prior strict core receipt at v18,911 was partial (5,151/5,258 expected; 5,457/5,564 source IDs matched). Type verification was partial and historical float was unavailable. EODHD fundamentals and symbol-rename endpoints returned HTTP 403. SEC enrichment provides dated classifications and shares facts but does not establish complete point-in-time membership or float.

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

- EODHD: bulk/daily prices, splits, and delisted listings are accessible with the configured account. The v18,914 warehouse has 14,060,949 prices / 14,073,659 revisions across 10,094 securities after the listed-issue import. Some reviewed price windows remain quarantined. EODHD fundamentals and ticker-rename endpoints return 403.
- SEC: 47 quarterly filing datasets (2015 Q1–2026 Q3) and 5,321 valid CompanyFacts inputs have been imported. The latest import contains 99,090 filing-dated classification observations for 3,610 positively matched issues, 83,824 dated shares observations, and no float observations. Of 5,388 CIK requests, 5,324 returned successfully and 64 returned upstream 404; three HTTP 200 payloads without a CIK were quarantined. SEC classifications bridge through the current catalog and do not prove a complete historical US universe.
- Nasdaq: the latest typed-reference import contains 4,493 classifications and 4,344 cap observations, matched to 4,632 identities. A separate official Nasdaq Composite (`IXIC.INDX`) series with 2,990 daily bars was imported as an index reference, not as a constituent or ETF benchmark. Typed classification/cap values are current-capture values, not historical series.
- Delisted records are present, but terminal-date/return completeness and ticker-reuse resolution are not established. Latest provider status showed 4,298 delisted records with no known terminal dates. Historical float is not available in current source loads.

See `npm run ingest -- status` and Settings → Data Quality for changing import and coverage state. The 5,155 traded / 4,046 ranked counts and 5,151/5,258 strict receipt are from v18,911 and should be treated as historical context after the v18,914 import. Float observations remain unavailable. The native UI verified historical `above_50d` counts of 2,469/4,732 on 2026-08-25 and 969/4,409 on 2026-11-20 under the prior context. Do not interpret those readings or a partial receipt as a whole-market guarantee.

### Preparation and expanded coverage import

The v18,914 listed-issue import is committed. Its reviewed input covered 233 directory-confirmed current tickers (229 new issue identities and four issuer-alias links), 439,864 valid source bars and 1,914 actions; 439,197 bars were new or changed. A local Nasdaq replay matched 4,842 identities. The plan withheld 23 stale provider symbols, 1,307 pre-listing bars, and 376 invalid OHLC rows. These are not proof of complete historical US-market coverage. Initial v18,914 preparation has started, but the broad historical backfill and complete analytics grid are not ready; inspect the exact context status before relying on results. Captured history and raw provider responses are retained, and daily capture appends new sessions. A partial receipt does not cause periodic full-history redownloads. Use targeted repair for known gaps; use `--force` only when intentionally restarting a plan or refreshing its source catalog.

After a dataset import commits, background preparation covers built-in universes and models plus saved definitions. It prioritizes current, then recent, then full-history chunks. Normal analytical GET requests read prepared results and report exact context readiness instead of starting expensive calculations; a missing context is reported as unprepared. Start an explicit materialization job to prepare it and poll that job. Large full-grid preparation can take hours and is admitted only when workspace disk headroom is sufficient. Seventeen representative context snapshots project to about 34 GiB alone, before remaining contexts and backups; latest measured free space is about 36 GiB. Do not assume recent results are ready until status reports them complete. The application calculates locally from captured data; provider access is used for capture, not analytical reads.

The screener's high/low filters support percentage distance from rolling highs/lows and strict trading-session ages since a session exceeded the preceding rolling high or fell below its low. Equal highs/lows do not reset the strict-crossing clock; age of the current rolling extreme is a separate field. The 52-week window is 252 sessions. Example filters include at least 30 sessions since a 20-session high or at least 250 since a 252-session low; these are filter values, not minimum-history requirements. The rolling window and prior-extreme event must be supported by contiguous, source-safe history. The ticker page shows six months (126 sessions) of candles and context-specific metrics, with a TradingView link. Built-in Stockbee-style presets are fixed at 4%/1D, 25%/63D, 25% or 50%/20D, and 13%/34D. Custom rolling controls are separate and collapsed by default; no proprietary Stockbee formula is claimed.

The NYSE summation chart is an observed common-stock breadth proxy, not the published all-issues NYSI. It uses ratio-adjusted advancer/decliner counts, requires at least 20 traded names and 80% comparable coverage, and has a gap-resetting 80-session warmup with 10- and 20-session moving averages. The EODHD NYSI symbol probes returned 404, so the proxy is explicitly labeled and may have gaps. Health views distinguish observed/descriptive readings from strict coverage-gated scores; a strict score is withheld when its configured support threshold is not met. Nasdaq's current taxonomy is not historical; SEC/SIC as-of classifications are the available dated industry context.

## Market Journal

The Market Journal route supports saved daily reports, revisioned Markdown prompts/skills, custom numeric factors, sentiment, health/risk scores, and factor charts/backtests. User notes are stored separately as dated revisions; including a note in a Claude request requires an explicit opt-in for that generation. Reports record the actual availability time and next eligible session, so historical factor studies do not treat a report as known before publication. Retrospective reports are labeled and excluded from backtests by default.

Configure the Anthropic API key in Settings → Journal. It is encrypted with AES-256-GCM and stored locally using a private 32-byte vault file (`data/.journal-key`, mode 0600); the database stores encrypted key material. The current workspace has no Anthropic key configured and no generated reports or notes, so live Claude generation has not been exercised. Browser integration used a mock Claude client. Never put API keys in prompts, notes, browser code, or documentation.

The optional CLI is `node scripts/journal.mjs status|generate|daily|series|prompt`; see `node scripts/journal.mjs --help`. The app can schedule one generation after a complete published market session when Journal scheduling is enabled.

The last fully verified materialization is data version 18,911 and calculation version `2-be44dec1f429`: 2,990 SEC/as-of/SPY daily rank dates, 621 weekly dates, 315-session standard/Monitor caches, and all-model velocity/ATH snapshots. These results are a previous revision, not readiness evidence for v18,914. The new revision has queued background preparation; check the exact status before using it. For example:

```sh
npm run materialize -- status --classification nasdaq --reference latest --benchmark SPY --data-version 18914 --limit 315
npm run materialize -- status --classification sec-sic --reference as-of --benchmark SPY --data-version 18914 --limit 315
npm run materialize -- workspace --classification nasdaq --reference latest --benchmark SPY --data-version 18914 --all-models --daily-tail 1
```

The last verified SEC-classification historical context (v18,911) contains 2,990 sessions from 2015-01-02 to 2026-11-20, with daily ranks 2,990/2,990 and weekly ranks 621/621. The v18,914 import has not completed equivalent full-history preparation. The earliest ~2015–2016 dates contain only five original sample securities; broad market capture starts in 2016-11, so full date coverage is not full-market membership coverage for the entire period. Check the exact historical context, separately from Nasdaq/latest:

```sh
npm run materialize -- status --classification sec-sic --reference as-of --benchmark SPY --data-version 18914 --limit 7560
npm run materialize -- status --classification sec-sic --reference as-of --benchmark SPY --model composite --data-version 18914 --limit 7560 --ranks
npm run materialize -- status --classification sec-sic --reference as-of --benchmark SPY --model composite --data-version 18914 --limit 7560 --cadence weekly --ranks
```

Current Nasdaq/latest and historical SEC/as-of archives are different contexts. The CLI default classification is `provider`, so leaving out these selectors checks a different cache. Standard rank archive status can be checked separately with `--ranks`; custom monitor metrics use comma-separated `--metrics`:

```sh
npm run materialize -- status --classification nasdaq --reference latest --benchmark SPY --data-version 18914 --limit 315 --ranks
npm run materialize -- status --classification nasdaq --reference latest --benchmark SPY --data-version 18914 --limit 315 --metrics up_13pct_34d,down_13pct_34d
```

The `--metrics` option accepts comma-separated breadth keys such as `up_13pct_34d,down_13pct_34d`. Use an explicit preparation/materialization job for a cold large-catalog history context; read-only GET requests report its readiness and do not start the heavy calculation. Poll the explicit job and request the prepared series after it completes. `--with-ranks` stores breadth and ranking outputs together. Materializations are versioned by data and calculation context; check status before relying on a series. The complete v18,911 archive is a prior verified revision; v18,914 preparation is still in progress.

For a large uncached history request, the API may respond with `materialization.pending`, `jobId`, status, progress, and missing dates. The app polls the job endpoint and reloads the requested series after completion. The API also offers `POST /api/v1/data/materialize` with `{"kind":"rankings", ...context/options}` for rank-archive jobs and `POST /api/v1/data/bootstrap` for a resumable provider-bootstrap job; poll the returned job ID. Use `npm run bootstrap -- --help`, `npm run ingest -- --help`, and `npm run materialize -- --help` for CLI options. The live warehouse may be overwritten or extended by imports; take a backup before changing the source dataset.

## Refresh and backup

Frontend files are served without browser caching. The UI checks `/api/v1/build` every 30 seconds and shows a **Reload build** action when app assets change; reloading picks up the new version while data remains in SQLite. This supports the requested 15–30-minute app update cadence without resetting the database. Refreshing the application does not clear `data/market.sqlite`.

Price/Nasdaq capture is configured for 16:30 America/New_York with bounded retries; check job status before assuming a scheduled capture or its analytics completed. Use `/api/v1/build` and `data/active-release.json` to identify the active immutable build and its validation evidence. The v18,914 import has queued its initial preparation work; broad historical backfill and analytics preparation remain incomplete. Current free disk is about 36 GiB; 17 representative context snapshots project to about 34 GiB alone, before remaining contexts and backups, so check disk admission before extending the workload. The latest v18,914 backup has passed independent verification. Provider fundamentals remain off because those endpoints are unavailable under the current account. Development runs do not inherit managed-service schedules unless configured.

For a compressed SQLite backup, use `node scripts/backup.mjs create`; verify a specific bundle with `node scripts/backup.mjs verify <bundle-directory>`. The independently verified v18,914 bundle is `data/backups/market-sqlite-gzip-2026-11-21T21-49-53-936Z-8e39e2a2-23d3-45c1-a652-59726e4af059`. It contains 14,060,949 daily prices and 14,073,659 revisions across 10,094 securities; raw size is 11,802,427,392 bytes and gzip size is 3,342,373,937 bytes. The gzip SHA-256 is `2b0c27f12fb9c5fd1838002d1e5508f6fdcac4663ed5e3db03d0cc9977a47ce7` and the raw SHA-256 is `b2cec7694c06249f7c1a71059d33904d1c5b5b070f25462980c9bfc24e50a154`. SQLite `quick_check` and independent streaming readback passed; see `data/preparation-v18914-backup-report.json` and `data/preparation-v18914-backup-independent.json`. The previous v18,911 managed backup was pruned by retain-one and is not a recovery option. Earlier SQLite and Parquet artifacts came from a five-symbol sample and are not recovery points for the expanded warehouse. Optional Parquet backup uses the app's authenticated `POST /api/v1/data/backup` with `{"format":"parquet"}` and the configured DuckDB CLI. The local DuckDB v2.0.1 binary is macOS arm64 and is not suitable for the Linux Docker image. Docker build/runtime have not been verified. See [docs/OPERATIONS.md](docs/OPERATIONS.md) for backup verification and derived-archive recovery commands.

## Development checks

```sh
npm run check
npm test
```

The latest source candidate passed `npm run check` and 206/206 tests, including 229 real handler/browser requests (`data/release-research-r4-build.log`). Use `/api/v1/build` and `data/active-release.json` to identify the active immutable build and its validation evidence. The latest independent full-backup verification applies to v18,914. Docker build/runtime remain unverified.

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
