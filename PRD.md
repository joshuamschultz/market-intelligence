# Product Requirements Document

## Market Intelligence — Relative Strength, Industry Leadership & Market Breadth Platform

PRD v1.0 · November 21, 2026 · Developer specification

### 1. Product vision

Build a comprehensive US equity market intelligence platform that uses historical daily price, volume, float, and security classification data to answer three fundamental questions:

1. Which stocks are demonstrating the strongest relative strength, and which are gaining or losing leadership?
2. Which industries, sectors, and market themes are showing the greatest strength, accumulation, and improving participation?
3. What is the actual health of the broader stock market, based on the behavior of its constituent stocks rather than a handful of index leaders?

The platform should combine the flexibility of a sophisticated quantitative stock screener, the relative-strength concepts of IBD/Minervini-style momentum investing, and Stockbee-style market breadth monitoring.

The differentiator is that every metric is calculated across a consistent, historically accurate market universe, enabling comparisons across time even as the number and composition of listed securities change.

The platform is a research and decision-support tool, not an automated trading system.

### 2. Core product principles

- Whole-market first: Analyze all eligible NYSE and Nasdaq common stocks, with configurable inclusion of NYSE American, ETFs, ADRs, REITs, and other instruments.
- Historical accuracy: Preserve delisted securities, historical ticker changes, corporate actions, and point-in-time classifications wherever available.
- Percentage-normalized breadth: Express market participation as a percentage of eligible traded securities, while retaining raw counts.
- Configurable analytics: No hardcoded RS formula, market-health model, or screening rule.
- Daily data, weekly intelligence: Update underlying data daily and maintain historical daily and weekly rankings.
- Explainability: Every score, ranking, and dashboard statistic must have an accessible calculation definition and contributing data.
- Reproducibility: Historical rankings and market-health results must be reproducible using saved universe definitions, formulas, and source-data versions.

### 3. Primary product modules

| Module                 | Purpose                                               | Priority |
| ---------------------- | ----------------------------------------------------- | -------- |
| Market Overview        | Whole-market health, breadth, momentum, participation | P0       |
| Stock Screener         | Advanced filtering, ranking, sorting, custom columns  | P0       |
| RS Engine              | Configurable weighted relative-strength rankings      | P0       |
| Stock Detail           | Price, volume, RS history, supply/demand metrics      | P0       |
| Industry Intelligence  | Group strength, rotation, breadth, leadership         | P0       |
| Historical Explorer    | Analyze any historical date and compare periods       | P0       |
| Market Monitor         | Stockbee-inspired breadth and momentum statistics     | P0       |
| Custom Screens         | Save, combine, compare, and schedule screening rules  | P1       |
| Alerts                 | Detect leadership changes and breadth transitions     | P1       |
| Research & Backtesting | Historical studies and forward-return analysis        | P2       |

### 4. Application navigation

Market Intelligence

Conceptual navigation

Market Overview

Breadth and market health

Stock Screener

Advanced filtering

RS Rankings

Stock leadership

Industries

Group rotation

Historical Explorer

Time-series research

Saved Screens

Custom strategies

Alerts

Leadership transitions

Settings & Data

Universe and models

## 5. Data requirements and market universe

### 5.1 Data coverage

The system must ingest and retain:

| Data                    | Fields                                                                           | Frequency            |
| ----------------------- | -------------------------------------------------------------------------------- | -------------------- |
| Security master         | Permanent ID, ticker, name, exchange, security type, listing and delisting dates | Daily reconciliation |
| Prices                  | Open, high, low, close, adjusted close                                           | Daily                |
| Volume                  | Shares traded, dollar volume                                                     | Daily                |
| Corporate actions       | Splits, dividends, mergers, ticker changes                                       | Daily                |
| Float                   | Public float shares, effective date, source date                                 | As available         |
| Shares outstanding      | Total shares, effective date                                                     | As available         |
| Market capitalization   | Historical or derived market cap                                                 | Daily where possible |
| Industry classification | Sector, industry, subindustry, effective dates                                   | As available         |
| Trading status          | Active, halted, suspended, delisted                                              | Daily                |
| Benchmarks              | SPY, QQQ, IWM, relevant sector benchmarks                                        | Daily                |

Critical distinction: Float and shares outstanding are different. Float is the number of shares generally available for public trading, whereas shares outstanding includes restricted holdings.

Historical float data is especially important for historical float-turnover analysis. Current float values must never be silently applied to historical dates.

### 5.2 Market universes

Support multiple named, versioned universes.

| Universe      | Definition                                              |
| ------------- | ------------------------------------------------------- |
| US Core       | NYSE and Nasdaq operating-company common stocks         |
| US Extended   | Core plus NYSE American                                 |
| US All Listed | All supported listed security types                     |
| Liquid US     | Core with configurable price and dollar-volume minimums |
| Small Caps    | Eligible stocks within a configurable market-cap range  |
| Custom        | User-selected stocks or rule-defined membership         |

The default Market Overview universe should be US Core, with NYSE and Nasdaq common stocks only.

Exclude ETFs, ETNs, warrants, rights, preferred shares, closed-end funds, units, and other non-common-stock instruments by default. ADRs and REITs should be separately configurable.

For breadth denominators, distinguish:

- Listed universe: All securities eligible on a given date.
- Traded universe: Eligible securities with a valid close and positive trading volume that day.
- Comparable universe: Traded securities with sufficient historical data to evaluate a particular metric.

Every breadth percentage must use the appropriate denominator and display the count used.

### 5.3 Historical storage

Target at least 10 years of daily market data, preferably 20+ where affordable.

Requirements include incremental ingestion, missing-date detection, provider reconciliation, restatement handling, and full reprocessing when a corporate action changes historical adjusted prices.

Use a permanent internal `security_id` so that a reused ticker does not merge two unrelated companies.

## 6. Relative Strength Engine

### 6.1 Configurable performance periods

