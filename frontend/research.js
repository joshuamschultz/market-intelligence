import {
  action, attr, bindHelpTooltips, bindObservedCoverage, chip, compact, count, csvDownload, dateLabel, direction, empty, field, heading, icon, iconButton, money, notice, number, numeric, option,
  observedCoverageFields, observedCoverageParams, observedCoverageSummary,
  panelHead, pagination, pathPart, pending, publishingHistory, percent, rate, ratio, safe, segment, shiftDate, signed, summary, table,
} from './ui.js';
import { axisDomain, chart, chartColors, focusedTickFormat } from './charts.js';
import { chartRanges, rangeLimit, rangeSegment } from './chart-ranges.js';
import { partialCoverage } from './overview.js';
import { mountJournalHistory } from './journal.js';
import { buildLeadershipMap, groupHeatmapMetrics, renderGroupHeatmap } from './group-visuals.js';
import { groupMembershipDetail, groupMembershipExport, groupMembershipUnavailable, groupMembershipValue, groupMembershipView, loadGroupMembershipStyles, membershipWindow,
  membershipWindows, renderGroupMembership, renderGroupMembershipDetail } from './group-membership.js';

const groupLevels = [['industry','Industries'], ['sector','Sectors'], ['subindustry','Subindustries'], ['theme','Themes']];
const groupViews = [['heatmap', 'Heatmap'], ['velocity', 'RS vs velocity'], ['table', 'Table']];
const leadershipWindows = [['velocity4w', '4 weeks'], ['velocity12w', '12 weeks']];
const rankDelta = (value) => signed(value, 0);
const groupMetrics = {
  rank: ['Rank', count], medianRS: ['Median RS', number], velocity4w: ['4W velocity', signed], velocity12w: ['12W velocity', signed],
  rankChange4w: ['4W rank change', rankDelta], rankChange12w: ['12W rank change', rankDelta], topDecile: ['Top decile', percent],
  above50: ['Above 50D', percent], above200: ['Above 200D', percent], breadthChange: ['4W breadth Δ', signed],
  equalWeight: ['1M equal weight', rate], relativeReturn: ['1M vs benchmark', rate], parentRelativeRS: ['Median RS vs parent', signed],
  upDownDollar: ['U/D dollar volume', ratio], newHighBreadth: ['New 52W highs', percent],
  parentRelativeReturn: ['1M return vs parent', rate], emergingLeaderCount: ['Emerging leaders', count],
};
const groupChartMetrics = [['percentile','Group RS percentile',number], ['medianRS','Median constituent RS percentile',number],
  ['index','Equal-weight index',number],
  ['capWeightIndex','Cap-weight index',number], ['largestPositiveDollarShare','Largest-cap share of advancing dollar volume',rate],
  ['above50','Above 50D SMA',percent], ['above200','Above 200D SMA',percent], ['upDownDollar','U/D dollar volume',ratio],
  ['topDecile','Top decile',percent], ['emergingLeaderCount','Emerging leader count',count], ['rank','Group rank',count]];
const stockColumns = ['symbol','name','rsRank','rsPercentile','velocity4w','return_21d','udv_50d','industry'];
const historicalWidths = [...chartRanges, [2520,'10Y']];
const groupChartDomain = (metric) => metric === 'largestPositiveDollarShare' ? [0, 1]
  : ['percentile', 'medianRS', 'above50', 'above200', 'topDecile'].includes(metric) ? [0, 100] : undefined;
const rotationFields = {
  percentile: ['Group RS percentile', (value) => number(value, 0), [0, 100]],
  medianRS: ['Median constituent RS', (value) => number(value, 0), [0, 100]],
  velocity4w: ['4W RS velocity (pts)', signed],
  velocity12w: ['12W RS velocity (pts)', signed],
  rankChange4w: groupMetrics.rankChange4w,
  rankChange12w: groupMetrics.rankChange12w,
  breadthChange: ['4W breadth change', signed],
  above50: ['Above 50D SMA', (value) => percent(value, 0), [0, 100]],
  topDecile: ['Top-decile participation', (value) => percent(value, 0), [0, 100]],
  relativeReturn: ['1M vs benchmark', (value) => rate(value, 1)],
  parentRelativeRS: groupMetrics.parentRelativeRS,
  parentRelativeReturn: groupMetrics.parentRelativeReturn,
};
const parentMetrics = ['parentRelativeRS', 'parentRelativeReturn'];
const directionMetrics = new Set(['velocity4w', 'velocity12w', 'rankChange4w', 'rankChange12w', 'breadthChange',
  'equalWeight', 'relativeReturn', ...parentMetrics]);
function groupTable(groups, sort, selected, level, membership) {
  const visible = ['rank','medianRS','rankChange4w','rankChange12w','velocity4w','velocity12w','topDecile','above50','above200',
    'breadthChange','equalWeight','relativeReturn', ...(['industry','subindustry'].includes(level) ? parentMetrics : []), 'upDownDollar'];
  const label = (key) => {
    const original = groupMetrics[key][0];
    if (membership.basis !== 'current') return original;
    if (key === 'rank' || key === 'medianRS') return `${original} (session)`;
    return membershipWindow(key) ? original.replace('W ', 'W paired ') : original;
  };
  const cell = (group, key) => {
    const value = groupMembershipValue(group, key, membership.basis);
    const window = membershipWindow(key);
    const info = groupMembershipDetail(group, window, membership) || (window && !numeric(value) ? groupMembershipUnavailable(membership, window) : '');
    const text = groupMetrics[key][1](value);
    return `<td class="numeric ${directionMetrics.has(key) ? direction(value) : ''}">${info ?
      `<span title="${safe(info)}" aria-label="${safe(`${numeric(value) ? text : 'Unavailable'} · ${info}`)}">${safe(text)}</span>` : safe(text)}</td>`;
  };
  return `<div class="table-scroll" tabindex="0" role="region" aria-label="${safe(level)} rankings"><table><thead><tr>
    <th scope="col">Compare</th><th scope="col">Group</th><th scope="col">Members</th>
    ${visible.map((key) => `<th scope="col"${sort.key === key ? attr('aria-sort', sort.direction === 1 ? 'ascending' : 'descending') : ''}>
      <button type="button" class="table-sort" data-action="group-sort" data-value="${key}">${safe(label(key))}${sort.key === key ? icon(sort.direction === 1 ? 'up' : 'down') : ''}</button></th>`).join('')}</tr></thead><tbody>
    ${groups.map((group) => `<tr><td><input type="checkbox" data-change="group-compare" value="${safe(group.id)}" aria-label="Compare ${safe(group.name)}" ${selected.has(group.id) ? 'checked' : ''}></td>
      <td><button type="button" class="stock-link" data-action="industry" data-value="${safe(group.id)}">${safe(group.name)}</button></td><td class="numeric">${count(group.count)}</td>
      ${visible.map((key) => cell(group, key)).join('')}</tr>`).join('')}
    </tbody></table></div>`;
}

