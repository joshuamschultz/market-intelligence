import {
  action, attr, bindVirtualTable, chip, count, dateLabel, empty, field, fieldDetails, fields, heading, icon, notice, number, numeric, option,
  panelHead, pagination, pathPart, pending, rangeFieldDetails, rangeFieldId, rankColumns, safe, savedScreenRoute, screenColumns, segment, table, tradingViewLink, warming,
} from './ui.js';
import { partialCoverage } from './overview.js';

const methodLabels = {
  weighted: 'Weighted returns', percentile: 'Weighted percentiles', zscore: 'Weighted z-scores',
  benchmark: 'Benchmark relative', risk: 'Risk adjusted', nonoverlapping: 'Nonoverlapping momentum',
};
const filterOps = { gte: 'Greater or equal', gt: 'Greater than', lte: 'Less or equal', lt: 'Less than', eq: 'Equal', ne: 'Not equal',
  between: 'Between', in: 'In list', contains: 'Contains', true: 'Is true', false: 'Is false', missing: 'Is missing', present: 'Is present' };
const valueLess = new Set(['true', 'false', 'missing', 'present']);
const pinned = ['symbol', 'name'];
const defaultFilter = () => ({ operator: 'and', filters: [] });
const defaultSort = [{ field: 'rsRank', direction: 'asc' }];
const periodColumns = ['periodRank', 'periodPercentile', 'periodReturn'];
const standardPeriodColumns = [...pinned, ...periodColumns, 'rsRank', 'rsPercentile', 'industry'];
const periodLabels = { windows: 'Return lengths', averages: 'Moving-average lengths', volumeWindows: 'Volume lengths', rangeWindows: 'High/low lookbacks' };
const periodDefaults = () => ({ windows: [], averages: [], volumeWindows: [], rangeWindows: [] });
const rangeMeasures = [['distance', 'Distance from high or low'], ['since', 'Sessions since last new high or low'], ['age', 'Age of high or low within window']];
const rangeModes = [['none', 'Columns only'], ['gte', 'At least'], ['lte', 'At most'], ['between', 'Between']];
const initialColumns = (ranking) => [...(ranking ? rankColumns : screenColumns)];
const columnSort = (columns) => [...new Set([...pinned, ...columns])];
const defaultWindow = () => ({ kind: 'sessions', length: 21, offset: 0, weight: 25 });
const preset = {
  leaders: { operator: 'and', filters: [{ field: 'rsPercentile', op: 'gte', value: 90 }, { field: 'velocity4w', op: 'gte', value: 5 },
    { operator: 'or', filters: [{ field: 'distance_high_252d', op: 'gte', value: -.10 }, { field: 'new_high_50d', op: 'true' }] }] },
  volume: { operator: 'and', filters: [{ field: 'udv_50d', op: 'gte', value: 1.3 }, { field: 'rvol_20d', op: 'gte', value: 1.5 }] },
  trend: { operator: 'and', filters: [{ field: 'above_50d', op: 'true' }, { field: 'above_200d', op: 'true' }] },
  emerging: { operator: 'and', filters: [{ field: 'industryEmerging', op: 'true' }] },
};
const groups = [['', 'No grouping'], ['sector', 'Sector'], ['industry', 'Industry'], ['marketCapBucket', 'Market cap']];
const windowKinds = [['sessions', 'Trading sessions'], ['months', 'Calendar months'], ['quarters', 'Calendar quarters'], ['years', 'Calendar years'], ['ytd', 'Year to date'], ['fixed', 'Fixed dates']];

function definition(state, context) {
  const list = state.rankingPeriod || state.rankingList;
  const filter = state.listFilter && activeRules(state.filter) ? { operator: 'and', filters: [state.listFilter, state.filter] }
    : state.listFilter || state.filter;
  return { filter, search: state.search, ...(list && !state.sortCustomized ? {} : { sort: state.sort }),
    columns: visibleColumns(state), ...(state.rankingPeriod ? { rankingPeriod: state.rankingPeriod, topPercent: state.topPercent } : {}),
    ...(state.rankingList ? { rankingList: state.rankingList } : {}),
    computed: state.computed, groupBy: state.groupBy, includeUntraded: state.includeUntraded,
    context: { ...context, ...Object.fromEntries(Object.entries(state.customPeriods).filter(([, values]) => values.length)) }, dateMode: context.date ? 'fixed' : 'latest' };
}
function visibleColumns(state) {
  if (!state.rankingPeriod) return state.columns;
  return state.columnsCustomized ? [...new Set([...pinned, ...periodColumns, ...state.columns])] : standardPeriodColumns;
}
const choices = (computed = []) => [...fields.values(), ...computed.map((item) => ({ id: item.field, label: item.label, format: 'decimal' }))];
const fieldOptions = (selected, computed = []) => choices(computed).map(({ id, label }) => option(id, label, selected)).join('');
const activeRules = (node) => node?.filters ? node.filters.reduce((total, item) => total + activeRules(item), 0) : Number(!!node);

function ruleValue(fieldId, op, text) {
  if (valueLess.has(op)) return null;
  const format = fieldDetails(fieldId).format;
  const typed = (input) => {
    const trimmed = input.trim();
    if (format === 'bool') {
      if (['true', 'yes'].includes(trimmed.toLowerCase())) return true;
      if (['false', 'no'].includes(trimmed.toLowerCase())) return false;
      throw new Error('Enter true or false for this comparison.');
    }
    if (['text', 'date'].includes(format) && !fieldId.startsWith('custom_')) return trimmed;
    if (!trimmed || !Number.isFinite(Number(trimmed))) throw new Error('Enter a numeric value for this comparison.');
    return Number(trimmed);
  };
  if (op === 'between' || op === 'in') return text.split(',').map(typed);
  return typed(text);
}

function registerPeriods(periods) {
  const register = (id, label, format) => { if (!fields.has(id)) fields.set(id, { id, label, format }); };
  for (const days of periods.windows) register(`return_${days}d`, `${days}D return`, 'rate');
  for (const days of periods.averages) {
    register(`sma_${days}d`, `${days}D SMA`, 'money');
    register(`ema_${days}d`, `${days}D EMA`, 'money');
    register(`vs_sma_${days}d`, `Price vs ${days}D SMA`, 'rate');
    register(`above_${days}d`, `Above ${days}D SMA`, 'bool');
    register(`slope_sma_${days}d`, `${days}D SMA slope`, 'rate');
    register(`vs_ema_${days}d`, `Price vs ${days}D EMA`, 'rate');
    register(`slope_ema_${days}d`, `${days}D EMA slope`, 'rate');
  }
  for (const days of periods.volumeWindows) {
    register(`udv_${days}d`, `U/D volume ${days}D`, 'ratio');
    register(`rvol_${days}d`, `Relative volume ${days}D`, 'ratio');
    register(`adv_${days}d`, `Avg dollar volume ${days}D`, 'compactMoney');
    register(`float_turnover_${days}d`, `Float turnover ${days}D`, 'rate');
    register(`obv_slope_${days}d`, `${days}D OBV change`, 'compact');
  }
  for (const days of periods.rangeWindows ?? []) {
    for (const [metric] of rangeMeasures) {
      for (const side of ['high', 'low']) {
        const details = rangeFieldDetails(rangeFieldId(metric, side, days));
        register(details.id, details.label, details.format);
      }
    }
  }
}

