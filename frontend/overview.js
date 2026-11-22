import {
  action, attr, bindHelpTooltips, bindObservedCoverage, breadthMoveHelp, breadthMoveKey, breadthMovePresets, chip, compact,
  count, dateLabel, direction, empty, field, heading, helpField, helpTooltip, icon, iconButton, notice, number, numeric, option,
  observedCoverageParams,
  pagination, panelHead, pending, publishingHistory, percent, rate, ratio, safe, segment, signed, summary, table,
} from './ui.js';
import { chart } from './charts.js';
import { rangeSegment } from './chart-ranges.js';
import { openBreadthDrawer } from './contributors.js';
import { universeDefinition } from './coverage.js';
import { renderMarketReading } from './market-reading.js';
import { createTimingReview } from './market-timing.js';
import { mountSummation } from './summation.js';
import { groupHeatmapMetrics, renderGroupHeatmap } from './group-visuals.js';
import { renderHealthAvailability, renderHealthComponents } from './health-visuals.js';

const dailyKeys = ['up_4pct', 'down_4pct', 'up_2pct', 'down_2pct', 'up_1pct', 'down_1pct'];
const averageKeys = ['above_10d', 'above_20d', 'above_50d', 'above_100d', 'above_150d', 'above_200d', 'ma_50_above_200', 'ma_rising_50', 'ma_rising_200', 'ma_aligned'];
const observedHealthDefaults = { observedMinimum: 20, observedThreshold: 0.8 };
const coveragePercent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
const fieldCoverageSelect = (value) => `<label class="field"><span>Coverage basis</span><select name="coverageMode">
  ${option('verified','Verified market coverage',value)}${option('observed','Observed universe (descriptive)',value)}</select></label>`;
