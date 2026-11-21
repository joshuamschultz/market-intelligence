# Architecture

## Runtime shape

The workspace is a dependency-free Node.js 24 modular monolith. `backend/server.mjs` serves the static browser app and same-origin JSON API; `backend/service.mjs` routes API calls and schedules jobs; `backend/job-worker.mjs` runs longer jobs in worker threads. The UI is plain browser JavaScript modules under `frontend/`. A Dockerfile and Compose configuration are provided, but Docker image build/runtime and network behavior have not been verified; the local Node process is the intended preview path.

SQLite (`node:sqlite`) is the persistent market warehouse and canonical source for the app. Its database defaults to `data/market.sqlite` and can be relocated with `MARKET_DB`. It uses WAL, foreign keys, a busy timeout, and durable tables for securities, dated identifiers, daily prices and revisions, corporate actions, fundamentals, classifications, SEC/Nasdaq source evidence, ingestion runs, workspace definitions, snapshots, rank archives, jobs, alerts, and journal content/settings.

This is a deliberate prototype stack choice. PRD §15.1 recommends Next.js/React, FastAPI, PostgreSQL, DuckDB/Polars, and Parquet; it does not mandate them. The current app instead uses Node, browser modules, and SQLite for a small, immediately usable local workspace. DuckDB is an optional external CLI used for Parquet exports/backups. Assess performance against the PRD targets before claiming those targets at full-market scale.

## Canonical calculation path

All app workflows use the shared engine in `backend/engine.mjs` and metric/ranking/breadth modules. A calculation context pins the as-of date, universe and version, RS model and version, benchmark, classification system, price basis, data version, and coverage threshold. Snapshots and archived results retain context and calculation-version identifiers so the screener, overview, monitor, groups, rankings, and historical queries can share definitions.

Analytics source files are SHA-256 hashed into `CALCULATION_VERSION`. Warehouse imports are fingerprinted and versioned. Price revisions and effective/known timestamps preserve corrections and the distinction between when a fact applied and when it became known. Materialized history and rank archives are keyed by context/version; rebuilding does not silently erase prior versions. For large cold history requests, the API queues calculations with a pinned context and reports pending job ID/status/progress/missing dates. A persisted FIFO queue runs one job per workspace; queued work survives restart, failed work releases its slot, and checkpoints are best-effort outside business transactions. The UI polls and reloads the series after completion.

The engine computes security-level measures from dated prices and aggregates breadth/group metrics from the same selected universe. Breadth records carry numerator, denominator, and coverage; metric-specific history sufficiency is enforced. The breadth contributor drawer includes a historical trend for the selected metric; selecting a session loads that date's qualifying, comparable, and excluded securities. Existing contributor selection, watchlist addition, and CSV export remain available. Incomplete coverage is exposed and can suppress a market-health score rather than silently returning a normal-looking value.

`backend/precompute.mjs` materializes a compact current workspace: recent daily snapshots plus canonical weekly points, velocity, breadth, and rank rows, optionally for all saved RS models. Larger history queries enqueue a pinned worker job; callers receive job ID/status/progress/missing dates while the UI polls. `--with-ranks` computes breadth and ranks together in one history pass.

## Data flow

1. EODHD provider adapter fetches EOD prices, bulk market history, corporate actions, security catalogs, delisted records, and supported reference data. The current account returns 403 for fundamentals and ticker-renames endpoints.
2. Quota-aware bootstrap checkpoints listings, price/action/reference tasks and publishes only after coverage checks. Import validation normalizes symbols/exchanges/types, resolves security identity where evidence allows, quarantines ambiguous aliases, rejects invalid observations, fingerprints source batches, and transactionally records accepted rows/provenance. Per-security reviewed quality overrides retain effective and known dates, reason, evidence, and immutable revisions; clear actions append a revision instead of deleting history.
3. SEC tooling imports dated SIC classifications and selected shares-outstanding facts from official SEC data. Nasdaq screener capture adds a dated current classification/reference snapshot. Source evidence and checksum manifests preserve capture dates. Neither source alone establishes complete point-in-time market membership; historical float remains unavailable.
4. SQLite stores prices, corporate actions, reference facts, SEC/Nasdaq evidence, ingestion runs, and source versions. Raw EODHD captures/manifests live under `data/raw/eodhd/`; SEC artifacts are in `data/raw/sec/`.
5. The canonical engine derives metrics, RS ranks, group summaries, breadth, health/regimes, and contributor sets for a pinned context.
6. Materialization and rank-archive jobs persist selected daily/weekly history. Verified daily publication occurs only after input coverage and stored analytics/ranks are checked; publication markers and alert updates commit together. Retry can publish stored raw data without another provider request. Worker jobs expose queued/running/complete/failed state and progress.
7. Same-origin API serves the UI, exports, quality status, and job state. CSV is built in; Parquet is available when DuckDB is installed/configured.

