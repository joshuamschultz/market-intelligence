# Session Review

Session Review is a deterministic, versioned summary of benchmark trend, rally attempts, volume pressure, market breadth, and lagged leadership. It is an explicit rules profile for reviewing completed sessions, not a probability model, forecast, or personal portfolio assessment.

## Instruments and data basis

The profile reads reconstructed split-adjusted price histories for:

| Symbol | Role | Volume meaning |
| --- | --- | --- |
| `SPY` | S&P 500 ETF proxy | ETF share volume |
| `QQQ` | Nasdaq-100 ETF proxy | ETF share volume |
| `IXIC` | Nasdaq Composite index | Reported index volume, not share turnover |

The overall posture compares SPY and IXIC; QQQ is an additional displayed proxy. Do not describe QQQ as the Nasdaq Composite or interpret IXIC volume as tradable share volume. A close, low, or volume value may be unavailable after a missing bar, quality quarantine, or unverified split. Volume comparisons require usable positive observations on adjacent sessions from the same source. Missing data remain unknown and do not count as zero.

Session output is pinned to an as-of exchange date, warehouse data version, core calculation version, and separate timing-model version. The model version changes when its profile code or calculation version changes. The model currently supports the reconstructed price basis; a request for another basis returns unavailable. If the exact date/version has not been prepared, the passive read returns `unprepared` and an explicit preparation action rather than calculating and persisting results during a read.

Prepare the selected session through the workspace job pipeline or, for an operator-managed local preparation, run:

```sh
node scripts/market-timing.mjs prepare
```

For a specific loaded date or warehouse revision, the script also accepts `--date YYYY-MM-DD` and `--data-version N`; `--force` rebuilds the timing archive through the selected date. The read endpoint and MCP tool only read prepared rows. API history defaults to 252 sessions and supports up to 1,260 sessions. A longer request is bounded by the archive and source coverage.

## Signal definitions

### Price trend and phase

The profile tracks EMA21 and SMA20, SMA50, SMA150, and SMA200. A rising trend requires the close at or above SMA50, the averages ordered SMA50 > SMA150 > SMA200, and a positive five-session SMA200 slope. A falling trend requires the close below SMA50, SMA50 < SMA150 < SMA200, and a negative five-session SMA200 slope. Other adequately observed arrangements are mixed; insufficient contiguous history is warm-up.

A correction begins after two consecutive closes below SMA20 with the latest close also below SMA50. A protected rally-low or first follow-through-low break also returns the benchmark to correction. After a correction, the first up-close starts a rally attempt at day one, anchored to the correction low. A lower low resets the attempt.

A follow-through confirms only from rally day four onward, when the close-to-close gain is at least 1.25%, the rally low remains intact, and actual volume is strictly greater than the previous exchange session. A price-qualified gain without usable higher-volume evidence is a candidate, not confirmation. A missing or quarantined price interrupts trend/rally continuity; missing, quarantined, or source-mismatched volume makes volume comparison unavailable.

### Distribution pressure

A distribution event is a close-to-close decline of at least 0.20% on strictly higher usable volume than the previous session. Each event stays active until its age reaches 25 sessions or the close recovers 5% from the event close. The screen reports the active count, its event dates, comparison coverage out of 25 sessions, and expiry reason. This count is a profile input, not a standalone bearish prediction.

### Strong-trend checklist

The checklist activates when all four conditions hold: the daily low has stayed above EMA21 for at least 10 consecutive sessions; EMA21 has stayed above SMA50 for at least five sessions; SMA50's five-session slope is positive; and the current close-to-close return is nonnegative. It exits when EMA21 falls below SMA50. This checklist is distinct from the rising/mixed/falling trend label.

## Breadth and lagged leadership

Breadth uses the prepared `us-core` universe, composite model, SPY benchmark, as-of classification reference, and an 80% comparable-observation requirement with at least 20 observations for each component. A component is usable only when it meets both coverage floors. The model shows each metric's numerator, denominator, comparability, volume observations, and source context.

- **Supportive:** comparable above-20/50/200-session averages are each at least 50%; 20-session new highs exceed new lows; and aggregate volume is up or even.
- **Weak:** comparable above-20 and above-50-session breadth are each below 50%, and 20-session new highs are fewer than new lows. This weak branch does not require a usable 200-session reading.
- **Mixed:** short-term inputs are comparable but neither supportive nor weak conditions hold.
- **Insufficient:** required short-term components do not meet their observation floor.

Lagged leadership measures the compounded daily response of each previous session's top-decile stock cohort over five consecutive sessions. Every cohort must have at least 80% usable coverage. If a cohort date does not match the preceding market session or any daily sample falls below the coverage floor, the five-session response is unavailable. It is not a forward forecast.

## Overall posture

The posture combines SPY and IXIC benchmark phases, pressure signals, support, breadth, and lagged leader response:

- **Conservative:** both SPY and IXIC are in correction.
- **Pressure:** an observed benchmark is in correction or shows a pressure flag, without both benchmarks meeting the conservative condition.
- **Constructive:** both benchmarks are confirmed and above SMA50; each has a usable current-session volume comparison and at least 20 usable volume comparisons in the trailing 25 sessions; breadth is supportive; and five-session lagged leader response is positive.
- **Test:** at least one observed benchmark is in baseline, rally, or confirmed phase, but the constructive requirements are not met.
- **Unknown:** available evidence does not support another posture.

`personalTradeFeedback` is always `unknown`: the workspace does not receive account positions or trade outcomes. “Constructive” describes the profile's conditions, not an instruction to increase exposure.

## Where to read it

The Market Overview has a compact Session Review summary. Open the review panel to select SPY, QQQ, or IXIC, inspect the price chart and signals, change the history window, expand the risk-posture history, or review the event audit. The `market_timing` API/MCP tool reads the same prepared profile and selected historical sessions, with exact data/model context and coverage.

When Market Journal generation is explicitly configured, its structured input may include `sessionReview` for the selected date and data revision. That field contains the saved session state and rules, not an unprepared history or a new prompt. Journal reports are separate generated text: `availableAt` records when the report became available, and `tradableDate` records the first session when it could have informed a decision. The research-token scopes for notes or journals are separate from the key used for journal generation.

## Limits

The profile does not incorporate personal positions, provide complete point-in-time membership, or establish that every breadth and volume component has adequate history. A mixed/unknown posture or missing component is a valid result. Review the date, data version, model version, instrument label, volume basis, and coverage before interpreting signals. The chart is a dated research aid, not a trade recommendation.