const dailyChartKeys = ['above_50d', 'above_200d', 'above_20d'];
const breakdownPairs = [
  { title: 'New highs and lows', label: 'Lookback', up: 'New highs', down: 'New lows',
    rows: [20, 50, 100, 252].map((days) => [`${days} sessions`, `new_high_${days}d`, `new_low_${days}d`]) },
  { title: 'High-volume moves', label: 'Relative volume', up: 'Advancers', down: 'Decliners',
    rows: [['≥ 1.5×', 'high_volume_up', 'high_volume_down'], ['≥ 2×', 'high_volume_up_2x', 'high_volume_down_2x']] },
];
const pairedKeys = new Set(breakdownPairs.flatMap(({ rows }) => rows.flatMap(([, up, down]) => [up, down])));
const moverViews = [['daily', 'Daily movers'], ['20', '20-day highs / lows'], ['252', '52-week highs / lows']];
const moverSides = [['gainers', 'Gainers'], ['losers', 'Losers']];
const extremeSides = [['high', 'Highs'], ['low', 'Lows']];
const dailyMoverThreshold = .10 + Number.EPSILON;
const moverPageSize = 25;

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
const moverColumns = [...overviewRowColumns, 'industry'];

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
    const label = definitions.get(key)?.label || key;
    const detail = safe(`${label} · ${breadthValue(metric)} · ${measurement(metric)}`);
    return `<button type="button" class="participation-row" data-action="breadth" data-value="${key}" title="${detail}" aria-label="${detail}">
      <span>${safe(label)}</span><span class="bar-rail" style="--bar-width:${width}%;--bar-color:${color}"><i></i></span>
      <span class="numeric">${breadthValue(metric)}</span></button>`;
  }).join('')}</div>`;
}

function breakdownMatrix(breadth, definitions) {
  const reading = (key) => {
    const label = definitions.get(key)?.label || key;
    const metric = breadth[key];
    return `<button type="button" class="breakdown-reading" data-action="breadth" data-value="${key}"
      aria-label="${safe(`${label} · ${breadthValue(metric)} · ${measurement(metric)}`)}">
      <strong class="numeric">${breadthValue(metric)}</strong><small>${measurement(metric)}</small></button>`;
  };
  return breakdownPairs.map(({ title, label, up, down, rows }) => `<section class="panel panel-body">
    ${panelHead(title)}<div class="table-scroll" tabindex="0" role="region" aria-label="${title}"><table class="breakdown-table">
    <thead><tr><th scope="col">${label}</th><th scope="col">${up}</th><th scope="col">${down}</th><th scope="col">Net spread</th></tr></thead>
    <tbody>${rows.map(([period, upKey, downKey]) => {
      const upValue = breadth[upKey]?.value;
      const downValue = breadth[downKey]?.value;
      const spread = numeric(upValue) && numeric(downValue) ? upValue - downValue : null;
      return `<tr><th scope="row">${period}</th><td>${reading(upKey)}</td><td>${reading(downKey)}</td>
        <td class="numeric ${direction(spread)}">${numeric(spread) ? `${signed(spread)} pp` : '—'}</td></tr>`;
    }).join('')}</tbody></table></div></section>`).join('');
}

export function dailyMoverRows(rows, side) {
  return (rows || []).filter(({ return_1d }) => numeric(return_1d) && (side === 'gainers'
    ? return_1d > dailyMoverThreshold : return_1d < -dailyMoverThreshold));
}
function volumeTiles(aggregate) {
  return [
    ['Up volume', compact(aggregate.upVolume)], ['Down volume', compact(aggregate.downVolume)],
    ['Up-volume share', rate(aggregate.upVolumeShare, 1, false)], ['U/D share volume', ratio(aggregate.upDownVolume, aggregate.upDownVolumeState)],
    ['Net advancing dollar volume', compact(aggregate.netDollar, true)], ['U/D dollar volume', ratio(aggregate.upDownDollar, aggregate.upDollar > 0 && !aggregate.downDollar ? 'infinity' : null)],
    ['Equal-weight 1D return', rate(aggregate.equalWeightReturn)], ['Median 1D return', rate(aggregate.medianReturn)],
  ].map(([label, value]) => `<div class="metric-tile"><span>${label}</span><strong>${value}</strong></div>`).join('');
}
const comparisonLabels = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', ne: '≠' };
const conditionLabel = (condition) => condition.any ? condition.any.map(conditionLabel).join(' or ')
  : `${healthFeatureLabels[condition.metric] || condition.metric}: ${number(condition.actual)} ${comparisonLabels[condition.op] || condition.op} ${number(condition.value)}`;
const healthFeatureLabels = {
  benchmarkMomentum: 'Benchmark momentum', shortBreadth: 'Short-term breadth', intermediateBreadth: 'Intermediate breadth',
  longBreadth: 'Long-term breadth', priceMomentum: 'Price momentum', industryLeadership: 'Industry leadership',
  priorWeakSessions: 'Prior weak sessions', shortChange: 'Short breadth change', intermediateChange: 'Intermediate breadth change',
};
function healthPanel(health = {}, { snapshot, weights, industryUrl, datedHealthUrl }) {
  const conditions = health.regime?.conditions || [];
  return `<section class="panel panel-body">${panelHead('Market health', health.model?.name || 'Composite model')}
    ${numeric(health.score) ? `<div class="health-title"><span class="summary-value">${number(health.score)}</span>
      ${health.regime?.label ? chip(health.regime.label, 'accent') : ''}</div>`
      : renderHealthAvailability(health, { coverage: snapshot.coverage, datedHealthUrl })}
    ${health.regime?.sessions ? `<p class="muted section-space">Since ${dateLabel(health.regime.since)} · ${count(health.regime.sessions)} comparable sessions</p>` : ''}
    ${conditions.length ? `<div class="inline-stack section-space">${conditions.map((condition) => chip(conditionLabel(condition), condition.met ? 'accent' : '')).join('')}</div>` : ''}
    ${renderHealthComponents(health, { snapshot, weights, industryUrl })}
  </section>`;
}

function coveragePolicyLine(mode, coverage, settings = {}) {
  if (mode === 'observed') {
    const { observedMinimum, observedThreshold } = { ...observedHealthDefaults, ...settings };
    return `${coveragePercent.format(observedThreshold)} comparable · ${count(observedMinimum)} traded minimum`;
  }
  return coverage.state === 'complete' ? 'Market-wide analysis' : 'Requires reconciled source coverage';
}

function healthCoverageRules(settings = {}) {
  const { coverageMode, observedMinimum, observedThreshold } = { ...observedHealthDefaults, ...settings };
  const hidden = coverageMode === 'observed' ? '' : ' hidden';
  const disabled = hidden ? ' disabled' : '';
  return `<details class="health-coverage-rules" data-observed-coverage${hidden}>
    <summary class="button ghost">${icon('settings')} Coverage rules</summary>
    <div class="health-coverage-fields inline-form">
      ${field('Minimum traded securities', `<input name="observedMinimum" type="number" min="1" max="100000" step="1" required value="${safe(observedMinimum)}"${disabled}>`)}
      ${field('Comparable coverage (%)', `<input name="observedThreshold" type="number" min="0.1" max="100" step="0.1" required value="${number(observedThreshold * 100)}"${disabled}>`)}
    </div></details>`;
}

const fallbackHealthComponents = (health) => (health?.components || []).map(({ id, value, numerator, denominator, readings, weight, definition }) =>
  ({ id, value, numerator, denominator, readings, weight, definition }));

const healthScoreNote = (health) => health?.regime?.label || (health?.state === 'loading' ? 'Loading score' : 'Score unavailable');

function compactStatus(message, controls = '') {
  return `<div class="inline-stack"><p class="muted">${safe(message)}</p>${controls}</div>`;
}

export async function render(env) {
  const { main, config, signal, api, routeUrl, state, context } = env;
  const definitions = new Map((config.breadthMetrics || []).map((metric) => [metric.key, metric]));
  let overview = await api('market/overview', { signal });
  if (!env.isActive()) return;
  const timing = createTimingReview(env, { date: overview.date, dataVersion: overview.dataVersion ?? env.snapshotContext.dataVersion,
    basis: overview.basis || env.snapshotContext.basis });
  state.tab = env.params.tab || state.tab || 'overview';
  if (env.params.coverage === 'observed' && state.healthCoverage?.coverageMode !== 'observed') state.healthCoverage = { coverageMode: 'observed' };
  state.range ||= 63;
  state.healthRange ||= 63;
  state.adRange ||= 63;
  state.rolling ||= 63;
  state.magnitude ||= 13;
  state.movers ||= 'gainers';
  state.moverView ||= 'daily';
  state.extremeSide ||= 'high';
  state.breakdownView = env.params.breakdownView === 'cards' ? 'cards' : 'compare';
  state.heatmapLevel ||= 'sector';
  state.heatmapMetric ||= 'medianRS';
  let groupRequest;
  let dailyMoverPanel;
  let moverPreview;
  let chartRequest = 0;
  let monitorRequest = 0;
  let customRequest = 0;
  let healthRequest = 0;

  function marketHealthPanel(health) {
    const baseline = config.healthModels?.find(({ id }) => id === 'default');
    const selected = config.healthModels?.find(({ id }) => id === context.healthModel);
    const canUseDatedGroups = (overview.classificationSystem || context.classification) === 'nasdaq' && config.classificationSystems?.includes('sec-sic');
    const datedGroups = { classification: 'sec-sic', reference: 'as-of' };
    const industryUrl = canUseDatedGroups ? groupRoute({ ...datedGroups, level: 'industry', groupView: 'velocity' }) : null;
    const datedHealthUrl = canUseDatedGroups ? routeUrl('overview', { ...datedGroups, tab: 'health',
      ...(state.healthCoverage?.coverageMode === 'observed' ? { coverage: 'observed' } : {}) }) : null;
    return healthPanel(health ?? {}, { snapshot: overview, weights: { ...baseline?.weights, ...selected?.definition?.weights }, industryUrl, datedHealthUrl });
  }

  function showOverview({ prepareHealth = false } = {}) {
    const { coverage, breadth, aggregates, health } = overview;
    const active = state.tab;
    const universeName = overview.universe?.name || config.universes?.find(({ id }) => id === context.universe)?.name || 'Selected universe';
    const definition = universeDefinition(context.universe);
    const policy = state.healthCoverage?.coverageMode || 'verified';
    const coverageNote = partialCoverage(coverage, routeUrl, { score: active !== 'health' });
    const currentHealth = active === 'health' && policy === 'observed' ? { state: 'loading', components: fallbackHealthComponents(health) } : health;
    const undergoingPreparation = overview.materialization?.pending || overview.materialization?.captureInProgress;
    const notes = coverageNote || undergoingPreparation || active === 'health'
      ? `<details class="panel panel-body formula-help section-space" id="overview-data-notes"><summary>Data notes</summary>
        <div class="section-space">${coverageNote}<div id="overview-preparation" aria-live="polite"></div>
          <p id="health-data-note" class="muted" hidden></p></div></details>` : '';
    main.innerHTML = heading('Market Overview', definition ? `${universeName} · ${definition}` : `${universeName} · Participation, momentum, and leadership`,
      `${overview.date ? chip(`Session ${dateLabel(overview.date)}`) : ''}<a class="button" href="${safe(routeUrl('monitor'))}">${icon('pulse')} Market monitor</a><a class="button" href="${safe(routeUrl('history'))}">${icon('history')} Explore history</a>`) +
      (active === 'overview' || active === 'health' ? renderMarketReading(overview) : '') +
      `<section class="summary-grid section-space" aria-label="Session summary">
        ${summary('Traded securities', count(coverage.traded),
          numeric(coverage.listed) ? `${count(coverage.listed)} eligible in ${universeName}` : `Eligible count unavailable for ${universeName}`, { glyph: 'layers' })}
        ${summary('Above 50D SMA', breadthValue(breadth.above_50d), measurement(breadth.above_50d), { action: 'breadth', value: 'above_50d' })}
        ${summary('Advance / decline spread', percent(breadth.adSpread?.value, 1, true), `${count(breadth.advancers?.numerator)} advance · ${count(breadth.decliners?.numerator)} decline`,
          { action: 'breadth', value: 'adSpread', style: direction(breadth.adSpread?.value) })}
        ${summary('Composite health', number(currentHealth?.score), healthScoreNote(currentHealth), { action: 'overview-tab', value: 'health' })}
      </section>` +
      (active === 'monitor' ? '' : '<div id="overview-timing-summary"></div>') +
      segment('overview-tab', [['overview', 'Breadth overview'], ['monitor', 'Session review'], ['health', 'Health & regimes']], active, 'tabs') +
      (active === 'overview' ? `<div class="market-grid">
        <section class="panel panel-body">${panelHead('Moving-average breadth', 'Share of comparable stocks above key moving averages.',
          rangeSegment('overview-range', state.range) + iconButton('Export breadth chart CSV', 'export-chart', 'download', 'moving-average-breadth.csv'))}
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
        <section class="panel panel-body" id="market-movers" aria-label="Market movers and new extremes"></section>
      </div>
      <section class="panel panel-body">${panelHead('Sector & industry heatmap', 'Group values for the selected session',
        segment('overview-heatmap-level', [['sector', 'Sectors'], ['industry', 'Industries']], state.heatmapLevel))}
        <div class="inline-form"><label class="field"><span>Heatmap metric</span><select data-change="overview-heatmap-metric">
          ${groupHeatmapMetrics.map(([key, label]) => option(key, label, state.heatmapMetric)).join('')}</select></label>
          <a class="button ghost" href="${safe(groupRoute({ level: state.heatmapLevel, groupView: 'velocity' }))}">RS vs velocity ${icon('chevron-right')}</a>
          <a class="button ghost" href="${safe(groupRoute({ level: state.heatmapLevel, groupView: 'table' }))}">Group table ${icon('chevron-right')}</a></div>
        <div id="overview-heatmap" class="section-space">${pending('Loading sector and industry groups…')}</div></section>
      <section class="panel panel-body">${panelHead('Moving-average participation', 'Open a reading to reconcile its contributing securities.')}<div class="metric-grid">${averageKeys.map((key) => metricTile(key, breadth, definitions)).join('')}</div></section>
      <div id="market-summation" class="section-space"></div>`
      : active === 'monitor' ? '<div id="overview-timing-panel"></div>' + monitorLayout() : `<form id="health-coverage-form" class="health-coverage-form" aria-describedby="health-coverage-policy">
        ${fieldCoverageSelect(policy)}
        <p class="muted" id="health-coverage-policy">${safe(coveragePolicyLine(policy, coverage, state.healthCoverage))}</p>
        ${healthCoverageRules(state.healthCoverage)}
        <button class="button" type="submit">Apply coverage</button>
        ${policy === 'verified' && coverage.state !== 'complete' ? action('Use observed universe', 'observe-health', 'pulse') : ''}
      </form>
        <div class="split-grid"><div id="current-health">${marketHealthPanel(currentHealth)}</div>
        <section class="panel panel-body health-divergence-panel">${panelHead('Breadth divergences', 'Dated benchmark and market participation comparisons')}<div id="divergences">${pending()}</div></section></div>
        <section class="panel panel-body">${panelHead('Market health history', 'Published composite scores using the selected market context.',
          rangeSegment('health-range', state.healthRange) + iconButton('Export market health history CSV', 'export-chart', 'download', 'market-health.csv'))}<div id="health-chart">${pending()}</div></section>`) + notes;
    timing.mount(main.querySelector('#overview-timing-summary'), main.querySelector('#overview-timing-panel'));
    if (active === 'overview') {
      loadMovers();
      loadChart();
      loadHeatmap();
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

  function groupContext() {
    return { ...env.snapshotContext, date: overview.date || env.snapshotContext.date,
      dataVersion: overview.dataVersion ?? env.snapshotContext.dataVersion };
  }

  function groupRoute(patch) {
    return routeUrl('industries', { ...groupContext(), ...patch });
  }

  function moverTable(rows, label, emptyText, params = groupContext()) {
    return table(rows, moverColumns, { label, emptyText, cells: {
      symbol: (row) => `<a class="stock-link mono" href="${safe(routeUrl('stock', { ...params, symbol: row.securityId || row.symbol }))}">${safe(row.symbol || row.securityId)}</a>`,
      industry: (row) => row.industryId && row.industry
        ? `<a class="text-link" href="${safe(routeUrl('industries', { ...params, level: 'industry', group: row.industryId, groupView: 'table' }))}">${safe(row.industry)}</a>` : null,
    } });
  }

  function dailyMoverPage(side, params, page, perPage) {
    const gainers = side === 'gainers';
    return api('screens/query', { signal, params, body: { context: params, page, perPage, columns: moverColumns,
      filter: { operator: 'and', filters: [{ field: 'return_1d', op: gainers ? 'gt' : 'lt', value: gainers ? dailyMoverThreshold : -dailyMoverThreshold }] },
      sort: [{ field: 'return_1d', direction: gainers ? 'desc' : 'asc' }] } });
  }

  async function loadMoverPreviewPage(page, button) {
    const preview = moverPreview;
    if (!preview || preview.loading) return;
    const { target, params, label, fetchPage, emptyText, fullList } = preview;
    const active = () => env.isActive() && moverPreview === preview && target.isConnected;
    const status = target.querySelector('[data-mover-page-status]');
    const controls = [...target.querySelectorAll('.pagination button:not(:disabled)')];
    const report = (message) => {
      if (status) status.textContent = message;
      else target.innerHTML = `<p class="muted" role="status">${safe(message)}</p>`;
    };
    preview.loading = true;
    for (const control of controls) control.setAttribute('aria-disabled', 'true');
    if (status) status.textContent = `Loading page ${count(page)}…`;
    else target.innerHTML = pending('Loading qualifying stocks…');
    try {
      const result = await fetchPage(page);
      if (!active()) return;
      if (result.pendingOnly || !numeric(result.total)) {
        report('This list is not prepared for the selected session and revision.');
        return;
      }
      if (result.metric?.denominator === 0) {
        report('No stocks have enough comparable history for this lookback in the selected session.');
        return;
      }
      const rows = result.rows || [];
      const total = result.total;
      const moveFocus = button && target.ownerDocument.activeElement === button;
      target.innerHTML = `<div class="panel-head"><p class="muted">${count(total)} qualifying ${total === 1 ? 'stock' : 'stocks'}</p>${total ? fullList : ''}</div>
        ${rows.length ? moverTable(rows, label, emptyText, params) : `<p class="muted">${safe(emptyText)}</p>`}
        ${total > moverPageSize ? pagination({ total, page, perPage: moverPageSize }, 'mover-preview-page') : ''}
        <p class="muted" role="status" data-mover-page-status></p>`;
      const scroll = target.querySelector('.table-scroll');
      scroll?.classList.add('market-mover-scroll');
      if (moveFocus) scroll?.focus({ preventScroll: true });
    } catch (error) {
      if (active() && error.name !== 'AbortError') report(`Could not load qualifying stocks. ${error.message}`);
    } finally {
      preview.loading = false;
      for (const control of controls) control.removeAttribute('aria-disabled');
    }
  }

  function loadMovers() {
    const panel = main.querySelector('#market-movers');
    if (!panel) return;
    const view = state.moverView;
    const daily = view === 'daily';
    const side = daily ? state.movers : state.extremeSide;
    const label = moverViews.find(([id]) => id === view)[1];
    panel.innerHTML = `${panelHead(label, daily ? 'Close-to-prior-close gains greater than 10% or losses greater than 10%'
      : `Session ${side} ${side === 'high' ? 'exceeds' : 'undercuts'} the preceding ${view} sessions’ ${side}s`)}
      <div class="inline-stack">${segment('mover-view', moverViews, view)}
      ${segment('mover-side', daily ? moverSides : extremeSides, side)}</div>
      <div class="section-space" data-mover-preview></div>`;
    const target = panel.querySelector('[data-mover-preview]');
    moverPreview = null;
    if (overview.coverage.state === 'unprepared') {
      target.innerHTML = '<p class="muted">This list is not prepared for the selected session and revision.</p>';
      return;
    }
    const params = groupContext();
    if (daily) {
      const saved = overview.movers?.[side];
      const rows = dailyMoverRows(saved, side);
      const total = overview.movers?.counts?.[side];
      const complete = Array.isArray(saved) && total === rows.length && rows.length <= moverPageSize;
      moverPreview = { target, params, label, fullList: action('Full list', 'daily-mover-list', 'layers', { value: side }),
        emptyText: `No stocks ${side === 'gainers' ? 'gained' : 'lost'} more than 10% from the prior close in this universe.`,
        fetchPage: complete ? () => ({ rows, total }) : (page) => dailyMoverPage(side, params, page, moverPageSize) };
    } else {
      const key = `new_${side}_${view}d`;
      moverPreview = { target, params, label,
        fullList: action('Full list', 'breadth', 'layers', { value: key }),
        emptyText: `No stocks reached a new ${view === '252' ? '52-week' : '20-day'} ${side} in this universe.`,
        fetchPage: (page) => api(`market/breadth/${key}/contributors`, { signal, params: { ...params, include: 'numerator', page, perPage: moverPageSize } }) };
    }
    return loadMoverPreviewPage(1);
  }

  function openDailyMoverList(side) {
    const title = side === 'gainers' ? 'Daily gainers' : 'Daily losers';
    const params = groupContext();
    dailyMoverPanel = { side, params, title, target: env.showDialog(env.detail, title, pending(), dateLabel(params.date)) };
    return loadDailyMoverList(1);
  }

  async function loadDailyMoverList(page) {
    const { side, params, title, target } = dailyMoverPanel;
    target.innerHTML = pending('Loading qualifying stocks…');
    try {
      const result = await dailyMoverPage(side, params, page, 30);
      if (!target.isConnected) return;
      target.innerHTML = result.pendingOnly ? '<p class="muted">This list is not prepared for the selected session and revision.</p>'
        : moverTable(result.rows || [], title, 'No qualifying stocks for this session.', params) + pagination(result, 'daily-mover-page');
    } catch (error) {
      if (target.isConnected && error.name !== 'AbortError') target.innerHTML = notice('Daily list unavailable', error.message, '', true);
    }
  }

  async function loadHeatmap() {
    const target = main.querySelector('#overview-heatmap');
    const params = groupContext();
    const key = `${params.date}|${params.dataVersion}|${overview.coverage.state}`;
    if (groupRequest?.key !== key) groupRequest = { key, promise: api('industries', { signal, params }) };
    const level = state.heatmapLevel;
    const metric = state.heatmapMetric;
    try {
      const result = await groupRequest.promise;
      if (!target?.isConnected || level !== state.heatmapLevel || metric !== state.heatmapMetric) return;
      target.innerHTML = renderGroupHeatmap(result.groups, { level, metric, date: result.date,
        contextLabel: overview.universe?.name, unavailableReason: result.coverage?.state === 'unprepared'
          ? 'Group readings are not prepared for this exact date and revision.' : undefined,
        routeUrl: (group) => groupRoute({ level: group.level, group: group.id, groupView: 'heatmap' }) });
    } catch (error) {
      if (target?.isConnected && error.name !== 'AbortError') target.innerHTML = notice('Group heatmap unavailable', error.message, '', true);
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
          ${option('', 'Selected universe', state.adUniverse || '')}${exchangeOptions.map((u) => option(u.id, u.name, state.adUniverse)).join('')}</select>` + rangeSegment('ad-range', state.adRange))}
          <div class="metric-grid" id="ad-metrics">${['advancers', 'decliners', 'unchanged'].map((key) => metricTile(key, overview.breadth, definitions)).join('')}</div>
          <div id="ad-line" class="section-space">${pending()}</div>
        </section>
        <section class="panel panel-body">${panelHead('Volume participation', 'Share- and dollar-volume aggregates')}<div class="metric-grid">${volumeTiles(overview.aggregates)}</div></section>
      </div>
      <div class="inline-form" aria-label="Session metric layout">
        ${segment('breakdown-view', [['compare', 'Compare matrix'], ['cards', 'Cards']], state.breakdownView)}
      </div>
      ${state.breakdownView === 'compare' ? `<div class="split-grid">${breakdownMatrix(overview.breadth, definitions)}</div>` : ''}
      ${['Volume','Highs and lows','Leadership','Multi-session momentum'].map((family) => {
        const metrics = [...definitions.values()].filter((metric) => metric.family === family && !/^(up|down)_/.test(metric.key)
          && (state.breakdownView === 'cards' || !pairedKeys.has(metric.key)));
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
    const adParams = { series: 1, metrics: 'advancers,decliners,unchanged,adSpread', limit: state.adRange,
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
    const setCurrentHealth = (result) => {
      const components = result.components?.length ? result.components : fallbackHealthComponents(overview.health);
      main.querySelector('#current-health').innerHTML = marketHealthPanel({ ...result, components });
      const tile = main.querySelector('.summary-card[data-action="overview-tab"][data-value="health"]');
      tile.querySelector('.summary-value').textContent = number(result.score);
      tile.querySelector('.summary-foot').textContent = healthScoreNote(result);
    };
    if (overview.coverage.state !== 'complete' && coverageMode === 'verified') {
      target.innerHTML = compactStatus('Verified divergence events are unavailable for this context.');
      plot.innerHTML = compactStatus('Verified composite history requires reconciled coverage.');
      return;
    }
    const request = { signal, params: { series: 1, limit: state.healthRange, ...settings } };
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
          body: { context: env.snapshotContext, healthModel: context.healthModel, limit: state.healthRange, ...settings } });
          if (!active()) return;
          if (job.status === 'failed') throw new Error(job.error || 'Market health preparation failed.');
          request.initialResponse = job.id && ['queued', 'running'].includes(job.status)
            ? { materialization: { pending: true, jobId: job.id, status: job.status, progress: job.progress } } : undefined;
        }
      }
      const result = await env.publishedSeries('market/health', request, progress);
      if (!active()) return;
      setCurrentHealth({ coverageMode, ...result });
      main.querySelector('#health-coverage-policy').textContent = coveragePolicyLine(coverageMode, overview.coverage, { ...settings, ...result });
      const note = main.querySelector('#health-data-note');
      note.textContent = result.coverageWarning || '';
      note.hidden = !note.textContent;
      if (result.materialization?.prepareAction === 'health' || result.state === 'unprepared') {
        const context = result.contextPreparation;
        if (context?.pending || context?.captureInProgress) {
          const prerequisite = context.captureInProgress ? 'Waiting for the market data import'
            : context.status === 'queued' ? 'Breadth history is queued'
              : `Breadth history is being prepared · ${count(context.progress)}%`;
          const explanation = 'Market health and divergences need the historical breadth inputs for this context.';
          target.innerHTML = compactStatus('Waiting for prepared breadth history.');
          plot.innerHTML = compactStatus(`${prerequisite}. ${explanation}`, action('Check readiness', 'check-health-readiness', 'refresh'));
          return;
        }
        const message = result.materialization?.error || 'Prepare these readings and events for the selected context and coverage policy.';
        target.innerHTML = compactStatus('Divergences have yet to be prepared.');
        plot.innerHTML = compactStatus(message, action('Prepare market health', 'prepare-health', 'chart'));
        return;
      }
      const events = (result.events || []).toReversed();
      plot.innerHTML = chart(result.history || [], [{ key: 'score', label: 'Market health score', format: number }], { domain: [0, 100], fill: true });
      exportButton.disabled = !plot.querySelector('[data-chart]');
      target.innerHTML = events.length ? `<div class="health-divergence-list" tabindex="0" role="region" aria-label="Dated breadth divergence events">
        <ul>${events.map((event) => `<li class="simple-row"><strong>${safe(event.label || event.id)}</strong>
          <time datetime="${safe(event.date)}">${dateLabel(event.date)}</time></li>`).join('')}</ul></div>`
        : empty('No divergences in this range', 'Recent comparable sessions contain no matching events.', 'pulse');
    } catch (error) {
      if (active() && error.name !== 'AbortError') {
        if (coverageMode === 'observed') setCurrentHealth({ coverageMode, reason: 'Could not load market health for the selected coverage.' });
        target.innerHTML = compactStatus('Divergence history unavailable.');
        plot.innerHTML = compactStatus(error.message,
          config.automaticPreparation ? action('Prepare market health', 'prepare-health', 'chart') : '');
      }
    } finally {
      if (active()) formButton.disabled = false;
    }
  }

  env.setActions({
    'overview-tab'(value) { state.tab = value; showOverview(); },
    'timing-instrument': timing.instrument,
    'timing-range': timing.range,
    'timing-retry': timing.retry,
    'observe-health'() {
      state.healthCoverage = { coverageMode: 'observed' };
      showOverview({ prepareHealth: true });
      main.querySelector('#health-coverage-form [name="coverageMode"]').focus();
    },
    'check-health-readiness'() { return loadHealth(); },
    'prepare-health'() { return loadHealth({ prepare: true }); },
    'overview-range'(value) { state.range = Number(value); showOverview(); },
    'health-range'(value) { state.healthRange = Number(value); showOverview(); },
    'ad-range'(value) { state.adRange = Number(value); showOverview(); },
    'mover-view'(value) {
      if (state.moverView === value) return;
      state.moverView = value;
      loadMovers();
      main.querySelector('[data-action="mover-view"][aria-pressed="true"]')?.focus();
    },
    'mover-side'(value) {
      if ((state.moverView === 'daily' ? state.movers : state.extremeSide) === value) return;
      if (state.moverView === 'daily') state.movers = value;
      else state.extremeSide = value;
      loadMovers();
      main.querySelector('[data-action="mover-side"][aria-pressed="true"]')?.focus();
    },
    'mover-preview-page'(value, button) { return loadMoverPreviewPage(Number(value), button); },
    'daily-mover-list': openDailyMoverList,
    'daily-mover-page'(value) { return loadDailyMoverList(Number(value)); },
    'breakdown-view'(value) { return env.go('overview', { ...env.params, tab: 'monitor', breakdownView: value }); },
    'overview-heatmap-level'(value) { state.heatmapLevel = value; showOverview(); },
    'change:overview-heatmap-metric'(value) { state.heatmapMetric = value; loadHeatmap(); },
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
      const fields = Object.fromEntries(new FormData(event.target));
      if (fields.coverageMode === 'observed') fields.observedThreshold = Math.round(Number(fields.observedThreshold) * 10) / 1000;
      state.healthCoverage = observedCoverageParams(fields);
      showOverview({ prepareHealth: true });
      main.querySelector('#health-coverage-form [name="coverageMode"]').focus();
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