function rotationPlot(groups, settings, { leadership = false, membership } = {}) {
  const { rotationX: xKey, rotation: yKey, rotationColor: colorKey, rotationSize: sizeKey } = settings;
  const comparisonMetric = [yKey, xKey].find(membershipWindow);
  const value = (group, key) => groupMembershipValue(group, key, membership.basis, comparisonMetric);
  const rows = groups.filter((group) => numeric(value(group, xKey)) && numeric(value(group, yKey)));
  if (!rows.length) return empty('No comparable rotation observations', comparisonMetric ? groupMembershipUnavailable(membership, membershipWindow(comparisonMetric)) :
    'Choose axes with group values in the selected session.', 'industries');
  const domain = (key) => {
    const fixed = rotationFields[key][2];
    const values = rows.map((row) => value(row, key));
    if (fixed) return axisDomain(values, fixed, settings.rotationScale === 'focus');
    const bound = Math.max(['relativeReturn', 'parentRelativeReturn'].includes(key) ? 0.01 : 1, ...values.map(Math.abs));
    return [-bound, bound];
  };
  const [xMin,xMax] = domain(xKey);
  const [yMin,yMax] = domain(yKey);
  const px = (value) => 49 + (value - xMin) * 510 / (xMax - xMin);
  const py = (value) => 181 - (value - yMin) * 159 / (yMax - yMin);
  const dataTicks = (min,max) => Array.from({ length: 5 }, (_, index) => min + index * (max - min) / 4);
  const maxSize = Math.max(1,...rows.map((row) => row[sizeKey] || 0));
  const label = (key) => {
    const original = rotationFields[key][0];
    if (membership.basis !== 'current') return original;
    if (key === 'percentile') return comparisonMetric ? `${membershipWindow(comparisonMetric).toUpperCase()} matched-peer RS percentile` : 'Session group RS percentile';
    if (key === 'medianRS') return 'Session median constituent RS';
    return membershipWindow(key) ? original.replace('W ', 'W paired ') : original;
  };
  const format = (key,value) => rotationFields[key][1](value);
  const tickFormat = (key, bounds) => settings.rotationScale === 'focus' && rotationFields[key][2]
    ? focusedTickFormat(rotationFields[key][1], bounds) : rotationFields[key][1];
  const xTicks = tickFormat(xKey, [xMin, xMax]);
  const yTicks = tickFormat(yKey, [yMin, yMax]);
  const colorBound = Math.max(0.01, ...rows.map((row) => Math.abs(value(row, colorKey) || 0)));
  const sizeLabel = sizeKey === 'count' ? 'eligible constituents' : 'market cap';
  return `<div class="rotation-layout"><svg class="rotation-chart" viewBox="0 0 600 218" role="img" aria-label="${safe(`${label(xKey)} versus ${label(yKey)}`)}">
    <g fill="#a4b3bb" font-size="10" font-family="monospace">
    ${dataTicks(xMin,xMax).map((x) => `<line x1="${px(x)}" y1="17" x2="${px(x)}" y2="181" stroke="#29383f" stroke-dasharray="3 4"/>
      <text x="${px(x)}" y="196" text-anchor="middle">${safe(xTicks(x))}</text>`).join('')}
    ${dataTicks(yMin,yMax).map((y) => `<line x1="49" y1="${py(y)}" x2="559" y2="${py(y)}" stroke="#3d4d56" stroke-dasharray="3 4"/>
      <text x="43" y="${py(y)+3}" text-anchor="end">${safe(yTicks(y))}</text>`).join('')}
    ${leadership ? `<line x1="${px(50)}" y1="17" x2="${px(50)}" y2="181" stroke="#70808a"/>
      <line x1="49" y1="${py(0)}" x2="559" y2="${py(0)}" stroke="#70808a"/>` : ''}
    <text x="304" y="212" text-anchor="middle">${safe(label(xKey))}</text></g>
    ${rows.toSorted((a,b) => (b[sizeKey] || 0) - (a[sizeKey] || 0)).map((row) => {
      const colorValue = value(row, colorKey);
      const cap = row[sizeKey];
      const radius = 3 + (numeric(cap) ? 14 * Math.sqrt(cap / maxSize) : 0);
      const fill = colorValue > 0 ? '#76e2a7' : colorValue < 0 ? '#ff8c94' : '#84a9fa';
      const opacity = numeric(colorValue) ? .52 + .4 * Math.abs(colorValue) / colorBound : .35;
      const details = [...new Set([yKey, xKey, colorKey].map(membershipWindow).filter(Boolean))].map((window) => groupMembershipDetail(row, window, membership));
      const title = [row.name, `${label(xKey)} ${format(xKey,value(row,xKey))}`, `${label(yKey)} ${format(yKey,value(row,yKey))}`,
        `${sizeKey === 'count' ? count(cap) : compact(cap,true)} ${sizeLabel}`, ...details].filter(Boolean).join(' · ');
      return `<a href="#industry-detail" data-action="industry" data-value="${safe(row.id)}" aria-label="${safe(title)}">
        <circle cx="${px(value(row,xKey))}" cy="${py(value(row,yKey))}" r="${radius}" fill="${fill}" opacity="${opacity}"/><title>${safe(title)}</title></a>`;
    }).join('')}</svg><p class="muted">Bubble area reflects ${sizeLabel}. Color shows ${safe(label(colorKey).toLowerCase())}.</p></div>`;
}

function leadershipMap(groups, state, membership) {
  const { points, plotted, omitted, velocity, quadrants } = buildLeadershipMap(groups, { level: state.level, velocity: state.leadershipVelocity, membership });
  const summary = [['RS ≥ 50, rising', quadrants.higherRSRising], ['RS ≥ 50, falling', quadrants.higherRSFalling],
    ['RS < 50, rising', quadrants.lowerRSRising], ['RS < 50, falling', quadrants.lowerRSFalling], ['Unchanged', quadrants.flat]];
  return `<div class="inline-form">${segment('leadership-window', leadershipWindows, velocity)}</div>
    <p class="muted section-space">${membership.basis === 'current' ? 'Each bubble shows the current matched-peer percentile and its change in points over the selected window.' : 'Vertical axis measures change in the group’s RS percentile in points.'} ${count(plotted)} groups plotted${omitted ? ` · ${count(omitted)} lack a comparable RS percentile or velocity` : ''}.</p>
    ${plotted ? `${rotationPlot(points, { rotationX: 'percentile', rotation: velocity, rotationColor: velocity, rotationSize: 'count', rotationScale: 'full' }, { leadership: true, membership })}
      <div class="inline-stack" aria-label="Leadership map categories">${summary.map(([label, value]) => chip(`${label} · ${count(value)}`)).join('')}</div>`
    : empty('RS velocity unavailable', groupMembershipUnavailable(membership, membershipWindow(velocity)), 'industries')}`;
}

function themeEditor(env, existing = null) {
  const members = existing?.definition.members || [];
  const target = env.showDialog(env.modal, existing ? 'Edit theme' : 'Create a theme', `<form class="stack">
    ${field('Theme name', `<input name="name" required maxlength="100" value="${safe(existing?.name || '')}" placeholder="AI infrastructure">`)}
    ${field('Members', `<input name="symbols" required value="${safe(members.map((row) => row.securityId).join(', '))}" placeholder="AAPL, MSFT, …">`, 'Enter tickers or saved security IDs separated by commas.')}
    <div class="form-grid">
      ${field('Effective from', `<input type="date" name="from" required min="1900-01-01" value="${safe(members[0]?.effectiveFrom || env.context.date || env.config.status.latestDate || '')}">`)}
      ${field('Effective through', `<input type="date" name="to" value="${safe(members[0]?.effectiveTo || '')}">`)}
    </div>
    <p class="muted">Themes use dated membership. A new membership appears only after its effective and recorded dates.</p>
    <div class="form-error" role="alert" hidden></div><div><button type="submit" class="button primary">Save theme</button></div></form>`);
  target.onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const raw = String(form.get('symbols')).split(',').map((item) => item.trim()).filter(Boolean);
    const previous = new Set(members.map((row) => row.securityId));
    const end = form.get('to') || null;
    const start = form.get('from');
    try {
      const ids = await Promise.all([...new Set(raw)].map(async (symbol) =>
        previous.has(symbol) ? symbol : (await env.api(`stocks/${pathPart(symbol)}/metrics`)).securityId));
      await env.api(existing ? `themes/${pathPart(existing.id)}` : 'themes', { method: existing ? 'PUT' : 'POST',
        body: { name: form.get('name'), definition: { members: ids.map((securityId) => ({ securityId, effectiveFrom: start, effectiveTo: end })) } } });
      env.modal.close();
      env.toast('Theme saved');
      env.state.level = 'theme';
      env.render();
    } catch (error) {
      const output = target.querySelector('.form-error');
      output.hidden = false;
      output.textContent = error.message;
    }
  };
}

