import {
  action, attr, bindObservedCoverage, chip, compact, count, dateLabel, direction, empty, heading, icon, iconButton, notice, number, numeric, option,
  observedCoverageFields, observedCoverageParams, observedCoverageSummary,
  panelHead, pending, publishingHistory, percent, rate, ratio, safe, segment, summary, table,
} from './ui.js';
import { chart } from './charts.js';
import { openBreadthDrawer } from './contributors.js';

const dailyKeys = ['up_4pct', 'down_4pct', 'up_2pct', 'down_2pct', 'up_1pct', 'down_1pct'];
const averageKeys = ['above_10d', 'above_20d', 'above_50d', 'above_100d', 'above_150d', 'above_200d', 'ma_50_above_200', 'ma_rising_50', 'ma_rising_200', 'ma_aligned'];
const fieldCoverageSelect = (value) => `<label class="field"><span>Coverage basis</span><select name="coverageMode">
  ${option('verified','Verified market coverage',value)}${option('observed','Observed universe (descriptive)',value)}</select></label>`;
const rangeChoices = [[20, '1M'], [63, '3M'], [120, '6M'], [252, '1Y']];
const dailyChartKeys = ['above_50d', 'above_200d', 'above_20d'];

export function partialCoverage(coverage, routeUrl, { score = false } = {}) {
  if (coverage?.state === 'complete') return '';
  const total = coverage?.traded;
  const message = total ? `${count(total)} traded securities in the selected universe. Whole-market coverage is unverified.${score ? ' Market health is withheld.' : ''}`
    : 'The selected context has no comparable trading data.';
  return notice(total ? 'Limited market coverage' : 'No traded securities', message,
    `<a href="${safe(routeUrl('settings'))}" class="text-link">Data coverage ${icon('chevron-right')}</a>`);
}

const measurement = (metric) => metric ? `${count(metric.numerator)} / ${count(metric.denominator)} comparable` : 'No comparable securities';
const breadthValue = (metric) => percent(metric?.value);
const overviewRowColumns = ['symbol', 'name', 'return_1d', 'rsPercentile'];

function metricTile(key, data, definitions, universe) {
  const metric = data?.[key];
  return `<button type="button" class="metric-tile" data-action="breadth" data-value="${safe(key)}"${attr('data-universe', universe)}><span>${safe(definitions.get(key)?.label || key)}</span>
    <strong>${breadthValue(metric)}</strong><small>${measurement(metric)}</small></button>`;
}
function dailyParticipation(snapshot, definitions) {
  return `<div class="bar-list">${dailyKeys.map((key) => {
    const metric = snapshot.breadth[key];
    const color = key.startsWith('up') ? 'var(--green)' : 'var(--red)';
    const width = Math.max(0, Math.min(100, metric?.value || 0));
    return `<button type="button" class="participation-row" data-action="breadth" data-value="${key}">
      <span>${safe(definitions.get(key)?.label || key)}</span><span class="bar-rail" style="--bar-width:${width}%;--bar-color:${color}"><i></i></span>
      <span class="numeric">${breadthValue(metric)}</span><span class="numeric quiet">${count(metric?.numerator)}/${count(metric?.denominator)}</span></button>`;
  }).join('')}</div>`;
}
function volumeTiles(aggregate) {
  return [
    ['Up volume', compact(aggregate.upVolume)], ['Down volume', compact(aggregate.downVolume)],
    ['Up-volume share', rate(aggregate.upVolumeShare, 1, false)], ['U/D share volume', ratio(aggregate.upDownVolume, aggregate.upDownVolumeState)],
    ['Net advancing dollar volume', compact(aggregate.netDollar, true)], ['U/D dollar volume', ratio(aggregate.upDownDollar, aggregate.upDollar > 0 && !aggregate.downDollar ? 'infinity' : null)],
    ['Equal-weight 1D return', rate(aggregate.equalWeightReturn)], ['Median 1D return', rate(aggregate.medianReturn)],
  ].map(([label, value]) => `<div class="metric-tile"><span>${label}</span><strong>${value}</strong></div>`).join('');
}
const healthReasons = {
  insufficient_coverage: 'Comparable whole-universe coverage has not been established.',
  insufficient_inputs: 'One or more weighted components lack sufficient data.',
};
const comparisonLabels = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', ne: '≠' };
const conditionLabel = (condition) => condition.any ? condition.any.map(conditionLabel).join(' or ')
  : `${healthFeatureLabels[condition.metric] || condition.metric}: ${number(condition.actual)} ${comparisonLabels[condition.op] || condition.op} ${number(condition.value)}`;
