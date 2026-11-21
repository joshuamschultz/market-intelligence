# Operations

## Requirements and local preview

- Node.js 24 or newer; no npm runtime packages are required.
- Keep `.env` private. `EODHD_API_KEY` is read by server-side scripts only; never put credentials in frontend files, documentation, screenshots, or command output.
- Default host/port: `127.0.0.1:4173`. Default warehouse: `data/market.sqlite`. Override with `HOST`, `PORT`, and `MARKET_DB`.

Start a watched preview:

```sh
npm run dev
```

The preview is installed as a managed macOS launchd service and has been verified over HTTP and in Chrome at <http://127.0.0.1:4173>. Control it with:

```sh
npm run service -- status
npm run service -- start
npm run service -- restart
npm run service -- stop
```

The installed service label is `com.market-intelligence.workspace-16773464c4`. It watches backend sources and restarts on failure. Logs are in `data/logs/`; the installer creates the log directory mode 0700 and logs mode 0600. For a foreground preview use `npm run dev`; `npm start` disables file watch. Frontend refreshes do not reset SQLite.

## Inspect current data and jobs

```sh
npm run ingest -- status
npm run materialize -- status
npm run check
npm test
```

The latest source candidate at calculation version `2-be44dec1f429` passed `npm run check` and 206/206 tests, including 229 real handler/browser requests (`data/release-research-r4-build.log`). Use `/api/v1/build` and `data/active-release.json` to identify the active immutable build and its validation evidence. A SIGTERM recovery check confirmed the launchd service restored HTTP in 10.489 seconds (`data/service-recovery-verification.json`). Recent local timings were overview 184 ms, Monitor 347 ms, and rankings 295 ms; these are smoke measurements, not full-scale load tests. jsdom is a development dependency; install project dependencies and run the suite with the configured DuckDB CLI:

```sh
npm install
MARKET_JS_DOM="$(pwd)/node_modules/jsdom" MARKET_DUCKDB_BIN="$(pwd)/data/bin/duckdb" npm test
```

Use a DuckDB CLI built for the current operating system; the workspace binary is macOS arm64.

The runtime warehouse is now data version 18,914, with 14,060,949 daily price rows, 14,073,659 price revisions, and 10,094 securities. The import adds reviewed history for 233 directory-confirmed current tickers (229 new issue identities and four alias links), with 439,864 valid source bars and 1,914 actions; 439,197 bars were new or changed. Local Nasdaq replay matched 4,842 identities. The plan withheld 23 stale provider symbols, 1,307 pre-listing bars, and 376 invalid OHLC rows. These facts describe this import, not full-market historical membership. The previous v18,911 strict core receipt was partial (5,151/5,258 expected; 5,457/5,564 source IDs matched) and remains a historical audit result. Historical float remains unavailable. Check current status and coverage through `npm run ingest -- status`, `/api/v1/data/status`, and `/api/v1/data/quality` before interpreting market-wide metrics. `data/` is ignored local runtime state, not a checked-in database.

Check jobs through `GET /api/v1/jobs` or `GET /api/v1/jobs/{jobId}`. Long-running API jobs return a job ID; wait for `complete` and inspect the result/error before assuming the work published.

## Provider access and bootstrap

Check provider capabilities/account access before starting a large bootstrap:

```sh
npm run ingest -- probe
```

The configured EODHD account was verified for daily prices, bulk history, split actions, and delisted listings. EODHD fundamentals and ticker-rename endpoints returned HTTP 403. Do not assume an endpoint is available merely because the provider adapter supports it.

After outbound access works, confirm EODHD quota and licensing, then run the resumable bootstrap. The default plan spans at least ten years and can request the full eligible US catalog, benchmarks, delisted catalog/listing events, corporate actions, and (with `--reference`) current available reference facts. The call cap is a ceiling, not an estimate of actual charges or quota units:

```sh
npm run bootstrap -- --reference --max-calls 90000
```

For a small research subset:

```sh
npm run bootstrap -- --symbols AAPL,MSFT --max-calls 1000
```

The earlier ten-year price and corporate-action captures are complete for their requested task sets; 96 tasks were no-history/invalid. The v18,914 listed-issue import is committed; its full preparation pass and historical backfill remain incomplete, while its full backup is now verified. The v18,911 strict receipt remains partial historical evidence, and source quality / broad historical coverage remain incomplete. Provider fundamentals remain off. Check current state with `npm run ingest -- status` or `GET /api/v1/data/status`. Bootstrap persists checkpoints and daily usage reservations in SQLite so it can resume. It may return partial/paused when quota, budget, unresolved identities, or missing source records prevent full publication. A complete task count alone does not establish complete point-in-time market coverage. Avoid `--force` unless you intend to restart a plan and refresh its source catalog.

