# Remaining work

This checklist describes what remains for the current local single-user release. It separates software/release work from unfinished calculation, evidence, and source coverage. A completed screen or passing test does not establish complete provider history or a full-corpus performance result.

See the [requirements tracker](REQUIREMENTS.md) for feature-level status.

## Current verified baseline

- The current package version is 0.2.7; use `/api/v1/build` and `data/active-release.json` to identify the active immutable build. Data version 18,914 is published through Nov 20 with calculation `2-081799bad3bf`; full readiness reports 1,260/1,260 history and NYSE summation sessions and 68 SEC industry groups with both velocity products ready. This is readiness for the declared archive contexts, not proof of complete survivorship-free market membership. The cold five-year rebuild took 72.6 minutes, exceeding the 600-second target; full available history has not been timed.
- Before the workspace CLI was added, the source suite passed 351 tests; the CLI has 15 focused tests, the daily workflow seven, and ordered catch-up 64 focused tests. Catch-up checks cover Mon–Tue sequencing, worker/restart recovery, stale queued work, retries, and bounded explicit backfill; a real provider trading day remains unobserved. R17 native smoke covered watchlist/alert editor Escape and focus restoration, RS sorting, screener high/low fields, Stock Lists, industry heatmap/scatter with 68 velocity groups, five-year history, Journal key/prompt controls, and overview lows with sticky 25-row paging. These targeted checks do not establish that all write flows or every screen are complete. The release builder gates promotion on a fresh complete suite and records its results in release evidence.
- The local source warehouse is v18,914 with 14,060,949 daily price rows, 14,073,659 revisions, and 10,094 securities. A matching prepared-archive backup passed integrity checking and exact-version readiness readback in a fresh read-only process; a full service restore has not been exercised.
- The original serial `2-081` verifier was cancelled/superseded after a saved checkpoint. Its warm-up and all 1,260 core sessions, 10,007 instruments, 221,764 health outputs, and 2,990 NYSE outputs were reused by a resumable four-worker job and published. A separate queued preparation job was superseded from its saved checkpoint; payload and data were retained. A cold rebuild of the five-year archive is measured at 72.6 minutes. The daily incremental chain is implemented and reviewed; ordered catch-up has passed 64 focused tests covering sequencing, restart/recovery, retries, and bounded backfill. V8 completed the same synthetic next-session workload as V7 in 179.137 seconds (2.94× faster): 5,747 prices, 10,007 detail rows, 30,021 risk rows, 87 logical recipes / 89 physical scopes, 1,261 history sessions, 504 health outputs, one NYSE summation series, and 199 cold industry proxies. It ran on an Apple M5 Max (18 CPU cores, 128 GiB RAM), 23,592 MiB worker heap; filesystem cache was uncontrolled and prior runs may have warmed inputs. Raw import took 24.639 seconds; raw publication plus calculations took 149.59 seconds, with reopen/readback included in the end-to-end time. Peak RSS was 4,665,952 KiB (about 4.45 GiB). Inputs were synthetic; provider/reference/action downloads, Claude, backup, and HTTP transport were excluded. The live warehouse remained at v18,914 / Nov 20. Independent persisted-output parity passed across 29 stages and 15 read-only API samples, with no missing rows or mathematical differences. This is not a real trading-day result or proof of the full-history cold target.
- The latest disk report showed about 1.0 TiB available; storage was not the bottleneck for the published archive. A synchronous cold SQL read was observed blocking the HTTP process. The `market_history_read_scope` index was applied for the matching read plan; end-to-end reader responsiveness still needs validation.
- Broad market coverage begins in 2016-11; 2015–2016 is only a small sample. No current status should describe the entire historical date span as complete US-market coverage.

## Release and usability

- [ ] Promote the 0.2.7 immutable build and verify it is live.
- [ ] Verify preview/warehouse persistence after the promotion and restart.
- [x] Run the pre-CLI source suite (351 passed), 15 focused workspace CLI tests, and seven focused daily-workflow tests.
- The release builder gates promotion on the complete suite and records the final test result in release evidence.
- [ ] Complete native user-acceptance review across overview/health, Market Monitor, Stock Lists/RS Rankings, Screener/Saved Screens, ticker detail, industries, historical research, ChartBook, settings/data quality, and readiness/job messages. The full source suite does not substitute for this screen-by-screen review.
- [ ] Record final deployed release/build evidence from the active manifest, keeping source-suite results distinct from deployed behavior and native review.
- [ ] Refresh stale release-status statements in project docs after the final build, calculation generation, and readiness checks are verified.

## Calculation, archives, and publication