async function renderIndustries(env) {
  const { main, state, signal } = env;
  state.level = env.params.level || state.level || 'industry';
  state.sort ||= { key: 'rank', direction: 1 };
  state.compare ||= new Set();
  state.chartMetric ||= 'medianRS';
  state.chartCadence ||= 'daily';
  state.limit ||= 63;
  state.rotation ||= 'velocity4w';
  state.rotationX ||= 'percentile';
  state.rotationColor ||= 'breadthChange';
  state.rotationSize ||= 'count';
  state.rotationScale ||= 'full';
  state.groupView = groupViews.some(([key]) => key === env.params.groupView) ? env.params.groupView : state.groupView || 'heatmap';
  state.heatmapMetric ||= 'medianRS';
  state.leadershipVelocity ||= 'velocity4w';
  const [data, themes] = await Promise.all([env.api('industries', { signal }), env.api('themes', { signal, plain: true })]);
  if (!env.isActive()) return;
  loadGroupMembershipStyles(main.ownerDocument);
  let selection = env.params.membership;
  let groupPanel;
  let memberRun = 0;
  let compareRun = 0;
  const byId = new Map(data.groups.map((group) => [group.id, group]));

  const membershipView = () => groupMembershipView(data, { level: state.level, selection, classification: env.context.classification });

  function visibleGroups(membership) {
    return data.groups.filter((group) => group.level === state.level && (!state.emergingOnly || group.emerging === true)).toSorted((a, b) => {
      const left = groupMembershipValue(a, state.sort.key, membership.basis);
      const right = groupMembershipValue(b, state.sort.key, membership.basis);
      return left == null ? right == null ? a.name.localeCompare(b.name) : 1
        : right == null ? -1 : state.sort.direction * (left - right) || a.name.localeCompare(b.name);
    });
  }
  function draw({ preserveComparison = false } = {}) {
    const existingComparison = preserveComparison ? main.querySelector('#industry-chart') : null;
    const membership = membershipView();
    const groups = visibleGroups(membership);
    const hasParent = ['industry','subindustry'].includes(state.level);
    const rotationChoices = Object.entries(rotationFields).filter(([key]) => hasParent || !parentMetrics.includes(key));
    const rotationSettings = { ...state,
      rotationX: !hasParent && parentMetrics.includes(state.rotationX) ? 'percentile' : state.rotationX,
      rotation: !hasParent && parentMetrics.includes(state.rotation) ? 'velocity4w' : state.rotation };
    const preferred = env.context.date ? ['sec-sic', 'nasdaq'] : ['nasdaq', 'sec-sic'];
    const alternative = preferred.find((system) => system !== env.context.classification && env.config.classificationSystems?.includes(system));
    const sourceName = { nasdaq: 'Nasdaq', 'sec-sic': 'SEC filing taxonomy' };
    const referenceNote = membership.basis === 'dated' && data.referenceMode === 'latest' && data.referenceDate ? ` · Industry directory through ${dateLabel(data.referenceDate)}` : '';
    const ranked = data.groups.filter((group) => group.level === state.level && numeric(group.rank));
    const [ready4w, ready12w] = membershipWindows.map((window) => ranked.filter((group) => numeric(groupMembershipValue(group, `velocity${window}`, membership.basis))).length);
    const source = data.classificationSystem || env.context.classification;
    const missingNasdaqHistory = membership.basis === 'dated' && source === 'nasdaq' && state.level !== 'theme' && ranked.length > 0 && !ready4w && !ready12w;
    const filingDatedLink = missingNasdaqHistory && env.config.classificationSystems?.includes('sec-sic')
      ? `<a class="text-link" href="${safe(env.routeUrl('industries', { ...env.snapshotContext, date: data.date,
        classification: 'sec-sic', reference: 'as-of', level: state.level, groupView: state.groupView }))}">View filing-dated SEC groups ${icon('chevron-right')}</a>` : '';
    const rotationNote = missingNasdaqHistory ? `<div class="inline-stack"><p class="muted">Dated Nasdaq ranks are unavailable for the 4W and 12W comparison sessions.</p>${filingDatedLink}</div>`
      : ranked.length && (membership.basis === 'current' || source === 'sec-sic') ? `<p class="muted">Velocity available for ${count(ready4w)} of ${count(ranked.length)} ranked groups over 4 weeks and ${count(ready12w)} over 12 weeks.</p>` : '';
    main.innerHTML = heading('Industries', 'Compare group leadership, participation, and rotation.', action('Create theme', 'create-theme', 'plus', { className: 'primary' })) +
      partialCoverage(data.coverage, env.routeUrl) +
      segment('industry-level', groupLevels, state.level, 'tabs') +
      `<div class="stack"><section class="panel panel-body">${panelHead('Group rankings', `${count(groups.length)} groups · ${dateLabel(data.date)}${referenceNote}`,
        `<label class="checkbox-label"><input type="checkbox" data-change="group-emerging"${state.emergingOnly?' checked':''}> Emerging groups</label>
        ${groups.length ? iconButton('Export group rankings CSV', 'export-group-rankings', 'download') : ''}`)}
        ${segment('group-view', groupViews, state.groupView)}
        ${renderGroupMembership(membership, { action: 'group-membership', helpId: 'industry-membership-help' })}
        ${rotationNote}
        <div class="section-space">${groups.length && state.groupView === 'heatmap' ? `
          <div class="inline-form">${field('Heatmap metric', `<select data-change="group-heatmap-metric">${groupHeatmapMetrics.map(([key, label]) => option(key, label, state.heatmapMetric)).join('')}</select>`)}</div>
          ${renderGroupHeatmap(groups, { level: state.level, metric: state.heatmapMetric, date: data.date, action: 'industry', membership })}`
          : groups.length && state.groupView === 'velocity' ? leadershipMap(groups, state, membership)
          : groups.length ? groupTable(groups, state.sort, state.compare, state.level, membership) : empty('No groups in this context',
          state.level === 'theme' ? 'Create a theme or select a session with existing dated theme membership.' : 'The selected classification has no eligible groups for this price session.',
          'industries', alternative ? action(`Use ${sourceName[alternative]}`, 'use-industry-source', 'layers', {value:alternative}) : '')}</div>
        </section>
      ${state.level === 'theme' && themes.length ? `<section class="panel panel-body">${panelHead('Saved themes', 'Dated membership definitions')}${themes.map((theme) => `<div class="simple-row"><div><strong>${safe(theme.name)}</strong>
        <span class="muted"> · ${count(theme.definition?.members?.length)} saved members</span></div><div class="actions">${action('Edit','edit-theme','edit',{ value: theme.id })}
        ${action('Delete','delete-theme','trash',{ value: theme.id, className: 'danger' })}</div></div>`).join('')}</section>` : ''}
      ${groups.length && state.groupView === 'table' ? `<div class="split-grid">
        <section class="panel panel-body">${panelHead('Rotation map', 'Positive rank changes indicate an improved rank. Parent comparisons use the group’s sector or industry.')}
          <div class="inline-form rotation-controls">
          ${[['X axis', 'rotation-x', rotationSettings.rotationX], ['Y axis', 'rotation', rotationSettings.rotation]].map(([label,change,current]) =>
            field(label, `<select data-change="${change}">${rotationChoices.map(([key,[text]])=>option(key,text,current)).join('')}</select>`)).join('')}
          ${field('Color', `<select data-change="rotation-color">${['breadthChange','velocity4w','velocity12w','relativeReturn'].map((key)=>option(key,rotationFields[key][0],state.rotationColor)).join('')}</select>`)}
          ${field('Size', `<select data-change="rotation-size">${option('count','Constituents',state.rotationSize)}${option('marketCap','Market cap',state.rotationSize)}</select>`)}
          ${[rotationSettings.rotationX, rotationSettings.rotation].some((key) => rotationFields[key][2])
            ? segment('rotation-scale', [['full', 'Full scale'], ['focus', 'Focus range']], state.rotationScale) : ''}
          </div>${rotationPlot(groups, rotationSettings, { membership })}</section>
        <section class="panel panel-body">${panelHead('Group comparison', 'Dated membership history · Select up to eight groups from the table.', iconButton('Export group comparison CSV','export-chart','download','industry-comparison.csv'))}
          <div class="inline-form">
          ${field('Metric', `<select data-change="group-chart">${groupChartMetrics.map(([id,label])=>option(id,label,state.chartMetric)).join('')}</select>`)}
          ${field('Second metric', `<select data-change="group-secondary"${state.compare.size!==1?' disabled':''}>${option('','No comparison',state.chartSecondary||'')}
            ${groupChartMetrics.map(([id,label])=>option(id,label,state.chartSecondary)).join('')}</select>`,'Select one group to compare its metrics.')}
          ${field('Sampling', `<select data-change="group-cadence">${option('daily','Daily',state.chartCadence)}${option('weekly','Weekly',state.chartCadence)}</select>`)}
          ${rangeSegment('group-range',state.limit)}</div>
          <div id="industry-chart" class="section-space"></div></section>
        </div>` : ''}</div>`;
    bindHelpTooltips(main);
    if (existingComparison) main.querySelector('#industry-chart')?.replaceWith(existingComparison);
    else if (groups.length && state.groupView === 'table') loadComparison();
  }

  async function loadComparison() {
    const target = main.querySelector('#industry-chart');
    if (!target) return;
    const ids = [...state.compare].filter((id) => byId.has(id));
    if (!ids.length) {
      target.innerHTML = empty('No groups selected', 'Use the comparison checkboxes to add time series.', 'chart');
      return;
    }
    const run = ++compareRun;
    target.innerHTML = pending();
    try {
      const result = await env.publishedSeries('industries/compare', { signal,
        params: { ids: ids.join(','), limit: rangeLimit(state.limit, state.chartCadence), cadence: state.chartCadence } }, (partial, job) => {
        if (target.isConnected && run === compareRun) target.innerHTML = publishingHistory(job);
      });
      if (run !== compareRun || !target.isConnected) return;
      const selectedMetrics = [state.chartMetric, ...(ids.length===1 && state.chartSecondary && state.chartSecondary!==state.chartMetric ? [state.chartSecondary] : [])];
      const labels = ids.flatMap((id, index) => selectedMetrics.map((metric, axis) => {
        const [,label,format] = groupChartMetrics.find(([key])=>key===metric);
        return { key: `${id}:${metric}`, label: `${byId.get(id).name} · ${label}`,
          axis: axis===1?'right':'left', color: chartColors[index+axis], format, value: (row) => row.groups.find((group) => group.id === id)?.[metric] };
      }));
      target.innerHTML = chart(result.rows, labels, { fill: ids.length === 1, axisFormat:labels[0]?.format, rightAxisFormat:labels[1]?.format,
        domain: groupChartDomain(selectedMetrics[0]), rightDomain: groupChartDomain(selectedMetrics[1]) });
    } catch (error) {
      if (target.isConnected && error.name !== 'AbortError') target.innerHTML = notice('Group comparison unavailable', error.message, '', true);
    }
  }

  async function loadMembers() {
    const { group, page, target, membership } = groupPanel;
    const run = ++memberRun;
    target.innerHTML = pending();
    try {
      const params = { date: data.date };
      const [detail, members] = await Promise.all([
        env.api(`industries/${pathPart(group.id)}`, { signal, params }),
        env.api(`industries/${pathPart(group.id)}/members`, { signal, params: { ...params, page, perPage: 30 } }),
      ]);
      if (run !== memberRun || !target.isConnected) return;
      target.innerHTML = `<div class="summary-grid three">${summary('Constituents', count(detail.count), `${count(detail.rankedCount)} ranked`)}
      ${summary('Median RS', number(detail.medianRS), `Rank ${count(detail.rank)}`)}
      ${summary('Above 50D SMA', percent(detail.above50), `${count(detail.counts?.above50?.numerator)} / ${count(detail.counts?.above50?.denominator)} comparable`)}
      </div>${renderGroupMembershipDetail({ ...detail, currentMembership: detail.currentMembership ?? group.currentMembership }, membership)}
      ${table(members.rows, stockColumns)}${pagination(members,'group-page')}`;
    } catch (error) {
      if (target.isConnected) target.innerHTML = notice('Group constituents unavailable', error.message, '', true);
    }
  }

  function openGroup(id) {
    const group = byId.get(id);
    if (!group) return;
    groupPanel = { group, page: 1, membership: membershipView(), target: env.showDialog(env.detail, group.name, pending(), `${group.level} · ${dateLabel(data.date)}`) };
    return loadMembers();
  }
  env.setActions({
    'industry-level'(value) {
      state.level = value;
      if (!['industry','subindustry'].includes(value) && parentMetrics.includes(state.sort.key)) state.sort = { key: 'rank', direction: 1 };
      draw();
    },
    'group-sort'(key) { state.sort = { key, direction: state.sort.key === key ? -state.sort.direction : key === 'rank' ? 1 : -1 }; draw(); },
    'group-view'(value) { state.groupView = value; draw(); },
    'group-membership'(value) {
      if (value !== 'dated' && value !== 'current') return;
      selection = value;
      env.replaceParams?.({ membership: value });
      draw({ preserveComparison: true });
      main.querySelector('[data-action="group-membership"][aria-pressed="true"]')?.focus();
    },
    'export-group-rankings'() {
      const membership = membershipView();
      const groups = visibleGroups(membership);
      if (!groups.length) return;
      const columns = ['id', 'name', 'level', 'count', 'rankedCount', 'percentile', ...Object.keys(groupMetrics)];
      const exportRows = groups.map((group) => ({ ...Object.fromEntries(columns.map((key) => [key, group[key]])),
        ...groupMembershipExport(group, membership, data, env.snapshotContext) }));
      csvDownload(exportRows, Object.keys(exportRows[0]), 'industry-rankings.csv');
    },
    'change:group-heatmap-metric'(value) { state.heatmapMetric = value; draw(); },
    'leadership-window'(value) { state.leadershipVelocity = value; draw(); },
    'change:group-compare'(id, input) {
      if (input.checked && state.compare.size >= 8) { input.checked = false; env.toast('Compare up to eight groups.'); return; }
      if (input.checked) state.compare.add(id);
      else state.compare.delete(id);
      const secondary = main.querySelector('[data-change="group-secondary"]');
      if (secondary) secondary.disabled = state.compare.size !== 1;
      loadComparison();
    },
    'use-industry-source'(value) { return env.go('industries', { classification:value, reference:env.context.date || value === 'sec-sic' ? 'as-of' : 'latest' }); },
    'change:rotation'(value) { state.rotation = value; draw(); },
    'change:rotation-x'(value) { state.rotationX = value; draw(); },
    'change:rotation-color'(value) { state.rotationColor = value; draw(); },
    'change:rotation-size'(value) { state.rotationSize = value; draw(); },
    'rotation-scale'(value) { state.rotationScale = value; draw(); },
    'change:group-chart'(key) { state.chartMetric = key; loadComparison(); },
    'change:group-secondary'(key) { state.chartSecondary = key; loadComparison(); },
    'change:group-cadence'(value) { state.chartCadence = value; loadComparison(); },
    'change:group-emerging'(value,input) { state.emergingOnly = input.checked; draw(); },
    'group-range'(value) { state.limit = Number(value); draw(); },
    industry(id, button, event) { event.preventDefault(); return openGroup(id); },
    'group-page'(page) { groupPanel.page = Number(page); return loadMembers(); },
    'create-theme': () => themeEditor(env),
    'edit-theme': (id) => themeEditor(env, themes.find((item) => item.id === id)),
    async 'delete-theme'(id) {
      const theme = themes.find((item) => item.id === id);
      if (!theme || !window.confirm(`Delete theme “${theme.name}”?`)) return;
      await env.api(`themes/${pathPart(id)}`, { method: 'DELETE' });
      env.toast('Theme deleted');
      env.render();
    },
  });
  draw();
  if (env.params.group) openGroup(env.params.group);
}

