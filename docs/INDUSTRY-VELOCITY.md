# Industry velocity

> **Availability:** Current-membership group velocity is implemented in source, and the current warehouse projection was prepared and verified. The active immutable release may still precede this change; check `/api/v1/build` before relying on the UI or API fields.

Industry velocity measures how a group's relative-strength position changed between two exact weekly anchors. The projection reports four- and twelve-week changes for groups in the latest selected membership capture. It supplements the canonical dated industry ranks and does not replace them.

## Two membership bases

**Dated membership** uses the securities assigned to a group on each historical date. It is the appropriate basis for a point-in-time question, subject to the source's historical coverage. Filing-dated SEC/SIC data remains the historical reference when available.

**Current-membership backcast** starts from the selected group's members trading on the current market-session anchor, then freezes the subset with a finite RS percentile in the canonical current group ranking. It reads those members' archived stock RS percentiles at the anchor and at a past weekly endpoint. The same finite-RS cohort is compared at both dates. For a current Nasdaq view, this basis can provide a historical comparison when dated Nasdaq membership is unavailable. It is a present-day cohort applied to past observations, not historical membership.

The backcast is exposed as supplemental `currentMembership` data. Canonical group rank, percentile, dated velocity, historical events, and point-in-time series remain unchanged. The capture date, market anchor, comparison dates, classification source, and projection recipe/version should accompany any displayed or exported value.

## Calculation

For a market-session anchor, each horizon uses the last expected exchange session of the week ending four or twelve calendar weeks earlier. A holiday week may end on Thursday. The calculation requires that exact expected session; it must not silently substitute a later stored observation when the target session is missing.

For each group and horizon:

1. Freeze the unique permanent IDs that belonged to the group and traded on the anchor date. Separately count the subset with a finite current RS percentile; that current-ranked subset is the comparison cohort.
2. Keep only those frozen members with finite archived stock RS percentiles at **both** endpoints. Use this same member intersection to calculate both endpoint medians.
3. Require at least 80% paired coverage of the current-ranked cohort and at least one paired member. Otherwise the group/horizon is unavailable with a reason. A one-member match is flagged as a thin sample.
4. At each endpoint, rank eligible group medians against the **same** peer-group set within the same group level. Require at least two eligible peer groups; the peer panel is selected independently for each horizon.
5. Calculate percentile-point change as current backcast percentile minus prior backcast percentile. Calculate ordinal rank change as prior rank minus current rank, so a positive value indicates improvement.

Rank ties share a percentile; ordinal ranks use stable group ID ordering. An all-tied peer panel has percentile 50. A finite zero percentile is valid data. The anchor median and canonical rank are reconciled against all current finite-RS members before the separate paired-coverage rule is applied.

The prepared result has projection state `ready`, `partial`, or `unprepared`. Each group's `currentMembership` records its cohort/roster counts and has a `horizons` entry for `4w` and `12w`; each horizon is `ready` or `unavailable` with a reason. The four-week and twelve-week views can use different eligible peer panels, so their anchor backcast rank/percentile may differ from one another and from the canonical current group rank. Read the basis and cohort counts before comparing values. The projection reports `cohortCount` (current finite-RS members), `tradedRosterCount` (all anchor-date traded group members), and `representativeness` (`cohortCount / tradedRosterCount`). Within a horizon, `matchedMembers` and `pairedCoverage` are measured against `cohortCount`. A high paired share can still represent a small share of all traded group members; report both.

## Missing data and provenance

An IPO or an unranked anchor member can lower representativeness because it is absent from the current finite-RS cohort. A missing expected endpoint, missing or corrupt archived rank block, and a valid historical universe that lacks a current-ranked member are different conditions; they remain distinguishable in state/reason fields. A missing/corrupt rank archive is unavailable evidence, not a zero percentile. A current-ranked member absent from an otherwise valid past universe lowers the paired count and coverage.

Projection metadata identifies the selected data revision, calculation and projection versions, universe/model/benchmark, price basis, classification/reference mode, classification capture date, observed reference date, anchor and endpoint dates, source rank revisions, roster hashes, paired counts, coverage, and comparable peer count. Existing rank-block lineage may be reused when its recipe and revisions match. Prepare or inspect the local projection with `node scripts/group-velocity.mjs prepare` or `node scripts/group-velocity.mjs status`. Preparation reads archived ranks; it does not require new price downloads or a raw-data revision. Passive page and research reads consume prepared projections and do not start calculations.

## Interpretation limits

The frozen roster is selected using current membership. Reclassifications, companies that no longer exist, and names absent from the current cohort are not represented. This creates survivorship and selection bias, so the backcast cannot be presented as point-in-time industry leadership or a complete historical market result. Use dated membership for historical claims whenever it is available, and label current-membership output as a proxy when it is not.

This projection answers how today's current-ranked group cohort ranked at two archived endpoints. It does not make a five-year group-velocity history available by itself; a longer chart requires its own prepared series and coverage evidence.
