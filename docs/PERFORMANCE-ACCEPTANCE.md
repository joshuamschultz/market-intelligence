# Performance Acceptance

## Goal and status

The user's primary target is to calculate and durably save the full historical analytics for every downloaded ticker in about ten minutes. The acceptance limit is **600 seconds from an explicit preparation request to durable completion**, measured on a declared machine and fixed release/data/context manifest. Provider downloading and ingestion happen before the timer; calculation, reading the imported warehouse, materializing every declared output, SQL writes, and commit happen inside it. Queue wait is reported separately and should be zero for a controlled run. Close/reopen and exact output-count verification are required before calling the result saved. A compressed backup is a separate operation and is not included in the 600 seconds.

No current result demonstrates this target. Cached API timings and the earlier archive preparation do not measure a cold all-ticker calculation. The v18,914 source warehouse is imported, but complete full-history/current-context preparation has not been verified. The current documented storage check found about 36 GiB free while 17 representative context snapshots alone project to about 34 GiB, before remaining contexts and backups; capacity admission is a prerequisite, not evidence of performance.

The v18,914 input basis contains 14,060,949 daily price rows. Processing that many source rows within 600 seconds requires at least about 23,435 rows/second before calculation and output writes, so report measured scan and write throughput rather than extrapolating from a small sample.

## Required benchmark scopes

Run both scopes against the same declared security roster and calculation matrix. The three-year all-universe run is the initial gate; it cannot stand in for the separate full-history result.

| Scope | Date range | Pass target |
| --- | --- | --- |
| Initial gate: three-year all-universe slice | Three complete calendar years ending at the last included completed session, all downloaded security identities with their available source history | ≤600 seconds for the entire declared calculation matrix, durable save, and fresh-process reopen |
| Full-history benchmark | Every available historical session for every downloaded security (about ten years where available), through the last included completed session; do not shorten security-specific histories to a common recent window | Separately target ≤600 seconds for the same matrix and durable save |

For every run, record first and last output session, expected market sessions, securities with source history, received/traded/comparable populations by context, and known source gaps. Broad market history begins later than the earliest sample records; a full date span must not be presented as complete historical US-market membership.

## Freeze the workload before timing

Create a versioned manifest before each run. It must identify:

- Active immutable release ID and fingerprint, data version, calculation version, source/correction revisions, price basis, and input capture manifest/checksums.
- All permanent security IDs in the downloaded catalog, dated ticker/alias mappings, source-eligibility rules, delisted/history treatment, and explicit exclusions with reasons. Ticker strings are not security identity.
- Ordered session dates and the source-history start/end for each security. Load the full warm-up required before the first output date: up to roughly 1,015 calendar days for long rolling measures; all available prior history for loaded-history ATH. Include the prior 12 weekly observations required by velocity/persistence outputs.
- The complete declared context matrix: built-in and saved universes, built-in and saved RS models, benchmarks, dated classification/reference modes, coverage settings, and any registered custom definitions. Include each output's required dates and security/group keys. Do not imply that every theoretical user-created context was calculated unless it appears in this matrix.
- Every supported derived output family in that matrix: per-security daily measures and detail/risk fields; daily and weekly ranks, percentiles, velocity, persistence, and leadership; daily breadth/Monitor; U/D and volume analytics; group/industry/theme summaries and rotation; health/regime/history outputs; and registered saved definitions. List concrete table/archive names and expected logical key counts in the manifest.

Run the three-year initial gate and full-source-history case as separate rows in the report. If an output family is not available for a context because of source limits, record its status and null/exclusion reason explicitly; do not silently remove the field or security from expected counts. Where independent historical classifications, public float, or point-in-time membership are unavailable, use their documented unavailable states. Do not fabricate inputs to increase coverage.

## Cold compute-and-save procedure

