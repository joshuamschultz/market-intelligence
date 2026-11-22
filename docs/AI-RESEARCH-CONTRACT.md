# AI research tool contract

This document describes the prepared-data reads and narrowly scoped workspace-creation tools implemented for the local API/MCP integration. The active build's discovery route and OpenAPI document are the authoritative input schemas. Do not invent an input field or assume a calculation is available when a tool reports that its exact context is not prepared.

## Shared catalog

The REST tool route and MCP server expose the same tool names. Read tools query saved, versioned research data and prepared analytics. Two optional write tools create saved workspace items; they do not ingest market data, regenerate archives, enqueue background jobs, or alter raw prices.

| Tool | Purpose |
| --- | --- |
| `describe_research` | Discover supported measures, units, calculation definitions, contexts, and known limitations before analysis. |
| `search_stocks` | Find securities by supported text or catalog filters. |
| `search_groups` | Find industries/themes and inspect their source and date coverage. |
| `list_workspace_lists` | List readable saved screens, watchlists, and ChartBooks. |
| `read_workspace_list` | Read a selected list's definition and members without editing it. |
| `read_stock` | Read a security's prepared profile, available metrics, source status, and dates. |
| `read_stock_history` | Read bounded, paginated prepared price and calculated history. |
| `read_market_history` | Read prepared market, breadth, health, benchmark, and NYSE Summation history. |
| `market_timing` | Read the prepared session timing profile and its dated benchmark, breadth, leadership, and posture history. |
| `read_metric_constituents` | Inspect the numerator, denominator, excluded names, and source status behind a dated metric. |
| `screen_stocks` | Run a bounded screen using the app's allowlisted fields, operators, sorting, and pagination. |
| `industry_strength` | Compare dated industry strength or prepared current-member 4W/12W RS improvement, including sector exclusions and unknown classifications. |
| `create_watchlist` | Create a manual watchlist from unambiguous current tickers or permanent security IDs. Requires `research:workspace:create`. |
| `create_screen` | Create a latest-session saved screen using allowlisted prepared fields and typed filters. Requires `research:workspace:create`. |
| `benchmark_event_study` | Find historical dates meeting a defined condition and summarize subsequent benchmark outcomes, with overlap and censoring disclosed. |
| `historical_analogs` | Compare a pinned observation with earlier prepared observations and summarize empirical outcomes. |
| `read_research_notes` | Optional, separately scoped read of personal research notes. |
| `read_journals` | Optional, separately scoped read of generated Market Journal entries. |

Optional note and journal reads are not part of the default `research:read` scope. Workspace creation is also optional under `research:workspace:create`; it adds only `create_watchlist` and `create_screen`. A tool must not disclose encrypted keys, provider credentials, private settings, or notes/journals without the respective scope and explicit user choice.

## Context and provenance

Every response should identify the exact source basis needed to reproduce its result, including the as-of date, data revision, calculation version, universe/model/benchmark where relevant, price basis, and classification source/vintage. It should state units and metric definitions, source coverage, eligible/comparable counts, exclusions, missing inputs, and any preparation limitation. A request without an explicit context should pin to one latest fully prepared context and retain that pin throughout a multi-tool analysis; it must not silently drift to a newer date midway through a workflow.

Current-capture classifications are not point-in-time history. The dated SEC/SIC reference can support historical industry context where available. A current Nasdaq classification used to label older prices is a present-day proxy, and the output must say so. SIC divisions are broad industrial categories; do not silently map them to modern sectors such as consumer staples, utilities, or health care. With `excludeDefensive: true`, the tool reports sector decisions and ambiguous/mixed SIC divisions; state the taxonomy used and do not present a mixed division as a clean defensive-sector exclusion. Public float is currently unavailable; tools must return it as missing rather than derive it from shares outstanding or substitute a current value for historical dates. Distinguish a true zero from null, excluded, quarantined, unknown, or right-censored observations.