const leadershipMetrics = [
  ['leadershipPersistence','Top-decile leadership persistence'], ['leadershipTurnover','Top-decile leadership turnover'],
];
const leadershipMetricKeys = new Set(leadershipMetrics.map(([key]) => key));
const historyMetrics = [
  ['benchmarkClose','Benchmark close'], ['equalWeightIndex','Equal-weight index'], ['capWeightIndex','Cap-weight index'],
  ['largestPositiveDollarShare','Largest-cap share of advancing dollar volume'], ['advanceDeclineLine','Cumulative A/D (rebased to zero)'],
  ['adSpread','A/D spread'], ['above_50d','Above 50D SMA'], ['above_200d','Above 200D SMA'],
  ['up_4pct','Up ≥ 4%'], ['down_4pct','Down ≥ 4%'], ...leadershipMetrics,
];
const eventOps = [['crossesAbove','Crosses above'], ['crossesBelow','Crosses below'], ['gt','Greater than'], ['gte','At least'], ['lt','Less than'], ['lte','At most']];
const horizonsInput = '<input name="horizons" required value="5, 10, 20, 60">';
function horizons(value) {
  const windows = String(value).split(',').map((item) => Number(item.trim()));
  if (!windows.length || !windows.every((n) => Number.isInteger(n) && n > 0 && n <= 5040)) throw new Error('Enter positive trading-session counts separated by commas.');
  return [...new Set(windows)];
}