Users must be able to define any number of return windows, including:

- 1, 5, 10, 20, 21, 42, 63, 126, and 252 trading days.
- Calendar months, quarters, and years.
- Year-to-date.
- Custom start and end dates.
- Nonoverlapping windows, such as 12–6 months ago and 6–3 months ago.

For each period:

\\[ R\_{i,t,n}=\frac{P\_{i,t}}{P\_{i,t-n}}-1 \\]

Use split-adjusted prices by default. Offer dividend-adjusted total return as an alternative.

### 6.2 Custom composite RS

Users configure weighted combinations of return periods.

Example:

| Period    | Weight |
| --------- | ------ |
| 12 months | 40%    |
| 6 months  | 30%    |
| 3 months  | 20%    |
| 1 month   | 10%    |

\\[ RS\_{i,t}=\sum\_{k=1}^{m}w_kR\_{i,t,k} \\]

Support these scoring methods:

| Method                  | Calculation                                              |
| ----------------------- | -------------------------------------------------------- |
| Raw weighted returns    | Weighted sum of percentage returns                       |
| Percentile weighted     | Percentile-rank each return window, then combine         |
| Z-score weighted        | Standardize returns within the universe before combining |
| Benchmark-relative      | Subtract benchmark returns for each window               |
| Risk-adjusted           | Normalize return by a defined volatility measure         |
| Nonoverlapping momentum | Combine separate historical return intervals             |

The scoring method must be selectable and saved as part of each model.

### 6.3 Ranking

For each calculation date:

1. Resolve the selected point-in-time universe.
2. Determine which securities have sufficient history.
3. Calculate component returns.
4. Calculate composite scores.
5. Sort descending.
6. Assign absolute rank and percentile rank.
7. Save the full results and model version.

Rank 1 is strongest.

Percentile scoring must use a documented convention in which 100 indicates the strongest security and 0 the weakest.

Handle ties deterministically, and do not substitute a zero return for missing data.

### 6.4 Rank velocity and acceleration

Calculate:

| Metric                 | Definition                                                    |
| ---------------------- | ------------------------------------------------------------- |
| 1W rank change         | Previous weekly rank minus current rank                       |
| 4W rank change         | Rank four weeks ago minus current rank                        |
| 12W rank change        | Rank twelve weeks ago minus current rank                      |
| Percentile velocity    | Current percentile minus historical percentile                |
| RS score change        | Current composite score minus previous score                  |
| RS acceleration        | Change in percentile velocity between successive periods      |
| Leadership persistence | Number or percentage of recent weeks in a top-percentile band |
| RS new high            | Current RS score or percentile exceeds prior lookback maximum |

Percentile velocity is the preferred normalized measure because absolute ranks depend on universe size.

Rank changes must be calculated only when the stock was eligible in both comparison snapshots. Newly eligible stocks receive a `NEW` status rather than an invented rank improvement.

### 6.5 Advanced leadership signals

Implement configurable screens for:

- Stocks entering the top 1%, 5%, 10%, or 20%.
- Stocks advancing more than a specified number of percentile points.
- Stocks maintaining top-decile RS for 4, 8, or 12 weeks.
- Stocks reaching a new RS high before a price high.
- Stocks whose 3-month return is improving relative to their 12-month return.
- Stocks outperforming their industry and sector.
- Stocks with strong RS while their industry is improving.
- Stocks with deteriorating RS despite rising prices.
- Stocks with strong price momentum and increasing volume demand.

All of these should be implemented as reusable screening predicates, not hardcoded dashboard widgets.

## 7. Price, volume, float, and supply/demand analytics

### 7.1 Core stock metrics

| Metric                      | Definition                                                            |
| --------------------------- | --------------------------------------------------------------------- |
| Distance from 52-week high  | `(Close / Highest High 252D - 1) × 100`                               |
| Distance from all-time high | Same calculation using all available valid history                    |
| Distance from 52-week low   | `(Close / Lowest Low 252D - 1) × 100`                                 |
| Drawdown from high          | Negative percentage distance from selected high                       |
| Average volume              | Mean daily share volume over N sessions                               |
| Average dollar volume       | Mean of daily `Close × Volume` over N sessions                        |
| Relative volume             | Current volume divided by average comparable volume                   |
| Float turnover              | Period share volume divided by effective-date float shares            |
| Market-cap change           | Change in point-in-time market capitalization                         |
| Price vs moving average     | Percentage distance from SMA or EMA                                   |
| Moving-average slope        | Percentage change in MA over N sessions                               |
| Volatility                  | Standard deviation of daily returns, optionally annualized            |
| ATR percentage              | Average true range divided by price                                   |
| Up-day frequency            | Percentage of comparable sessions with positive close-to-close return |

The screener must allow users to select 20-day, 50-day, 100-day, 150-day, 200-day, or custom moving averages.

### 7.2 Up/Down Volume Ratio

Your specified supply/demand metric is a core feature.

For a 50-session lookback:

\\[ UDVR\_{50}= \frac{\sum\_{d\in UpDays}V_d} {\sum\_{d\in DownDays}V_d} \\]

Where:

- Up day: Today's adjusted close exceeds the previous adjusted close.
- Down day: Today's adjusted close is below the previous adjusted close.
- Unchanged day: Excluded from both sums.
- Volume: Daily share volume, normalized for splits when comparing historical share quantities.

Provide 10-, 20-, 50-, and 100-day U/D ratios, plus custom lookbacks.

Supply/demand interpretation

## 0.70

More volume on down days

## 1.00

Balanced up/down volume

## 1.50

More volume on up days

Illustrative interpretations, not trading thresholds. U/D volume is a proxy for buying and selling pressure, not a direct measurement of buyer-initiated versus seller-initiated trades.

Edge cases:

- No down-day volume: return a documented positive-infinity or capped-display state, never silently divide by zero.
- Insufficient history: return null with a reason.
- Split dates: ensure consistent share-volume units.
- Zero-volume days: exclude invalid trading observations.
- Missing sessions: expose observation count and completeness.