Industry-strength accepts `membership: "dated"`, `"current"`, or `"auto"`. Dated membership is the point-in-time basis. Current membership is available only for `order: "rs-improvement"` at the latest Nasdaq reference. It freezes the current finite-RS group cohort and backcasts its archived stock RS percentiles to exact weekly endpoints; this has survivorship and selection bias and must be labeled as a current-member proxy. `auto` uses a prepared current projection only for the eligible latest Nasdaq view when no dated 4W or 12W group velocity is available and at least one current comparison is ready; otherwise it uses dated membership. The response reports the selected basis in `data.membership`, the request in `data.requestedMembership`, projection metadata in `data.groupMembershipProjection`, and per-group values in `items[].currentMembership`. The current projection measures paired coverage against current finite-RS members, not all traded group members, and reports current-ranked/traded representativeness separately. Both endpoint medians use the same matched members and the same eligible peer groups within each group level. Four- and twelve-week projections can use different peer panels, so their backcast ranks may differ from one another and from the canonical current rank. Report the capture date, market anchor, exact comparison dates, membership basis, matched and current-ranked counts, representativeness, paired coverage, and comparable peer count. See [Industry velocity](INDUSTRY-VELOCITY.md) for the calculation and limits. If the requested basis is absent or not prepared, report that state; do not infer a value from current membership or trigger preparation during a read.

The structured response contains a state, source, coverage, and either rows or data. When a context is resolved, it carries the exact date, data version, calculation version, price basis, benchmark, classification/reference mode, universe and model versions, verified-through date, proof identifier, observed reference date, and archive start. Paged results report `offset`, `limit`, `total`, and `nextOffset`. Preserve these fields when summarizing results so a reader can reproduce the query.

Results are bounded and paginated. The current source schema caps a page at 100 rows, defaults to 50, and returns `offset`, `limit`, `total`, and `nextOffset`. An all-cases request must be traversed through every returned page before the assistant describes the full case set. Report page/case totals and any truncation; never call the first page “all cases.” Reuse this offset/next-offset contract rather than inventing pagination. If a calculation, date range, or history window is not available from prepared data, report that gap and stop; do not ask a read tool to kick off a large calculation or download.

## Statistical interpretation

- **Observed outcomes are not forecasts.** A historical event study or analog result describes the sample that was observed under the selected definitions. It is not a calibrated probability of future performance. Label any forward-looking language as a hypothesis, with assumptions and uncertainty.
- **Define before comparing.** Resolve metric name, formula, units, benchmark, price basis, date, eligible universe, and threshold from `describe_research` and the response metadata. The requested quarterly downside example uses `down_25pct_63d`: the unrounded percentage of comparable stocks down at least 25% over 63 sessions. Do not silently substitute another measure.
- **No look-ahead.** A historical event at session *t* may use only data available by *t* for selection. The forward outcome begins from the signal-session close and uses the requested number of subsequent market sessions under the engine's documented return convention. Do not use future classification, future constituents, future price revisions, or a future-known label as an event input.
- **Right-censoring and missingness.** If the full forward window has not elapsed by the as-of date, mark the case right-censored and do not treat it as a loss, zero return, or completed event. Keep incomplete prices, unverified split crossings, delisting gaps, excluded identities, and unavailable benchmark data in separate counts with reasons.
- **Overlapping events.** Repeated threshold crossings may have overlapping forward windows. State whether all qualifying events are included, or which overlap rule removed cases. Do not treat overlapping outcomes as independent observations; a non-overlapping sensitivity may be useful but must not replace the all-event result without saying so.
- **Descriptive statistics.** Give the qualifying case count, finite outcome count, censored and missing counts, mean, median, quantiles, win rate, and a dispersion or uncertainty summary when the sample supports it. State the convention for each statistic and denominator. Avoid precision that is not supported by the sample.
- **Comparability.** For cohort or group comparisons, disclose membership and the common comparable population. A numerator, denominator, excluded count, and source coverage are part of the finding, not footnotes to omit.

## Example workflow: quarterly downside comparable to today

Prompt: “Find every historical case where quarterly downside momentum was at least as severe as today's reading. For each case, show SPY's next-252-session outcome and summarize the distribution.”