async function waitForJob(env, job, target) {
  let current = job;
  while (['queued','running'].includes(current.status)) {
    if (!target.isConnected || !env.isActive()) return null;
    target.innerHTML = `<div class="pending" role="status">Research job ${safe(current.status)} · ${count(current.progress)}%</div>`;
    await new Promise((resolve) => setTimeout(resolve, 650));
    if (!target.isConnected || !env.isActive()) return null;
    current = await env.api(`jobs/${pathPart(current.id)}`, { signal: env.signal, plain: true });
  }
  if (current.status === 'failed') throw new Error(current.error || 'Research calculation failed.');
  return current.result;
}

function outcomeData(results, kind) {
  return results.flatMap((result) => {
    const series = kind === 'cohort' ? [['Cohort', result.summary]] : [...Object.entries(result.benchmarks || {}), ['Median stock', result.medianStock]];
    return series.map(([name, stats]) => ({ name, stats, horizon:result.horizon, suppressed:result.suppressedCount }));
  });
}

function outcomeRows(results, kind) {
  return outcomeData(results, kind).map(({ name, stats, horizon, suppressed }) => `<tr>
    <td>${count(horizon)}D</td><td>${safe(name)}</td><td class="numeric">${count(stats?.count)} / ${count(stats?.observations)}</td>
    ${kind === 'event' ? `<td class="numeric">${count(suppressed)}</td>` : ''}
    <td class="numeric ${direction(stats?.mean)}">${percent(stats?.mean,2,true)}</td><td class="numeric ${direction(stats?.median)}">${percent(stats?.median,2,true)}</td>
    <td class="numeric">${percent(stats?.winRate,1)}</td><td class="numeric">${percent(stats?.maximumAdverseExcursion,2,true)}</td>
    <td class="numeric">${percent(stats?.maximumDrawdown,2,true)}</td></tr>`).join('');
}

function distributionPlot(stats, label) {
  const values = stats.distribution.values;
  const min = stats.distribution.min;
  const max = stats.distribution.max;
  const binWidth = max === min ? 1 : (max - min) / 10;
  const buckets = Array.from({ length: 10 }, (_, index) => ({ from: min + binWidth*index, to: min + binWidth*(index+1), count:0 }));
  for (const value of values) buckets[Math.min(9, Math.floor((value-min)/binWidth))].count++;
  const visible = min === max ? buckets.slice(0,1) : buckets;
  const highest = Math.max(1,...visible.map((bin) => bin.count));
  const items = visible.map((bin) => {
    const binLabel = `${percent(bin.from,1,true)} to ${percent(bin.to,1,true)} · ${count(bin.count)} returns`;
    return `<div class="histogram-bin" title="${safe(binLabel)}" aria-label="${safe(binLabel)}"><i class="${direction(bin.from + bin.to)}"
      style="--histogram-height:${bin.count / highest * 100}%"></i></div>`;
  }).join('');
  const quartiles = [['10th',stats.distribution.p10],['25th',stats.distribution.p25],['Median',stats.distribution.p50],
    ['75th',stats.distribution.p75],['90th',stats.distribution.p90]];
  return `<div class="histogram" role="img" aria-label="${safe(label)} histogram of ${count(values.length)} forward returns">${items}</div>
    <div class="histogram-range muted mono"><span>${percent(min,1,true)}</span><span>${percent(max,1,true)}</span></div>
    <div class="inline-stack">${quartiles.map(([name,value])=>chip(`${name} · ${percent(value,2,true)}`)).join('')}
    ${chip(`Observable returns · ${rate(stats.returnCoverage,1,false)}`)}
    ${stats.knownDelistings ? chip(`${count(stats.knownDelistings)} known delistings`,'warning') : ''}
    ${stats.counts?.rightCensored ? chip(`${count(stats.counts.rightCensored)} incomplete forward windows`,'warning') : ''}</div>`;
}

function distributions(result, kind) {
  const available = outcomeData(result.results || [], kind).filter(({stats}) => stats?.distribution?.values?.length);
  if (!available.length) return '';
  return `<section class="section-space">${panelHead('Forward return distributions','Explore the observations underlying the summary.',
    action('Export observations','export-research-returns','download',{value:kind}))}
    <div class="distribution-list">${available.map(({name,stats,horizon},index) => {
      const label = `${count(horizon)}D · ${name}`;
      return `<details class="formula-help distribution-item"${index ? '' : ' open'}><summary>${safe(label)} · ${count(stats.count)} returns</summary>
        ${distributionPlot(stats,label)}</details>`;
    }).join('')}</div></section>`;
}