const healthFeatureLabels = {
  benchmarkMomentum: 'Benchmark momentum', shortBreadth: 'Short-term breadth', intermediateBreadth: 'Intermediate breadth',
  longBreadth: 'Long-term breadth', priceMomentum: 'Price momentum', industryLeadership: 'Industry leadership',
  priorWeakSessions: 'Prior weak sessions', shortChange: 'Short breadth change', intermediateChange: 'Intermediate breadth change',
};
function healthPanel(data) {
  const health = data.health || {};
  const components = health.components || [];
  const conditions = health.regime?.conditions || [];
  return `<section class="panel panel-body">${panelHead('Market health', health.model?.name || 'Composite model')}
    <div class="health-title"><span class="summary-value">${numeric(health.score) ? number(health.score) : '—'}</span>
    ${chip(health.regime?.label || (data.coverage?.state === 'complete' ? 'Unavailable' : 'Insufficient coverage'), numeric(health.score) ? 'accent' : 'warning')}</div>
    ${health.reason ? `<p class="muted section-space">${safe(healthReasons[health.reason] || health.reason)}</p>` : ''}
    ${health.regime?.sessions ? `<p class="muted section-space">Since ${dateLabel(health.regime.since)} · ${count(health.regime.sessions)} comparable sessions</p>` : ''}
    ${conditions.length ? `<div class="inline-stack section-space">${conditions.map((condition) => chip(conditionLabel(condition), condition.met ? 'accent' : '')).join('')}</div>` : ''}
    ${components.length ? `<div class="health-components">${components.map((part) => `<div><span title="${safe(part.definition)}">${safe(part.label)}</span>
      <span class="mono">${numeric(part.weight) ? percent(part.weight * 100, 0) : '—'}</span><strong class="mono">${number(part.score)}</strong></div>`).join('')}</div>` : ''}
  </section>`;
}