Bootstrap stages are checkpointed and quota-aware. They support resume and partial completion; only an eligible-core catalog with adequate expected/received coverage is published as complete. A five-symbol dataset remains sample scope even when it spans ten years.

## User interface and API boundaries

The primary UI has distinct Market Overview and Market Monitor routes. The monitor is a date-aligned timeline of horizontal up/down participation bars with adjustable window/threshold, optional counts, historical extremes, and contributor drilldown. It is not a panel substituted into the main overview.

Key API surfaces include:

- `GET /api/v1/config`, `/data/status`, `/data/quality`
- `GET /api/v1/market/overview`, `/market/breadth`, `/market/monitor`, `/market/health`, `/market/events`
- `GET /api/v1/rankings`, `/stocks/{id}`, `/stocks/{id}/metrics`, `/stocks/{id}/rankings`
- `POST /api/v1/screens/query`; saved collection APIs for screens, universes, ranking/health models, watchlists, themes, cohorts, and alert rules
- `GET /api/v1/industries`, `/industries/{id}`, `/industries/compare`
- `POST /api/v1/research/cohorts`, `/research/event-studies`
- `GET/PUT /api/v1/journal/settings`, `GET/POST /api/v1/journal/prompts`, `POST /api/v1/journal/generate`, `/journal/backtest`, `GET /api/v1/journal/series`, dated entry and note routes
- `POST /api/v1/data/import`, `/data/refresh`, `/data/reference`, `/data/bootstrap`, `/data/probe`, `/data/materialize`, `/data/backup`; `GET /api/v1/jobs`

Dates, universe/model versions, paging, and exports are passed through the shared context and API query/body contracts. The server applies same-origin mutation checks, JSON size limits, restrictive security headers, optional bearer/basic workspace authentication, and a loopback-host guard.

## Current evidence and boundaries

At the latest import: 47 SEC quarterly filing datasets (2015 Q1–2026 Q3) and 5,321 valid CompanyFacts inputs produced 99,090 filing-dated classification observations across 3,610 positively matched issues and 83,824 dated shares observations; no float observations were found. Of 5,388 CIK requests, 5,324 returned successfully, 64 upstream 404s, and three malformed HTTP 200 payloads were quarantined. Latest Nasdaq typed-reference import has 4,493 classifications and 4,344 cap observations matched to 4,632 identities; these are current reference facts, not a historical cap series. SEC identity uses the current catalog and does not prove complete point-in-time universe membership.

EODHD prices, bulk history, splits, and delisted listings are accessible. EODHD fundamentals and rename endpoints returned HTTP 403. The provider status had 4,298 delisted records but zero known delisting dates at a snapshot, so terminal-return coverage remains unverified. No historical float is available. The Journal currently has a built-in prompt, but no Anthropic key is configured and no generated entries/notes exist yet; live Claude calls have not been made.

Current warehouse data version is 18,911; frozen calculation version is `2-be44dec1f429`. Capture completed for 9,439 price tasks and 9,439 corporate-action tasks across 15 ETF benchmarks; 96 tasks were marked no-history/invalid. The separate official Nasdaq Composite `IXIC.INDX` index series was imported with 2,990 observations and is not treated as a stock constituent or ETF benchmark. Daily capture through November 20 was published. Seven evidence-backed corrections were applied through data versions 18,897–18,903. The latest strict core receipt is partial: 5,151/5,258 expected (97.9650%) and 5,457/5,564 source IDs matched. Retained prices include 5,155 traded and 4,046 ranked; type verification remains partial, and historical float is unavailable. These measurements are context-specific and do not certify the feed. The managed macOS launchd service runs the promoted build and scheduled price/Nasdaq/precompute/backup jobs are enabled. The `data/` directory is git-ignored local runtime state.

At v18,911 / `2-be44dec1f429`, SEC/as-of history has 2,990/2,990 daily market sessions and ranks; weekly ranks are 621/621. Nasdaq/latest standard and Monitor and SEC/as-of caches each cover 315/315 dates. All three models' current and ATH velocity snapshots are warm. The prior v18,905 / `2-45c72c3cdb9b` derived slice was exported and verified before retirement; raw captures and saved research were not changed. Current API timing samples were overview 184 ms, Monitor 347 ms, and rankings 295 ms; these are smoke timings, not full-scale load tests. The early-date limitation remains: only five original sample securities in the earliest ~2015–2016 dates, with broad-market capture beginning 2016-11.

The earlier verified 12-year Parquet export/readback and SQLite backup used the five-symbol sample warehouse; they do not represent the expanded live database. The final v18,911 full-warehouse compressed SQLite backup passed integrity and independent verification: 13,623,872 price rows and 13,634,462 revisions across 9,865 securities (10,747,887,616 raw bytes; 2,878,210,438 compressed bytes). SQLite remains the live database, with DuckDB an optional Parquet tool. Historical float, complete point-in-time membership/ticker reuse, delisting terminal returns, provider entitlements/licensing, live Claude generation, and production-scale performance remain unverified.