const listPeriods = (input) => [...new Set(String(input || '').split(',').map((item) => item.trim()).filter(Boolean).map(Number))];

function usedRangeWindows(screen) {
  const fields = JSON.stringify([screen.filter, screen.sort, screen.columns, screen.computed?.map(({ expression }) => expression)]);
  const used = [...fields.matchAll(/\brange_(?:distance|since|age)_(?:high|low)_(\d+)d\b/g)].map(([, window]) => Number(window));
  return [...new Set([...listPeriods(screen.context?.rangeWindows), ...used])].sort((a, b) => a - b);
}

function rangeEditor(env, apply) {
  const target = env.showDialog(env.modal, 'Highs and lows', `<form class="stack" id="range-filter-editor">
    <div class="form-grid">
      ${field('Measure', `<select name="measure">${rangeMeasures.map(([id, label]) => option(id, label, 'distance')).join('')}</select>`)}
      ${field('Side', `<select name="side">${option('high', 'High', 'high')}${option('low', 'Low', 'high')}</select>`)}
      ${field('Lookback (trading sessions)', '<input name="lookback" type="number" min="1" max="7560" step="1" value="20" required>')}
      ${field('Condition', '<select name="condition"></select>')}
      <div class="form-grid" id="range-operands"></div>
    </div>
    <p class="muted" id="range-definition"></p>
    <div class="form-error" role="alert" hidden></div>
    <div><button type="submit" class="button primary">Apply high/low settings</button></div></form>`);
  const form = target.querySelector('form');
  const select = form.elements.condition;
  const explanations = {
    distance: 'Compares the close with the highest high or lowest low across the window, including the selected session.',
    since: 'Counts market sessions since price strictly exceeded the preceding window’s high or fell below its low. Ties leave the clock running. An event today counts as zero. Gaps and unverified split crossings can make an age unavailable.',
    age: 'Counts from the most recent occurrence of the window’s high or low, including ties. This age stays inside the lookback.',
  };
  function showOperands() {
    const choice = select.value;
    const distance = form.elements.measure.value === 'distance';
    target.querySelector('#range-operands').innerHTML = choice === 'none' ? '' : distance
      ? field('Within (%)', '<input name="value" type="number" min="0" step="any" value="5" required>')
      : field(choice === 'between' ? 'From (sessions)' : 'Trading sessions', '<input name="value" type="number" min="0" max="7560" step="1" value="30" required>') +
        (choice === 'between' ? field('Through (sessions)', '<input name="upper" type="number" min="0" max="7560" step="1" required>') : '');
  }
  function showCondition() {
    const measure = form.elements.measure.value;
    const options = measure === 'distance' ? [['within', 'Within a percentage'], rangeModes[0]] : [...rangeModes.slice(1), rangeModes[0]];
    select.innerHTML = options.map(([id, label]) => option(id, label, options[0][0])).join('');
    target.querySelector('#range-definition').textContent = explanations[measure];
    showOperands();
  }
  showCondition();
  form.elements.measure.onchange = showCondition;
  select.onchange = showOperands;
  target.onsubmit = async (event) => {
    event.preventDefault();
    const values = new FormData(form);
    const measure = values.get('measure');
    const side = values.get('side');
    const window = Number(values.get('lookback'));
    const condition = values.get('condition');
    const value = Number(values.get('value'));
    const upper = Number(values.get('upper'));
    const id = rangeFieldId(measure, side, window);
    const submit = form.querySelector('[type="submit"]');
    let filter;
    try {
      if (!form.reportValidity()) return;
      submit.disabled = true;
      if (condition === 'within') {
        const limit = value / 100;
        filter = { field: id, op: 'between', value: side === 'high' ? [-limit, 0] : [0, limit] };
      } else if (condition !== 'none') {
        if (condition === 'between' && upper < value) throw new Error('The upper age must be at least the lower age.');
        filter = { field: id, op: condition, value: condition === 'between' ? [value, upper] : value };
      }
      await apply({ window, filter, columns: ['high', 'low'].map((kind) => rangeFieldId(measure, kind, window)) });
      env.modal.close();
    } catch (error) {
      const output = target.querySelector('.form-error');
      output.hidden = false;
      output.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  };
}

function periodEditor(env, state, apply) {
  const target = env.showDialog(env.modal, 'Custom periods', `<form class="stack">
    ${Object.entries(periodLabels).map(([key,label]) => field(label, `<input name="${key}" value="${safe(state.customPeriods[key].join(', '))}" placeholder="37, 75, 120">`)).join('')}
    <p class="muted">Enter up to 16 trading-session counts in each field. Custom metrics appear in filters, columns, and sorting.</p>
    <div class="form-error" role="alert" hidden></div><div><button type="submit" class="button primary">Apply periods</button></div></form>`);
  target.onsubmit = async (event) => {
    event.preventDefault();
    const values = new FormData(event.target);
    const custom = Object.fromEntries(Object.keys(periodLabels).map((key) => [key, listPeriods(values.get(key))]));
    try {
      if (Object.values(custom).some((periods) => periods.length > 16 || periods.some((period) => !Number.isInteger(period) || period < 1 || period > 7560))) {
        throw new Error('Use up to 16 whole trading-session counts between 1 and 7,560 in each field.');
      }
      registerPeriods(custom);
      await apply(custom);
      env.modal.close();
    } catch (error) {
      const output = target.querySelector('.form-error');
      output.hidden = false;
      output.textContent = error.message;
    }
  };
}

function filterEditor(env, state, apply) {
  let filter = structuredClone(state.filter || defaultFilter());
  if (!filter.filters) filter = { operator: 'and', filters: [filter] };
  const target = env.showDialog(env.modal, 'Filter builder', '', 'Combine metric comparisons with nested groups and validated expressions.');
  const nodeAt = (path) => path === '' ? filter : path.split('.').reduce((current, segment) => current.filters[Number(segment)], filter);
  const input = (id, op, value) => {
    const hint = op === 'between' || op === 'in' ? 'Comma-separated values'
      : fieldDetails(id).format === 'rate' ? 'Percentage as decimal, e.g. 0.05' : 'Value';
    return `<input data-rule-key="value" aria-label="Comparison value" placeholder="${hint}"${attr('value', Array.isArray(value) ? value.join(', ') : value)} ${valueLess.has(op) ? 'disabled' : ''}>`;
  };
  function html(node, path = '', depth = 0) {
    if (node.filters) return `<fieldset class="filter-group" data-filter-group="${path}">
      <legend>${depth ? 'Nested group' : 'Filter rules'}</legend>
      <div class="filter-group-head"><label class="field"><span class="sr-only">Group operator</span><select data-rule-key="operator" data-rule-path="${path}">${option('and', 'Match all rules', node.operator)}${option('or', 'Match any rule', node.operator)}</select></label>
      <div class="actions"><button type="button" class="button ghost" data-editor="add-rule" data-at="${path}">${icon('plus')} Rule</button>
      <button type="button" class="button ghost" data-editor="add-expression" data-at="${path}">${icon('code')} Expression</button>
      ${depth < 12 ? `<button type="button" class="button ghost" data-editor="add-group" data-at="${path}">${icon('layers')} Group</button>` : ''}
      ${depth ? `<button type="button" class="icon-button" aria-label="Remove group" data-editor="remove" data-at="${path}">${icon('trash')}</button>` : ''}</div></div>
      ${node.filters.map((item, index) => html(item, path ? `${path}.${index}` : String(index), depth + 1)).join('') || '<p class="muted">An empty group matches all stocks when its operator is Match all.</p>'}</fieldset>`;
    const remove = `<button class="icon-button" type="button" data-editor="remove" data-at="${path}" aria-label="Remove rule">${icon('trash')}</button>`;
    if (Object.hasOwn(node, 'expression')) return `<div class="expression-rule" data-rule-path="${path}">
      ${field('Filter expression', `<input type="text" data-rule-key="expression" value="${safe(node.expression)}" placeholder="rsPercentile >= 90 and udv_50d > 1.3" maxlength="1000" required>`)}${remove}</div>`;
    return `<div class="filter-rule" data-rule-path="${path}"><select data-rule-key="field" aria-label="Metric">${fieldOptions(node.field, state.computed)}</select>
      <select data-rule-key="op" aria-label="Comparison">${Object.entries(filterOps).map(([op, label]) => option(op, label, node.op)).join('')}</select>
      ${input(node.field, node.op, node.value)}${remove}</div>`;
  }
  function draw() {
    target.innerHTML = `<form class="stack" id="filter-editor">${html(filter)}<details class="formula-help"><summary>Expression syntax</summary>
      <p class="muted">Use metric IDs, arithmetic, comparisons, and boolean operators. Available functions include rank, percentile, previous, change, min, max, abs, log, and coalesce.</p>
      <code>change(rsPercentile, 20) &gt; 5 and return_63d &gt; 0.1</code></details>
      <div class="form-error" role="alert" hidden></div><div class="actions"><button type="submit" class="button primary">Apply filters</button>
      <button type="button" class="button" data-editor="reset">Reset rules</button></div></form>`;
  }
  function validate(node) {
    if (node.filters) return { operator: node.operator, filters: node.filters.map(validate) };
    if (Object.hasOwn(node, 'expression')) {
      if (!node.expression.trim()) throw new Error('Enter an expression for each expression rule.');
      return { expression: node.expression.trim() };
    }
    return { field: node.field, op: node.op, value: ruleValue(node.field, node.op, String(node.value ?? '')) };
  }
  target.oninput = (event) => {
    const key = event.target.dataset.ruleKey;
    const path = event.target.closest('[data-rule-path]')?.dataset.rulePath;
    if (key && path != null) nodeAt(path)[key] = event.target.value;
  };
  target.onchange = (event) => {
    if (['op', 'field'].includes(event.target.dataset.ruleKey)) draw();
  };
  target.onclick = (event) => {
    const button = event.target.closest('[data-editor]');
    if (!button) return;
    const { editor, at } = button.dataset;
    if (editor === 'reset') filter = defaultFilter();
    else if (editor === 'remove') {
      const path = at.split('.');
      const index = Number(path.pop());
      nodeAt(path.join('.')).filters.splice(index, 1);
    } else {
      const group = nodeAt(at);
      if (group.filters.length >= 35) return env.toast('This group already has 35 rules.');
      group.filters.push(editor === 'add-group' ? defaultFilter() : editor === 'add-expression' ? { expression: '' } : { field: 'rsPercentile', op: 'gte', value: '90' });
    }
    draw();
  };
  target.onsubmit = async (event) => {
    event.preventDefault();
    const error = target.querySelector('.form-error');
    try {
      await apply(validate(filter));
      env.modal.close();
    } catch (failure) {
      error.hidden = false;
      error.textContent = failure.message;
    }
  };
  draw();
}

function columnEditor(env, state, apply) {
  const chosen = new Set(state.columns);
  const target = env.showDialog(env.modal, 'Visible columns', '<label class="field">Search metrics<input type="search" id="column-search" placeholder="Search column names"></label><div id="column-choices" class="column-choices section-space"></div><div class="actions section-space"></div>');
  function show(query = '') {
    target.querySelector('#column-choices').innerHTML = choices(state.computed).filter((col) => `${col.label} ${col.id}`.toLowerCase().includes(query.toLowerCase())).map((col) =>
      `<label><input type="checkbox" value="${safe(col.id)}" ${chosen.has(col.id) ? 'checked' : ''} ${pinned.includes(col.id) ? 'disabled' : ''}><span>${safe(col.label)}<small>${safe(col.id)}</small></span></label>`).join('');
  }
  target.querySelector('#column-search').oninput = (event) => show(event.target.value);
  target.querySelector('#column-choices').onchange = (event) => {
    const { checked, value } = event.target;
    if (checked) chosen.add(value);
    else chosen.delete(value);
  };
  const footer = target.querySelector('.actions');
  footer.innerHTML = '<button type="button" class="button primary">Apply columns</button>';
  footer.firstElementChild.onclick = async () => {
    try {
      await apply(columnSort([...chosen]));
      env.modal.close();
    } catch (error) { env.toast(error.message); }
  };
  show();
}

function sortEditor(env, state, apply) {
  const drafts = structuredClone(state.sort);
  const target = env.showDialog(env.modal, 'Sort precedence', '', 'Rows are ordered by the first metric, then by each successive metric.');
  function show() {
    target.innerHTML = `<form class="stack">${drafts.map((row, index) => `<div class="sort-row" data-index="${index}">
      <span class="mono quiet">${index + 1}</span><select aria-label="Sort metric" data-key="field">${fieldOptions(row.field, state.computed)}</select>
      <select aria-label="Sort direction" data-key="direction">${option('asc', 'Ascending', row.direction)}${option('desc', 'Descending', row.direction)}</select>
      <button type="button" data-edit-sort="remove" data-index="${index}" class="icon-button" aria-label="Remove sort">${icon('trash')}</button></div>`).join('')}
      <div class="actions"><button type="submit" class="button primary">Apply sort</button><button type="button" class="button" data-edit-sort="add">${icon('plus')} Add sort</button></div></form>`;
  }
  target.onchange = (event) => {
    const index = event.target.closest('.sort-row')?.dataset.index;
    if (index != null) drafts[Number(index)][event.target.dataset.key] = event.target.value;
  };
  target.onclick = (event) => {
    const control = event.target.closest('[data-edit-sort]');
    if (!control) return;
    if (control.dataset.editSort === 'remove') drafts.splice(Number(control.dataset.index), 1);
    else if (drafts.length < 12) drafts.push({ field: 'return_1d', direction: 'desc' });
    show();
  };
  target.onsubmit = async (event) => {
    event.preventDefault();
    if (new Set(drafts.map(({ field }) => field)).size !== drafts.length) return env.toast('Each sort metric can only appear once.');
    try {
      await apply(drafts);
      env.modal.close();
    } catch (error) { env.toast(error.message); }
  };
  show();
}

function computedEditor(env, state, apply) {
  const target = env.showDialog(env.modal, 'Computed columns', `<div id="computed-list" class="stack">${state.computed.map((item) =>
    `<div class="simple-row"><div><strong>${safe(item.label)}</strong><div class="muted mono">${safe(item.expression)}</div></div><button type="button" class="icon-button" aria-label="Remove ${safe(item.label)}" data-remove="${safe(item.field)}">${icon('trash')}</button></div>`).join('')}</div>
    <form class="stack section-space">
      ${field('Label', '<input name="label" placeholder="Momentum blend" maxlength="100" required>')}
      ${field('Field ID', '<input name="field" pattern="custom_[A-Za-z_0-9]+" placeholder="custom_momentum" required>')}
      ${field('Expression', '<textarea name="expression" placeholder="0.6 * percentile(return_252d) + 0.4 * percentile(return_63d)" maxlength="1000" required></textarea>')}
      <div class="form-error" role="alert" hidden></div><div class="actions"><button type="submit" class="button primary">${icon('plus')} Add column</button></div>
    </form>`);
  target.onclick = (event) => {
    const remove = event.target.closest('[data-remove]')?.dataset.remove;
    if (remove) {
      apply(state.computed.filter(({ field }) => field !== remove), remove).then(() => env.modal.close()).catch((error) => env.toast(error.message));
    }
  };
  target.onsubmit = async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target));
    try {
      await apply([...state.computed, values], null, values.field);
      env.modal.close();
    } catch (error) {
      const output = target.querySelector('.form-error');
      output.hidden = false;
      output.textContent = error.message;
    }
  };
}