export async function render(env) {
  const { main, config, signal, api, routeUrl, state, context } = env;
  const definitions = new Map((config.breadthMetrics || []).map((metric) => [metric.key, metric]));
  const overview = await env.publishedSeries('market/overview', { signal }, (partial, job) => {
    if (env.isActive()) main.innerHTML = publishingHistory(job);
  });
  if (!env.isActive()) return;
  state.tab ||= 'overview';
  state.range ||= 63;
  state.rolling ||= 20;
  state.magnitude ||= 25;
  state.movers ||= 'gainers';
  let chartRequest = 0;
  let monitorRequest = 0;

  function showOverview() {
    const { coverage, breadth, aggregates, health } = overview;
    const active = state.tab;
    main.innerHTML = heading('Market Overview', 'Participation, momentum, and leadership across the selected universe.',
      `${overview.date ? chip(`Session ${dateLabel(overview.date)}`) : ''}<a class="button" href="${safe(routeUrl('monitor'))}">${icon('pulse')} Market monitor</a><a class="button" href="${safe(routeUrl('history'))}">${icon('history')} Explore history</a>`) +
      partialCoverage(coverage, routeUrl, { score: true }) +
      `<section class="summary-grid" aria-label="Session summary">
        ${summary('Traded securities', count(coverage.traded), `${count(coverage.listed)} eligible in warehouse`, { glyph: 'layers' })}
        ${summary('Above 50D SMA', breadthValue(breadth.above_50d), measurement(breadth.above_50d), { action: 'breadth', value: 'above_50d' })}
        ${summary('Advance / decline spread', percent(breadth.adSpread?.value, 1, true), `${count(breadth.advancers?.numerator)} advance · ${count(breadth.decliners?.numerator)} decline`,
          { action: 'breadth', value: 'adSpread', style: direction(breadth.adSpread?.value) })}
        ${summary('Market health', numeric(health?.score) ? number(health.score) : 'Withheld', health?.regime?.label || 'Coverage unavailable',
          { action: 'overview-tab', value: 'health', small: !numeric(health?.score), style: numeric(health?.score) ? '' : 'warning-text' })}
      </section>` +
      segment('overview-tab', [['overview', 'Breadth overview'], ['monitor', 'Session breakdown'], ['health', 'Health & regimes']], active, 'tabs') +
      (active === 'overview' ? `<div class="market-grid">
        <section class="panel panel-body">${panelHead('Moving-average breadth', 'Share of comparable stocks above key moving averages.',
          segment('overview-range', rangeChoices, state.range) + iconButton('Export breadth chart CSV', 'export-chart', 'download', 'moving-average-breadth.csv'))}
          <div id="overview-chart">${pending('Loading breadth history…')}</div>
        </section>
        <section class="panel panel-body">${panelHead('Daily participation', 'Close-to-close move thresholds')}${dailyParticipation(overview, definitions)}
          <div class="participation-foot"><span>${safe(overview.benchmark)} benchmark</span><strong class="numeric ${direction(aggregates.benchmarkReturn)}">${rate(aggregates.benchmarkReturn)}</strong></div>
        </section>
      </div>
      <div class="split-grid">
        <section class="panel panel-body">${panelHead('RS leaders', `${overview.model.name} · ${count(coverage.ranked)} ranked`, `<a class="button ghost" href="${safe(routeUrl('rankings'))}">All rankings ${icon('chevron-right')}</a>`)}
          ${table(overview.leaders || [], ['rsRank', ...overviewRowColumns], { label: 'Relative strength leaders' })}
        </section>
        <section class="panel panel-body">${panelHead('Daily movers', 'Traded stocks with a comparable prior close',
          segment('mover-side', [['gainers', 'Gainers'], ['losers', 'Losers']], state.movers))}
          ${table((overview.movers?.[state.movers] || []).filter((row) => state.movers === 'gainers' ? row.return_1d > 0 : row.return_1d < 0),
          overviewRowColumns, { label: 'Daily movers' })}
        </section>
      </div>
      <section class="panel panel-body">${panelHead('Moving-average participation', 'Open a reading to reconcile its contributing securities.')}<div class="metric-grid">${averageKeys.map((key) => metricTile(key, breadth, definitions)).join('')}</div></section>`
      : active === 'monitor' ? monitorLayout() : `<form id="health-coverage-form" class="inline-form section-space">
        ${fieldCoverageSelect(state.healthCoverage?.coverageMode || 'verified')}
        ${observedCoverageFields(state.healthCoverage)}
        <button class="button primary" type="submit">Apply coverage</button></form>
        <div class="split-grid"><div id="current-health">${healthPanel(overview)}</div>
        <section class="panel panel-body">${panelHead('Breadth divergences', 'Dated benchmark and market participation comparisons')}<div id="divergences">${pending()}</div></section></div>
        <section class="panel panel-body">${panelHead('Market health history', 'Published composite scores using the selected market context.',
          iconButton('Export market health history CSV', 'export-chart', 'download', 'market-health.csv'))}<div id="health-chart">${pending()}</div></section>`);
    if (active === 'overview') loadChart();
    if (active === 'monitor') loadMonitor();
    if (active === 'health') {
      bindObservedCoverage(main.querySelector('#health-coverage-form'));
      loadHealth();
    }
  }

  async function loadChart() {
    const target = main.querySelector('#overview-chart');
    const run = ++chartRequest;
    const labels = ['Above 50D SMA', 'Above 200D SMA', 'Above 20D SMA'];
    try {
      const result = await env.publishedSeries('market/breadth', { signal, params: { series: 1, metrics: dailyChartKeys.join(','), limit: state.range } }, (partial, job) => {
        if (target?.isConnected && run === chartRequest) target.innerHTML = publishingHistory(job);
      });
      if (!target?.isConnected || run !== chartRequest) return;
      target.innerHTML = chart(result.rows, dailyChartKeys.map((key, i) => ({ key, label: labels[i], format: percent, dash: i === 2 })),
        { domain: [0, 100], axisFormat: (value) => percent(value, 0), fill: true, onPick: ({ date }) => env.go('overview', { date, dataVersion: env.snapshotContext.dataVersion }) });
    } catch (error) {
      if (target?.isConnected && error.name !== 'AbortError') target.innerHTML = notice('Breadth history unavailable', error.message, '', true);
    }
  }

  function monitorLayout() {
    const exchangeOptions = (config.universes || []).filter(({ id }) => ['us-core', 'nyse', 'nasdaq', 'sample'].includes(id));
    return `<div class="stack">
      <section class="panel panel-body">${panelHead('Large-move participation', 'Percentage of comparable stocks meeting a rolling return threshold.')}
      <form id="monitor-form" class="inline-form">
        <label class="field">Trading sessions<input type="number" name="sessions" min="1" max="7560" value="${state.rolling}" required></label>
        <label class="field">Move magnitude (%)<input type="number" name="magnitude" min=".01" max="1000" step=".01" value="${state.magnitude}" required></label>
        <button type="submit" class="button primary">Apply</button>${segment('rolling-window', [[5,'5D'],[10,'10D'],[20,'20D'],[63,'63D'],[126,'126D'],[252,'252D']], state.rolling)}
      </form><div id="large-move-results" class="section-space">${pending()}</div></section>
      <div class="split-grid">
        <section class="panel panel-body">${panelHead('Advance / decline', 'Daily session counts and cumulative history',
          `<label class="sr-only" for="ad-exchange">Exchange universe</label><select id="ad-exchange" data-change="ad-universe">
          ${option('', 'Selected universe', state.adUniverse || '')}${exchangeOptions.map((u) => option(u.id, u.name, state.adUniverse)).join('')}</select>`)}
          <div class="metric-grid" id="ad-metrics">${['advancers', 'decliners', 'unchanged'].map((key) => metricTile(key, overview.breadth, definitions)).join('')}</div>
          <div id="ad-line" class="section-space">${pending()}</div>
        </section>
        <section class="panel panel-body">${panelHead('Volume participation', 'Share- and dollar-volume aggregates')}<div class="metric-grid">${volumeTiles(overview.aggregates)}</div></section>
      </div>
      ${['Volume','Highs and lows','Leadership','Multi-session momentum'].map((family) => {
        const metrics = [...definitions.values()].filter((metric) => metric.family === family && !/^(up|down)_/.test(metric.key));
        return metrics.length ? `<section class="panel panel-body">${panelHead(family)}<div class="metric-grid">${metrics.map(({ key }) => metricTile(key, overview.breadth, definitions)).join('')}</div></section>` : '';
      }).join('')}
    </div>`;
  }

  async function loadMonitor() {
    const target = main.querySelector('#large-move-results');
    const ad = main.querySelector('#ad-line');
    const run = ++monitorRequest;
    const keys = [...new Set([state.magnitude, 50].flatMap((magnitude) => ['up', 'down'].map((side) => `${side}_${magnitude}pct_${state.rolling}d`)))];
    const adParams = { series: 1, metrics: 'advancers,decliners,unchanged,adSpread', limit: 80,
      ...(state.adUniverse ? { universe: state.adUniverse, universeVersion: '' } : {}) };
    const [large, advance] = await Promise.allSettled([
      env.publishedSeries('market/breadth', { signal, params: { series: 1, metrics: keys.join(','), limit: 80 } }, (partial, job) => {
        if (target?.isConnected && run === monitorRequest) target.innerHTML = publishingHistory(job);
      }),
      env.publishedSeries('market/breadth', { signal, params: adParams }, (partial, job) => {
        if (ad?.isConnected && run === monitorRequest) ad.innerHTML = publishingHistory(job);
      }),
    ]);
    if (run !== monitorRequest || !target?.isConnected) return;
    if (large.status === 'fulfilled') {
      const row = large.value.rows.at(-1) || {};
      target.innerHTML = `<div class="table-scroll" role="region" aria-label="Large move metrics" tabindex="0"><table><thead><tr>
        <th>Threshold</th><th>Reading</th><th>Qualify / comparable</th><th>5D avg</th><th>10D avg</th><th>20D avg</th><th>Sample percentile</th><th>1D Δ</th><th>5D Δ</th><th>21D Δ</th>
        </tr></thead><tbody>${keys.map((key) => {
          const name = key.startsWith('up') ? 'Up' : 'Down';
          const magnitude = key.match(/_(.*?)pct/)?.[1];
          return `<tr><td><button type="button" class="stock-link" data-action="breadth" data-value="${key}">${name} ≥ ${magnitude}%</button></td>
            <td class="numeric">${percent(row[key])}</td><td class="numeric">${count(row[`${key}_numerator`])} / ${count(row[`${key}_denominator`])}</td>
            ${[5, 10, 20].map((n) => `<td class="numeric">${percent(row[`${key}_sma${n}`])}</td>`).join('')}
            <td class="numeric">${number(row[`${key}_historical_percentile`])}</td>
            ${[1, 5, 21].map((n) => `<td class="numeric">${percent(row[`${key}_change${n}`], 1, true)}</td>`).join('')}</tr>`;
        }).join('')}</tbody></table></div>`;
    } else if (large.reason.name !== 'AbortError') target.innerHTML = notice('Momentum readings unavailable', large.reason.message, '', true);
    if (ad?.isConnected && advance.status === 'fulfilled') {
      const keys = ['advancers', 'decliners', 'unchanged'];
      const latest = advance.value.rows.at(-1);
      const readings = latest ? Object.fromEntries(keys.map((key) => [key, { value: latest[key],
        numerator: latest[`${key}_numerator`], denominator: latest[`${key}_denominator`] }])) : {};
      main.querySelector('#ad-metrics').innerHTML = keys.map((key) => metricTile(key, readings, definitions, state.adUniverse)).join('');
      ad.innerHTML = chart(advance.value.rows, [{ key: 'advanceDeclineLine', label: 'Cumulative A/D line', format: count }], { fill: true });
    } else if (ad?.isConnected && advance.reason?.name !== 'AbortError') ad.innerHTML = notice('A/D history unavailable', advance.reason?.message, '', true);
  }

  async function loadHealth() {
    const target = main.querySelector('#divergences');
    const plot = main.querySelector('#health-chart');
    const settings = state.healthCoverage || { coverageMode: 'verified' };
    const { coverageMode } = settings;
    if (overview.coverage.state !== 'complete' && coverageMode === 'verified') {
      target.innerHTML = empty('Divergence events withheld', 'Complete market coverage is required for market-wide event publication.', 'pulse');
      plot.innerHTML = empty('Market health history withheld', 'Complete market coverage is required for the selected context.', 'chart');
      return;
    }
    try {
      const result = await env.publishedSeries('market/health', { signal, params: { series: 1, limit: 63, ...settings } }, (partial, job) => {
        if (target?.isConnected) target.innerHTML = publishingHistory(job);
        if (plot?.isConnected) plot.innerHTML = publishingHistory(job);
      });
      if (!target.isConnected) return;
      main.querySelector('#current-health').innerHTML = (coverageMode === 'observed'
        ? notice('Observed universe · descriptive', `${observedCoverageSummary(result)} ${result.coverageWarning || ''}`)
        : '') + healthPanel({ ...overview, health: result });
      const events = (result.events || []).toReversed();
      plot.innerHTML = chart(result.history || [], [{ key: 'score', label: 'Market health score', format: number }], { domain: [0, 100], fill: true });
      target.innerHTML = events.length ? events.map((event) =>
        `<div class="simple-row"><strong>${safe(event.label || event.id)}</strong><span>${dateLabel(event.date)}</span></div>`).join('')
        : empty('No divergences in this range', 'Recent comparable sessions contain no matching events.', 'pulse');
    } catch (error) {
      if (target.isConnected && error.name !== 'AbortError') {
        target.innerHTML = notice('Divergences unavailable', error.message, '', true);
        plot.innerHTML = notice('Market health history unavailable', error.message, '', true);
      }
    }
  }

  env.setActions({
    'overview-tab'(value) { state.tab = value; showOverview(); },
    'overview-range'(value) { state.range = Number(value); showOverview(); },
    'mover-side'(value) { state.movers = value; showOverview(); },
    'rolling-window'(value) { state.rolling = Number(value); showOverview(); },
    'change:ad-universe'(value) { state.adUniverse = value; loadMonitor(); },
    breadth(key, button) {
      const universe = button.dataset.universe;
      const title = key === 'adSpread' ? 'Advance / decline spread' : definitions.get(key)?.label || key.replaceAll('_', ' ');
      const metric = !universe || universe===context.universe ? overview.breadth[key] : null;
      const reading = metric ? {date:overview.date,coverage:overview.coverage.state,[key]:metric.value,
        [`${key}_numerator`]:metric.numerator,[`${key}_denominator`]:metric.denominator} : null;
      return openBreadthDrawer(env,{key,date:overview.date,title,universe,reading});
    },
  });
  main.onsubmit = (event) => {
    if (event.target.id === 'health-coverage-form') {
      event.preventDefault();
      state.healthCoverage = observedCoverageParams(Object.fromEntries(new FormData(event.target)));
      showOverview();
      return;
    }
    if (event.target.id !== 'monitor-form') return;
    event.preventDefault();
    const values = new FormData(event.target);
    state.rolling = Number(values.get('sessions'));
    state.magnitude = Number(values.get('magnitude'));
    showOverview();
  };
  showOverview();
}
