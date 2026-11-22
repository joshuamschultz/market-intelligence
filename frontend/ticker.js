import { chart, disposeChartNoteBindings, exportChart } from './charts.js';
import { rangeLimit, rangeSegment } from './chart-ranges.js';
import { stockQualityPanel } from './data-quality.js';
import { mountResearchNoteHistory, noteSubject, openResearchNoteEditor } from './research-notes.js';
import { renderStockMovingAverages, renderStockVolumeWindows, stockMetricValue, stockSectionTabs, stockSections, stockVolumePeriods } from './stock-sections.js';
import { describePricePoint, plottableBar, stockScreenMatches, toWeekly } from './stocks.js';
import {
  action, chip, count, dateLabel, direction, empty, fieldDetails, heading, icon, iconButton,
  money, notice, number, numeric, panelHead, pathPart, pending, rangeFieldDetails, rangeFieldId, rate, ratio, safe, segment,
  signed, summary, tradingViewLink, warming,
} from './ui.js';

const defaultRange = 126;
const cadences = [['daily', 'Daily'], ['weekly', 'Weekly']];
const quarters = [4, 8, 12];
const rangeWindows = [20, 252];
const extraFields = [
  ...[50, 100, 150, 200].map((days) => [`return_${days}d`, `${days}D return`, 'rate']),
  ['raw_close', 'Unadjusted close', 'money'],
  ['leadingWeekCoverage', 'Comparable RS weeks', 'integer'],
  ['relative_strength_line', 'Price / benchmark close', 'decimal'],
  ['dailyMove', 'Advance / decline'],
  ['nearHigh', 'Within 10% of 52W high', 'bool'],
  ['topDecile', 'Top-decile RS', 'bool'],
  ['highVolumeMove', 'High-volume move (≥ 1.5×)'],
  ['sectorRelativeReturn', '1M return vs sector', 'rate'],
  ['gap_up', 'Gap up over 2%', 'bool'], ['gap_down', 'Gap down over 2%', 'bool'],
  ['streak', 'Consecutive up / down days', 'signed'],
  ['high_252d', '52W high', 'money'], ['low_252d', '52W low', 'money'],
  ['loadedHistoryHigh', 'Loaded-history high', 'money'], ['allTimeHigh', 'Verified listing high', 'money'],
  ['float_turnover_1d', 'Float turnover 1D', 'rate'],
  ['marketCapDate', 'Market cap date', 'date'],
  ['annualizedVolatility', '20D annualized volatility', 'rate'],
  ['maximumDrawdown', 'Maximum drawdown in chart window', 'rate'],
  ['beta', 'Beta vs benchmark', 'decimal'], ['correlation', 'Correlation with benchmark', 'decimal'],
  ['dailyHistoricalReturn5pct', 'Daily return, 5th percentile', 'rate'],
  ['dailyHistoricalVaR95', 'Daily historical VaR (95%)', 'rate'],
  ['observations', 'Comparable risk observations', 'integer'], ['benchmarkObservations', 'Paired benchmark observations', 'integer'],
  ...stockVolumePeriods.map((days) => [`obv_slope_${days}d`, `${days}D OBV change`, 'compact']),
].map(([field, label, format = 'text']) => ({ field, label, format }));

function valueTile(label, value, note = '') {
  return `<div class="metric-tile"><span>${safe(label)}</span><strong>${safe(value ?? '—')}</strong>${note ? `<small>${safe(note)}</small>` : ''}</div>`;
}

function metrics(ids, row) {
  return ids.map((id) => {
    const { label } = fieldDetails(id, extraFields, row);
    return `<div class="metric-tile" data-metric="${safe(id)}"><span>${safe(label)}</span><strong>${stockMetricValue(id, row, extraFields)}</strong></div>`;
  }).join('');
}

function metricPanel(title, body, { tools = '', collapse = false, description = '' } = {}) {
  const grid = `<div class="metric-grid${collapse ? ' section-space' : ''}">${body}</div>`;
  return collapse
    ? `<details class="panel panel-body formula-help"><summary>${safe(title)}</summary>${grid}</details>`
    : `<section class="panel panel-body">${panelHead(title, description, tools)}${grid}</section>`;
}