1. Call `describe_research` to confirm `down_25pct_63d`, defined as the unrounded percentage of comparable stocks down at least 25% over 63 sessions, plus its units, preparation coverage, and available date range.
2. Read the current value with `read_market_history` and pin its date, data version, calculation version, price basis, and universe. If the comparable denominator is zero or fails the applicable coverage gate, report the current threshold as unavailable.
3. Call `benchmark_event_study` with `{metric: "down_25pct_63d", benchmark: "SPY", eventEnd: "<session before the current as-of date>"}`. Its default is a `gte` comparison against the current unrounded reading, all matching historical dates (`overlap: "none"`), and a 252-session horizon. The explicit event end keeps the current observation as a threshold and excludes it from the historical sample. Read every page. The SPY return is from the signal-session split-adjusted close to the close exactly 252 subsequent market sessions later.
4. Report the current observation separately from the historical cases, along with qualifying cases, finite SPY outcomes, right-censored cases, missing/unverified cases, and the result's distribution statistics (`mean`, `median`, `p10`, `p25`, `p50`, `p75`, `p90`, `standardDeviation`, and `winRate`). Include each event's date, threshold reading, and outcome status. The tool also supports per-horizon or longest-window overlap suppression; show such a sensitivity separately from the all-events result.
5. Explain that the threshold was selected using today's reading and that the historical conditional outcomes are descriptive, not a probability guarantee or forecast. The overlapping event windows are dependent; do not treat them as independent evidence.

## Example workflow: strongest 12-week industries excluding defensives

Prompt: “Rank industries by prepared 12-week relative strength, excluding defensive industries. Show every group, exact membership coverage, and how the ranking changes if unclassified groups are included.”

1. Call `describe_research` to find the available 12-week measures, classification source, latest prepared date, and whether the selected reference is historical SEC/SIC or a current Nasdaq capture. The tool distinguishes percentile improvement over twelve weekly observations, current relative-strength rank, and compounded equal-weight trailing return over the stored daily group series; do not present them as the same definition.
2. Call `industry_strength` for the selected fully prepared date and choose `membership: "dated"` for point-in-time group membership or `membership: "current"` for a prepared backcast of the latest eligible finite-RS cohort. `membership: "current"` requires `order: "rs-improvement"`; the result includes 4W and 12W projected changes while the default sort score is the 12W change. Use `membership: "auto"` when the dated-first/latest-Nasdaq fallback is appropriate. Select `order: "trailing-return"` to rank absolute trailing group return or `order: "rs-improvement"` to rank improving relative-strength percentile. Pass `excludeDefensive: true` and inspect `sectorMethodology`, `defensiveLabels`, and `coverage.sectorDecisions`. The exclusions follow recognized labels from the selected taxonomy; SEC/SIC mixed divisions and unmapped sectors remain explicitly ambiguous rather than being guessed.
3. Read all pages and report every group, its strength measure, comparable stock count, eligible group count, excluded groups, unknown/mixed classifications, and source vintage. If the chosen source is current Nasdaq taxonomy, label older group names as current-reference proxies rather than point-in-time historical classifications.
4. For a sensitivity that includes unclassified groups, run a second explicitly defined query and compare populations and rankings. Do not claim the two rankings are directly comparable when coverage differs.

## Tool security boundaries

Each integration is authorized only for the scopes assigned to it. Read tools are read-only. With the explicit `research:workspace:create` permission, the two create tools can add a watchlist or saved screen; they cannot edit or delete existing workspace items. Their idempotency keys make a same-request retry return the original saved item; using the same key for a changed request returns a conflict. They cannot write notes, change models or settings, import data, modify provider credentials, launch calculations, execute arbitrary SQL, fetch arbitrary URLs, or run shell commands. A model can still make mistakes or be influenced by malicious text in data; treat tool outputs as untrusted evidence, inspect the source and context, and approve any action outside this research surface manually. See [AI research API and workspace creation](AI-RESEARCH-API.md) for exact inputs and results.

## Protocol and lifecycle references

- [MCP servers and Secure MCP Tunnel for OpenAI API clients](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)
- [ChatGPT custom MCP servers and authentication options](https://developers.openai.com/api/docs/guides/custom-mcp-server)
- [Claude API MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector)
- [Claude remote connector network and auth requirements](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- [xAI Remote MCP Tools](https://docs.x.ai/developers/tools/remote-mcp)