### 7.3 Additional volume indicators

Implement the following:

| Indicator                       | Why it matters                                             |
| ------------------------------- | ---------------------------------------------------------- |
| Up-volume percentage            | Share of total classified volume occurring on up days      |
| Volume trend                    | Change in 20D vs 50D average volume                        |
| High-volume up days             | Count of positive sessions above 1.5× or 2× average volume |
| High-volume down days           | Count of negative sessions above comparable thresholds     |
| Accumulation/distribution count | Net high-volume up versus down sessions                    |
| On-Balance Volume               | Cumulative signed volume                                   |
| OBV slope                       | Trend in OBV over a configurable window                    |
| Money Flow Index                | Price-and-volume-based momentum                            |
| Close Location Value            | Where price closes within its daily high-low range         |
| Chaikin Money Flow              | Volume-weighted close-location measure                     |
| Float turnover                  | How much reported float trades over a period               |
| Volume contraction              | Reduction in average volume during a consolidation         |
| Breakout volume                 | Breakout-session volume relative to historical average     |

The platform must distinguish observable price/volume signals from inferred accumulation. These metrics cannot prove institutional buying.

### 7.4 Technical price structure

Support optional technical screening based on:

- 52-week highs and lows.
- New 20-, 50-, and 100-day highs.
- 20/50/200-day moving-average alignment.
- Price above or below key moving averages.
- Consecutive up or down sessions.
- ATR contraction and volatility compression.
- Breakouts above rolling highs.
- Pullbacks from recent highs.
- Relative-strength line versus SPY or a custom benchmark.
- Relative-strength line reaching new highs.
- Gap-up and gap-down days.
- Price consolidation duration and range.

These metrics should be computable from daily OHLCV without external chart-pattern vendors.

## 8. Advanced stock screener

The screener should behave like a query builder rather than a fixed list of filters.

### 8.1 Filter types

Support numeric ranges, categorical selections, booleans, date comparisons, historical comparisons, calculated expressions, percentile conditions, and group-relative conditions.

Example conditions:

- RS percentile at least 95.
- RS percentile increased at least 10 points in four weeks.
- U/D volume ratio above 1.3.
- Price within 15% of 52-week high.
- Float below 50 million shares.
- Average dollar volume above $10 million.
- Industry RS percentile above 80.
- Price above 50-day and 200-day moving averages.
- At least 60% of industry members above their 50-day moving average.

### 8.2 Nested AND/OR logic

Allow arbitrarily nested logical groups with a reasonable configurable depth limit.

Example: Emerging leaders

Saved screen concept

Match ALL conditions

AND

RS percentile ≥ 90

AND

4-week RS velocity ≥ +5 percentile points

AND

U/D volume ratio (50D) ≥ 1.3

Match ANY condition

OR

Within 10% of 52-week high

OR

New 50-day high in last 5 sessions

AND

Average daily dollar volume ≥ $5M

### 8.3 Advanced sort and ranking

Users must be able to:

- Sort by any metric, ascending or descending.
- Apply multi-column sorting with explicit precedence.
- Create custom weighted ranking formulas.
- Rank the results within a filtered subset.
- Compare each stock against its industry.
- Rank within each industry, sector, or market-cap bucket.
- Sort by rate of change rather than absolute level.
- Create custom computed columns using supported operators and functions.
- Save column sets and sorting configurations.

Custom expressions must use a validated expression language, not arbitrary executable Python or SQL.

Example:

```
0.40 * percentile(return_252d)
+ 0.30 * percentile(return_126d)
+ 0.20 * percentile(return_63d)
+ 0.10 * percentile(return_21d)
```

The expression engine should support arithmetic, comparison, boolean operations, `min`, `max`, `abs`, `log`, `rank`, `percentile`, and historical-change functions, with explicit null behavior.

### 8.4 Historical screening

A user must be able to select a historical date and run the same screen against information available on that date.

Requirements:

- Point-in-time eligible universe.
- Point-in-time price and volume metrics.
- Point-in-time fundamentals and float where available.
- Historical industry membership where available.
- No future-data leakage.
- Optional comparison to current screen results.

Support saved historical cohorts, such as "all stocks that met this screen on January 2, 2024."

## 9. Market Overview and Market Monitor

This is the central homepage.

Its objective is to show the condition of the entire market, not merely the performance of SPY, QQQ, or the Nasdaq Composite.

### 9.1 Homepage layout

Market Overview

Illustrative dashboard layout — not live market data

US Core

## 5,240

Traded stocks

## 61.8%

Above 50D MA

## +18.2

Breadth thrust score

Daily market participation

0%6%12%18%24%Up ≥4%Down ≥4%Up ≥2%Down ≥2%

Market breadth history

Above 50D MAAbove 200D MA

0%25%50%75%100%W1W2W3W4W5W6W7W8

### 9.2 Daily percentage-move breadth

Calculate the percentage of traded stocks advancing or declining by specified daily thresholds.

Default thresholds:

| Metric      | Formula                                                                     |
| ----------- | --------------------------------------------------------------------------- |
| % Up ≥ 4%   | Count of stocks with daily return ≥ +4% / eligible comparable traded stocks |
| % Down ≥ 4% | Count with daily return ≤ −4% / eligible comparable traded stocks           |
| % Up ≥ 2%   | Same for +2%                                                                |
| % Down ≥ 2% | Same for −2%                                                                |
| % Up ≥ 1%   | Same for +1%                                                                |
| % Down ≥ 1% | Same for −1%                                                                |

Retain raw counts alongside percentages.

### 9.3 Large-move market monitor

Also calculate the number and percentage of stocks that have appreciated or declined by 25% and 50% over configurable rolling windows.

The key requirement is separating move magnitude from measurement period.

For example:

| Statistic  | Default lookback |
| ---------- | ---------------- |
| Up ≥ 25%   | 20 trading days  |
| Down ≥ 25% | 20 trading days  |
| Up ≥ 50%   | 20 trading days  |
| Down ≥ 50% | 20 trading days  |
| Up ≥ 25%   | 63 trading days  |
| Down ≥ 25% | 63 trading days  |
| Up ≥ 50%   | 63 trading days  |
| Down ≥ 50% | 63 trading days  |

These are proposed configurable defaults, not a claim that Stockbee uses these exact definitions.

The system should additionally support 5-, 10-, 42-, 126-, and 252-day windows, plus custom windows.

For each threshold/window combination, provide:

- Raw qualifying count.
- Percentage of eligible comparable traded stocks.
- Five-day moving average of that percentage.
- Ten-day moving average.
- Twenty-day moving average.
- Historical percentile of the breadth reading.
- Change versus prior session, week, and month.

### 9.4 Stockbee-style market monitor

Build a configurable market-monitor module inspired by the breadth and momentum analysis associated with Stockbee.

Include separate metric families:

Daily momentum participation: Stocks up/down 4% and other thresholds.

Multi-day momentum participation: Stocks advancing/declining 25% and 50% over configurable lookbacks.

New-high/new-low participation: Stocks making 20-, 50-, and 252-day highs or lows.

Breadth thrusts: Rapid improvement in advancing participation, high-volume positive sessions, and stocks above moving averages.

Momentum deterioration: Falling participation, rising negative-move counts, fewer new highs, and increasing high-volume down days.

Do not label a metric as an exact Stockbee formula unless its original definition has been verified. This module should support faithful replication of verified formulas and separately named custom variants.

### 9.5 Advancers and decliners

Calculate:

- Number and percentage of advancing stocks.
- Number and percentage of declining stocks.
- Unchanged stocks.
- Advance/decline ratio.
- Advance/decline net count.
- Normalized advance/decline spread.
- Cumulative advance/decline line.
- 5-, 10-, 20-, and 50-day averages.

A normalized daily A/D spread is:

\\[ ADSpread_t=\frac{Advancers_t-Decliners_t}{EligibleComparable_t}\times100 \\]

Maintain separate A/D lines for NYSE, Nasdaq, and combined US Core.

### 9.6 Market-wide volume breadth

Calculate:

- Total up-day share volume.
- Total down-day share volume.
- Up-volume percentage.
- Up/down volume ratio.
- Net advancing dollar volume.
- High-volume advancing-stock count.
- High-volume declining-stock count.
- Percentage of stocks with relative volume above 1.5 or 2.0.
- Percentage of stocks showing positive OBV trends.
- Percentage with U/D ratio above 1.0, 1.2, and 1.5.

For whole-market aggregation, prefer dollar-volume measures alongside share-volume measures. Raw share counts can be distorted by differences in share prices and split structures.

### 9.7 Moving-average breadth

Calculate the percentage of stocks trading above:

- 10-day SMA
- 20-day SMA
- 50-day SMA
- 100-day SMA
- 150-day SMA
- 200-day SMA

Also calculate:

- Percentage with 50D SMA above 200D SMA.
- Percentage with rising 50D SMA.
- Percentage with rising 200D SMA.
- Percentage with bullish 20/50/200 alignment.
- Percentage within 10% of their 52-week highs.
- Percentage more than 30% below their 52-week highs.

All should have daily historical series and rolling averages.

### 9.8 Market momentum and leadership concentration

Measure:

- Percentage of stocks with positive 1-, 3-, 6-, and 12-month returns.
- Median stock return versus cap-weighted index return.
- Equal-weight versus cap-weight index performance.
- Top-decile RS participation by sector.
- Percentage of industries with improving RS.
- Percentage of stocks outperforming SPY.
- Percentage of stocks outperforming their own industry.
- Share of total positive dollar-volume participation from the largest-cap stocks.
- Leadership turnover and persistence.

This helps identify cases where the headline index rises but the median stock and most industries are weakening.

## 10. Market health and regime analysis

### 10.1 Composite market-health model

Provide a configurable market-health model with independently weighted components.

Proposed initial model:

| Component                    | Weight |
| ---------------------------- | ------ |
| Short-term breadth           | 20%    |
| Intermediate-term breadth    | 20%    |
| Long-term breadth            | 15%    |
| Price momentum participation | 15%    |
| Volume participation         | 15%    |
| Industry leadership breadth  | 10%    |
| New highs versus new lows    | 5%     |

Each component should be transformed into a 0–100 score using documented thresholds or historical percentile calibration.

The final score is a weighted composite, not a probability of future returns.

Users should be able to create alternative health models and compare them historically.

### 10.2 Market regimes

Support configurable regimes:

| Regime            | General characteristics                                                  |
| ----------------- | ------------------------------------------------------------------------ |
| Broad expansion   | Rising participation, improving momentum, widespread industry leadership |
| Narrow expansion  | Rising indexes, weak or declining participation                          |
| Early recovery    | Improving short-term breadth after prolonged weakness                    |
| Deterioration     | Falling participation despite relatively stable indexes                  |
| Broad contraction | Negative breadth, declining momentum, widespread weakness                |
| Transitional      | Conflicting or inconclusive signals                                      |

The initial system should use transparent rules rather than a black-box classifier.

A regime classification must show which conditions triggered it, when the classification changed, and how long it has persisted.

### 10.3 Breadth divergence detection

Create explicit divergence indicators.

Examples:

- SPY makes a new 20-day high, but fewer stocks are above their 50-day moving averages.
- Nasdaq rises while median Nasdaq constituent return falls.
- Market indexes rise while new 52-week lows expand.
- Top RS stocks continue rising, but fewer industries participate.
- Market index declines while positive breadth participation improves.

Store these as dated, explainable events.

### 10.4 Market-health historical studies

The Historical Explorer must let users select a breadth condition and examine what happened afterward.

Example study:

> When fewer than 20% of stocks are above their 50-day moving average and the percentage subsequently rises above 35%, what have SPY, QQQ, and the median stock returned over the next 5, 10, 20, and 60 trading days?

Support event counts, median and mean forward returns, win rates, maximum adverse excursion, and return distributions.

These analyses must avoid look-ahead bias, overlapping-event distortions, and survivorship bias. Clearly distinguish descriptive historical findings from predictive claims.

## 11. Industry and sector intelligence

### 11.1 Industry classification

Use a hierarchical model:

`Sector → Industry → Subindustry → Security`

Also support custom thematic groups that can overlap, such as:

- AI infrastructure
- Nuclear energy
- Defense technology
- Semiconductor equipment
- Cybersecurity
- Robotics
- Industrial automation

Custom groups require dated membership records so historical group calculations are reproducible.

### 11.2 Industry strength metrics

Calculate the following for each group:

| Metric                    | Definition                                               |
| ------------------------- | -------------------------------------------------------- |
| Average RS percentile     | Mean constituent RS percentile                           |
| Median RS percentile      | Median constituent RS percentile                         |
| Group return              | Equal-weight or cap-weight group return                  |
| Group RS rank             | Rank among comparable groups                             |
| 4W group velocity         | Change in group RS percentile or rank                    |
| Top-decile participation  | % of constituents with RS percentile ≥ 90                |
| Positive momentum breadth | % with positive return over selected period              |
| 50D breadth               | % above 50-day moving average                            |
| 200D breadth              | % above 200-day moving average                           |
| Group U/D ratio           | Group-level up/down dollar-volume ratio                  |
| New-high breadth          | % reaching a new rolling high                            |
| Leadership concentration  | Contribution of largest leaders versus remaining members |

The group U/D ratio must be calculated from constituent volume aggregates, not by averaging individual ratios.

### 11.3 Industry rotation dashboard

Display industries by:

- Absolute RS rank.
- Four-week rank improvement.
- Twelve-week rank improvement.
- Percentage of members in the top 10% RS.
- Improving versus deteriorating breadth.
- Relative performance against SPY.
- Strength compared with their parent sector.

A particularly valuable screen:

Emerging industries: Groups with rapidly improving median RS, increasing top-decile participation, improving 50D breadth, and rising group-relative performance.

### 11.4 Industry heatmap

Create an interactive heatmap with configurable axes and colors.

Examples:

- X-axis: Current group RS percentile.
- Y-axis: Four-week group RS velocity.
- Bubble size: Number of eligible constituents or total market cap.
- Bubble color: Group breadth improvement.

Users can click a group to drill into its constituent stocks and their contribution to the group's strength.

### 11.5 Group comparison

Allow side-by-side comparison of multiple industries over time, including:

- Group RS percentile.
- Equal-weight group index.
- Breadth above moving averages.
- Up/down volume.
- Number of emerging leaders.
- Historical rank.

Support rebased group indices starting at 100 and avoid assuming today's group members were always members.

## 12. Historical Explorer

### 12.1 Historical replay

Users must be able to select any trading date and view the market as it existed on that date.

This includes:

- Market breadth dashboard.
- Stock rankings.
- Industry rankings.
- Saved screens.
- Market-health regime.
- Top movers.
- Leading and deteriorating industries.

### 12.2 Time-series comparison

Users can chart multiple metrics on the same timeline.

Examples:

- SPY price versus percentage of stocks above 50D SMA.
- Nasdaq Composite versus Nasdaq new-high/new-low breadth.
- Semiconductor group RS versus semiconductor group breadth.
- Percentage of stocks up 4% versus down 4%.
- RS leadership concentration versus equal-weight index performance.

Support independent axes, normalization, rebasing, smoothing, and date-range selection.

### 12.3 Cohort analysis

Users can save a historical group of securities matching a condition.

Example:

"Stocks with RS above 95, U/D ratio above 1.5, and float below 100 million shares on a selected date."

Analyze the cohort's subsequent performance, attrition, drawdowns, and industry distribution.

The analysis must retain delisted stocks and account for delisting returns where the data supports them.

## 13. Saved screens, workspaces, and alerts

### 13.1 Saved screens

Save:

- Universe.
- Filters and nested logical conditions.
- RS model.
- Sorting configuration.
- Visible columns.
- Historical date or current-date mode.
- Industry grouping.
- Display preferences.

Support duplication, versioning, export, and optional sharing.

### 13.2 Watchlists

Users can create watchlists manually or dynamically.

Dynamic watchlists update automatically based on saved-screen criteria.

Examples include top 100 RS stocks, emerging industry leaders, high-volume breakouts, and deteriorating former leaders.

### 13.3 Alerts

Support event-based alerts such as:

- A stock enters the top 5% RS.
- A stock's RS percentile rises by 10 points in four weeks.
- A stock's U/D ratio crosses 1.5.
- An industry enters the top 10.
- Market breadth crosses a user-defined threshold.
- New-low breadth expands sharply.
- A saved screen gains or loses members.
- A market-health regime changes.

Alerts must specify the calculation date, source data timestamp, universe, and rule that triggered them.

Delivery options: in-app first, with email as a later enhancement.

## 14. Detailed application UX requirements

### 14.1 Global controls

Every analytical page should have a consistent global toolbar for:

- Universe selection.
- As-of date.
- RS model selection.
- Comparison benchmark.
- Industry classification system.
- Data refresh status.
- Saved view selection.

Changing the as-of date must update every compatible component on the page consistently.

### 14.2 Stock screener table

Required capabilities:

- Server-side filtering, sorting, and pagination.
- Virtualized rows for large result sets.
- Column search and column visibility controls.
- Pinned ticker and name columns.
- Multi-sort with visible sort precedence.
- User-defined computed columns.
- Conditional formatting.
- Historical metric comparisons.
- Group-by industry, sector, or market-cap bucket.
- Export current results to CSV or Parquet.
- Save current screen as a reusable view.