Price/Nasdaq capture is configured for 16:30 America/New_York with bounded retries; check job status before assuming a scheduled capture or its analytics completed. Use `/api/v1/build` and `data/active-release.json` to identify the active immutable build and its validation evidence. The v18,914 import has queued its initial preparation work; broad historical backfill and analytics preparation remain incomplete. Current free disk is about 36 GiB; 17 representative context snapshots project to about 34 GiB alone, before remaining contexts and backups, so check disk admission before extending the workload. The v18,914 backup has passed independent verification. Provider fundamentals/reference sync remains off because those endpoints are unavailable under the current account. These settings apply to the managed service; development runs need explicit configuration. Restart the server after changing `.env`.

Direct EODHD import and captured files are available through `npm run ingest -- eodhd ...` and `npm run ingest -- file ...`; see `npm run ingest -- --help`.

### Staged listed-issue expansion and preparation

The reviewed listed-issue expansion is committed as data version 18,914. It covers 233 directory-confirmed current tickers (229 new issue identities plus four issuer-alias links), 439,864 valid source bars, and 1,914 actions; 439,197 bars were new or changed. A local Nasdaq replay matched 4,842 identities. It withheld 23 stale provider symbols, 1,307 pre-listing bars, and 376 invalid OHLC rows. Check `npm run ingest -- status` for the durable import state; do not assume the queued analytics preparation or backup is complete.

Keep the normalized historical SQLite rows and raw source captures/sidecar manifests as the durable base. Daily capture is append-only; the capture receipt records expected, received, and matched issues separately from analytics coverage. A partial receipt is not an instruction to redownload the full history on each scheduled run. Repair a specific gap with a targeted range/capture; use `--force` only when deliberately restarting a plan or refreshing its source catalog. Calculations run locally over the committed warehouse.

After import, the preparation worker queues built-in universes/models and saved definitions, prioritizing current contexts, then recent history, then full-history chunks. Prepared-only read endpoints return the exact context's ready/partial/unprepared state; they do not compute a cold broad query inline. Use job status and materialization status to confirm readiness. A complete broad-market history grid may take hours and may fail disk admission if the workspace lacks sufficient free space for the planned contexts. Keep worker concurrency bounded, watch SQLite WAL/free disk, and do not describe recent or full-history analytics as ready before the corresponding preparation completes.

Screener range filters measure percent distance from rolling highs/lows, strict session ages since the prior rolling extreme was exceeded/broken, and age of the current rolling extreme separately. Equal highs/lows do not reset strict age. Example age filters include 30 sessions since a 20-session high or 250 since a 252-session low; these are filter values, not minimum-history requirements. The rolling window and prior-extreme event must be supported by contiguous, source-safe history. Ticker detail presents 126 sessions of candles and metrics scoped to the selected date/model/revision. Built-in Stockbee-style presets are fixed at 4%/1D, 25%/63D, 25% or 50%/20D, and 13%/34D. Custom rolling controls are separate and collapsed by default; proprietary formulas are not claimed.

The summation view is an observed NYSE common-stock RASI proxy, not the published all-issues NYSI; EODHD NYSI symbol probes returned 404. It requires at least 20 traded stocks and 80% comparable coverage and resets its 80-session warmup after a data gap. The chart includes 10/20-session averages. Observed health reports available, descriptive readings with the support counts; strict health withholds a score below its configured coverage threshold. Current Nasdaq classifications are not historical, so SEC/SIC as-of is the historical industry context.

SEC submissions/SIC and CompanyFacts imports use `scripts/sec.mjs`. The latest import contains 47 quarterly filing datasets (2015 Q1–2026 Q3), 5,321 valid CompanyFacts inputs, 99,090 filing-dated classification observations across 3,610 positively matched issues, 83,824 dated shares observations, and no float observations. Of 5,388 CIK requests, 5,324 returned successfully and 64 returned upstream 404; three HTTP 200 payloads without CIKs were quarantined. This identity bridge uses the current catalog and does not prove a complete survivorship-free historical universe. The downloader requires `SEC_USER_AGENT` identifying the application and a contact email, and is rate-limited. Import captured artifacts with:

```sh
node scripts/sec.mjs import --catalog data/sec-company-tickers-exchange.json --sic data/raw/sec/sic-codes.html --sub-dir data/raw/sec --facts-dir data/raw/sec
```