function participation(row) {
  const move = row.return_1d;
  const dailyMove = numeric(move) ? move > 0 ? 'Advancer' : move < 0 ? 'Decliner' : 'Unchanged'
    : row.traded === false ? 'Untraded' : null;
  const highVolumeMove = numeric(move) && numeric(row.rvol_20d)
    ? row.rvol_20d >= 1.5 && move !== 0 ? dailyMove : 'No' : null;
  return { ...row, dailyMove, highVolumeMove,
    nearHigh: numeric(row.distance_high_252d) ? row.distance_high_252d >= -0.1 : null,
    topDecile: numeric(row.rsPercentile) ? row.rsPercentile >= 90 : null };
}

function participationBadges(row) {
  const badges = [];
  if (row.dailyMove) badges.push(chip(row.dailyMove));
  if (numeric(row.return_1d) && Math.abs(row.return_1d) >= 0.04 - 1e-12) {
    badges.push(chip(row.return_1d > 0 ? 'Up at least 4%' : 'Down at least 4%'));
  }
  if (row.above_50d != null) badges.push(chip(row.above_50d ? 'Above 50D SMA' : 'At or below 50D SMA'));
  if (row.topDecile) badges.push(chip('Top-decile RS', 'accent'));
  return badges.join('');
}

function priceRanges(row) {
  const stored = Object.keys(row).map(rangeFieldDetails).filter(Boolean).map(({ days }) => days);
  const requested = row.rangeMetrics?.windows || rangeWindows;
  const missing = row.rangeMetrics?.missingWindows || requested.filter((days) => !stored.includes(days));
  const windows = [...new Set([...requested, ...stored])].sort((a, b) => a - b);
  const rangeIds = windows.flatMap((days) =>
    ['distance', 'since', 'age'].flatMap((metric) => ['high', 'low'].map((side) => rangeFieldId(metric, side, days))));
  const note = missing.length
    ? `<p class="muted">Rolling high and low calculations for ${safe(missing.join(', '))} sessions are unavailable for this snapshot.</p>` : '';
  return `<section class="panel panel-body">${panelHead('Highs, lows, and event age')}${note}<div class="metric-grid">${metrics([
    'high_252d', 'low_252d', 'distance_high_252d', 'distance_low_252d',
    'allTimeHigh', 'distance_all_time_high', 'loadedHistoryHigh', 'distance_loaded_history_high', ...rangeIds,
  ], row)}</div></section>`;
}

function companyContext(env, row, current) {
  const peers = [['industry', row.industryId], ['sector', row.sectorId]].filter(([, id]) => id).map(([level, group]) =>
    `<a class="button" href="${safe(env.routeUrl('industries', { ...current, group, level }))}">${level === 'industry' ? 'Industry' : 'Sector'} peers ${icon('chevron-right')}</a>`).join('');
  return metricPanel('Industry and sector', metrics([
    'sector', 'industry', 'subindustry', 'industryRS', 'industryVelocity', 'industryBreadth', 'industryRelativeRS',
    'industryRelativeReturn', 'sectorRelativeRS', 'sectorRelativeReturn', 'industryImproving', 'industryEmerging',
  ], row), { tools: peers });
}

function liquidityPanel(row) {
  const fields = ['market_cap', 'market_cap_change', 'shares', 'float', 'adv_20d',
    ...(row.marketCapDate ? ['marketCapDate'] : []), ...(row.marketCapBucket ? ['marketCapBucket'] : []),
    ...(numeric(row.float_turnover_1d) ? ['float_turnover_1d'] : [])];
  return metricPanel('Liquidity and company fundamentals', metrics(fields, row) + [
    row.sharesDate && valueTile('Shares effective date', dateLabel(row.sharesDate)),
    row.floatDate && valueTile('Float effective date', dateLabel(row.floatDate)),
  ].filter(Boolean).join(''), { description: 'Share and float figures use the dated records available for this snapshot.' });
}