function outcomePanel(result, kind) {
  const events = kind === 'event';
  const amount = events ? result.eventCount : result.memberCount;
  const countLabel = events ? 'Matched sessions' : 'Cohort members';
  const stats = events ? [['Matched sessions',count(amount)], ['Evaluated sessions',count(result.evaluatedCount)],
    ['Unavailable sessions',count(result.unknownCount)]] : [[countLabel,count(amount)],['Excluded members',count(result.excludedCount)],['Entry date',dateLabel(result.date)]];
  const observations = outcomeData(result.results || [],kind);
  const missingEntry = observations.some(({stats}) => stats?.counts?.missingEntry > 0);
  return `<section class="panel panel-body"><div class="summary-grid three">${stats.map(([key,value])=>summary(key,value,`Through ${dateLabel(result.asOf)}`)).join('')}</div>
    ${result.descriptive ? notice('Observed universe · descriptive',
      `${observedCoverageSummary(result)} ${result.coverageWarning || ''}`) : ''}
    ${events && !amount && result.unknownCount ? notice('No comparable event observations', result.descriptive
      ? 'The observed universe did not meet the comparable coverage required for this rule.'
      : 'Verified tests require reconciled breadth coverage. You can select Observed universe for descriptive research.') : ''}
    ${missingEntry ? notice('Some entry prices are unavailable', 'Forward returns require entry prices available under the selected data basis.') : ''}
    <div class="table-scroll" tabindex="0" role="region" aria-label="Forward return statistics"><table><thead><tr><th>Horizon</th><th>Series</th>
    <th>Returns / observations</th>${events ? '<th>Overlaps omitted</th>' : ''}<th>Mean return</th><th>Median return</th><th>Win rate</th><th>Max adverse excursion</th><th>Max drawdown</th></tr></thead><tbody>
      ${outcomeRows(result.results || [], kind)}</tbody></table></div>
    ${distributions(result,kind)}
    ${events && result.events?.length ? `<details class="formula-help section-space"><summary>Matching dates (${count(result.events.length)})</summary>
    <div class="inline-stack section-space">${result.events.slice(0,150).map((event)=>chip(`${dateLabel(event.date)} · ${percent(event.value)}`)).join('')}</div></details>` : ''}
    ${!events && result.industries?.length ? `<div class="inline-stack section-space">${result.industries.map((group)=>chip(`${group.industry || 'Unclassified'} · ${count(group.count)}`)).join('')}</div>` : ''}
    <p class="muted section-space">Historical results describe the selected observations. Unavailable forward returns are excluded and shown in the observation counts.</p></section>`;
}