Use `node scripts/sec.mjs --help` for download/import options. Nasdaq screener captures are checksum-verified and ingested with `node scripts/nasdaq.mjs FILE.json`; latest typed-reference import contains 4,493 classifications and 4,344 cap observations matched to 4,632 identities. This is current reference state, not historical point-in-time classification or cap data.

Reconciliation and typed Nasdaq references are committed. A separate audit found seven security-specific source/identity/action issues; evidence-backed correction revisions 18,897–18,903 were applied, and the report is in `data/corrections-applied-report.json`. Examples include dated venue/alias changes, a merger last-trading date, and a verified reverse-split date. No price factor was inferred from an apparent chart jump. RITR/RITRF/RITRD were mapped across dated Nasdaq/OTC identities with a verified 1-for-250 consolidation; pre-split OTC volume with an unverified basis is withheld. POM and VCIG affected price windows remain quarantined until complete quote series can be verified. These targeted reviews improve the records but do not certify the full feed. The Nasdaq Composite is captured as a separate official `IXIC.INDX` index series; it is preferred over the QQQ proxy where available.

Reviewed overrides appear in Settings → Data Quality and Stock Detail. A correction must retain permanent security ID, effective interval, known date, reason, and HTTPS evidence. The system appends immutable revisions; clearing creates another revision and preserves earlier evidence/raw source. A volume-only override preserves otherwise valid price observations while volume-derived metrics remain null. To apply an audited manifest, inspect it first and use the script's dry-run default; only use `--apply` for a reviewed manifest:

```sh
node scripts/apply-verified-correction.mjs scripts/corrections/FILE.json
node scripts/apply-verified-correction.mjs scripts/corrections/FILE.json --apply
```

Never infer splits or other adjustment factors from price discontinuities alone. Keep unresolved price windows quarantined until an independently verified complete series is available.

The last fully verified caches are data version 18,911 / calculation version `2-be44dec1f429`, benchmark SPY: SEC/as-of history spans 2,990 market sessions with 2,990 daily and 621 weekly rank dates; Nasdaq/latest standard and Monitor and SEC/as-of standard caches cover 315 sessions; all three models' current and ATH velocity snapshots were warm. The newer v18,914 import has an initial preparation pass queued, so none of those cache counts certify readiness for v18,914. The prior v18,905 / `2-45c72c3cdb9b` derived archive is an older verified recovery bundle. Check v18,914 readiness with explicit context arguments:

```sh
npm run materialize -- status --classification nasdaq --reference latest --benchmark SPY --data-version 18914 --limit 315
npm run materialize -- status --classification nasdaq --reference latest --benchmark SPY --data-version 18914 --limit 315 --metrics up_13pct_34d,down_13pct_34d
npm run materialize -- status --classification sec-sic --reference as-of --benchmark SPY --data-version 18914 --limit 315
npm run materialize -- workspace --classification nasdaq --reference latest --benchmark SPY --data-version 18914 --all-models --daily-tail 1
```

Only five original sample securities are present in the earliest ~2015–2016 period; broad market capture begins 2016-11. Thus, even a complete date archive does not represent a whole-market universe for the earliest years. Check current full-period status with these explicit historical selectors. The CLI default classification is `provider`, so omitting `--classification` selects a different context:

```sh
npm run materialize -- status --classification sec-sic --reference as-of --benchmark SPY --data-version 18914 --limit 7560
npm run materialize -- status --classification sec-sic --reference as-of --benchmark SPY --model composite --data-version 18914 --limit 7560 --ranks
npm run materialize -- status --classification sec-sic --reference as-of --benchmark SPY --model composite --data-version 18914 --limit 7560 --cadence weekly --ranks
```

If status reports missing history after a source update, and no matching materialization job is already running, rebuild the requested context:

```sh
npm run materialize -- write --from YYYY-MM-DD --to YYYY-MM-DD --limit 7560 --force
npm run materialize -- status
```

This CLI materializes breadth/history by default. Use `--with-ranks` to calculate breadth and ranks in one pass, or `--ranks` to produce only the rank archive. `status` verifies the selected context. Custom monitor metrics use comma-separated `--metrics`:

```sh
npm run materialize -- write --from 2015-01-02 --to 2026-11-20 --limit 7560 --with-ranks --classification sec-sic --reference as-of --benchmark SPY --data-version 18914
npm run materialize -- status --from 2015-01-02 --to 2026-11-20 --limit 7560 --with-ranks --classification sec-sic --reference as-of --benchmark SPY --data-version 18914
npm run materialize -- write --classification nasdaq --reference latest --benchmark SPY --data-version 18914 --limit 315 --metrics up_13pct_34d,down_13pct_34d
```

