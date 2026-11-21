import {
  action, attr, bindHelpTooltips, bindObservedCoverage, breadthMoveHelp, breadthMoveKey, breadthMovePresets, chip, compact,
  count, dateLabel, direction, empty, heading, helpField, helpTooltip, icon, iconButton, notice, number, numeric, option,
  observedCoverageFields, observedCoverageParams, observedCoverageSummary,
  panelHead, pending, publishingHistory, percent, rate, ratio, safe, segment, summary, table,
} from './ui.js';
import { chart } from './charts.js';
import { openBreadthDrawer } from './contributors.js';
import { mountSummation } from './summation.js';

const dailyKeys = ['up_4pct', 'down_4pct', 'up_2pct', 'down_2pct', 'up_1pct', 'down_1pct'];
const averageKeys = ['above_10d', 'above_20d', 'above_50d', 'above_100d', 'above_150d', 'above_200d', 'ma_50_above_200', 'ma_rising_50', 'ma_rising_200', 'ma_aligned'];
const fieldCoverageSelect = (value) => `<label class="field"><span>Coverage basis</span><select name="coverageMode">
  ${option('verified','Verified market coverage',value)}${option('observed','Observed universe (descriptive)',value)}</select></label>`;
const rangeChoices = [[20, '1M'], [63, '3M'], [126, '6M'], [252, '1Y']];
const dailyChartKeys = ['above_50d', 'above_200d', 'above_20d'];
const healthHistoryLimit = 63;