- [x] Publish the five-year v18,914 / `2-081799bad3bf` generation; current full readiness reports 1,260/1,260 history and NYSE summation sessions and 68 SEC industries with both velocity products.
- [x] Reconcile expected/stored keys, partition coverage, and publication state; fresh read-only process confirmed the published version and readiness. The matching backup passed integrity and readiness readback.
- [x] Reopen the published database in a fresh process and confirm current 1,260-session history and NYSE summation plus SEC group velocity readiness.
- [ ] Keep Nasdaq current-reference captures separate from SEC/SIC historical context. Nasdaq taxonomy captured now cannot supply missing earlier classification vintages; calculate only the historical group contexts supported by dated references.
- [ ] Run the separate full-available-history preparation/verification after the five-year slice. Early sample years and security-specific listing histories must remain visible in coverage counts.

## Performance and daily operations

- [x] Measure the cold five-year rebuild: 72.6 minutes. This exceeds the user's 600-second compute-and-save target; no full-available-history timing is recorded.
- [ ] Optimize and rerun the full-available-history cold build within 600 seconds; retain all declared outputs and verify fresh-process reopen. Report scan/calculation/write/reopen phases, CPU/memory, DB/WAL/archive, and peak disk use.
- [ ] Measure the three-year all-universe cold compute, durable save, and fresh-process reopen as a separate initial gate; report all output families and context counts, not a warm API response.
- [ ] Measure PRD targets independently: cached overview/detail and 10,000-row sort/filter, 10-year breadth retrieval, one custom latest RS recalculation, and daily end-to-end processing under 15 minutes after complete ingestion.
- [ ] Benchmark cold SQL history readers and HTTP responsiveness under preparation load. Validate that the new scoped index matches the intended query plan and determine whether cold reads must move off the synchronous request path or use bounded cache/background work.
- [x] Implement and review the daily incremental chain: fetch only missing finalized sessions and append calculations from stored outputs; changed history or analysis scope requires an explicit verified backfill.
- [x] Complete the V8 synthetic next-session benchmark in 179.137 seconds with saved/reopened outputs; uncontrolled filesystem cache and synthetic inputs prevent treating it as a live-day or cold-history performance result.
- [x] Complete independent persisted-output parity review between V7 and V8: 29 stages and 15 read-only API samples had no missing rows or mathematical differences.
- [x] Verify ordered multi-day catch-up, worker/restart recovery, stale queued work, retry schedule, and bounded explicit backfill with 64 focused tests.
- [ ] Observe a live next-trading-day run and measure processing after real finalized prices; test live provider quota behavior and confirm publication/status on that real run.
- [x] Create and independently integrity-check a backup matching the published v18,914 archive; a fresh read-only process confirmed exact-version readiness.
- [ ] Exercise a full service restore from that backup and verify restored outputs.

## Provider data and evidence limits

- [ ] Improve and report actual expected/received coverage by date and universe; review source corrections and quarantined price windows such as POM/VCIG before treating affected returns/volume as usable.
- [ ] Establish trusted dated public-float data. Current float coverage is zero; do not derive float from shares outstanding or apply a current value to past dates.
- [ ] Establish complete point-in-time membership, historical security identity/ticker-reuse continuity, and delisted terminal returns. SEC data currently join through the present catalog, and Nasdaq classifications are current-capture only.
- [ ] Resolve provider capability and license questions. EODHD price/bulk/action/delisted access is available; fundamentals and rename requests have returned 403. Verify whether another entitlement/source is required for the remaining fields and intended use.
- [ ] Preserve unresolved or unsupported facts as null, excluded, quarantined, or right-censored, and keep their counts visible in screens, breadth, studies, and acceptance reports.

## Optional scope and user configuration

- [ ] If the user wants live Market Journal generation, configure a supplied Anthropic key and verify one real generation and the scheduled path. Current mock tests do not prove a live Claude response; no key has been supplied.
- [ ] During UX acceptance, confirm whether a named pullback preset is needed. The screener can express basic pullback-from-high conditions using arbitrary high-distance windows; the PRD does not specify a separate pullback formula. Consolidation duration currently means trailing sessions contained in a 10% range, capped at 63 sessions.
- [ ] Consider PRD §21's market-cap/liquidity/float cohort breadth and cross-sectional daily return distributions (including dispersion/skewness) as future analytics; these are distinct from implemented forward-return study distributions. Other §21 candidates, including lifecycle, analogs, transitions, and breakout breadth, already have implementations.
- [ ] Treat remote/multi-user deployment, HTTPS hardening, roles/ownership, email alerts, and Docker verification as optional expansion beyond the local single-user release. If external access is requested, scope and validate those controls before exposing the service.

## What is not a new implementation task

Core ranking, screening, monitor, breadth, group/history, research, archive, recovery, and scheduled-job code already exists. Remaining unchecked requirements should be closed only with current-version evidence or a specific identified gap; an old release's archive, a smoke timing, or an unchecked PRD box is not evidence that the corresponding code is absent or complete.