Explicit materialization/bootstrap requests queue pinned jobs and return status/progress/missing dates. Analytical GET requests remain read-only: they return prepared data or readiness information without queueing a heavy calculation. The UI polls an explicitly queued job and reloads after completion. Workspace precompute stores recent daily metrics plus 13 canonical weekly/current dates per model. The `--with-ranks` mode keeps rank and breadth calculations together and reduces repeated history work. The prior provisional cache was exported to a reversible, checksum-verified gzip bundle and retired; a second v18,905 / `2-45c72c3cdb9b` derived slice was also exported and verified (856 MB) before retirement. Both preserved raw captures and saved research data. These are recovery artifacts, not current materialized results. The previous v18,911 workspaces, 315-date standard/Monitor/SEC caches, and 2,990-date history were complete under `2-be44dec1f429`. The v18,914 preparation pass is still underway; check its exact job and context status before relying on results. Earliest broad-market coverage remains limited as described above. Use `status` with exact context and calculation version before relying on a series.

Derived-archive lifecycle commands support count-only selection, export-and-retire of an exact calculation/data-version slice, verification, and restore. Default mode counts only. `--apply` writes and verifies the new bundle before retiring selected rows; restore adds missing rows into existing archive tables rather than replacing the warehouse. Use the exact versions printed by status and keep the manifest with the bundle:

```sh
node scripts/archive-derived.mjs --calculation-version VERSION --data-version N
node scripts/archive-derived.mjs --calculation-version VERSION --data-version N --apply --output NEW_DIRECTORY
node scripts/archive-derived.mjs verify NEW_DIRECTORY
node scripts/archive-derived.mjs restore NEW_DIRECTORY
```

Do not restore a retired derived bundle as current analytics. `data/derived-18896-2-df3da7d98a36` predates applied source corrections; `data/derived-18905-2-45c72c3cdb9b` is the verified prior-calculation slice (856 MB). Both are recovery artifacts only; current raw captures and saved research remain in the live workspace.

The server API also supports `POST /api/v1/data/bootstrap` to queue a resumable provider-bootstrap worker job; it returns a job ID to poll. The CLI `npm run bootstrap -- ...` runs the same bootstrap flow directly. Both use server-side provider credentials and can consume substantial quota. Start large history preparation explicitly through the materialization API/CLI; the job returns its pinned context, job ID, status, progress, and missing-date details. Poll `/api/v1/jobs/{jobId}` until complete, then issue the read request for the prepared series. Read-only GET endpoints do not queue cold calculations. The prior final runtime check (`data/final-runtime-verification.json`) reported HTTP 200, v18,911 / `2-be44dec1f429`, Journal scheduling ready, and no queued or running jobs. It predates the v18,914 import and queued preparation jobs.

## Backup and restore

Earlier SQLite and DuckDB/Parquet backups came from the five-symbol sample warehouse; do not restore those snapshots over the current expanded import. The latest independently verified backup is v18,914: `data/backups/market-sqlite-gzip-2026-11-21T21-49-53-936Z-8e39e2a2-23d3-45c1-a652-59726e4af059`. It contains 14,060,949 daily prices and 14,073,659 revisions across 10,094 securities; raw size 11,802,427,392 bytes, gzip size 3,342,373,937 bytes, gzip SHA-256 `2b0c27f12fb9c5fd1838002d1e5508f6fdcac4663ed5e3db03d0cc9977a47ce7`, raw SHA-256 `b2cec7694c06249f7c1a71059d33904d1c5b5b070f25462980c9bfc24e50a154`. SQLite `quick_check` and independent streaming readback passed; reports are `data/preparation-v18914-backup-report.json` and `data/preparation-v18914-backup-independent.json`. Retain-one pruned the previous managed v18,911 backup, so restore only from the current verified bundle or another existing independently validated copy. The DuckDB v2.0.1 macOS arm64 executable and SHA-256 manifest are in `data/bin/`; the macOS binary is incompatible with the Linux Docker image.

Create and verify a private compressed SQLite backup from the command line:

```sh
node scripts/backup.mjs create --retain 5
node scripts/backup.mjs verify data/backups/VERIFIED_BUNDLE_DIRECTORY
```

The bundle includes `market.sqlite.gz` and a verification manifest; validation checks compressed and restored content hashes plus SQLite integrity. The creator checks free space, writes privately, and applies retention only to eligible known backup bundles. Preserve the journal vault file separately if configured, or re-enter the key after restoring to a new vault. The current verified bundle remains in the workspace; copy a recovery bundle to independent storage for disaster recovery.

