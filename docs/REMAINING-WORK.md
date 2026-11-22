# Remaining work

This checklist describes what remains for the current local single-user release. It separates software/release work from unfinished calculation, evidence, and source coverage. A completed screen or passing test does not establish complete provider history or a full-corpus performance result.

See the [requirements tracker](REQUIREMENTS.md) for feature-level status and the [PRD](../PRD.md) for the original scope.

## Current verified baseline

- Immutable R14 / app 0.2.4 is live with warm calculation `2-be44dec1f429`. Native Chrome verified the 52-week lows list, MRNA's 63-session candle card, and Market & Industries ChartBook with dated notes. R13 native checks covered the 6M daily Daily 4% Movers card, Space to the 5/10-session ratios, N opening a note, Escape closing without save, and 69 SEC industries; the industry chart showed 126/126 sessions from May 26–Nov 20 with SPY and 20/50-session moving averages on a common base. R14 verified that plot legends, zoom controls, actual-date/proxy captions fit above the footer; changing scope returns focus to content, where Space advances. The context is collapsed. R14 passed 342/342 exact source-index checks and 10 assembled UI checks; the prior R13 protocol suite passed 50 checks and Astra's independent focused suite passed 35. These checks do not constitute full native acceptance. The five-year archive remains unpublished and the 600-second target was not met.
- The local source warehouse is v18,914 with 14,060,949 daily price rows, 14,073,659 revisions, and 10,094 securities. The v18,914 full backup was verified, but a new backup is needed after the pending archive build and final workspace changes.
- The `2-081` generation's original serial oracle was superseded after a saved checkpoint. All warm-up and 1,260 core sessions, 10,007 instruments, 221,764 health outputs, and 2,990 NYSE outputs were completed and reused by a resumable four-worker recovery job. A separate queued preparation job was paused by its checkpoint guard; queued work and payload are retained, with no data loss. Bounded parallel verification is still in progress; production verification has not passed and the archive remains unpublished. The cold 600-second target was not met.
- Health readiness is separate from the failed generation. Current Nasdaq health is withheld because comparable coverage is 97.965%, below the configured 98% threshold; observed health at an 80% threshold has long-horizon support of 79.89% and high readings of 78.52%. The current Nasdaq industry baseline is absent. SEC/SIC industry health passes its support gate, while two other inputs remain below 80%; do not describe the default health context as ready.
- About 200 GiB of free disk was reported by the user; disk space is not the current admission blocker. A synchronous cold SQL read was observed blocking the HTTP process. The `market_history_read_scope` index was applied at 01:35:09 UTC in 466 ms for the matching read plan without changing data version 18,914 or calculation hash. End-to-end responsiveness still needs validation; do not infer that all cold reads are fast.
- Broad market coverage begins in 2016-11; 2015–2016 is only a small sample. No current status should describe the entire historical date span as complete US-market coverage.

## Release and usability

- [x] Promote R14 / 0.2.4 and verify the immutable build is live.
- [ ] Verify preview/warehouse persistence after the promotion and restart.
- [x] Run R14 validation: 342/342 exact source-index checks and 10 assembled UI checks passed; the R13 protocol suite's 50 checks and Astra's independent 35 focused checks also passed.
- [ ] Complete native user-acceptance review across overview/health, Market Monitor, Stock Lists/RS Rankings, Screener/Saved Screens, ticker detail, industries, historical research, ChartBook, settings/data quality, and readiness/job messages. The full source suite does not substitute for this screen-by-screen review.
- [ ] Record final deployed release/build evidence from the active manifest, keeping source-suite results distinct from deployed behavior and native review.
- [ ] Refresh stale release-status statements in project docs after the final build, calculation generation, and readiness checks are verified.

## Calculation, archives, and publication

- [ ] Continue bounded verification/recovery of the saved v18,914 / `2-081` five-year, 1,260-session output across all 87 declared recipes and contexts. The verifier is under optimization; establish whether the original failure occurred before or after sealing, then verify expected versus stored keys, missing dates, null reasons, job failures, and publication readiness before publishing.
- [ ] Reopen the published database in a fresh process and reconcile counts/checksums. Confirm current standard/Monitor/SEC tails, ranks, velocity, leadership, breadth, health, and NYSE summation readiness against the exact data/calculation/context versions.
- [ ] Reconcile the prior generation's 106 failed contexts/range separately from the current run. Confirm each is repaired or explicitly withheld; neither the prior failure count nor the current saved output is proof of readiness.
- [ ] Keep Nasdaq current-reference captures separate from SEC/SIC historical context. Nasdaq taxonomy captured now cannot supply missing earlier classification vintages; calculate only the historical group contexts supported by dated references.
- [ ] Run the separate full-available-history preparation/verification after the five-year slice. Early sample years and security-specific listing histories must remain visible in coverage counts.

## Performance and daily operations

- [ ] Measure the three-year all-universe cold compute, durable save, and fresh-process reopen as the initial gate; report all output families and context counts, not a warm API response.
- [ ] Benchmark the full available historical workload separately against the user's 600-second compute-and-save target. Include actual scan/calculation/write/reopen phases, CPU/memory, DB/WAL/archive and peak disk use. Neither the 1,260-session run nor a 3-year gate proves full ~10-year performance.
- [ ] Measure PRD targets independently: cached overview/detail and 10,000-row sort/filter, 10-year breadth retrieval, one custom latest RS recalculation, and daily end-to-end processing under 15 minutes after complete ingestion.
- [ ] Benchmark cold SQL history readers and HTTP responsiveness under preparation load. Validate that the new scoped index matches the intended query plan and determine whether cold reads must move off the synchronous request path or use bounded cache/background work.
- [ ] Verify the scheduled finalized-EOD path end to end: price sync, retry/quota behavior, duplicate-safe ingest, quality/reconciliation, affected-current-context recompute, atomic publication, and job/alert status. A configured schedule alone is not a successful daily run.
- [ ] After final precomputation, create and independently verify a new full backup, then confirm a restore/readback against the published data version. Preserve the existing verified v18,914 backup as a prior checkpoint.

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
