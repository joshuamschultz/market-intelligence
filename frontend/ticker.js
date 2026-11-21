import { chart, exportChart } from './charts.js';
import { stockQualityPanel } from './data-quality.js';
import { describePricePoint, plottableBar, stockScreenMatches, toWeekly } from './stocks.js';
import {
  action, cellValue, chip, count, dateLabel, direction, empty, fieldDetails, heading, icon, iconButton,
  money, notice, number, numeric, panelHead, pathPart, pending, rangeFieldDetails, rangeFieldId, rate, ratio, safe, segment,
  signed, summary, tradingViewLink, warming,
} from './ui.js';

const ranges = [[21, '1M'], [63, '3M'], [126, '6M']];
const defaultRange = 126;
const cadences = [['daily', 'Daily'], ['weekly', 'Weekly']];
const quarters = [4, 8, 12];
const averageWindows = [10, 20, 50, 100, 150, 200];
const volumeWindows = [10, 20, 50, 100];
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
  ...volumeWindows.flatMap((days) => [
    [`rvol_${days}d`, `Relative volume ${days}D`, 'ratio'],
    [`adv_${days}d`, `Avg dollar volume ${days}D`, 'compactMoney'],
    [`avg_volume_${days}d`, `Avg share volume ${days}D`, 'compact'],
    [`up_volume_${days}d`, `Up-volume share ${days}D`, 'rate'],
    [`float_turnover_${days}d`, `Float turnover ${days}D`, 'rate'],
    [`obv_slope_${days}d`, `OBV change ${days}D`, 'compact'],
  ]),
].map(([field, label, format = 'text']) => ({ field, label, format }));

function valueTile(label, value, note = '') {
  return `<div class="metric-tile"><span>${safe(label)}</span><strong>${safe(value ?? '—')}</strong>${note ? `<small>${safe(note)}</small>` : ''}</div>`;
}

function metrics(ids, row) {
  return ids.map((id) => {
    const { label } = fieldDetails(id, extraFields, row);
    const observations = row[id.replace(/^udv_/, 'udv_obs_')];
    const note = id.startsWith('udv_') && numeric(observations)
      ? `<small>${count(observations)} comparable observations</small>` : '';
    return `<div class="metric-tile" data-metric="${safe(id)}"><span>${safe(label)}</span><strong>${cellValue(id, row, extraFields)}</strong>${note}</div>`;
  }).join('');
}