Clicking a ticker opens a detail panel without losing the current screen.

### 14.3 Stock detail page

Display:

- Daily and weekly price charts with volume.
- Float, shares outstanding, market cap, and liquidity.
- Current and historical RS percentile.
- RS rank velocity.
- Price relative to 52-week high.
- U/D volume ratio history.
- Moving averages and technical conditions.
- Industry and sector comparison.
- Historical screen membership.
- Relevant data quality warnings.

### 14.4 Market Overview interactions

Users must be able to click any breadth statistic to see the securities contributing to it.

For example, clicking "8.2% up at least 4%" should open the exact set of securities included in that day's numerator, along with the eligible denominator and exclusions.

Every chart should support hovering, zooming, historical comparison, and exporting underlying values.

## 15. Technical architecture

### 15.1 Recommended stack

| Layer                   | Technology                                        |
| ----------------------- | ------------------------------------------------- |
| Frontend                | Next.js, React, TypeScript                        |
| UI                      | Tailwind CSS, shadcn/ui                           |
| Tables                  | TanStack Table with virtualization                |
| Charts                  | TradingView Lightweight Charts and Apache ECharts |
| API                     | Python FastAPI                                    |
| Analytical engine       | DuckDB, Polars                                    |
| Primary database        | PostgreSQL                                        |
| Historical bulk storage | Partitioned Parquet                               |
| Background jobs         | Python workers with scheduled orchestration       |
| Cache                   | Redis, optional initially                         |
| Deployment              | Docker-based application                          |
| Observability           | Structured logs, metrics, error tracking          |

Avoid microservices initially. A modular monolith with independent ingestion and calculation workers is sufficient.

### 15.2 Data processing pipeline

1\. Provider ingestion

Daily bulk prices, historical data, reference updates

2\. Normalization and validation

Security identity, splits, missing sessions, classification

3\. Point-in-time market warehouse

Prices, float history, industry memberships, universe snapshots

4\. Analytics engine

Stock indicators, RS, group metrics, market breadth

5\. Materialized analytics

Daily metrics, historical ranks, breadth series, alerts

6\. API and dashboards

Interactive screening, history, comparisons, exports

### 15.3 Database schema

Required core entities:

| Table                    | Key fields                                                       |
| ------------------------ | ---------------------------------------------------------------- |
| `securities`             | security_id, name, type, listing_date, delisting_date            |
| `security_identifiers`   | security_id, ticker, exchange, valid_from, valid_to              |
| `daily_prices`           | security_id, date, OHLCV, source_id                              |
| `corporate_actions`      | security_id, type, effective_date, factor                        |
| `security_fundamentals`  | security_id, effective_date, known_at, float, shares_outstanding |
| `classification_history` | security_id, group_id, effective_from, effective_to, known_at    |
| `universes`              | universe_id, definition_json, version                            |
| `universe_membership`    | universe_id, date, security_id, eligibility_status               |
| `stock_daily_metrics`    | security_id, date, metric_version, calculated values             |
| `ranking_models`         | model_id, version, formula_json                                  |
| `stock_rankings`         | model_id, date, security_id, score, rank, percentile             |
| `industry_daily_metrics` | group_id, date, metric values                                    |
| `market_breadth_daily`   | universe_id, date, metric_id, numerator, denominator, value      |
| `saved_screens`          | screen_id, owner_id, filter_ast, columns, sort                   |
| `alert_rules`            | rule_id, condition_ast, schedule                                 |
| `alert_events`           | rule_id, security_id or group_id, date, trigger details          |
| `ingestion_runs`         | provider, dataset, dates, status, row counts                     |
| `calculation_runs`       | calculation version, inputs, output version, status              |

Every historical fact should distinguish when it was economically effective from when the system or data provider knew it.

### 15.4 Data provenance

Store:

- Provider and dataset.
- Original source identifier.
- Ingestion timestamp.
- Effective date.
- Available/known timestamp.
- Adjustment version.
- Calculation version.
- Completeness status.

The system must support recalculation after provider corrections without silently overwriting published historical snapshots.

### 15.5 API endpoints

Representative REST API:

```
GET  /api/v1/market/overview
GET  /api/v1/market/breadth
GET  /api/v1/market/health
GET  /api/v1/market/events

GET  /api/v1/stocks/{security_id}
GET  /api/v1/stocks/{security_id}/metrics
GET  /api/v1/stocks/{security_id}/rankings

POST /api/v1/screens/query
POST /api/v1/screens
GET  /api/v1/screens/{screen_id}
POST /api/v1/screens/{screen_id}/execute

GET  /api/v1/rankings
POST /api/v1/ranking-models
GET  /api/v1/ranking-models/{model_id}

GET  /api/v1/industries
GET  /api/v1/industries/{group_id}
GET  /api/v1/industries/{group_id}/members

POST /api/v1/research/cohorts
POST /api/v1/research/event-studies

GET  /api/v1/data/status
GET  /api/v1/data/quality
```

Endpoints must support as-of dates, universe IDs, model versions, pagination, and consistent metric definitions.

Long-running research queries should return a job ID and expose progress and completion status.

## 16. Daily calculation and ingestion schedule

All scheduling should use the US market calendar and `America/New_York` timezone.

| Stage             | Trigger                                    | Requirement                                     |
| ----------------- | ------------------------------------------ | ----------------------------------------------- |
| Price ingestion   | After provider's finalized EOD publication | Fetch completed trading session                 |
| Reference updates | Daily                                      | Reconcile listings, delistings, classifications |
| Data validation   | After ingestion                            | Detect gaps, duplicates, anomalies              |
| Stock metrics     | After validation                           | Calculate price, volume, float indicators       |
| RS rankings       | After stock metrics                        | Calculate all active ranking models             |
| Industry metrics  | After rankings                             | Calculate group strength and breadth            |
| Market breadth    | After stock metrics                        | Calculate full-market statistics                |
| Market health     | After breadth and industry metrics         | Calculate health score and regime               |
| Alert evaluation  | After published analytics                  | Evaluate saved alert rules                      |
| Weekly snapshots  | Last completed trading session of week     | Save weekly rank and velocity history           |