export function partialCoverage(coverage, routeUrl, { score = false } = {}) {
  if (coverage?.state === 'complete') return '';
  if (coverage?.state === 'unprepared') return notice('Calculation preparation pending',
    'The source warehouse can be populated before this universe’s requested metrics have been prepared.',
    `<a href="${safe(routeUrl('settings',{tab:'jobs'}))}" class="text-link">Preparation progress ${icon('chevron-right')}</a>`);
  const total = coverage?.traded;
  const excluded = numeric(coverage?.listed) && numeric(total) && coverage.listed > total ? ` ${count(coverage.listed-total)} eligible securities have no usable trade for the session.` : '';
  const basis = numeric(coverage?.received) && numeric(coverage?.expected)
    ? ` Provider coverage is ${count(coverage.received)} of ${count(coverage.expected)} expected.`
    : ' A reconciled source roster is unavailable for this context.';
  const message = total ? `${count(total)} traded securities in the selected universe. Whole-market coverage is unverified.${excluded}${basis}${score ? ' Market health is withheld.' : ''}`
    : 'The selected context has no comparable trading data.';
  const links = `<a href="${safe(routeUrl('settings'))}" class="text-link">Data coverage ${icon('chevron-right')}</a>` +
    (score ? ` <a href="${safe(routeUrl('overview',{tab:'health',coverage:'observed'}))}" class="text-link">Explore observed coverage ${icon('chevron-right')}</a>` : '');
  return notice(total ? 'Limited market coverage' : 'No traded securities', message,
    links);
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
  insufficient_comparable_coverage: 'Too few comparable securities for this component.',
  insufficient_calibration_history: 'Not enough comparable past readings for the selected calibration.',
  input_unavailable: 'The source history or reference observations needed for this component are unavailable.',
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
    ${components.length ? `<div class="health-components">${components.map((part) => `<div><span title="${safe(part.definition)}">${safe(part.label)}
      ${!numeric(part.score) && part.reason ? `<small class="muted">${safe(healthReasons[part.reason] || part.reason)}</small>` : ''}</span>
      <span class="mono">${numeric(part.weight) ? percent(part.weight * 100, 0) : '—'}</span><strong class="mono">${number(part.score)}</strong></div>`).join('')}</div>` : ''}
  </section>`;
}

export async function render(env) {
  const { main, config, signal, api, routeUrl, state, context } = env;
  const definitions = new Map((config.breadthMetrics || []).map((metric) => [metric.key, metric]));
  let overview = await api('market/overview', { signal });
  if (!env.isActive()) return;
  state.tab = env.params.tab || state.tab || 'overview';
  if (env.params.coverage === 'observed' && state.healthCoverage?.coverageMode !== 'observed') state.healthCoverage = { coverageMode: 'observed' };
  state.range ||= 63;
  state.rolling ||= 63;
  state.magnitude ||= 13;
  state.movers ||= 'gainers';
  let chartRequest = 0;
  let monitorRequest = 0;
  let customRequest = 0;
  let healthRequest = 0;

  function showOverview({ prepareHealth = false } = {}) {
    const { coverage, breadth, aggregates, health } = overview;
    const active = state.tab;
    main.innerHTML = heading('Market Overview', 'Participation, momentum, and leadership across the selected universe.',
      `${overview.date ? chip(`Session ${dateLabel(overview.date)}`) : ''}<a class="button" href="${safe(routeUrl('monitor'))}">${icon('pulse')} Market monitor</a><a class="button" href="${safe(routeUrl('history'))}">${icon('history')} Explore history</a>`) +
      partialCoverage(coverage, routeUrl, { score: true }) +
      '<div id="overview-preparation" aria-live="polite"></div>' +
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
      <section class="panel panel-body">${panelHead('Moving-average participation', 'Open a reading to reconcile its contributing securities.')}<div class="metric-grid">${averageKeys.map((key) => metricTile(key, breadth, definitions)).join('')}</div></section>
      <div id="market-summation" class="section-space"></div>`
      : active === 'monitor' ? monitorLayout() : `${coverage.state !== 'complete' ? notice('Verified market coverage is unavailable',
        'Preparation does not resolve missing source coverage. You can explicitly analyze comparable stocks in the selected universe through observed coverage.',
        action('Use observed universe', 'observe-health', 'pulse')) : ''}
        ${context.classification === 'nasdaq' && config.classificationSystems?.includes('sec-sic') ? notice('Industry history uses dated classifications',
          'The current Nasdaq capture does not establish earlier industry membership.',
          `<a class="text-link" href="${safe(routeUrl('overview',{tab:'health',classification:'sec-sic',reference:'as-of',
            ...(state.healthCoverage?.coverageMode === 'observed' ? {coverage:'observed'} : {})}))}">Use filing-dated SEC groups ${icon('chevron-right')}</a>`) : ''}
      <form id="health-coverage-form" class="inline-form section-space">
        ${fieldCoverageSelect(state.healthCoverage?.coverageMode || 'verified')}
        ${observedCoverageFields(state.healthCoverage)}
        <button class="button primary" type="submit">Apply coverage</button></form>
        <div class="split-grid"><div id="current-health">${healthPanel(overview)}</div>
        <section class="panel panel-body">${panelHead('Breadth divergences', 'Dated benchmark and market participation comparisons')}<div id="divergences">${pending()}</div></section></div>
        <section class="panel panel-body">${panelHead('Market health history', 'Published composite scores using the selected market context.',
          iconButton('Export market health history CSV', 'export-chart', 'download', 'market-health.csv'))}<div id="health-chart">${pending()}</div></section>`);
    if (active === 'overview') {
      loadChart();
      mountSummation(main.querySelector('#market-summation'), env);
    }
    if (active === 'monitor') {
      bindHelpTooltips(main);
      loadMonitor();
      loadCustomMomentum();
    }
    if (active === 'health') {
      bindObservedCoverage(main.querySelector('#health-coverage-form'));
      loadHealth({ prepare: prepareHealth });
    }
  }

  async function loadChart() {
    const target = main.querySelector('#overview-chart');
    const run = ++chartRequest;
    const labels = ['Above 50D SMA', 'Above 200D SMA', 'Above 20D SMA'];
    const plot = (rows) => chart(rows, dailyChartKeys.map((key, i) => ({ key, label: labels[i], format: percent, dash: i === 2 })),
      { domain: [0, 100], axisFormat: (value) => percent(value, 0), fill: true, onPick: ({ date }) => env.go('overview', { date, dataVersion: env.snapshotContext.dataVersion }) });
    try {
      const result = await env.publishedSeries('market/breadth', { signal, params: { series: 1, metrics: dailyChartKeys.join(','), limit: state.range } }, (partial, job) => {
        if (target?.isConnected && run === chartRequest) target.innerHTML = publishingHistory(job) + (partial.rows?.length ? plot(partial.rows) : '');
      });
      if (!target?.isConnected || run !== chartRequest) return;
      const issue = result.materialization?.preparationState;
      target.innerHTML = (issue && result.materialization.missingDates?.length ? notice('Some chart history is not prepared',
        result.materialization.error || `${count(result.materialization.missingDates.length)} requested sessions are missing from the selected archive.`) : '') +
        (result.rows.length ? plot(result.rows) : '');
    } catch (error) {
      if (target?.isConnected && error.name !== 'AbortError') target.innerHTML = notice('Breadth history unavailable', error.message, '', true);
    }
  }

  function monitorLayout() {
    const exchangeOptions = (config.universes || []).filter(({ id }) => ['us-core', 'nyse', 'nasdaq', 'sample'].includes(id));
    return `<div class="stack">
      <section class="panel panel-body">${panelHead('Standard breadth presets', 'Each comparison uses a fixed threshold and lookback.',
        helpTooltip('overview-fixed-help','fixed preset definitions',breadthMoveHelp.fixed))}
      <div id="large-move-results" class="section-space">${pending()}</div>
      <details class="monitor-custom"${state.customEnabled ? ' open' : ''}><summary>Custom comparison</summary>
      <form id="monitor-form" class="inline-form section-space">
        ${helpField('overview-rolling-window','Rolling window',(attrs)=>`<input ${attrs} type="number" name="sessions" min="1" max="7560" value="${state.rolling}" required>`,breadthMoveHelp.window)}
        ${helpField('overview-rolling-threshold','Rolling threshold (%)',(attrs)=>`<input ${attrs} type="number" name="magnitude" min=".01" max="1000" step=".01" value="${state.magnitude}" required>`,breadthMoveHelp.threshold)}
        <button type="submit" class="button primary">Apply custom comparison</button>${segment('rolling-window', [[5,'5D'],[10,'10D'],[20,'20D'],[63,'63D'],[126,'126D'],[252,'252D']], state.rolling)}
      </form><p class="muted section-space">This comparison is separate from the fixed breadth presets.</p>
      <div id="custom-move-results" class="section-space"></div></details></section>
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

  const momentumKeys = (pairs) => pairs.flatMap(({threshold,sessions})=>['up','down'].map((side)=>breadthMoveKey(side,threshold,sessions)));
  function paintMomentum(target, data, pairs, id) {
    const row = data.rows.at(-1) || {};
    target.innerHTML = `<div class="inline-stack muted"><span class="field-caption">Counts ${helpTooltip(`${id}-counts-help`,'comparable stocks',breadthMoveHelp.counts)}</span>
      <span class="field-caption">Averages and changes ${helpTooltip(`${id}-statistics-help`,'averages and changes',breadthMoveHelp.statistics)}</span>
      <span class="field-caption">Historical percentile ${helpTooltip(`${id}-extremes-help`,'historical percentile',breadthMoveHelp.extremes)}</span></div>
      <div class="table-scroll" role="region" aria-label="Momentum participation" tabindex="0"><table><thead><tr>
      <th>Comparison</th><th>Reading</th><th>Qualifying / comparable</th><th>5D avg</th><th>10D avg</th><th>20D avg</th>
      <th>Historical percentile</th><th>1D Δ</th><th>5D Δ</th><th>21D Δ</th>
      </tr></thead><tbody>${pairs.flatMap(({label,threshold,sessions})=>['up','down'].map((side) => {
        const key = breadthMoveKey(side,threshold,sessions);
        const name = side === 'up' ? 'Up' : 'Down';
        return `<tr><td><button type="button" class="stock-link" data-action="breadth" data-value="${safe(key)}">${safe(label)} · ${name} ≥ ${threshold}% · ${sessions}D</button></td>
          <td class="numeric">${percent(row[key])}</td><td class="numeric">${count(row[`${key}_numerator`])} / ${count(row[`${key}_denominator`])}</td>
          ${[5, 10, 20].map((n) => `<td class="numeric">${percent(row[`${key}_sma${n}`])}</td>`).join('')}
          <td class="numeric">${number(row[`${key}_historical_percentile`])}</td>
          ${[1, 5, 21].map((n) => `<td class="numeric">${percent(row[`${key}_change${n}`], 1, true)}</td>`).join('')}</tr>`;
      })).join('')}</tbody></table></div>`;
    bindHelpTooltips(target);
  }

  async function loadCustomMomentum({ register = false } = {}) {
    const target = main.querySelector('#custom-move-results');
    if (!state.customEnabled || !target) return;
    const run = ++customRequest;
    const pair = { label:'Custom',threshold:state.magnitude,sessions:state.rolling };
    if (breadthMovePresets.some(({threshold,sessions})=>threshold===pair.threshold && sessions===pair.sessions)) {
      target.innerHTML = '<p class="muted">This comparison is already in the standard table.</p>';
      return;
    }
    const keys = momentumKeys([pair]);
    target.innerHTML = pending('Loading the custom comparison…');
    try {
      if (register && config.automaticPreparation) await api('data/preparation', { plain:true, body:{ context:{
        ...env.snapshotContext, breadthKeys:keys, followLatest:!env.context.date && !env.context.dataVersion,
      } } });
      const data = await env.publishedSeries('market/breadth', { signal, params:{ series:1,limit:1,metrics:keys.join(',') } }, (partial,job) => {
        if (target.isConnected && run === customRequest) target.innerHTML = publishingHistory(job);
      });
      if (!target.isConnected || run !== customRequest) return;
      if (!data.rows.length && data.materialization?.preparationState) {
        target.innerHTML = notice('Custom comparison is not prepared',data.materialization.error || 'Apply the custom comparison to prepare its history.');
        return;
      }
      paintMomentum(target,data,[pair],'overview-custom');
    } catch (error) {
      if (target.isConnected && run === customRequest && error.name !== 'AbortError') target.innerHTML = notice('Custom comparison unavailable',error.message,'',true);
    }
  }

  async function loadMonitor() {
    const target = main.querySelector('#large-move-results');
    const ad = main.querySelector('#ad-line');
    const run = ++monitorRequest;
    const keys = momentumKeys(breadthMovePresets);
    const adParams = { series: 1, metrics: 'advancers,decliners,unchanged,adSpread', limit: 63,
      ...(state.adUniverse ? { universe: state.adUniverse, universeVersion: '' } : {}) };
    const [large, advance] = await Promise.allSettled([
      env.publishedSeries('market/breadth', { signal, params: { series: 1, metrics: keys.join(','), limit: 1 } }, (partial, job) => {
        if (target?.isConnected && run === monitorRequest) target.innerHTML = publishingHistory(job);
      }),
      env.publishedSeries('market/breadth', { signal, params: adParams }, (partial, job) => {
        if (ad?.isConnected && run === monitorRequest) ad.innerHTML = publishingHistory(job);
      }),
    ]);
    if (run !== monitorRequest || !target?.isConnected) return;
    if (large.status === 'fulfilled') paintMomentum(target,large.value,breadthMovePresets,'overview-fixed');
    else if (large.reason.name !== 'AbortError') target.innerHTML = notice('Momentum readings unavailable', large.reason.message, '', true);
    if (ad?.isConnected && advance.status === 'fulfilled') {
      const keys = ['advancers', 'decliners', 'unchanged'];
      const latest = advance.value.rows.at(-1);
      const readings = latest ? Object.fromEntries(keys.map((key) => [key, { value: latest[key],
        numerator: latest[`${key}_numerator`], denominator: latest[`${key}_denominator`] }])) : {};
      main.querySelector('#ad-metrics').innerHTML = keys.map((key) => metricTile(key, readings, definitions, state.adUniverse)).join('');
      ad.innerHTML = chart(advance.value.rows, [{ key: 'advanceDeclineLine', label: 'Cumulative A/D line', format: count }], { fill: true });
    } else if (ad?.isConnected && advance.reason?.name !== 'AbortError') ad.innerHTML = notice('A/D history unavailable', advance.reason?.message, '', true);
  }

  async function loadHealth({ prepare = false } = {}) {
    const run = ++healthRequest;
    const target = main.querySelector('#divergences');
    const plot = main.querySelector('#health-chart');
    if (!target || !plot) return;
    const exportButton = plot.closest('.panel').querySelector('[data-action="export-chart"]');
    exportButton.disabled = true;
    const formButton = main.querySelector('#health-coverage-form [type="submit"]');
    const active = () => env.isActive() && run === healthRequest && target.isConnected;
    const settings = state.healthCoverage || { coverageMode: 'verified' };
    const { coverageMode } = settings;
    if (overview.coverage.state !== 'complete' && coverageMode === 'verified') {
      target.innerHTML = empty('Divergence events withheld', 'Complete market coverage is required for market-wide event publication.', 'pulse');
      plot.innerHTML = empty('Market health history withheld', 'Complete market coverage is required for the selected context.', 'chart');
      return;
    }
    const request = { signal, params: { series: 1, limit: healthHistoryLimit, ...settings } };
    const progress = (partial, job) => {
      if (!active()) return;
      target.innerHTML = publishingHistory(job);
      plot.innerHTML = publishingHistory(job);
    };
    try {
      if (prepare && config.automaticPreparation) {
        formButton.disabled = true;
        const initial = await api('market/health', request);
        if (!active()) return;
        request.initialResponse = initial;
        if (initial.materialization?.prepareAction === 'health' && !initial.contextPreparation?.pending
          && !initial.contextPreparation?.captureInProgress) {
          target.innerHTML = plot.innerHTML = pending('Requesting market health preparation…');
          const job = await api('market/health/prepare', { plain: true, signal,
            body: { context: env.snapshotContext, healthModel: context.healthModel, limit: healthHistoryLimit, ...settings } });
          if (!active()) return;
          if (job.status === 'failed') throw new Error(job.error || 'Market health preparation failed.');
          request.initialResponse = job.id && ['queued', 'running'].includes(job.status)
            ? { materialization: { pending: true, jobId: job.id, status: job.status, progress: job.progress } } : undefined;
        }
      }
      const result = await env.publishedSeries('market/health', request, progress);
      if (!active()) return;
      main.querySelector('#current-health').innerHTML = (coverageMode === 'observed'
        ? notice('Observed universe · descriptive', `${observedCoverageSummary({ ...settings, ...result })} ${result.coverageWarning || ''}`)
        : '') + healthPanel({ ...overview, health: result });
      if (result.materialization?.prepareAction === 'health' || result.state === 'unprepared') {
        const context = result.contextPreparation;
        if (context?.pending || context?.captureInProgress) {
          const prerequisite = context.captureInProgress ? 'Waiting for the market data import'
            : context.status === 'queued' ? 'Breadth history is queued'
              : `Breadth history is being prepared · ${count(context.progress)}%`;
          const explanation = 'Market health and divergences need the historical breadth inputs for this context.';
          target.innerHTML = empty('Waiting for breadth history', explanation, 'pulse');
          plot.innerHTML = notice(prerequisite, explanation, action('Check readiness', 'check-health-readiness', 'refresh'));
          return;
        }
        const message = result.materialization?.error || 'Prepare these readings and events for the selected context and coverage policy.';
        target.innerHTML = empty('Divergences have yet to be prepared', message, 'pulse');
        plot.innerHTML = notice('Market health preparation required', message,
          action('Prepare market health', 'prepare-health', 'chart'));
        return;
      }
      const events = (result.events || []).toReversed();
      plot.innerHTML = chart(result.history || [], [{ key: 'score', label: 'Market health score', format: number }], { domain: [0, 100], fill: true });
      exportButton.disabled = !plot.querySelector('[data-chart]');
      target.innerHTML = events.length ? events.map((event) =>
        `<div class="simple-row"><strong>${safe(event.label || event.id)}</strong><span>${dateLabel(event.date)}</span></div>`).join('')
        : empty('No divergences in this range', 'Recent comparable sessions contain no matching events.', 'pulse');
    } catch (error) {
      if (active() && error.name !== 'AbortError') {
        target.innerHTML = notice('Divergences unavailable', error.message, '', true);
        plot.innerHTML = notice('Market health history unavailable', error.message,
          config.automaticPreparation ? action('Prepare market health', 'prepare-health', 'chart') : '', true);
      }
    } finally {
      if (active()) formButton.disabled = false;
    }
  }

  env.setActions({
    'overview-tab'(value) { state.tab = value; showOverview(); },
    'observe-health'() { state.healthCoverage = { coverageMode: 'observed' }; showOverview({ prepareHealth: true }); },
    'check-health-readiness'() { return loadHealth(); },
    'prepare-health'() { return loadHealth({ prepare: true }); },
    'overview-range'(value) { state.range = Number(value); showOverview(); },
    'mover-side'(value) { state.movers = value; showOverview(); },
    'rolling-window'(value, button) {
      const form = button.closest('form');
      form.elements.sessions.value = value;
      for (const choice of form.querySelectorAll('[data-action="rolling-window"]')) choice.setAttribute('aria-pressed', String(choice===button));
    },
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
  main.onsubmit = async (event) => {
    if (event.target.id === 'health-coverage-form') {
      event.preventDefault();
      state.healthCoverage = observedCoverageParams(Object.fromEntries(new FormData(event.target)));
      showOverview({ prepareHealth: true });
      return;
    }
    if (event.target.id !== 'monitor-form') return;
    event.preventDefault();
    const values = new FormData(event.target);
    state.rolling = Number(values.get('sessions'));
    state.magnitude = Number(values.get('magnitude'));
    event.target.elements.sessions.defaultValue = String(state.rolling);
    event.target.elements.magnitude.defaultValue = String(state.magnitude);
    state.customEnabled = true;
    await loadCustomMomentum({ register:true });
  };
  showOverview();
  if (overview.materialization?.pending || overview.materialization?.captureInProgress) {
    env.publishedSeries('market/overview', { signal, initialResponse: overview }, (partial, job) => {
      const target = main.querySelector('#overview-preparation');
      if (env.isActive() && target) target.innerHTML = publishingHistory(job);
    }).then((ready) => {
      if (!env.isActive()) return;
      overview = ready;
      showOverview();
    }).catch((error) => {
      const target = main.querySelector('#overview-preparation');
      if (env.isActive() && target && error.name !== 'AbortError') target.innerHTML = notice('Current calculations could not be prepared', error.message);
    });
  }
}