function saveEditor(env, state, saved, prepareRanges) {
  const list = env.page === 'stocklists';
  const target = env.showDialog(env.modal, list ? saved ? 'Save list version' : 'Save a stock list' : saved ? 'Save screen version' : 'Save a screen', `<form class="stack">
    ${field('Name', `<input name="name" required maxlength="100" value="${safe(saved?.name || '')}" placeholder="Emerging leaders">`)}
    <label class="checkbox-label"><input type="checkbox" name="fixed" ${env.context.date ? 'checked' : ''}> Pin the selected session</label>
    <p class="muted">${list ? 'Saved Screens stores this list’s rules, table layout, and analysis context.' : 'This screen stores filters, columns, sorting, and the current analysis context.'}</p>
    <div class="form-error" role="alert" hidden></div><div><button class="button primary" type="submit">${icon('check')} ${list ? 'Save list' : 'Save screen'}</button></div></form>`);
  target.onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const context = { ...env.context };
    if (form.has('fixed')) {
      context.date ||= state.result?.date || env.config.status.latestDate;
      context.dataVersion ??= env.snapshotContext.dataVersion;
    } else {
      delete context.date;
      delete context.dataVersion;
    }
    const body = { name: form.get('name'), definition: definition(state, context) };
    try {
      await prepareRanges(body.definition, { date: context.date || env.config.status.latestDate, followLatest: !form.has('fixed') });
      const result = await env.api(saved ? `screens/${pathPart(saved.id)}` : 'screens', { method: saved ? 'PUT' : 'POST', body, plain: true });
      env.modal.close();
      await env.reloadConfig();
      env.toast(`Saved ${result.name}`);
      env.go(list ? 'stocklists' : 'screener', { ...(list ? { rankList: null, period: null, rankingPeriod: null, rankingList: null, topPercent: null } : {}),
        screen: result.id, ...savedScreenRoute(body.definition) });
    } catch (error) {
      const output = target.querySelector('.form-error');
      output.hidden = false;
      output.textContent = error.message;
    }
  };
}