1. Make an isolated benchmark copy of the latest verified warehouse backup. Never clear or mutate the live workspace for a timing run.
2. Verify the input manifest and capture checksums. Confirm that the exact data/calculation/context slices being measured have no reusable derived rows, no warm process results, and no lineage-reused rows. Source prices/actions may be read; prior computed answers may not be used to meet the cold-run target.
3. Start with an idle worker queue. Invoke the same explicit preparation path intended for users. Time request acceptance through completed writes and durable commit. Record queue delay separately from worker wall time, and split worker time into input scan, calculation, serialization, and persistence phases.
4. Record rows and keys written for every output table/archive, by context and date. Also record expected versus actual security-date and group-date keys, ranks, breadth numerator/denominator/exclusions, null-reason counts, job failures, and unprocessed dates. A computed null is different from a missing output row.
5. Close the writer, reopen the database in a fresh process, and reconcile persisted counts/checksums against the manifest. Report SQLite integrity-check time separately from the 600-second compute-and-save timer. Include the database, WAL, derived archives, and any export bytes in storage measurements.
6. Repeat the three-year initial gate with three independent cold copies using the identical release, input, context matrix, and output coverage. The gate passes only when all three runs complete within 600 seconds and all persisted output checks pass. Report the full-history benchmark separately against the same 600-second target. If any run exceeds its limit or misses an output, report it as a failure with phase timings and the missing keys; do not reduce the ticker roster, history, context matrix, or output families to claim success.

## Correctness and no-lookahead gates

Speed does not waive calculation correctness. Before accepting a timed run:

- Run deterministic known-answer checks for split-adjusted returns, ranking weights, tie ordering/percentiles, breadth counts, rolling windows, and supported technical fields. Validate near-equal floating-point scores, exact ties, and null handling against the canonical calculation path.
- Compare EMA and other recursive measures with their required prior observations. In particular, test five-prior-session EMA drift and ensure the long-window warm-up is included before saving output.
- Reconcile every breadth value to its exact qualifying numerator and comparable denominator; verify constituent counts and exclusions against row-level records.
- For historical snapshots, require each input revision's `known_at` and each reference fact's availability/effective interval to be valid at the as-of date. Keep forward returns in explicitly labeled study outcomes only; never feed them into as-of ranks, screen fields, health, or features.
- Check alias and ticker-reuse identity boundaries, splits, quarantined intervals, and source corrections in the same data revision. Missing history remains null/withheld, not a synthetic zero.

## Separate workloads

| Workload | Measurement | Reference target or interpretation |
| --- | --- | --- |
| Full historical compute + save | Cold all-ticker history, all declared contexts and outputs, persisted and reopened as above | User target: ≤10 minutes (600 seconds) |
| Daily append | After complete ingestion, calculate/publish the new session and recompute affected current outputs for active contexts; include archive writes and publication checks | Separate from backfill; PRD §18.1 proposes <15 minutes after ingestion |
| Cached API reads | Measure overview, stock detail, precomputed breadth/history, and sort/filter on the declared 10,000-stock workload | Separate PRD targets include <2 seconds for overview, stock detail, and precomputed 10,000-stock filter/sort; 10-year breadth history <3 seconds |
| Provider collection/import | Request and validate provider data, then commit the source warehouse | Report quota, network, ingestion, and publication time separately; it is not part of the 600-second calculation timer |

An endpoint that returns quickly because its cache is already populated does not pass the historical-compute target. Likewise, a successful daily append or the three-year initial gate does not establish full downloaded-history performance.

## Evidence to retain

Store a per-run report beside the release evidence with: release/data/calculation fingerprints; workload manifest and input checksums; exact date/security/context/output counts; cold-cache proof; queue, phase, and total timings; rows/second; CPU and peak memory; database/WAL/archive sizes and peak disk use; integrity/reopen reconciliation; correctness checks; and any unavailable data or failed keys. Record hardware, operating system, filesystem/device, Node version, SQLite settings, worker count, and free space so another run can reproduce the result.

## Remaining gaps: software evidence and data

**Software/performance evidence.** The known gap is that no documented cold full-history all-ticker compute-and-save run has yet passed the 600-second target with exact output reconciliation and a fresh-process reopen. Full current/recent/history materialization for v18,914 is also not yet complete. These are measured-completion gaps; an unchecked PRD box alone does not prove a code feature is absent. Source review and an explicit output manifest are required before naming any additional software gap.

**Data limitations.** The imported warehouse contains real provider history but is not a complete survivorship-free US universe. Broad history begins in 2016; early dates have only a small sample. Historical public float, complete point-in-time membership/classification and ticker-reuse history, and terminal delisted returns remain unavailable or unverified. EODHD fundamentals and rename endpoints are unavailable under the current account. These limits affect the expected valid population and must be shown in the benchmark manifest and result; they cannot be fixed by computing faster.