Do not assume prices are finalized immediately at 4:00 p.m. Eastern. The provider's EOD availability and correction schedule controls publication.

Jobs must be idempotent, retryable, and safe to rerun for a single date or a historical date range.

### 16.1 Backfill requirements

The historical bootstrap must:

1. Import the historical security master.
2. Reconstruct ticker identity and listing intervals.
3. Import prices and corporate actions.
4. Validate and normalize adjusted price series.
5. Import historical classifications and float where available.
6. Construct daily universe eligibility.
7. Compute historical stock metrics.
8. Compute historical RS rankings.
9. Compute industry metrics.
10. Compute historical market breadth and market-health series.

The system must support partial reprocessing after corrections, rather than requiring a complete historical rebuild every time.

## 17. Data provider strategy

### 17.1 Initial provider

EODHD remains a reasonable budget-first candidate for daily US market prices.

However, do not assume one low-cost provider satisfies every requirement. Before committing, run a formal coverage test.

| Requirement           | Validation                                            |
| --------------------- | ----------------------------------------------------- |
| Daily OHLCV           | Complete NYSE/Nasdaq daily bulk coverage              |
| Historical prices     | At least 10 years                                     |
| Delisted stocks       | Historical prices and identifiable delisting dates    |
| Security identity     | Reliable handling of symbol changes and ticker reuse  |
| Split adjustments     | Accurate adjusted series and corporate-action records |
| Historical float      | Availability, coverage, and timestamp quality         |
| Historical industries | Point-in-time membership availability                 |
| Bulk downloads        | Full daily universe without excessive API calls       |
| Licensing             | Permitted personal use and future commercial options  |

Historical float and point-in-time classifications are likely to be the hardest requirements to satisfy cheaply.

### 17.2 Provider abstraction

Implement a provider-neutral interface for:

```
get_securities(as_of_date)get_daily_prices(start_date, end_date)get_corporate_actions(start_date, end_date)get_float_history(security_ids, start_date, end_date)get_classification_history(security_ids)get_listing_events(start_date, end_date)
```

Not every provider will implement every method. Missing capabilities must be explicitly reported.

The core application must not depend on provider-specific ticker formats or adjustment conventions.

### 17.3 Data-quality dashboard

Provide an administrative view showing:

- Last successful ingestion.
- Expected versus received security counts.
- Missing dates and prices.
- Unresolved security identifiers.
- Suspected split anomalies.
- Float coverage percentage.
- Historical classification coverage.
- Delisted-security coverage.
- Stale datasets.
- Failed calculation jobs.

A market-wide breadth reading must be flagged if coverage falls below a configured threshold. Never quietly publish a normal-looking market-health score from incomplete data.

## 18. Performance, reliability, and security

### 18.1 Performance targets

Proposed acceptance targets for a single-user or small-team deployment:

| Operation                                               | Target                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| Load Market Overview                                    | Under 2 seconds for cached results                                 |
| Sort/filter 10,000 stocks                               | Under 2 seconds for precomputed metrics                            |
| Open stock detail                                       | Under 2 seconds                                                    |
| Retrieve 10 years of breadth history                    | Under 3 seconds                                                    |
| Recalculate one custom RS model over latest market data | Under 10 seconds                                                   |
| Daily end-to-end processing                             | Under 15 minutes after complete ingestion                          |
| Historical backfill                                     | Complete without manual intervention; duration measured in staging |

These are engineering targets to validate, not guaranteed performance.

### 18.2 Reliability

Required:

- Automated retries and backoff.
- Duplicate-safe ingestion.
- Atomic publication of completed daily analytics.
- Data and calculation versioning.
- Recovery from partial job failures.
- Database backups.
- Historical Parquet backups.
- Job execution logs and alerts.
- Trading-calendar awareness.
- Provider outage handling.

### 18.3 Security

For the initial personal deployment, use authenticated access, encrypted provider credentials, HTTPS, and regular backups.

If expanded to multiple users, add role-based access, user-owned screens and watchlists, audit logging, rate limiting, and subscription/licensing controls.

## 19. Testing and acceptance criteria

### 19.1 Data tests

The system passes when:

- A delisted stock appears in rankings for dates when it was eligible.
- A ticker rename does not create an artificial price discontinuity.
- Ticker reuse does not combine unrelated companies.
- Split-adjusted returns are correct across split dates.
- A stock without sufficient historical observations is excluded from the appropriate metric denominator.
- Missing float is represented as missing rather than inferred from current float.
- Historical calculations do not use later-published information.
- All published breadth metrics reconcile to their underlying numerator and denominator.

### 19.2 Formula tests

Create deterministic test fixtures for:

- Weighted RS with different periods and weights.
- Percentile ranking and tied values.
- Rank velocity with changing universe size.
- U/D volume ratio with up, down, and unchanged sessions.
- Zero down-day volume.
- Distance from 52-week high.
- Float turnover.
- Daily ±4% breadth.
- Rolling ±25% and ±50% breadth.
- Industry aggregation.
- Market-health composite scores.

Every metric must have a documented mathematical definition and at least one known-answer unit test.

### 19.3 User acceptance scenarios

| Scenario                  | Expected behavior                                                       |
| ------------------------- | ----------------------------------------------------------------------- |
| Create custom RS          | User sets 12M/6M/3M weights and receives ranked market results          |
| Compare models            | User switches between saved RS models and sees different scores/ranks   |
| Find emerging leaders     | User filters by RS velocity, U/D volume, float, and proximity to highs  |
| Analyze industry rotation | User sorts industries by 4W RS improvement and drills into constituents |
| Analyze weak breadth      | User examines percentage of stocks below moving averages over time      |
| Inspect daily momentum    | User clicks the up-4% breadth statistic and sees qualifying stocks      |
| Replay history            | User selects a historical date and sees historically valid results      |
| Research a breadth event  | User evaluates subsequent index returns following a defined condition   |
| Recover from missing data | Dashboard identifies incomplete input and avoids misleading output      |