export function modelEditor(env, existing = null) {
  const source = existing?.definition || env.config.models?.find(({ id }) => id === env.context.model)?.definition;
  const method = source?.method || 'weighted';
  const mode = source?.priceMode || 'split';
  const windows = (source?.windows?.length ? source.windows : [{ ...defaultWindow(), weight: 1 }]).map((item) => ({ ...item, weight: Math.round(item.weight * 100000) / 1000 }));
  const builtIn = existing && ['composite', 'short-momentum', 'benchmark-relative'].includes(existing.id);
  const target = env.showDialog(env.modal, existing && !builtIn ? 'Edit RS model' : 'Build an RS model',
    `<form class="stack">
    ${field('Model name', `<input name="name" value="${safe(existing && !builtIn ? existing.name : '')}" required maxlength="100" placeholder="My momentum model">`)}
    <div class="form-grid">${field('Scoring method', `<select name="method">${Object.entries(methodLabels).map(([id, label]) => option(id, label, method)).join('')}</select>`)}
    ${field('Price adjustment', `<select name="mode">${option('split','Split adjusted',mode)}${option('total','Dividend-adjusted total return',mode)}</select>`)}</div>
    <div id="model-windows" class="stack"></div><div><button type="button" class="button" data-model-action="add">${icon('plus')} Add return window</button></div>
    <p class="muted">Weights are normalized to 100%. A lag places the end of a return window before the as-of date.</p>
    <div class="form-error" role="alert" hidden></div><div><button type="submit" class="button primary">${icon('check')} Save and use model</button></div></form>`);
  function showWindows() {
    target.querySelector('#model-windows').innerHTML = windows.map((row, index) => `<fieldset class="model-window" data-window="${index}"><legend>Return window ${index + 1}</legend>
      ${field('Window', `<select data-property="kind">${windowKinds.map(([kind, label]) => option(kind, label, row.kind)).join('')}</select>`)}
      ${row.kind === 'fixed' ? field('Start', `<input type="date" data-property="start" value="${safe(row.start)}" required>`) + field('End', `<input type="date" data-property="end" value="${safe(row.end)}" required>`)
        : row.kind === 'ytd' ? '' : field('Length', `<input type="number" min="1" data-property="length" value="${safe(row.length)}" required>`) +
          field('Lag', `<input type="number" min="0" data-property="offset" value="${safe(row.offset || 0)}" required>`)}
      ${field('Weight (%)', `<input type="number" min="0" step="0.001" data-property="weight" value="${safe(row.weight)}" required>`)}
      <button type="button" class="icon-button" data-model-action="remove" data-index="${index}" aria-label="Remove return window" ${windows.length <= 1 ? 'disabled' : ''}>${icon('trash')}</button></fieldset>`).join('');
  }
  target.oninput = (event) => {
    const index = event.target.closest('[data-window]')?.dataset.window;
    if (index == null) return;
    const key = event.target.dataset.property;
    windows[Number(index)][key] = event.target.type === 'number' ? Number(event.target.value) : event.target.value;
  };
  target.onchange = (event) => { if (event.target.dataset.property === 'kind') showWindows(); };
  target.onclick = (event) => {
    const button = event.target.closest('[data-model-action]');
    if (!button) return;
    if (button.dataset.modelAction === 'remove' && windows.length > 1) windows.splice(Number(button.dataset.index), 1);
    if (button.dataset.modelAction === 'add' && windows.length < 50) windows.push(defaultWindow());
    showWindows();
  };
  target.onsubmit = async (event) => {
    event.preventDefault();
    const values = new FormData(event.target);
    const updating = existing && !builtIn;
    try {
      const model = await env.api(updating ? `ranking-models/${pathPart(existing.id)}` : 'ranking-models', { method: updating ? 'PUT' : 'POST',
        body: { name: values.get('name'), definition: { method: values.get('method'), priceMode: values.get('mode'), windows } }, plain: true });
      env.modal.close();
      await env.reloadConfig();
      env.toast(`Saved ${model.name}`);
      env.go('rankings', { model: model.id, modelVersion: model.version });
    } catch (error) {
      const output = target.querySelector('.form-error');
      output.hidden = false;
      output.textContent = error.message;
    }
  };
  showWindows();
}