To create a fresh backup, submit an authenticated `POST /api/v1/data/backup` with `{}` for SQLite or `{"format":"parquet"}` for Parquet. Poll the returned job through `/api/v1/jobs/{jobId}` until complete; keep the resulting files and manifest. Parquet backup requires DuckDB CLI.

To restore a SQLite copy safely:

1. Stop the server and any ingest/materialization jobs.
2. Copy the chosen known-good `.sqlite` backup to a temporary file beside the target database.
3. Verify the copied file opens and `npm run ingest -- status --db /path/to/copy.sqlite` reports the expected date span and rows.
4. Preserve the existing database directory, including any `-wal`/`-shm` files, as a separate rollback copy. Replace the active DB only while the server is stopped, and remove stale WAL/SHM files only when they belong to the stopped database being replaced.
5. Start the app and re-check status and quality before resuming scheduled imports.

Keep at least one backup independent of the workspace volume for real deployments. Do not remove raw EODHD captures or older backups until a restore has been validated.

The local workspace permissions were checked: `data/` is mode 0700; database and `.env` are mode 0600. A scan of source/documentation files found no provider key outside `.env`. The journal vault key is stored separately at `data/.journal-key` with mode 0600 when the user configures an Anthropic key.

## Deployment and access controls

Dockerfile/Compose configuration is present, with a loopback-published port and persistent `market-data` volume, but the image build, container runtime, and network behavior are **unverified**. The Compose file does not install DuckDB or pass the local DuckDB path to the container. Before relying on Parquet in Docker, provide/install a compatible Linux CLI and configure `MARKET_DUCKDB_BIN`; do not use the workspace's macOS arm64 executable. Configure a long `MARKET_ACCESS_TOKEN` before using a non-loopback `HOST`; the server requires at least 20 characters for a non-loopback bind. Keep API/provider credentials server-side and terminate public HTTPS at a trusted reverse proxy if remote access is intentionally configured.

The server's automatic market sync is opt-in and follows the US market calendar/finalization delay. Long-running jobs use a persisted FIFO queue with one active job per workspace; queued jobs survive service restarts, and a failed job releases the next queue slot. Worker checkpoints are best-effort and occur outside business transactions. After an interrupted active job, inspect `/api/v1/jobs` and its checkpoint before resubmitting.

The prior eight-way full-history backfill saturated SQLite WAL/disk capacity and was recovered using a checkpoint and bounded three-worker/60-session batches; those prior ranges completed with raw captures and saved research preserved. The new v18,914 preparation pass is separate and has not completed. At the last status check, preparation remained incomplete and workspace free disk was about 36 GiB. Seventeen representative context snapshots projected to about 34 GiB alone, before remaining contexts and backups. Keep concurrency bounded and monitor free disk/WAL before extending work; broad preparation may take hours and can fail admission when headroom is insufficient.

## Research and export acceptance

Final acceptance artifacts include `data/final-archive-verification.json`, `data/final-current-verification.json`, `data/final-real-research-verification.json`, and `data/final-live-timings.json`. The archive check reports 2,990/2,990 daily and 621/621 weekly rank dates, complete SEC/as-of sessions, current Nasdaq/Monitor 315-date caches, and all three models' normal/ATH velocity snapshots.

The historical research case for 2024-07-15 used SEC/as-of data: `above_50d` was 2,918/4,768 and observed health was 61.881530 with an explicit 75% coverage threshold and 20-security minimum; the strict threshold withheld that score. A separate 2024 study evaluated 252 sessions and 42 events with finite SPY/QQQ forward returns. Weekly transition analysis returned 30,125 comparable transitions and the analog panel returned 10 examples. Outputs are descriptive. The default 80% threshold can withhold long-horizon inputs; current Nasdaq classifications lack dated historical vintages, so use SEC/SIC for historical industry and health analysis.

The Monitor supports adjusted window/threshold controls, means/deltas, drilldown, and chart zoom/reset. Native Chrome verified `up_4pct` contributors of 529/5,035 for 2025-08-25 and a current default of 127/4,791; `above_50d` was 969/4,409 for 2026-11-20. The official IXIC benchmark is preferred to QQQ when available. Parquet readback confirmed 5,155 rows, 4,046 ranks, 5,155 loaded-history-high values, and 4,409 EMA50 values. Timings were overview 184 ms, Monitor 347 ms, and rankings 295 ms; these are local smoke timings, not scale guarantees.
