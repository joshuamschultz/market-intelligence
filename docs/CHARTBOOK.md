# ChartBook

ChartBook is a saved, date-aware chart review assembled from built-in lists, saved screens, manual watchlists, or manually entered tickers. It deduplicates by permanent security ID, so a stock that appears in several sources is reviewed once and displays a badge for each matching source.

## Create and review a book

1. Choose **New book**, name it, and select one or more built-in lists, saved screens, watchlists, or manual tickers/security IDs. Save the definition. Use **Edit book** to change sources later.
2. Optionally choose a default manual watchlist. **Bookmark** or the **B** key adds the current security to that list; a saved screen-backed dynamic watchlist cannot be the bookmark destination.
3. Review the selected session, data revision, matching source badges, and source status. If a source is pending or unavailable, check **Sources** and the preparation status before interpreting a short list.
4. Use **Previous** and **Next** or the keyboard to move through the deduplicated securities. Save a note for the current security and session; notes persist with that security/date.

Manual entries resolve against the selected date and revision. An ambiguous or unavailable identity is shown as unresolved instead of being guessed. Sources may be partial when a saved list is unavailable or unprepared.

## Chart and overlays

The default range is six months (126 trading sessions). Select 1M, 3M, 6M, 1Y, or 5Y (21, 63, 126, 252, or 1,260 sessions). The chart reports actual priced sessions and date bounds. If stored price history is shorter, the 5Y control does not imply five years of data; the chart labels the shorter range.

Available overlays are 20-session and 50-session simple moving averages, SPY, Industry, and a ±4% daily-move strip. The strip marks a stock's individual close-to-close return when its absolute move is at least 4%; it is not a market breadth percentage. Comparison lines are rebased to the stock close at their displayed common/first usable anchor, so they share a visual price scale but are not raw SPY or industry prices. Missing or quarantined sessions create gaps rather than interpolated values.

Industry comparison uses dated group returns when those records exist. A current-member equal-weight price proxy may be prepared for the latest reconstructed session. That proxy applies today's roster retrospectively and does not establish historical constituents. Historical dates without dated industry membership can therefore have no industry line. Check the comparison status and label under the chart.

The point display shows the selected session's date, close, daily return, OHLC and volume when available, and rebased comparison values. It is keyboard accessible: focus the chart, then use Up/Down to inspect adjacent sessions or Home/End to jump to the first/last plotted session. Escape dismisses the point display.

## Industry constituents

Source package 0.3.2 adds a **Stocks (count)** button to industry cards in the Market & Industry ChartBook's Combined and Industries views. The count is the group's traded constituents at the selected review session. Open it to search by ticker or company; results are server-paged in 30-row pages, sorted by RS rank, and show ticker, company, close, daily return, RS percentile, and 4-week stock RS velocity. Check `/api/v1/build` to confirm the feature is in the active release.

Hover or keyboard-focus a ticker to see its prepared 3-month (63-session) daily candle preview. Select the ticker to open the full stock dashboard, including its available stats, pinned to the ChartBook's session and data revision. Escape or clicking outside closes the drawer and returns focus to its opener without moving the chart or changing its range. There is no extra keyboard shortcut for this drawer. The existing **M** shortcut still sets the main chart range to 3M.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| Space | Next security |
| Shift+Space or ← | Previous security |
| B | Bookmark in the configured default watchlist |
| V | Increase the chart range to the next available range |
| M | Set the chart to 3M |
| N | Open/edit the dated note |
| Escape | Dismiss the chart point display |

Shortcuts are inactive while a dialog is open or focus is in an input, text area, select, or editable text. This keeps ordinary typing from triggering navigation or edits.

## Stock Lists and saved definitions

Stock Lists is for period-return leaders and saved RS model lists. Period lists rank their own comparable population and allow an adjustable top-percent cutoff; model lists answer the selected model's ranking question. Edit model configuration in **Settings**. Use **Saved Screens** as the canonical home for reusable filter, sort, and column rules; a saved screen can also be included as a ChartBook source.

## Data and interpretation limits

ChartBook reads the selected date/revision and available prepared price and ranking history; source status is visible in the book. It does not fill missing prices or prove complete US-market membership. Industry proxies and short stored histories should be interpreted according to their displayed method and date coverage. The constituents list uses group membership at the selected review session; the chart cursor does not change that date. ChartBook is a research aid, not a trading recommendation.