async function renderHistory(env) {
  const { main, state, config, context, signal } = env;
  state.tab ||= 'series';
  state.primary ||= 'above_50d';
  state.secondary ??= 'benchmarkClose';
  state.limit ||= 63;
  state.cadence ||= 'daily';
  state.transform ||= 'values';
  state.smoothing ||= 0;
  state.archive ??= false;
  const [snapshot, cohorts] = await Promise.all([
    env.api('market/breadth', { signal }), env.api('cohorts',{ plain:true, signal }),
  ]);
  if (!env.isActive()) return;
  let historyRun = 0;
  const last = snapshot.date || config.status.latestDate;
  const first = config.status.earliestDate || shiftDate(last, -95);
  const metricLabels = new Map([...historyMetrics, ...(config.breadthMetrics || []).map(({key,label})=>[key,label])]);
  const metricOptions = (which, selected, chart = true) => `${which ? option('','No comparison',selected) : ''}${[...metricLabels]
    .filter(([key]) => chart || !leadershipMetricKeys.has(key)).map(([key,label])=>option(key,label,selected)).join('')}`;
  const rangeStart = (days) => [first, shiftDate(last, -days)].sort().at(-1) || first;
  const anchor = (page) => `<a class="button" href="${safe(env.routeUrl(page, { date:last, dataVersion:env.snapshotContext.dataVersion }))}">${icon(page)} ${safe({ overview:'Market overview', screener:'Stock screener', rankings:'RS rankings', industries:'Industry rotation' }[page])}</a>`;

  function historyForm() {
    return `<section class="panel panel-body">${panelHead('Compare historical series', `Replay endpoint · ${dateLabel(last)}`, iconButton('Export selected series CSV','export-chart','download','historical-series.csv'))}
    <form class="inline-form" id="history-form">
      ${field('Primary series',`<select name="primary">${metricOptions(false,state.primary)}</select>`)}
      ${field('Comparison series',`<select name="secondary">${metricOptions(true,state.secondary)}</select>`)}
      ${field('From',`<input type="date" name="from" min="${safe(first)}" max="${safe(last)}" value="${safe(state.from || '')}">`)}
      ${field('To',`<input type="date" name="to" min="${safe(first)}" max="${safe(last)}" value="${safe(state.to || last)}">`)}
      ${field('Sampling',`<select name="cadence">${option('daily','Daily',state.cadence)}${option('weekly','Weekly',state.cadence)}</select>`)}
      ${field('Data source',`<select name="source">${option('recent','Recent calculated sessions',state.archive ? 'archive' : 'recent')}
        ${option('archive','Published archive',state.archive ? 'archive' : 'recent')}</select>`)}
      ${field('Scale',`<select name="transform">${option('values','Independent axes',state.transform)}${option('rebased','Rebase to 100',state.transform)}${option('normalized','Normalize 0–100',state.transform)}</select>`)}
      ${field('Smoothing',`<select name="smooth">${[0,5,10,20,50].map((n)=>option(n,n ? `${n}-point mean` : 'None',state.smoothing)).join('')}</select>`)}
      <button type="submit" class="button primary">Apply</button>
    </form><div class="actions section-space">${segment('history-range',historicalWidths,state.limit)}<span class="muted">Choose a chart point to replay that session.</span></div>
    <div id="history-chart" class="section-space">${pending()}</div></section>
    <section class="panel panel-body section-space">${panelHead('Replay this session', dateLabel(last))}<div class="actions">
      ${['overview','screener','rankings','industries'].map(anchor).join('')}</div></section>`;
  }
  function eventForm() {
    const shown = typeof state.eventForm === 'object' ? state.eventForm : {};
    return `<section class="panel panel-body">${panelHead('Breadth event study','Measure forward benchmark and constituent returns after a selected breadth condition.')}
      <form class="stack" id="event-form"><div class="form-grid">
      ${field('Breadth reading',`<select name="metric">${metricOptions(false,shown.metric || 'above_50d', false)}</select>`)}
      ${field('Event condition',`<select name="op">${eventOps.map(([id,label])=>option(id,label,shown.op || 'crossesAbove')).join('')}</select>`)}
      ${field('Threshold (%)',`<input name="threshold" type="number" step=".1" value="${safe(shown.threshold ?? 35)}" required>`)}
      ${field('Forward trading sessions',shown.horizons ? `<input name="horizons" value="${safe(shown.horizons)}" required>` : horizonsInput)}
      ${field('Start date',`<input name="start" type="date" min="${safe(first)}" max="${safe(last)}" value="${safe(shown.start || rangeStart(180))}" required>`)}
      ${field('Last event date',`<input name="end" type="date" min="${safe(first)}" max="${safe(last)}" value="${safe(shown.end || last)}" required>`)}
      ${field('Coverage basis',`<select name="coverageMode">${option('verified','Verified market coverage',shown.coverageMode||'verified')}
        ${option('observed','Observed universe (descriptive)',shown.coverageMode)}</select>`)}
      ${field('Overlap',`<select name="overlap">${option('perHorizon','Separate per horizon',shown.overlap || 'perHorizon')}${option('longest','Separate by longest horizon',shown.overlap)}${option('none','Allow overlapping windows',shown.overlap)}</select>`)}
      ${field('Benchmark tickers',`<input name="benchmarks" value="${safe(shown.benchmarks || context.benchmark)}" required>`)}</div>
      ${observedCoverageFields(shown)}
      <label class="checkbox-label"><input name="medianStocks" type="checkbox"${shown.medianStocks ? ' checked' : ''}> Include median stock returns</label>
      <details class="formula-help"><summary>Require a prior breadth condition</summary><div class="form-grid section-space">
        ${field('Prior reading below (%)','<input name="prior" type="number" step=".1" placeholder="Optional">')}
        ${field('Within trading sessions','<input name="lookback" type="number" min="1" value="20">')}</div></details>
      <div><button class="button primary" type="submit">${icon('chart')} Run study</button></div></form></section>
      <div id="research-results" class="section-space" aria-live="polite">${state.eventResult ? outcomePanel(state.eventResult,'event') : ''}</div>`;
  }
  function cohortForm() {
    return `<section class="panel panel-body">${panelHead('Historical cohort','Analyze subsequent performance for stocks matching a saved screen on its entry date.')}
      <form class="stack" id="cohort-form"><div class="form-grid">
        ${field('Cohort name','<input name="name" placeholder="Optional saved cohort" maxlength="100">')}
        ${field('Saved screen',`<select name="screen">${option('','All eligible stocks','')}${config.screens.map(({id,name})=>option(id,name,'')).join('')}</select>`)}
        ${field('Entry date',`<input name="date" type="date" min="${safe(first)}" max="${safe(last)}" value="${safe(context.date || rangeStart(90))}" required>`)}
        ${field('Observe through',`<input name="asOf" type="date" min="${safe(first)}" max="${safe(config.status.latestDate)}" value="${safe(last)}" required>`)}
        ${field('Forward trading sessions',horizonsInput)}
      </div><div><button class="button primary" type="submit">${icon('chart')} Run cohort</button></div></form></section>
      ${cohorts.length ? `<section class="panel panel-body section-space">${panelHead('Saved cohorts')}${cohorts.map((cohort)=>`<div class="simple-row"><div><strong>${safe(cohort.name)}</strong>
        <span class="muted"> · ${dateLabel(cohort.definition?.date)}</span></div>${action('Run','run-cohort','history',{value:cohort.id})}</div>`).join('')}</section>` : ''}
      <div id="research-results" class="section-space" aria-live="polite">${state.cohortResult ? outcomePanel(state.cohortResult,'cohort') : ''}</div>`;
  }
  function comparisonsForm() {
    return `<div class="stack"><section class="panel panel-body">${panelHead('Historical market analogs',
      'Compare the selected session’s breadth profile with similar earlier observations.')}
      <form id="analog-form" class="inline-form">
        ${field('Coverage basis',`<select name="coverageMode">${option('verified','Verified market coverage',state.analogCoverage?.coverageMode || 'verified')}
          ${option('observed','Observed universe (descriptive)',state.analogCoverage?.coverageMode)}</select>`)}
        ${observedCoverageFields(state.analogCoverage)}
        ${field('Forward sessions',`<input name="horizon" type="number" min="1" max="126" required value="${state.analogHorizon || 20}">`)}
        <button type="submit" class="button primary">Find analogs</button></form>
        <div id="analog-results" class="section-space" aria-live="polite"></div></section>
      <section class="panel panel-body">${panelHead('Weekly leadership transitions','Compare RS bands between consecutive completed market weeks.')}
        <form id="transition-form" class="inline-form">
          ${field('Completed weeks',`<input name="weeks" type="number" min="2" max="25" required value="${state.transitionWeeks || 8}">`)}
          <button type="submit" class="button primary">Build transition matrix</button></form>
        <div id="transition-results" class="section-space" aria-live="polite"></div></section></div>`;
  }

  async function studyComparisons(form, values) {
    const analog = form.id === 'analog-form';
    const target = main.querySelector(analog ? '#analog-results' : '#transition-results');
    target.innerHTML = pending();
    try {
      if (analog) {
        state.analogHorizon = Number(values.horizon);
        state.analogCoverage = observedCoverageParams(values);
        const result = await env.publishedSeries('market/analogs', { signal,
          params: { horizon: state.analogHorizon, ...state.analogCoverage } }, (partial, job) => {
          if (target.isConnected) target.innerHTML = publishingHistory(job);
        });
        if (!target.isConnected) return;
        target.innerHTML = (result.descriptive ? notice('Observed universe · descriptive',
          `${observedCoverageSummary(result)} ${result.coverageWarning || ''}`) : '') +
          `<div class="inline-stack section-space">${chip(`${count(result.sampleCount)} eligible comparison sessions`)}
          ${chip(`${count(result.outcomeCount)} realized outcomes`)}${chip(`Median return ${percent(result.benchmarkSummary?.median,2,true)}`)}</div>` +
          (result.matches.length ? `<div class="table-scroll" tabindex="0" role="region" aria-label="Historical analogs"><table><thead>
            <tr><th>Session</th><th>Normalized distance</th><th>Forward session</th><th>Benchmark return</th><th>Outcome</th></tr></thead><tbody>
            ${result.matches.map((match)=>`<tr><td><button class="date-button" data-action="replay-analog" data-value="${safe(match.date)}">${dateLabel(match.date)}</button></td>
            <td>${number(match.distance,3)}</td><td>${dateLabel(match.targetDate)}</td><td>${percent(match.forwardReturn,2,true)}</td>
            <td>${safe({complete:'Realized',rightCensored:'Not yet observed',missingBenchmark:'Benchmark unavailable'}[match.status] || 'Unavailable')}</td></tr>`).join('')}</tbody></table></div>`
            : empty('No comparable analogs', 'The selected coverage basis and lookback do not contain enough comparable profiles.', 'history'));
      } else {
        state.transitionWeeks = Number(values.weeks);
        const queued = await env.api('research/leadership-transitions', { body: { context: env.snapshotContext, weeks: state.transitionWeeks } });
        const result = await waitForJob(env, queued, target);
        if (!result || !target.isConnected) return;
        target.innerHTML = result.pairs ? `<div class="inline-stack">${chip(`${count(result.pairs)} weekly pairs`)}
          ${chip(`${count(result.comparable)} comparable transitions`)}${chip(`${count(result.newlyRanked)} new ranks`)}${chip(`${count(result.lostRank)} lost ranks`)}
          ${result.skippedGaps ? chip(`${count(result.skippedGaps)} gaps omitted`,'warning') : ''}</div>
          <div class="table-scroll section-space" tabindex="0" role="region" aria-label="Weekly leadership transition matrix"><table><thead>
          <tr><th>Previous → current percentile</th>${result.to.map((band)=>`<th scope="col">${safe(band)}</th>`).join('')}</tr></thead>
          <tbody>${result.from.map((band,index)=>`<tr><th scope="row">${safe(band)}</th>${result.matrix[index].map((value)=>`<td class="numeric">${count(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
          : empty('No comparable weekly pairs', 'Select a date with consecutive completed weeks and ranked securities.', 'rankings');
      }
    } catch (error) {
      if (target.isConnected && error.name !== 'AbortError') target.innerHTML = notice('Comparison unavailable',error.message,'',true);
    }
  }

  function draw() {
    main.innerHTML = heading('Historical Explorer','Replay sessions, compare market series, and study forward returns.') +
      partialCoverage(snapshot.coverage,env.routeUrl) +
      segment('history-tab',[['series','Time series'],['event','Event studies'],['cohort','Cohorts'],['comparisons','Analogs & transitions'],['journal','Journal signals']],state.tab,'tabs') +
      (state.tab === 'series' ? historyForm() : state.tab === 'event' ? eventForm() : state.tab === 'cohort' ? cohortForm()
        : state.tab === 'comparisons' ? comparisonsForm() : '<div id="journal-research"></div>');
    if (state.tab === 'series') loadSeries();
    bindObservedCoverage(main.querySelector('#event-form'));
    bindObservedCoverage(main.querySelector('#analog-form'));
    if (state.tab === 'journal') mountJournalHistory(env,main.querySelector('#journal-research'),{firstDate:first,lastDate:last});
  }
  const isPercent = (key) => !['benchmarkClose','equalWeightIndex','capWeightIndex','advanceDeclineLine'].includes(key);
  function transformValues(values) {
    if (state.smoothing > 0) values = values.map((_,index)=>{
      const window = values.slice(index - state.smoothing + 1,index + 1);
      return window.length === state.smoothing && window.every(numeric) ? window.reduce((sum,value)=>sum+value,0)/state.smoothing : null;
    });
    const present = values.filter(numeric);
    if (!present.length) return values;
    if (state.transform === 'rebased') {
      const base = present.find((value)=>value !== 0);
      return values.map((value)=>numeric(value) && base ? value/base*100 : null);
    }
    if (state.transform === 'normalized') {
      const low = Math.min(...present);
      const high = Math.max(...present);
      return values.map((value)=>!numeric(value) ? null : high === low ? 50 : (value-low)/(high-low)*100);
    }
    return values;
  }

  async function loadSeries() {
    const target = main.querySelector('#history-chart');
    if (!target) return;
    const run = ++historyRun;
    const keys = [...new Set([state.primary,state.secondary].filter(Boolean))];
    try {
      const maxDays = state.from ? state.archive ? 7560 : rangeLimit(1260, state.cadence) : rangeLimit(state.limit, state.cadence);
      const result = await env.publishedSeries('market/breadth', { signal, params: { series: 1, metrics: keys.join(','), from: state.from, to: state.to,
        limit: maxDays, cadence: state.cadence, ...(state.archive ? { materializedOnly: 1 } : {}) } }, (partial, job) => {
        if (target.isConnected && run === historyRun) target.innerHTML = publishingHistory(job);
      });
      if (!target.isConnected || run !== historyRun) return;
      const stored = result.rows.map((row)=>({...row}));
      const byDate = new Map(stored.map((row) => [row.date,row]));
      const missing = result.materialization?.missingDates || [];
      const week = (value) => {
        const date = new Date(`${value}T00:00:00Z`);
        return shiftDate(value,-((date.getUTCDay()+6)%7));
      };
      let gapDates = state.archive ? missing : [];
      if (state.archive && state.cadence === 'weekly') {
        const present = new Set(stored.map((row) => week(row.date)));
        gapDates = [...new Map(missing.map((date) => [week(date),date])).entries()].filter(([key]) => !present.has(key)).map(([,date]) => date);
      }
      const data = [...new Set([...byDate.keys(),...gapDates])].sort().map((date) => byDate.get(date) || {date});
      if (!stored.length && state.archive) {
        target.innerHTML = empty('Archive range unavailable','Publish history for the selected universe, model, and warehouse revision.','history',
          `<a class="button" href="${safe(env.routeUrl('settings',{tab:'jobs'}))}">Open history jobs ${icon('chevron-right')}</a>`);
        return;
      }
      const series = keys.map((key,index)=>{
        const values = transformValues(data.map((row)=>row[key]));
        data.forEach((row,i)=>{row[key]=values[i];});
        const formatter = state.transform !== 'values' ? (v)=>number(v,2) : key === 'benchmarkClose' ? money : isPercent(key) ? percent : (v)=>number(v,2);
        return { key, label:key === 'benchmarkClose' ? `${context.benchmark} close` : metricLabels.get(key), format:formatter, axis:index && state.transform === 'values' ? 'right' : 'left' };
      });
      const from = data[0]?.date;
      const to = data.at(-1)?.date;
      const realized = from && to ? `<p class="muted section-space">${dateLabel(from)} to ${dateLabel(to)} · ${count(stored.length)} observations
        ${state.archive && missing.length ? ` · ${count(missing.length)} unmaterialized daily sessions` : ''}</p>` : '';
      const axis = (key) => state.transform !== 'values' ? (value)=>number(value,0) : key === 'benchmarkClose' ? (value)=>compact(value,true)
        : isPercent(key) ? (value)=>percent(value,0) : compact;
      const leadership = keys.some((key) => leadershipMetricKeys.has(key));
      const describePoint = leadership ? (row) => [row.previousLeaderDate && numeric(row.leadershipRankObservations) && numeric(row.leaderReturnExpected)
        ? `${count(row.leadershipRankObservations)} of ${count(row.leaderReturnExpected)} prior-session leaders have comparable ranks · ${dateLabel(row.previousLeaderDate)}`
        : 'Prior-session leadership comparison unavailable'] : undefined;
      const domain = (key) => state.transform !== 'values' || !key || !isPercent(key) ? undefined : key === 'adSpread' ? [-100, 100] : [0, 100];
      target.innerHTML = chart(data,series,{height:260,fill:true,axisFormat:axis(keys[0]),rightAxisFormat:axis(keys[1]),
        domain: domain(keys[0]), rightDomain: domain(keys[1]),
        describePoint, onPick:({date})=>env.go('history',{date,dataVersion:env.snapshotContext.dataVersion})})+realized+
        (leadership ? '<p class="muted section-space">Persistence is the share of comparable prior-session top-decile leaders that remain in the top decile. Turnover is the share that drop below it. Weekly sampling shows the final session’s reading.</p>' : '');
    } catch(error) {
      if (target.isConnected && error.name !== 'AbortError') target.innerHTML=notice('Historical series unavailable',error.message,'',true);
    }
  }

  async function process(kind, jobPromise) {
    const target = main.querySelector('#research-results');
    target.innerHTML = pending('Submitting research job…');
    try {
      const job = await jobPromise;
      const result = await waitForJob(env,job,target);
      if (!result || !target.isConnected) return;
      state[`${kind}Result`] = result;
      target.innerHTML = outcomePanel(result,kind);
    } catch(error) {
      if (target.isConnected && error.name !== 'AbortError') target.innerHTML=notice('Research job failed',error.message,'',true);
    }
  }

  main.onsubmit = (event) => {
    if (event.target.closest('#journal-research')) return;
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target));
    if (event.target.id === 'history-form') {
      Object.assign(state,{primary:values.primary,secondary:values.secondary,from:values.from,to:values.to,cadence:values.cadence,
        archive:values.source === 'archive',transform:values.transform,smoothing:Number(values.smooth)});
      draw();
    }
    if (event.target.id === 'event-form') {
      try {
        state.eventForm={...values,medianStocks:!!values.medianStocks};
        const condition={metric:values.metric,op:values.op,value:Number(values.threshold)};
        if (values.prior !== '') condition.after={op:'lt',value:Number(values.prior),within:Number(values.lookback)};
        process('event',env.api('research/event-studies',{body:{condition,context:env.snapshotContext,start:values.start,end:values.end,asOf:last,
          ...observedCoverageParams(values),
          horizons:horizons(values.horizons),benchmarks:values.benchmarks.split(',').map((s)=>s.trim().toUpperCase()).filter(Boolean),overlap:values.overlap,medianStocks:!!values.medianStocks}}));
      } catch(error) { env.toast(error.message); }
    }
    if (event.target.id === 'cohort-form') {
      try {
        const saved=config.screens.find(({id})=>id===values.screen);
        const screen=saved?.definition || {};
        process('cohort',env.api('research/cohorts',{body:{name:values.name,context:{...env.snapshotContext,...screen.context,date:values.date},
          screen,date:values.date,asOf:values.asOf,horizons:horizons(values.horizons)}}));
      } catch(error) { env.toast(error.message); }
    }
    if (['analog-form','transition-form'].includes(event.target.id)) studyComparisons(event.target,values);
  };
  env.setActions({
    'history-tab'(value) { state.tab=value; draw(); },
    'history-range'(value) {
      state.limit = Number(value);
      state.archive = state.limit > 252;
      state.from = '';
      state.to = last;
      draw();
    },
    'run-cohort':(id)=>process('cohort',env.api(`cohorts/${pathPart(id)}/execute`,{body:{}})),
    'replay-analog':(date)=>env.go('history',{date,dataVersion:env.snapshotContext.dataVersion}),
    'export-research-returns'(kind) {
      const result = state[`${kind}Result`];
      if (!result) return;
      const rows = outcomeData(result.results || [],kind).flatMap(({name,stats,horizon}) =>
        (stats?.distribution?.values || []).map((value)=>({horizon,series:name,percent_return:value})));
      csvDownload(rows,['horizon','series','percent_return'],`${kind}-forward-returns.csv`);
    },
  });
  draw();
}

export async function render(env) {
  return env.page === 'industries' ? renderIndustries(env) : renderHistory(env);
}