function dataContext(row, context, source) {
  return metricPanel('Security and source data', [
    valueTile('Permanent security ID', row.securityId), valueTile('ISIN', row.isin), valueTile('Security type', row.type),
    valueTile('Price source', source), valueTile('Source price known through', dateLabel(row.sourceKnownAt)),
    valueTile('Reference through', dateLabel(row.referenceDate), row.referenceMode === 'latest' ? 'Latest reference data' : ''),
    valueTile('Classification', row.classificationSystem || context.classification),
    valueTile('Warehouse revision', row.dataVersion ?? context.dataVersion), valueTile('Calculation version', row.calculationVersion),
    ...(row.sourceDataVersion != null ? [valueTile('Calculation source revision', row.sourceDataVersion)] : []),
    valueTile('Earliest observation', dateLabel(row.earliestDate)), valueTile('Latest observation', dateLabel(row.latestDate)),
    valueTile('Loaded high history from', dateLabel(row.loadedHistoryHighFrom)),
    valueTile('Listing date', dateLabel(row.listingDate)), valueTile('Delisting date', dateLabel(row.delistingDate)),
    valueTile('Fundamentals date', dateLabel(row.fundamentalsDate)), valueTile('Fundamentals known', dateLabel(row.fundamentalsKnownAt)),
    valueTile('Corporate actions', count(row.actions?.length)), valueTile('Watchlists', row.watchlists?.join(', ') || 'None'),
  ].join(''), { collapse: true });
}

function details(id, value, title) {
  return `<details class="panel panel-body formula-help"><summary data-action="stock-tab-local" data-value="${value}">${title}</summary>
    <div id="${id}" class="section-space"></div></details>`;
}

function preparationNotice(info, subject) {
  if (!info) return '';
  if (info.error) return notice(`${subject} unavailable`, info.error, '', true);
  if (info.pending || info.captureInProgress) {
    return warming(info.captureInProgress ? { ...info, status: 'waiting_for_capture' } : info, subject);
  }
  return notice(`${subject} unavailable`, 'This analysis has yet to be prepared for the selected context.',
    action('Open jobs', 'warehouse-jobs', 'settings'));
}

function canFollow(info) {
  return info?.captureInProgress || (info?.pending && info.jobId);
}

function productNotice(product, subject) {
  if (!product || product.state === 'ready') return '';
  if (product.pending) return warming(product, subject);
  const reason = product.error || (product.state === 'requires-exact-date'
    ? 'This session requires its own prepared price frame.'
    : 'This product is waiting for preparation at the selected date and warehouse revision.');
  return notice(`${subject} unavailable`, reason, action('Prepare price and risk', 'prepare-ticker-detail', 'refresh'), !!product.error);
}

function chartPanel(row, bars, range, cadence, noteOptions = {}) {
  const product = row.detailPreparation?.chart;
  const controls = rangeSegment('stock-range-local', range) + segment('stock-cadence-local', cadences, cadence);
  if (product && product.state !== 'ready') return panelHead('Price and volume', '', controls) + productNotice(product, 'Price history');
  if (product?.priceAvailability === 'no-known-observations') {
    return panelHead('Price and volume', '', controls) + notice('No prices known for this interval',
      'The selected point-in-time revision has no usable prices in this window.');
  }
  const visible = bars.slice(-range);
  let nextSession = 0;
  const plot = cadence === 'weekly' ? toWeekly(visible).map((week) => {
    const noteDates = [];
    while (visible[nextSession]?.date <= week.date) noteDates.push(visible[nextSession++].date);
    return { ...week, noteDates };
  }) : visible;
  const tools = controls + (visible.some((bar) => numeric(bar.close)) ? iconButton('Export plotted prices CSV', 'stock-export-local', 'download') : '');
  return panelHead('Price and volume', `${count(visible.length)} market sessions through ${dateLabel(row.date)} · Split-adjusted prices`, tools) +
    chart(plot, [{ key: 'close', label: 'Close', format: money }], {
      label: `${row.symbol} ${cadence} candlestick chart`, candles: true, volume: true, width: 900, height: 305,
      exportFields: ['open', 'high', 'low', 'close', 'volume'], describePoint: describePricePoint,
      ...noteOptions,
    });
}

const sectionVisible = (selected, scope) => selected === 'all' || scope.split(' ').includes(selected);