## 20. Development roadmap

Phase 1

Weeks 1–3

Market data foundation

Provider evaluation, historical backfill, security master, adjusted prices, daily updates, validation, and data-quality dashboard.

Phase 2

Weeks 4–6

Stock analytics and RS

Returns, moving averages, U/D volume, proximity to highs, configurable RS models, daily and weekly ranks, velocity, and stock detail pages.

Phase 3

Weeks 7–9

Market Overview and advanced screener

Percentage-normalized breadth, daily and rolling momentum monitors, A/D and volume breadth, nested screening logic, custom columns, saved screens.

Phase 4

Weeks 10–12

Industry intelligence and historical analysis

Industry rankings, rotation dashboard, group breadth, historical replay, breadth divergences, configurable market-health model.

Phase 5

Later

Advanced research

Alerts, cohort analysis, event studies, additional technical signals, backtesting, commercial multi-user support.

The 12-week plan is a preliminary estimate for an experienced developer using existing UI and analytics libraries. Historical data quality, especially delisted securities and point-in-time reference data, is the largest schedule risk.

## 21. Additional capabilities worth building into the foundation

These are not all required for the first release, but the data architecture should support them.

### 21.1 Market breadth by cohort

Calculate breadth separately for large caps, mid caps, small caps, microcaps, high-float stocks, low-float stocks, and liquidity tiers.

This helps determine whether market strength is concentrated in speculative low-float names or broadly supported by liquid stocks.

### 21.2 Leadership lifecycle

Track how stocks progress through identifiable states:

`Emerging → Strengthening → Established Leader → Deteriorating → Lagging`

Use transparent combinations of RS percentile, RS velocity, price trend, and volume characteristics. These are descriptive classifications, not forecasts.

### 21.3 Historical market analogs

Allow users to compare today's market-breadth profile against historical periods with similar breadth, momentum, and leadership concentration.

Return the closest historical matches and their subsequent outcomes, while clearly accounting for limited sample sizes.

### 21.4 Market participation distributions

Beyond averages, show the distribution of stock returns.

Useful measures include:

- Median versus mean return.
- 10th, 25th, 75th, and 90th percentile returns.
- Return dispersion.
- Skewness.
- Percentage of stocks with positive returns.
- Percentage outperforming the index.

This exposes market conditions that a single index or average breadth number can hide.

### 21.5 Leadership transition matrices

Track stocks moving between RS percentile bands each week.

For example:

| Previous band | Current band | Interpretation        |
| ------------- | ------------ | --------------------- |
| Bottom 50%    | Top 20%      | Major improvement     |
| Top 20%       | Top 10%      | Strengthening         |
| Top 10%       | Top 10%      | Persistent leadership |
| Top 10%       | Bottom 50%   | Major deterioration   |

Use a transition matrix to quantify the stability or turnover of market leadership.

### 21.6 Breadth of breakouts

Track the percentage of the market breaking above 20-, 50-, and 252-day highs on expanding volume.

This can help distinguish a rally driven by a few existing leaders from one in which new stocks are joining the advance.

## 22. Final delivery requirements

The completed application must deliver:

- A locally owned historical US equity database.
- Daily automated price and volume ingestion.
- Configurable market universes with historical eligibility.
- Multiple saved RS models with arbitrary period weighting.
- Daily and weekly historical rankings and rank velocity.
- Advanced nested screening and multi-column sorting.
- Float, price-high proximity, U/D volume, and other price-volume indicators.
- A percentage-normalized market breadth homepage.
- Daily and multi-day momentum participation monitors.
- Market-wide volume and moving-average breadth.
- Sector, industry, and custom-theme rankings.
- Industry rotation and breadth analytics.
- Historical replay and market-health visualization.
- Saved screens, exports, and an extensible alert architecture.
- Reproducible calculations with comprehensive data-quality controls.

## 23. Product decisions to finalize before development

The following defaults are recommended, but should be confirmed during technical design:

| Decision                       | Proposed default                                   |
| ------------------------------ | -------------------------------------------------- |
| Primary market                 | NYSE + Nasdaq common stocks                        |
| Extended coverage              | NYSE American optional                             |
| Historical backfill            | 10 years minimum                                   |
| Price adjustment               | Split-adjusted                                     |
| Dividend treatment             | Optional total-return mode                         |
| Default RS                     | 40/30/20/10 weighting over 12M/6M/3M/1M            |
| RS ranking frequency           | Daily, with saved weekly snapshots                 |
| Default U/D ratio              | 50 trading sessions                                |
| Market monitor daily threshold | ±4%                                                |
| Large-move thresholds          | ±25%, ±50%                                         |
| Large-move windows             | 20 and 63 sessions initially                       |
| Breadth denominator            | Eligible, comparable, traded common stocks         |
| Industry scoring               | Median constituent RS percentile                   |
| Market health                  | Configurable composite, no opaque predictive model |
| Deployment                     | Private, single-user application initially         |

### Most important engineering requirement

The platform should have one canonical calculation engine shared by every module.

The stock screener, RS rankings, industry dashboard, Market Overview, historical replay, and event studies must all use the same underlying security universe, adjusted prices, metric definitions, and historical snapshots.

Otherwise, it is easy to end up with inconsistent figures—for example, the screener reporting one number of stocks above their 50-day average while the Market Overview reports another.

The central architectural objective is a reusable market intelligence engine that can calculate any stock-level metric, aggregate it into any group, normalize it against a historical universe, and analyze how it changes over time.

That foundation is what will make the software extensible as you develop more sophisticated ways to identify stock leadership, industry rotation, and market health.