function metricPanel(title, body, { tools = '', collapse = false } = {}) {
  const grid = `<div class="metric-grid${collapse ? ' section-space' : ''}">${body}</div>`;
  return collapse
    ? `<details class="panel panel-body formula-help"><summary>${safe(title)}</summary>${grid}</details>`
    : `<section class="panel panel-body">${panelHead(title, '', tools)}${grid}</section>`;
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

function chartPanel(row, bars, range, cadence) {
  const product = row.detailPreparation?.chart;
  if (product && product.state !== 'ready') return panelHead('Price and volume') + productNotice(product, 'Price history');
  if (product?.priceAvailability === 'no-known-observations') {
    return panelHead('Price and volume') + notice('No prices known for this interval',
      'The selected point-in-time revision has no usable prices in this window.');
  }
  const visible = bars.slice(-range);
  const plot = cadence === 'weekly' ? toWeekly(visible) : visible;
  const tools = segment('stock-range-local', ranges, range) + segment('stock-cadence-local', cadences, cadence) +
    iconButton('Export plotted prices CSV', 'stock-export-local', 'download');
  return panelHead('Price and volume', `${count(visible.length)} market sessions through ${dateLabel(row.date)} · Split-adjusted prices`, tools) +
    chart(plot, [{ key: 'close', label: 'Close', format: money }], {
      label: `${row.symbol} ${cadence} candlestick chart`, candles: true, volume: true, width: 900, height: 305,
      exportFields: ['open', 'high', 'low', 'close', 'volume'], describePoint: describePricePoint,
    });
}

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

  function display(data) {
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
    const bars = (row.chartBars || row.bars || []).filter((bar) => bar?.date && bar.date <= date).slice(-defaultRange).map(plottableBar);
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
    const plotRow = { ...row, date };

    main.innerHTML = `<div id="ticker-dashboard">
      ${heading(title, `As of ${dateLabel(date)}${selectedDate && selectedDate !== date ? ` · ${contextDate}` : ''}`, tools)}
      <div class="inline-stack">${tags}${participationBadges(row)}</div>
      <div id="stock-warming" class="section-space">${preparationNotice(products?.weekly?.state === 'ready' ? null : products?.weekly || info,
        products?.metrics?.state === 'unprepared' ? 'Stock metrics' : 'Rank change and persistence')}</div>
      <div class="summary-grid three section-space">
        ${summary('Split-adjusted close', money(priceQuarantined ? null : row.close), priceQuarantined ? 'Source price quarantined' : rate(row.return_1d), { glyph: 'chart', style: direction(row.return_1d) })}
        ${summary('RS percentile', number(row.rsPercentile), row.rsRank == null ? 'Unranked' : `Rank ${count(row.rsRank)}`, { glyph: 'rankings' })}
        ${summary('4W RS velocity', signed(row.velocity4w), 'Percentile-point change', { glyph: 'pulse', style: direction(row.velocity4w) })}
      </div>
      <div class="stack">
        <section class="panel panel-body" id="stock-price-panel">${chartPanel(plotRow, bars, range, cadence)}</section>
        ${metricPanel('Participation and volume', metrics([
          'dailyMove', 'traded', 'above_20d', 'above_50d', 'above_200d', 'nearHigh', 'topDecile', 'highVolumeMove',
          'volume', 'dollar_volume', 'rvol_20d', 'udv_50d', 'adv_20d', 'udvChange4w', 'upVolumeShareChange4w', 'priceAndVolumeStrength',
        ], row))}
        ${metricPanel('Relative strength and persistence', metrics([
          'rsRank', 'rsPercentile', 'rsScore', 'rsStatus', 'lifecycle', 'rsScoreChange', 'rsAcceleration',
          ...[1, 4, 12].flatMap((n) => [`velocity${n}w`, `rankChange${n}w`]),
          'leadingWeeks', 'leadingWeekCoverage', ...quarters.flatMap((n) => [`topDecileWeeks${n}w`, `topDecilePersistence${n}w`]),
          ...[1, 5, 10, 20].map((n) => `enteredTop${n}`),
          'rsNewHigh', 'rsHighBeforePrice', 'deterioratingOnPriceStrength', 'momentumImproving',
          'relative_strength_line', 'rs_line_new_high', 'relative_return_21d',
        ], row))}
        ${details('stock-rs-chart', 'rs', 'RS and volume history')}
        ${companyContext(env, row, current)}
        ${priceRanges(row)}
        ${metricPanel('Returns and price action', metrics([
          'raw_close', ...new Set(['return_1d', 'return_5d', 'return_21d', 'return_63d', 'return_126d', 'return_252d', ...returns]),
          'gap', 'gap_up', 'gap_down', 'intraday_return', 'streak', 'volatility_compression',
          'atr_14d', 'atr_contraction', 'consolidation_range_20d', 'consolidation_duration',
          ...[20, 50, 100, 252].flatMap((n) => [`new_high_${n}d`, `new_low_${n}d`]),
        ], row), { collapse: true })}
        ${metricPanel('Moving averages', metrics([
          'ma_aligned', 'ma_50_above_200', 'ma_rising_50', 'ma_rising_200',
          ...averageWindows.flatMap((n) => [`sma_${n}d`, `ema_${n}d`, `above_${n}d`, `vs_sma_${n}d`, `vs_ema_${n}d`, `slope_sma_${n}d`, `slope_ema_${n}d`]),
        ], row), { collapse: true })}
        ${metricPanel('Liquidity, volume, and fundamentals', metrics([
          'float', 'shares', 'market_cap', 'market_cap_change', 'marketCapDate', 'marketCapBucket', 'float_turnover_1d',
          ...volumeWindows.flatMap((n) => [`avg_volume_${n}d`, `adv_${n}d`, `rvol_${n}d`, `udv_${n}d`,
            `up_volume_${n}d`, `float_turnover_${n}d`, `obv_slope_${n}d`]),
          'volume_trend', 'volume_contraction', 'breakout_volume', 'obv', 'mfi_14d', 'cmf_20d', 'clv', 'up_frequency_20d',
          'high_volume_up_20d', 'high_volume_down_20d', 'accumulation_20d', 'high_volume_up_2x_20d', 'high_volume_down_2x_20d',
          'accumulation_2x_20d', 'volumeDemandImproving',
        ], row), { collapse: true })}
        <div id="stock-risk-panel">${products?.risk?.state && products.risk.state !== 'ready' ? productNotice(products.risk, 'Risk analysis') :
          metricPanel('Risk', metrics(['annualizedVolatility', 'maximumDrawdown', 'beta', 'correlation',
            'dailyHistoricalReturn5pct', 'dailyHistoricalVaR95', 'observations', 'benchmarkObservations'], row.risk || {}), { collapse: true })}</div>
        ${dataContext({ ...row, sourceKnownAt: latestBar?.knownAt }, current, source)}
        ${details('stock-screens', 'screens', 'Saved screen membership')}
        ${stockQualityPanel(row.quality, date)}
        ${warnings.length ? notice('Data quality', warnings.join(' ')) : ''}
      </div>
    </div>`;

    const price = main.querySelector('#stock-price-panel');
    const security = `stocks/${pathPart(row.securityId || symbol)}`;
    async function followProduct(job) {
      const productsInFlight = row.detailPreparation;
      const status = productsInFlight?.chart?.state !== 'ready' ? price : main.querySelector('#stock-risk-panel');
      const subject = productsInFlight?.chart?.state !== 'ready' ? 'Price history' : 'Risk analysis';
      if (!status) return;
      try {
        const result = await env.publishedSeries(path, { ...options, initialResponse: { ...data, materialization: job } }, (_, progress) => {
          if (active() && status.isConnected) status.innerHTML = warming(progress, subject);
        });
        if (active() && status.isConnected) display(result);
      } catch (error) {
        if (active() && status.isConnected && error.name !== 'AbortError') {
          status.innerHTML = notice(`${subject} unavailable`, error.message, action('Prepare price and risk', 'prepare-ticker-detail', 'refresh'), true);
        }
      }
    }
    function changePlot(key, value) {
      if (key === 'stock-range-local') range = Number(value);
      else cadence = value;
      price.innerHTML = chartPanel(plotRow, bars, range, cadence);
      price.querySelector(`[data-action="${key}"][aria-pressed="true"]`)?.focus();
    }
    env.setActions({
      'stock-range-local': (value) => changePlot('stock-range-local', value),
      'stock-cadence-local': (value) => changePlot('stock-cadence-local', value),
      'stock-watch-local': () => env.openAddWatchlist([row.securityId]),
      'stock-export-local': () => exportChart(price.querySelector('[data-chart]'), `${row.symbol}-${cadence}-plotted-prices.csv`),
      'prepare-ticker-detail': async () => {
        const job = await env.api(`${security}/prepare`, { body: { context: current, lookback: defaultRange, followLatest: !env.context?.date }, signal });
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

    function load(target, endpoint, requestParams, title, paint) {
      const disclosure = target.closest('details');
      disclosure.addEventListener('toggle', async function loadOnOpen() {
        if (!disclosure.open) return;
        disclosure.removeEventListener('toggle', loadOnOpen);
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
      });
    }

    load(history, 'rankings', { cadence: 'weekly', limit: 52 }, 'Ranking history', (result) => (result.supplyDemand?.state === 'partial'
      ? notice('Up/down volume history partly prepared', `${count(result.supplyDemand.preparedSessions)} of ${count(result.supplyDemand.requestedSessions)} requested sessions have prepared volume readings.`) : '') + chart(result.rows || [], [
      { key: 'percentile', label: 'RS percentile', format: number },
      { key: 'udv_50d', label: 'U/D volume 50D', axis: 'right', format: ratio },
    ], { domain: [0, 100], fill: true, rightAxisFormat: number, label: 'RS percentile and up/down volume history' }));
    load(screens, 'screens', {}, 'Screen membership', (result) => stockScreenMatches(env, result));
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