export async function render(env) {
  const { main, state, context, params, config, signal } = env;
  const stockLists = env.page === 'stocklists';
  const warehouse = env.page === 'rankings';
  const ranking = warehouse || stockLists;
  const periods = config.rankingPeriods || [];
  const modelLists = config.rankingLists || [];
  const top100 = { id: 'top-100', label: 'Top 100 by RS rank', description: 'Stocks ranked 1–100 by the selected RS model.' };
  const requested = params.rankList || params.period || params.rankingPeriod || params.rankingList;
  const knownList = [...periods, ...modelLists, top100].some(({ id }) => id === requested);
  if (warehouse && knownList) {
    env.go('stocklists', { rankList: requested, topPercent: params.topPercent }, true);
    return;
  }
  const coverage = await env.api('market/breadth', { signal }).then((data) => data.coverage);
  if (!env.isActive()) return;
  const saved = params.screen ? config.screens.find(({ id }) => id === params.screen) : null;
  if (params.screen !== state.screen || !state.columns) {
    const data = saved?.definition || {};
    Object.assign(state, { screen: params.screen, filter: data.filter || defaultFilter(), search: data.search || '',
      sort: data.sort || structuredClone(defaultSort), sortCustomized: !!data.sort,
      columns: columnSort(data.columns || initialColumns(ranking)), columnsCustomized: !!data.columns, computed: data.computed || [],
      groupBy: data.groupBy || '', perPage: 50, page: 1, selected: new Set(), includeUntraded: !!data.includeUntraded,
      customPeriods: { ...Object.fromEntries(Object.keys(periodLabels).map((key) => [key, listPeriods(data.context?.[key])])),
        rangeWindows: usedRangeWindows(data) } });
  }
  const selectedList = saved ? saved.definition?.rankingPeriod || saved.definition?.rankingList
    : stockLists ? knownList ? requested : periods.find(({ id }) => id === '1m')?.id || periods[0]?.id || top100.id : null;
  const period = periods.find(({ id }) => id === selectedList);
  const rankList = modelLists.find(({ id }) => id === selectedList);
  const topPercent = Number((stockLists && !saved ? params.topPercent : saved?.definition?.topPercent) || 2);
  if (state.activeList !== selectedList || state.topPercent !== topPercent) state.page = 1;
  Object.assign(state, { activeList: selectedList, rankingPeriod: period?.id, rankingList: rankList?.id, topPercent,
    listFilter: selectedList === top100.id ? { field: 'rsRank', op: 'lte', value: 100 } : null });
  state.customPeriods = { ...periodDefaults(), ...state.customPeriods };
  registerPeriods(state.customPeriods);
  const contextKey = JSON.stringify(context);
  if (state.contextKey !== contextKey) {
    state.page = 1;
    state.selected.clear();
    state.contextKey = contextKey;
  }
  let request = 0;
  let queryController;
  const registeredRanges = new Set();
  signal.addEventListener('abort',()=>queryController?.abort(),{once:true});
  let searchTimer = null;

  function columns() {
    return [...new Set([...visibleColumns(state), ...(state.groupBy ? ['group', 'groupRank'] : []),
      ...(ranking && state.compareModel ? ['compareRank', 'comparePercentile'] : []),
      ...(state.compareDate ? [state.compareMetric || 'rsPercentile', 'compareDateMetric', 'compareDateDelta'] : [])])];
  }
  function sortOrder() {
    if (state.sortCustomized || !period && !rankList) return state.sort;
    return [{ field: period ? 'periodRank' : rankList.rankField, direction: rankList?.direction || 'asc' }];
  }
  const openList = (value) => env.go('stocklists', { screen: null, rankList: value || null, period: null, rankingPeriod: null, rankingList: null });
  function draw() {
    const rankDescription = `Rank 1 is strongest. Percentiles are relative to the comparable securities in the selected universe.`;
    const replay = context.date || context.dataVersion;
    const visibleName = period ? `${period.label} price leaders` : rankList?.label || (selectedList === top100.id ? top100.label : null);
    const timing = replay ? 'Historical replay · pinned session or data revision' : 'Live EOD · follows completed daily publications';
    const listDescription = period ? `Ranked by split-adjusted return over ${period.sessions} trading sessions. Filters apply after period ranks are assigned.`
      : rankList?.description || (selectedList === top100.id ? top100.description : 'Results use the saved screen definition.');
    main.innerHTML = heading(stockLists ? 'Stock Lists' : warehouse ? 'RS Rankings' : 'Stock Screener',
      stockLists ? 'Price leaders, RS signals, and saved lists.' : warehouse ? rankDescription : 'Filter, rank, and compare securities in a historical session.',
      warehouse ? `<a class="button" href="${safe(env.routeUrl('settings', { tab: 'config' }))}">${icon('settings')} Manage RS models</a>`
        : stockLists ? `<a class="button" href="${safe(env.routeUrl('screens'))}">${icon('screens')} Saved Screens</a>`
          : action('Save view', 'save-screen', 'screens', { className: 'primary' })) +
      partialCoverage(coverage, env.routeUrl) +
      (stockLists ? `<section class="panel panel-body ranking-lists">${panelHead('Select a list', timing, action('Save list', 'save-screen', 'screens'))}
        <div class="query-options"><div><p class="muted">Period return leaders</p>${segment('ranking-list',
          periods.map(({ id, label }) => [id, label]), saved ? null : period?.id)}</div>
          <label class="field">RS model lists<select data-change="ranking-list">
          ${option('', 'Select an RS model list', saved || period ? '' : selectedList)}
          ${[top100, ...modelLists].map(({ id, label }) => option(id, label, saved ? null : selectedList)).join('')}
        </select></label>
        ${config.screens.length ? `<label class="field">Saved lists<select data-change="saved-stock-list">
          ${option('', 'Select a saved list', saved?.id || '')}${config.screens.map(({ id, name }) => option(id, name, saved?.id)).join('')}
        </select></label>` : ''}
        ${period && !saved ? `<form id="rs-cutoff-form" class="inline-stack"><label class="field">Top percent<input name="cutoff" type="number" min="0.1" max="100" step="any" required value="${safe(topPercent)}"></label>
          <button class="button" type="submit">Apply cutoff</button></form>` : ''}</div><p class="muted">${safe(listDescription)}</p>
      </section>` : '') +
      `<section class="panel workplace-table">
        <header class="results-head"><div><h2>${safe(saved?.name || visibleName || (warehouse ? 'Ranking warehouse' : 'Security results'))}</h2><p id="results-meta" class="muted"></p></div>
        <div class="actions" id="selection-tools"></div></header>
        <div class="query-toolbar">
          <label class="search-field">${icon('search')}<span class="sr-only">Search stocks</span><input type="search" id="security-search" value="${safe(state.search)}" placeholder="Ticker, company, industry"></label>
          ${action(`Filters${activeRules(state.filter) ? ` (${activeRules(state.filter)})` : ''}`, 'filters', 'filter')}
          ${action('Sort', 'sort-editor', 'sort')}${action('Columns', 'columns', 'columns')}
          ${action('Highs & lows', 'range-filters', 'pulse')}${action('Periods', 'periods', 'clock')}${action('Computed', 'computed', 'code')}${action('Compare dates', 'compare-date-editor', 'history')}${action('Export CSV', 'export-screen', 'download', { value: 'csv' })}
          ${config.exportFormats?.includes('parquet') ? action('Export Parquet', 'export-screen', 'download', { value: 'parquet' }) : ''}
        </div>
        <div class="query-options"><label class="field">Group by<select data-change="screen-group">${groups.map(([id,label]) => option(id,label,state.groupBy)).join('')}</select></label>
          <label class="field">Rows per page<select data-change="screen-limit">${[25,50,100,250].map((n) => option(n, n, state.perPage)).join('')}</select></label>
          ${ranking ? `<label class="field">Compare model<select data-change="compare-model">${option('', 'No comparison', state.compareModel || '')}
          ${config.models.filter(({ id }) => id !== context.model).map(({ id,name }) => option(id,name,state.compareModel)).join('')}</select></label>`
          : `<label class="field">Filter preset<select data-change="screen-preset">${option('', 'Select a preset', '')}
          ${option('leaders','Emerging leaders','')}${option('emerging','Stocks in emerging industries','')}${option('volume','Volume demand','')}${option('trend','Above 50D and 200D','')}${option('clear','Clear filters','')}</select></label>`}
          <label class="checkbox-label"><input type="checkbox" data-change="include-untraded" ${state.includeUntraded ? 'checked' : ''}> Include untraded</label>
        </div>
        <div class="inline-stack sort-chips" id="sort-chips">${state.compareDate ? chip(`Compared with ${dateLabel(state.compareResolvedDate || state.compareDate)}`, 'accent') : ''}${sortOrder().map((sort, index) => chip(`${index + 1} · ${fieldDetails(sort.field, state.computed).label} · ${sort.direction === 'asc' ? 'Ascending' : 'Descending'}`)).join('')}</div>
        <div id="screen-warming"></div>
        <div id="result-table">${pending('Querying securities…')}</div></section>`;
    const search = main.querySelector('#security-search');
    const cutoff = main.querySelector('#rs-cutoff-form');
    if (cutoff) cutoff.onsubmit = (event) => {
      event.preventDefault();
      env.go('stocklists', { topPercent: new FormData(cutoff).get('cutoff') });
    };
    search.oninput = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.search = search.value;
        search.defaultValue = state.search;
        state.page = 1;
        load();
      }, 220);
    };
    selection();
  }

  function selection() {
    const target = main.querySelector('#selection-tools');
    if (target) target.innerHTML = state.selected.size ? chip(`${count(state.selected.size)} selected`, 'accent') +
      action('Add to watchlist', 'add-selected', 'watchlists') + action('Clear', 'clear-selected', 'close', { className: 'ghost' }) : '';
  }

  function paintResults(result, target) {
    const compareMetric = state.compareMetric || 'rsPercentile';
    state.result = result;
      const references = result.referenceMode === 'latest' && result.referenceDate ? ` · reference ${dateLabel(result.referenceDate)}` : '';
      const comparedDate = state.compareResolvedDate ? ` · compared with ${dateLabel(state.compareResolvedDate)}` : '';
    const population = result.period
      ? `${count(result.total)} shown · top ${number(result.period.topPercent, 2)}% cutoff: ${count(result.period.cutoff)} of ${count(result.period.comparable)} comparable · ${result.period.sessions} sessions`
      : result.rankingList ? `${count(result.total)} shown · ${count(result.rankingList.qualifying)} qualify of ${count(result.rankingList.ranked)} ranked${result.rankingList.unclassified == null ? '' : ` · ${count(result.rankingList.unclassified)} unclassified excluded`}`
      : `${count(result.total)} of ${count(result.universeCount)} securities`;
    const meta = main.querySelector('#results-meta');
    meta.textContent = `${population} · ${dateLabel(result.date)}${references}${comparedDate}`;
    if (result.period) meta.title = result.period.selection;
      const reportField = fieldDetails(compareMetric, state.computed);
      const computed = [...state.computed, { field: 'compareRank', label: 'Comparison rank', format: 'integer' },
        { field: 'comparePercentile', label: 'Comparison percentile', format: 'decimal' },
        { field: 'compareDateMetric', label: `Past ${reportField.label}`, format: reportField.format },
        { field: 'compareDateDelta', label: `${reportField.label} Δ`, format: reportField.format === 'rate' ? 'rate' : 'signed' },
      ];
      target.innerHTML = (result.groups?.length ? `<div class="inline-stack table-groups">${result.groups.map(({ name,count: n }) => chip(`${name} · ${count(n)}`)).join('')}</div>` : '') +
        table(result.rows, columns(), { computed, sort: sortOrder(), sortable: true, selectable: true, selected: state.selected, virtualRows: true,
          label: 'Screener results', rowAction: ranking || period || rankList ? tradingViewLink : null }) + pagination(result);
      bindVirtualTable(target);
  }

  let requiredRangeDate;
  async function load({ report = true } = {}) {
    const run = ++request;
    const target = main.querySelector('#result-table');
    if (!target) return;
    queryController?.abort();
    queryController = new AbortController();
    const querySignal = queryController.signal;
    const initialMessage = main.querySelector('#screen-warming');
    initialMessage.innerHTML = '';
    let baseShown = false;
    target.setAttribute('aria-busy', 'true');
    try {
      const query = { ...definition(state, context), page: state.page, perPage: state.perPage };
      const result = await env.publishedSeries('screens/query',{body:query,signal:querySignal},(partial,job)=>{
        if (run!==request || !env.isActive()) return;
        if (partial.pendingOnly) target.innerHTML = pending(`Preparing ${(partial.pendingReason || 'verified high history').toLowerCase()}…`);
        else if (!baseShown) { paintResults(partial,target);baseShown=true; }
        target.removeAttribute('aria-busy');
        initialMessage.innerHTML = partial.pendingOnly ? warming(job,partial.pendingReason || 'Verified high history') : warming(job,'Historical comparison metrics') +
          '<p class="muted warming-note">Changes and filters that depend on historical ranks may be incomplete.</p>';
        main.querySelectorAll('[data-action="export-screen"]').forEach((button)=>{button.disabled=true;});
      });
      if (run !== request || !env.isActive()) return;
      requiredRangeDate = result.materialization?.prepareAction === 'range' ? result.materialization.requiredDate : undefined;
      if (usedRangeWindows(query).length && (result.materialization?.prepareAction === 'range' || result.pendingOnly || !Array.isArray(result.rows))) {
        target.innerHTML = notice('High/low metrics need preparation', result.materialization?.error ||
          (requiredRangeDate ? `Prepare the comparison inputs for ${dateLabel(requiredRangeDate)} before using this historical expression.`
            : 'Prepare the selected lookbacks for this session before filtering or sorting.'),
          action('Prepare high/low metrics', 'prepare-screen-ranges', 'refresh'));
        main.querySelectorAll('[data-action="export-screen"]').forEach((button) => { button.disabled = true; });
        return;
      }
      const compareMetric = state.compareMetric || 'rsPercentile';
      if ((state.compareDate || (ranking && state.compareModel)) && result.rows.length) {
        const ids = result.rows.map(({ securityId }) => securityId);
        const chunks = [ids.slice(0, 200), ids.slice(200)].filter((group) => group.length);
        const range = rangeFieldDetails(compareMetric);
        const compare = (patch) => Promise.all(chunks.map((value) => env.publishedSeries('screens/query', {
          body: { filter: { field: 'securityId', op: 'in', value }, context: { ...query.context, ...patch },
            ...(period ? { rankingPeriod: period.id, topPercent: 100 } : {}),
            ...(range ? { columns: [compareMetric] } : {}),
            computed: state.computed, includeUntraded: state.includeUntraded, all: true }, signal:querySignal,
        })));
        const [models, dates] = await Promise.all([
          ranking && state.compareModel ? compare({ model: state.compareModel, modelVersion: '' }) : [],
          state.compareDate ? compare({ date: state.compareDate }) : [],
        ]);
        if (run !== request || !env.isActive()) return;
        const found = (pages) => new Map(pages.flatMap((page) => (page.rows || []).map((row) => [row.securityId, row])));
        const byModel = found(models);
        const byDate = found(dates);
        state.compareResolvedDate = dates[0]?.date;
        for (const row of result.rows) {
          const peer = byModel.get(row.securityId);
          const historical = byDate.get(row.securityId)?.[compareMetric];
          row.compareRank = peer?.rsRank;
          row.comparePercentile = peer?.rsPercentile;
          row.compareDateMetric = historical;
          row.compareDateDelta = numeric(row[compareMetric]) && numeric(historical) ? row[compareMetric] - historical : null;
        }
      }
      main.querySelector('#screen-warming').innerHTML = '';
      main.querySelectorAll('[data-action="export-screen"]').forEach((button)=>{button.disabled=false;});
      paintResults(result,target);
    } catch (error) {
      if (!report) throw error;
      if (run === request && error.name !== 'AbortError' && target.isConnected) {
        const output = baseShown ? initialMessage : target;
        output.innerHTML = notice('Query failed', error.message, action('Retry', 'retry-screen', 'refresh'), true);
      }
    } finally {
      if (run===request) target.removeAttribute('aria-busy');
    }
  }

  function update(patch, { redraw = true, page = 1 } = {}) {
    Object.assign(state, patch, { page });
    if (redraw) draw();
    return load();
  }
  async function prepareRanges(screen, { date, followLatest = !env.context.date, retry = false } = {}) {
    const rangeWindows = usedRangeWindows(screen);
    if (!rangeWindows.length) return;
    if (rangeWindows.length > 16 || rangeWindows.some((day) => !Number.isInteger(day) || day < 1 || day > 7560)) {
      throw new Error('Use up to 16 whole high/low lookbacks from 1 to 7,560 trading sessions.');
    }
    const preparation = { ...env.snapshotContext, ...screen.context,
      date: date || screen.context?.date || env.snapshotContext.date || config.status.latestDate,
      dataVersion: screen.context?.dataVersion ?? env.snapshotContext.dataVersion, rangeWindows, followLatest };
    const key = JSON.stringify(preparation);
    if (!retry && registeredRanges.has(key)) return;
    await env.api('data/preparation', { body: { context: preparation, ...(retry ? { retry } : {}) }, signal, plain: true });
    registeredRanges.add(key);
  }

  async function validate(patch) {
    const screen = definition({ ...state, ...patch }, context);
    const rangeWindows = usedRangeWindows(screen);
    if (rangeWindows.length) {
      await prepareRanges(screen);
      patch.customPeriods = { ...(patch.customPeriods ?? state.customPeriods), rangeWindows };
      registerPeriods(patch.customPeriods);
    }
    await env.api('screens/query', { body: { ...screen, perPage: 1 }, signal });
    return update(patch);
  }
  function compareDateEditor() {
    const target = env.showDialog(env.modal, 'Compare historical metrics', `<form class="stack">
      ${field('Comparison date', `<input name="date" type="date" value="${safe(state.compareDate || '')}" min="${safe(config.status.earliestDate)}"
        max="${safe(state.result?.date || config.status.latestDate)}" required>`)}
      ${field('Metric', `<select name="metric">${choices(state.computed).filter((item) => !['text','bool','date'].includes(item.format))
        .map(({ id,label }) => option(id,label,state.compareMetric || 'rsPercentile')).join('')}</select>`)}
      <p class="muted">Comparison uses the same universe, model, benchmark, and version. Securities with unavailable historical values show a dash.</p>
      <div class="actions"><button class="button primary" type="submit">Compare</button>
        ${state.compareDate ? '<button class="button" type="button" id="clear-date-compare">Clear comparison</button>' : ''}</div></form>`);
    const clear = target.querySelector('#clear-date-compare');
    if (clear) clear.onclick = () => { env.modal.close(); update({ compareDate: null, compareResolvedDate: null }); };
    target.onsubmit = async (event) => {
      event.preventDefault();
      const data = new FormData(event.target);
      const date = data.get('date');
      const metric = data.get('metric');
      const range = rangeFieldDetails(metric);
      try {
        if (range) {
          const next = definition(state, context);
          next.columns = [...next.columns, metric];
          await prepareRanges(next);
          await prepareRanges(next, { date, followLatest: false });
          state.customPeriods = { ...state.customPeriods, rangeWindows: usedRangeWindows(next) };
        }
        env.modal.close();
        update({ compareDate: date, compareMetric: metric, compareResolvedDate: null });
      } catch (error) { env.toast(error.message); }
    };
  }
  env.setActions({
    'compare-date-editor': compareDateEditor,
    filters: () => filterEditor(env, state, (filter) => validate({ filter })),
    'range-filters': () => rangeEditor(env, ({ window, filter, columns }) => {
      const customPeriods = { ...state.customPeriods, rangeWindows: [...new Set([...(state.customPeriods.rangeWindows ?? []), window])] };
      const existing = state.filter;
      const filters = existing?.operator === 'and' ? [...existing.filters] : existing ? [existing] : [];
      if (filter) filters.push(filter);
      return validate({ customPeriods, columns: columnSort([...visibleColumns(state), ...columns]), columnsCustomized: true,
        ...(filter ? { filter: { operator: 'and', filters } } : {}) });
    }),
    'prepare-screen-ranges': async () => {
      await prepareRanges(definition(state, context), { retry: true,
        ...(requiredRangeDate && { date: requiredRangeDate, followLatest: false }) });
      return load();
    },
    columns: () => columnEditor(env, { ...state, columns: visibleColumns(state) }, (columns) => validate({ columns, columnsCustomized: true })),
    periods: () => periodEditor(env, state, (customPeriods) => validate({ customPeriods })),
    'sort-editor': () => sortEditor(env, { ...state, sort: sortOrder() }, (sort) => validate({ sort, sortCustomized: true })),
    computed: () => computedEditor(env, state, (computed, removed, added) => validate({ computed,
      columns: [...state.columns.filter((id) => id !== removed), ...(added ? [added] : [])], sort: state.sort.filter(({ field }) => field !== removed) })),
    sort(field, element, event) {
      if (field.startsWith('compare')) return env.toast('Comparison values are shown for the active result set.');
      const activeSort = sortOrder();
      const active = activeSort.find((item) => item.field === field);
      const range = rangeFieldDetails(field);
      const ascending = range ? range.metric !== 'distance' || range.side === 'low'
        : ['symbol', 'name', 'rsRank', 'periodRank', 'subsetRank', 'groupRank'].includes(field);
      const first = { field, direction: active?.direction === 'asc' ? 'desc' : active?.direction === 'desc' ? 'asc'
        : ascending ? 'asc' : 'desc' };
      const sort = event.shiftKey ? active ? activeSort.map((item) => item.field === field ? first : item) : [...activeSort, first] : [first];
      return update({ sort, sortCustomized: true });
    },
    page: (value) => update({}, { redraw: false, page: Number(value) }),
    'retry-screen': () => load(),
    'ranking-list': openList,
    'save-screen': () => saveEditor(env, state, saved, prepareRanges),
    'export-screen': (format = 'csv') => env.exportFile('screens/query', { body: { ...definition(state, context), export: format } }, `stock-screener.${format}`),
    'add-selected': () => env.openAddWatchlist([...state.selected]),
    'clear-selected'() { state.selected.clear(); selection(); return load(); },
    'change:select-stock'(id, box) {
      if (box.checked) state.selected.add(id);
      else state.selected.delete(id);
      const all = main.querySelector('[data-change="select-page"]');
      if (all) all.checked = (state.result?.rows || []).every((row) => state.selected.has(row.securityId));
      selection();
    },
    'change:select-page'(value, box) {
      for (const { securityId } of state.result?.rows || []) {
        if (box.checked) state.selected.add(securityId);
        else state.selected.delete(securityId);
      }
      main.querySelectorAll('[data-change="select-stock"]').forEach((input) => { input.checked = box.checked; });
      selection();
    },
    'change:screen-group': (value) => update({ groupBy: value }),
    'change:screen-limit': (value) => update({ perPage: Number(value) }),
    'change:screen-preset': (value) => value && update({ filter: structuredClone(preset[value] || defaultFilter()) }),
    'change:include-untraded': (value, box) => update({ includeUntraded: box.checked }),
    'change:compare-model': (value) => update({ compareModel: value }),
    'change:ranking-list': openList,
    'change:saved-stock-list': (id) => {
      const screen = config.screens.find((item) => item.id === id);
      if (screen) env.go('stocklists', { screen: id, ...savedScreenRoute(screen.definition) });
      else openList(null);
    },
  });
  draw();
  await load();
}