export async function render(env) {
  const { main, params, snapshotContext = {}, signal } = env;
  const symbol = params.symbol?.trim();
  const selectedDate = snapshotContext.date;
  const contextDate = selectedDate ? `Selected session ${dateLabel(selectedDate)}` : '';
  if (!symbol) {
    main.innerHTML = heading('Ticker') + empty('Select a security', 'Use ticker search or choose a ticker from a market view.', 'search');
    return;
  }
  main.innerHTML = heading(symbol, contextDate) + pending('Loading ticker dashboard…');
  const path = `stocks/${pathPart(symbol)}`;
  const options = { params: { lookback: defaultRange }, signal };
  const active = () => !signal?.aborted && (env.isActive?.() ?? true);
  let range = defaultRange;
  let cadence = 'daily';
  let rankingRange = 252;
  let priceRun = 0;
  let selectedSection = 'session';
  let notesCleanup;

  function display(data) {
    notesCleanup?.();
    notesCleanup = null;
    disposeChartNoteBindings(main);
    const info = data.materialization;
    if (data.pendingOnly || !data.symbol) {
      main.innerHTML = heading(data.symbol || symbol, contextDate || dateLabel(data.date)) +
        `<div id="stock-warming">${preparationNotice(info, 'Ticker dashboard') || notice('Ticker dashboard unavailable', 'No security detail was returned for the selected context.')}</div>`;
      return;
    }

    const row = participation(data);
    const products = row.detailPreparation;
    const date = row.date || selectedDate;
    const current = { ...snapshotContext, date, dataVersion: row.dataVersion ?? snapshotContext.dataVersion,
      classification: snapshotContext.classification || row.classificationSystem,
      reference: snapshotContext.reference || row.referenceMode };
    const bars = (row.chartBars || row.bars || []).filter((bar) => bar?.date && bar.date <= date).map(plottableBar);
    const latestBar = bars.findLast((bar) => bar.source);
    const source = latestBar?.source || row.source || row.provider;
    const priceQuarantined = row.quality?.some((record) => record.kind === 'price' &&
      record.effective_from <= date && date <= record.effective_to);
    const warnings = (row.warnings || []).filter((message) => !row.quality?.some(({ reason }) => reason === message));
    const model = row.model?.name || env.config?.models?.find(({ id, version }) =>
      id === current.model && (current.modelVersion == null || String(version) === String(current.modelVersion)))?.name || current.model;
    const title = `${row.symbol}${row.name ? ` · ${row.name}` : ''}`;
    const tags = [row.exchange, row.type, source, model, current.universe, row.benchmark,
      priceQuarantined ? 'Price quarantined' : null].filter(Boolean).map((text) => chip(text)).join('');
    const tools = tradingViewLink(row) + action('Add to watchlist', 'stock-watch-local', 'watchlists');
    const returns = Object.keys(row).filter((key) => /^return_\d+d$/.test(key));
    const obvChanges = stockVolumePeriods.filter((period) => period === 20 || numeric(row[`obv_slope_${period}d`]))
      .map((period) => `obv_slope_${period}d`);
    const plotRow = { ...row, date };
    const subject = row.securityId && noteSubject('stock', row.securityId, current);
    const noteOptions = { notes: [], noteSignal: signal,
      onNoteEdit: (note) => openResearchNoteEditor(env, { subject, date: note.date, note }) };
    const section = (scope, content) => `<div data-stock-section="${scope}"${sectionVisible(selectedSection, scope) ? '' : ' hidden'}>${content}</div>`;

    main.innerHTML = `<div id="ticker-dashboard">
      ${heading(title, `As of ${dateLabel(date)}${selectedDate && selectedDate !== date ? ` · ${contextDate}` : ''}`, tools)}
      <div class="inline-stack">${tags}${participationBadges(row)}</div>
      <div id="stock-warming" class="section-space">${preparationNotice(products?.weekly?.state === 'ready' ? null : products?.weekly || info,
        products?.metrics?.state === 'unprepared' ? 'Stock metrics' : 'Rank change and persistence')}</div>
      ${stockSectionTabs(selectedSection)}
      <div class="stack">
        ${section('session', `<div class="summary-grid three">
          ${summary('Split-adjusted close', money(priceQuarantined ? null : row.close), priceQuarantined ? 'Source price quarantined' : rate(row.return_1d), { glyph: 'chart', style: direction(row.return_1d) })}
          ${summary('RS percentile', number(row.rsPercentile), row.rsRank == null ? 'Unranked' : `Rank ${count(row.rsRank)}`, { glyph: 'rankings' })}
          ${summary('4W RS velocity', signed(row.velocity4w), 'Percentile-point change', { glyph: 'pulse', style: direction(row.velocity4w) })}
        </div>${metricPanel('Session activity', metrics([
          'dailyMove', 'gap', 'intraday_return', 'volume', 'dollar_volume', 'rvol_20d', 'new_high_20d', 'highVolumeMove',
        ], row))}`)}
        ${section('session price', `<section class="panel panel-body" id="stock-price-panel">${chartPanel(plotRow, bars, range, cadence)}</section>`)}
        ${subject ? '<section class="panel panel-body" id="stock-research-notes"></section>' : ''}
        ${section('price', renderStockMovingAverages(row))}
        ${section('price', metricPanel('Trend and participation signals', metrics([
          'ma_aligned', 'ma_50_above_200', 'ma_rising_50', 'ma_rising_200', 'traded', 'nearHigh', 'topDecile',
        ], row), { collapse: true }))}
        ${section('price', metricPanel('Returns and price action', metrics([
          'raw_close', ...new Set(['return_1d', 'return_5d', 'return_21d', 'return_63d', 'return_126d', 'return_252d', ...returns]),
          'gap', 'gap_up', 'gap_down', 'intraday_return', 'streak', 'volatility_compression',
          'atr_14d', 'atr_contraction', 'consolidation_range_20d', 'consolidation_duration',
          ...[20, 50, 100, 252].flatMap((n) => [`new_high_${n}d`, `new_low_${n}d`]),
        ], row), { collapse: true }))}
        ${section('price', priceRanges(row))}
        ${section('price', metricPanel('Relative strength and persistence', metrics([
          'rsRank', 'rsPercentile', 'rsScore', 'rsStatus', 'lifecycle', 'rsScoreChange', 'rsAcceleration',
          ...[1, 4, 12].flatMap((n) => [`velocity${n}w`, `rankChange${n}w`]),
          'leadingWeeks', 'leadingWeekCoverage', ...quarters.flatMap((n) => [`topDecileWeeks${n}w`, `topDecilePersistence${n}w`]),
          ...[1, 5, 10, 20].map((n) => `enteredTop${n}`),
          'rsNewHigh', 'rsHighBeforePrice', 'deterioratingOnPriceStrength', 'momentumImproving',
          'relative_strength_line', 'rs_line_new_high', 'relative_return_21d',
        ], row), { collapse: true }))}
        ${section('volume', renderStockVolumeWindows(row))}
        ${section('volume', metricPanel('Volume and participation signals', metrics([
          'volume_trend', 'volume_contraction', 'breakout_volume', 'obv', ...obvChanges, 'mfi_14d', 'cmf_20d', 'clv', 'up_frequency_20d',
          'high_volume_up_20d', 'high_volume_down_20d', 'accumulation_20d', 'high_volume_up_2x_20d', 'high_volume_down_2x_20d',
          'accumulation_2x_20d', 'volumeDemandImproving', 'udvChange4w', 'upVolumeShareChange4w', 'priceAndVolumeStrength',
        ], row), { collapse: true }))}
        ${section('session price volume', details('stock-rs-chart', 'rs', 'RS and volume history'))}
        ${section('liquidity', liquidityPanel(row))}
        ${section('price liquidity', companyContext(env, row, current))}
        ${section('price', `<div id="stock-risk-panel">${products?.risk?.state && products.risk.state !== 'ready' ? productNotice(products.risk, `Risk analysis · ${count(options.params.lookback)} sessions`) :
          metricPanel(`Risk · ${count(options.params.lookback)} sessions`, metrics(['annualizedVolatility', 'maximumDrawdown', 'beta', 'correlation',
            'dailyHistoricalReturn5pct', 'dailyHistoricalVaR95', 'observations', 'benchmarkObservations'], row.risk || {}), { collapse: true })}</div>`)}
        ${section('liquidity', dataContext({ ...row, sourceKnownAt: latestBar?.knownAt }, current, source))}
        ${section('session liquidity', details('stock-screens', 'screens', 'Saved screen membership'))}
        ${stockQualityPanel(row.quality, date)}
        ${warnings.length ? notice('Data quality', warnings.join(' ')) : ''}
      </div>
    </div>`;

    const price = main.querySelector('#stock-price-panel');
    const security = `stocks/${pathPart(row.securityId || symbol)}`;
    function replacePrice(markup) {
      disposeChartNoteBindings(price);
      price.innerHTML = markup;
    }
    function paintPrice() {
      replacePrice(chartPanel(plotRow, bars, range, cadence, noteOptions));
    }
    if (subject) notesCleanup = mountResearchNoteHistory(main.querySelector('#stock-research-notes'), env, subject, {
      from: [row.listingDate, row.earliestDate].filter(Boolean).sort().at(-1),
      to: [row.delistingDate, date].filter(Boolean).sort()[0],
      onChange(notes) {
        const hadNotes = noteOptions.notes.length;
        noteOptions.notes = notes;
        if ((!hadNotes && !notes.length) || !active() || !price.querySelector('[data-chart]')) return;
        const focused = price.ownerDocument.activeElement;
        const controls = [...price.querySelectorAll('button[data-action]')];
        const index = controls.indexOf(focused);
        const marker = focused?.dataset?.researchNoteMarker;
        paintPrice();
        if (index !== -1) price.querySelectorAll('button[data-action]')[index]?.focus();
        if (marker) [...price.querySelectorAll('[data-research-note-marker]')]
          .find((node) => node.dataset.researchNoteMarker === marker)?.focus();
      },
    });
    async function followProduct(job) {
      const run = priceRun;
      const productsInFlight = row.detailPreparation;
      const status = productsInFlight?.chart?.state !== 'ready' ? price : main.querySelector('#stock-risk-panel');
      const subject = productsInFlight?.chart?.state !== 'ready' ? 'Price history' : 'Risk analysis';
      if (!status) return;
      try {
        const result = await env.publishedSeries(path, { ...options, initialResponse: { ...data, materialization: job } }, (_, progress) => {
          if (active() && status.isConnected && run === priceRun) {
            if (status === price) replacePrice(warming(progress, subject));
            else status.innerHTML = warming(progress, subject);
          }
        });
        if (active() && status.isConnected && run === priceRun) display(result);
      } catch (error) {
        if (active() && status.isConnected && run === priceRun && error.name !== 'AbortError') {
          const markup = notice(`${subject} unavailable`, error.message, action('Prepare price and risk', 'prepare-ticker-detail', 'refresh'), true);
          if (status === price) replacePrice(markup);
          else status.innerHTML = markup;
        }
      }
    }
    async function changePlot(key, value) {
      if (key === 'stock-range-local') {
        range = Number(value);
        const run = ++priceRun;
        if (range > options.params.lookback) {
          const requested = range;
          const controls = rangeSegment('stock-range-local', range) + segment('stock-cadence-local', cadences, cadence);
          replacePrice(panelHead('Price and volume', '', controls) + pending('Loading prices for this range…'));
          try {
            const result = await env.api(security, { params: { ...current, lookback: requested }, signal });
            if (!active() || !price.isConnected || run !== priceRun) return;
            if (result.pendingOnly || !result.symbol) throw new Error('The selected price window has yet to be prepared.');
            if (result.date !== current.date || result.dataVersion != null && String(result.dataVersion) !== String(current.dataVersion)) {
              throw new Error('The selected price window was returned for a different session or revision.');
            }
            const opened = [...main.querySelectorAll('details[open] [data-action="stock-tab-local"]')].map((node) => node.dataset.value);
            options.params = { ...current, lookback: requested };
            display(result);
            for (const tab of opened) main.querySelector(`[data-action="stock-tab-local"][data-value="${tab}"]`).closest('details').open = true;
          } catch (error) {
            if (!active() || !price.isConnected || run !== priceRun || error.name === 'AbortError') return;
            replacePrice(panelHead('Price and volume', '', controls) + notice('Price window unavailable', error.message, '', true));
          }
          main.querySelector(`#stock-price-panel [data-action="${key}"][aria-pressed="true"]`)?.focus();
          return;
        }
      }
      else cadence = value;
      paintPrice();
      price.querySelector(`[data-action="${key}"][aria-pressed="true"]`)?.focus();
    }
    env.setActions({
      'stock-section': (value) => {
        if (!stockSections.some(([key]) => key === value) || value === selectedSection) return;
        selectedSection = value;
        for (const control of main.querySelectorAll('[data-action="stock-section"]')) {
          control.setAttribute('aria-pressed', String(control.dataset.value === value));
        }
        for (const panel of main.querySelectorAll('[data-stock-section]')) panel.hidden = !sectionVisible(value, panel.dataset.stockSection);
      },
      'stock-range-local': (value) => changePlot('stock-range-local', value),
      'stock-cadence-local': (value) => changePlot('stock-cadence-local', value),
      'stock-watch-local': () => env.openAddWatchlist([row.securityId]),
      'stock-export-local': () => exportChart(price.querySelector('[data-chart]'), `${row.symbol}-${cadence}-plotted-prices.csv`),
      'prepare-ticker-detail': async () => {
        const job = await env.api(`${security}/prepare`, { body: { context: current, lookback: options.params.lookback, followLatest: !env.context?.date }, signal });
        return followProduct({ pending: true, status: job.status, jobId: job.id, progress: job.progress });
      },
    });
    mountHistory(security, current);
    if (products) {
      const waiting = [products.chart, products.risk].find(canFollow);
      if (waiting) void followProduct(waiting);
    }
  }

  function mountHistory(security, context) {
    const history = main.querySelector('#stock-rs-chart');
    const screens = main.querySelector('#stock-screens');
    const connected = (target) => active() && target.isConnected;

    function onOpen(target, show) {
      const disclosure = target.closest('details');
      disclosure.addEventListener('toggle', function loadOnOpen() {
        if (!disclosure.open) return;
        disclosure.removeEventListener('toggle', loadOnOpen);
        show();
      });
    }

    async function load(target, endpoint, requestParams, title, paint) {
        target.innerHTML = pending(`Loading ${title.toLowerCase()}…`);
        const request = { signal, params: { ...context, ...requestParams } };
        try {
          let result = await env.api(`${security}/${endpoint}`, request);
          if (!connected(target)) return;
          if (canFollow(result.materialization)) {
            result = await env.publishedSeries(`${security}/${endpoint}`, { ...request, initialResponse: result }, (_, job) => {
              if (connected(target)) target.innerHTML = warming(job, title);
            });
          }
          if (connected(target)) target.innerHTML = preparationNotice(result.materialization, title) +
            (result.pendingOnly ? '' : paint(result));
        } catch (error) {
          if (connected(target) && error.name !== 'AbortError') target.innerHTML = notice(`${title} unavailable`, error.message, '', true);
        }
    }

    function showRanks() {
      history.innerHTML = `${rangeSegment('stock-rank-range', rankingRange)}<div class="section-space" data-rank-plot></div>`;
      return load(history.querySelector('[data-rank-plot]'), 'rankings', { cadence: 'weekly', limit: rangeLimit(rankingRange, 'weekly') },
        'Ranking history', (result) => (result.supplyDemand?.state === 'partial'
          ? notice('Up/down volume history partly prepared', `${count(result.supplyDemand.preparedSessions)} of ${count(result.supplyDemand.requestedSessions)} requested sessions have prepared volume readings.`) : '') + chart(result.rows || [], [
          { key: 'percentile', label: 'RS percentile', format: number },
          { key: 'udv_50d', label: 'U/D volume 50D', axis: 'right', format: ratio },
        ], { domain: [0, 100], fill: true, rightAxisFormat: number, label: 'RS percentile and up/down volume history' }));
    }
    onOpen(history, showRanks);
    history.addEventListener('click', (event) => {
      const choice = event.target.closest('[data-action="stock-rank-range"]');
      if (!choice || Number(choice.dataset.value) === rankingRange) return;
      rankingRange = Number(choice.dataset.value);
      void showRanks();
      history.querySelector('[data-action="stock-rank-range"][aria-pressed="true"]')?.focus();
    });
    onOpen(screens, () => load(screens, 'screens', {}, 'Screen membership', (result) => stockScreenMatches(env, result)));
  }

  try {
    const data = await env.api(path, options);
    if (!active()) return;
    display(data);
    if (!canFollow(data.materialization)) return;
    try {
      const completed = await env.publishedSeries(path, { ...options, initialResponse: data }, (_, job) => {
        const status = main.querySelector('#stock-warming');
        if (active() && status) status.innerHTML = warming(job, data.pendingOnly ? 'Ticker dashboard' : 'Rank change and persistence');
      });
      if (active()) display(completed);
    } catch (error) {
      const status = main.querySelector('#stock-warming');
      if (active() && status && error.name !== 'AbortError') status.innerHTML = notice('Ticker preparation unavailable', error.message, '', true);
    }
  } catch (error) {
    if (active() && error.name !== 'AbortError') main.innerHTML = heading(symbol, contextDate) +
      notice('Ticker dashboard unavailable', error.message, action('Retry', 'retry-view', 'refresh'), true);
  }
}
