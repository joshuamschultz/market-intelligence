import { chartRanges, rangeSegment } from './chart-ranges.js';
import {
  bindChartbookChart, buildChartbookPlot, chartbookDefaultRange, chartbookLayers, chartbookShortcut, chartbookStats, renderChartbookChart,
} from './chartbook-ui.js';
import { action, count, dateLabel, empty, field, icon, notice, numeric, option, pathPart, pending, rate, safe, tradingViewLink } from './ui.js';

const cacheLimit = 9;
const readAhead = 2;
const rangeValues = chartRanges.map(([range]) => range);
const routeContextKeys = ['date', 'dataVersion', 'universe', 'universeVersion', 'model', 'modelVersion', 'basis',
  'benchmark', 'classification', 'reference', 'observedReferenceDate'];
const sourceKey = ({ type, id }) => `${type}:${id}`;
const storeKey = (securityId, date) => `${securityId}|${date}`;
const reviewPath = (id) => `chartbooks/${pathPart(id)}`;
const metricOptions = [['composite-rs', 'Composite RS'], ['selected-rs', 'Selected RS model'], ['price-performance', 'Raw price performance']];
const periodOptions = [['1w', '1W · 5 sessions'], ['1m', '1M · 21 sessions'], ['3m', '3M · 63 sessions'],
  ['6m', '6M · 126 sessions'], ['1y', '1Y · 252 sessions']];

function sourceCatalog(catalog) {
  return [
    ['Built-in lists', (catalog.builtins || []).map((item) => ({ ...item, type: 'builtin' }))],
    ['Saved screens', (catalog.screens || []).map(({ id, label, name }) => ({ id, label: label || name, type: 'screen' }))],
    ['Watchlists', (catalog.watchlists || []).map(({ id, label, name }) => ({ id, label: label || name, type: 'watchlist' }))],
  ];
}

function showFormError(body, error) {
  const target = body.querySelector('[role="alert"]');
  if (!target || !body.isConnected) return;
  target.textContent = error.message || String(error);
  target.hidden = false;
}

function bookEditor(env, catalog, existing, { watchlist = false } = {}) {
  const definition = existing?.definition || {};
  const sources = definition.sources || [];
  const selected = new Set(sources.filter(({ type }) => type !== 'manual').map(sourceKey));
  const manualSources = sources.filter(({ type }) => type === 'manual');
  const manual = manualSources.flatMap(({ members }) => members).join(', ');
  const groups = sourceCatalog(catalog);
  const all = groups.flatMap(([, options]) => options);
  const known = new Map(all.map((source) => [sourceKey(source), source]));
  const missing = sources.filter((source) => source.type !== 'manual' && !known.has(sourceKey(source)));
  if (missing.length) groups.push(['Unavailable saved sources', missing.map((source) => ({ ...source, label: source.label || source.id }))]);
  const lists = (catalog.watchlists || []).filter((item) => !item.definition?.screenId && item.writable !== false);
  const currentList = definition.defaultWatchlistId || '';
  const { metric = 'composite-rs', direction = 'desc', period = '1m' } = definition.sort || {};
  const body = env.showDialog(env.modal, existing ? 'Edit ChartBook' : 'Create ChartBook', `<form class="stack chartbook-editor">
    ${field('Book name', `<input name="name" ${watchlist ? '' : 'autofocus'} required maxlength="100" value="${safe(existing?.name || '')}" placeholder="Daily chart review">`)}
    <div class="inline-form">
      ${field('Sort by', `<select name="sortMetric">${metricOptions.map(([id, label]) => option(id, label, metric)).join('')}</select>`)}
      ${field('Direction', `<select name="sortDirection">${option('desc', 'Highest first', direction)}${option('asc', 'Lowest first', direction)}</select>`)}
      <div data-chartbook-sort-period${metric === 'price-performance' ? '' : ' hidden'}>${field('Price performance period', `<select name="sortPeriod">${periodOptions.map(([id, label]) => option(id, label, period)).join('')}</select>`)}</div>
    </div>
    ${field('Default watchlist for B', `<select name="watchlist" ${watchlist ? 'autofocus' : ''}>${option('', 'Choose a watchlist', currentList)}
      ${lists.map(({ id, name, label }) => option(id, name || label, currentList)).join('')}
      ${currentList && !lists.some(({ id }) => id === currentList) ? option(currentList, 'Unavailable watchlist', currentList, true) : ''}</select>`,
      lists.length ? '' : 'Create a manual list under Watchlists to bookmark tickers with B.')}
    <div class="chartbook-source-picker">${groups.filter(([, options]) => options.length).map(([label, options]) => `<fieldset>
      <legend>${safe(label)}</legend>${options.map((source) => `<label class="checkbox-label"><input type="checkbox" name="source" value="${safe(sourceKey(source))}"${selected.has(sourceKey(source)) ? ' checked' : ''}>${safe(source.label || source.id)}</label>`).join('')}
    </fieldset>`).join('')}</div>
    ${field('Manual tickers', `<textarea name="manual" rows="2" placeholder="AAPL, MSFT, NVDA">${safe(manual)}</textarea>`, 'Separate tickers or permanent security IDs with commas or spaces.')}
    <p class="form-error" role="alert" hidden></p><div class="actions"><button type="submit" class="button primary">${icon('check')} Save ChartBook</button>
      <button type="button" class="button" data-action="close-dialog">Cancel</button></div></form>`);
  body.querySelector('[name="sortMetric"]').onchange = ({ target }) => {
    body.querySelector('[data-chartbook-sort-period]').hidden = target.value !== 'price-performance';
  };
  body.onsubmit = async (event) => {
    event.preventDefault();
    const form = event.target;
    const data = new FormData(form);
    const checked = new Set(data.getAll('source'));
    const savedSources = sources.filter((source) => source.type !== 'manual' && checked.delete(sourceKey(source)));
    for (const key of checked) {
      const source = known.get(key);
      if (source) savedSources.push({ type: source.type, id: source.id });
    }
    const text = String(data.get('manual')).trim();
    if (text === manual.trim()) savedSources.push(...manualSources);
    else if (text) savedSources.push({ type: 'manual', label: 'Manual tickers', members: [...new Set(text.split(/[\s,]+/).filter(Boolean))] });
    if (!savedSources.length) return showFormError(body, 'Select a list or add at least one manual ticker.');
    const sortMetric = data.get('sortMetric');
    const sort = { metric: sortMetric, direction: data.get('sortDirection'),
      ...(sortMetric === 'price-performance' && { period: data.get('sortPeriod') }) };
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const book = await env.api(existing ? reviewPath(existing.id) : 'chartbooks', {
        signal: env.signal, method: existing ? 'PUT' : 'POST', body: {
          name: String(data.get('name')).trim(), definition: { ...definition, sources: savedSources, defaultWatchlistId: data.get('watchlist') || null, sort },
        },
      });
      if (!env.isActive()) return;
      if (body.isConnected && env.modal.open) env.modal.close();
      env.toast(`Saved ${book.name}`);
      return env.go('chartbook', { book: book.id, ...(!existing && { symbol: null }) });
    } catch (error) {
      if (error.name !== 'AbortError') showFormError(body, error);
    } finally {
      submit.disabled = false;
    }
  };
}

function sourceStatus(env, review) {
  env.showDialog(env.detail, 'ChartBook sources', `<div class="stack">${(review.sources || []).map((source) => {
    const status = source.state === 'ready' ? `${count(source.count)} matching ${source.count === 1 ? 'stock' : 'stocks'}`
      : source.state === 'pending' ? 'Waiting for prepared data' : 'Source unavailable';
    return `<div class="simple-row"><div><strong>${safe(source.label || source.id)}</strong><p class="muted">${safe(status)}${source.error ? ` · ${safe(source.error)}` : ''}</p></div>
      ${source.unavailable?.length ? `<span class="muted">${count(source.unavailable.length)} unresolved</span>` : ''}</div>`;
  }).join('')}</div>`, `${count(review.total)} unique stocks · ${dateLabel(review.date)}`);
}

function sortReadout(sort, row) {
  if (!sort) return '';
  const title = `${sort.label} · ${sort.direction === 'asc' ? 'lowest first' : 'highest first'}`;
  const detail = numeric(row.sortRank) ? sort.rankScope === 'book' ? ` · Book #${count(row.sortRank)} (${rate(row.sortValue)})`
    : ` · Universe #${count(row.sortRank)}` : ' · Ranking unavailable';
  return ` · <span title="${safe(title)}">${safe(sort.label)} ${sort.direction === 'asc' ? '↑' : '↓'}${safe(detail)}</span>`;
}

function layerControls(layers) {
  return `<div class="segmented chartbook-layers" role="group" aria-label="Chart overlays">${chartbookLayers.map(([key, label]) =>
    `<button type="button" data-action="chartbook-layer" data-value="${key}" aria-pressed="${Boolean(layers[key])}">${safe(label)}</button>`).join('')}</div>`;
}

function comparisonReadout(comparisons, anchor, layers) {
  const lines = comparisons.filter(({ key }) => layers[key]).map(({ key, label, shown, source }) => {
    const description = shown ? key === 'industry' ? ` · ${source?.label || 'Equal-weight price proxy'}` : ''
      : ` · ${source?.state === 'pending' ? 'Preparation running' : source?.reason || 'Comparable history unavailable in this range'}`;
    return `<span class="chartbook-line-label${shown ? ` ${key}` : ''}"${shown ? '' : ' data-unavailable'}>${safe(label + description)}</span>`;
  });
  return lines.join('') + (anchor ? `<span>Rebased to stock close on ${safe(dateLabel(anchor))}</span>` : '');
}

function actualRange(rows, sessions, bundle) {
  if (!rows.length) return '';
  const first = rows[0].date;
  const last = rows.at(-1).date;
  const priced = rows.filter(({ close }) => numeric(close)).length;
  const listingDate = bundle.stats?.listingDate || bundle.listingDate;
  const afterListing = Date.parse(first) - Date.parse(listingDate);
  const shortListing = afterListing >= 0 && afterListing <= 7 * 86_400_000 && rows.length < sessions;
  const limited = shortListing ? ' · Listing history is shorter than this range'
    : priced < sessions ? ' · Full range is unavailable from stored price history' : '';
  return `${count(priced)} priced of ${count(sessions)} requested sessions · ${dateLabel(first)} – ${dateLabel(last)}${limited}`;
}

function reviewShell(catalog, book) {
  return `<section class="chartbook-workspace" data-chartbook>
    <header class="chartbook-toolbar"><h1>ChartBook</h1><div class="actions">
      ${catalog.books?.length ? `<label class="chartbook-book-picker"><span class="sr-only">Saved ChartBook</span><select data-change="chartbook-book" aria-label="Saved ChartBook">${catalog.books.map(({ id, name }) => option(id, name, book?.id)).join('')}</select></label>` : ''}
      ${book ? action('Edit book', 'chartbook-edit', 'edit') : ''}${action('New book', 'chartbook-new', 'plus')}
    </div></header><div data-chartbook-view></div></section>`;
}

export async function render(env) {
  const { main, state, signal, params } = env;
  const catalog = await env.api('chartbooks', { signal, plain: true });
  if (!env.isActive()) return;
  const book = (catalog.books || []).find(({ id }) => id === (params.book || state.bookId)) || catalog.books?.[0];
  const sameBook = state.bookId === book?.id;
  state.bookId = book?.id;
  if (!sameBook || !state.range) state.range = chartbookDefaultRange;
  state.layers ||= Object.fromEntries(chartbookLayers.map(([key]) => [key, true]));
  state.noteDrafts ||= new Map();
  state.notes ||= new Map();
  state.bookmarks ||= new Set();
  const layers = state.layers;
  const actions = {
    'chartbook-new': () => bookEditor(env, catalog),
    'chartbook-edit': () => bookEditor(env, catalog, book),
    'change:chartbook-book': (id) => env.go('chartbook', { book: id, symbol: null }),
  };
  env.setActions(actions);
  main.innerHTML = reviewShell(catalog, book);
  const root = main.querySelector('[data-chartbook]');
  const view = root.querySelector('[data-chartbook-view]');
  if (!book) {
    view.innerHTML = empty('Create a ChartBook', 'Combine built-in lists, saved screens, watchlists, or manual tickers into one review.', 'chart',
      action('Create ChartBook', 'chartbook-new', 'plus', { className: 'primary' }));
    return;
  }
  view.innerHTML = pending('Reading saved lists…');
  const path = reviewPath(book.id);
  const review = await env.api(`${path}/review`, { signal });
  if (!env.isActive()) return;
  const rows = review.rows || [];
  const reviewContext = { ...env.snapshotContext, ...review.context, date: review.date, dataVersion: review.dataVersion };
  const context = Object.fromEntries(routeContextKeys.filter((key) => reviewContext[key] != null).map((key) => [key, reviewContext[key]]));
  const sourceIssues = (review.sources || []).filter((source) => source.state !== 'ready' || source.unavailable?.length);
  const showSources = action(sourceIssues.length ? `Sources · ${count(sourceIssues.length)} need attention` : 'Sources', 'chartbook-sources', 'layers');
  Object.assign(actions, { 'chartbook-sources': () => sourceStatus(env, review), 'chartbook-retry': () => env.render() });
  if (!rows.length) {
    const reason = review.state === 'pending' ? 'The lists are waiting for stored analysis in this context.' : sourceIssues.length
      ? 'Some lists could not be opened in this analysis context.' : 'The selected lists have no matching stocks for this session.';
    view.innerHTML = empty(review.state === 'pending' ? 'ChartBook waiting for preparation' : 'No stocks in this ChartBook', reason, 'chart',
      `${showSources}${action('Check again', 'chartbook-retry', 'refresh')}${action('Edit book', 'chartbook-edit', 'edit')}`);
    return;
  }

  const wanted = params.symbol || (sameBook ? state.securityId : null);
  let index = Math.max(0, rows.findIndex((row) => row.securityId === wanted || row.symbol === wanted));
  let bundle = null;
  let requestId = 0;
  let dismissPoint = () => false;
  let preparingIndustry = false;
  const adding = new Set();
  const cache = new Map();
  const list = (catalog.watchlists || []).find((item) => item.id === book.definition?.defaultWatchlistId && item.writable !== false && !item.definition?.screenId);
  const bookState = list?.definition?.members || [];
  for (const member of bookState) state.bookmarks.add(storeKey(typeof member === 'string' ? member : member.securityId, list.id));
  if (list) for (const row of rows) {
    if (row.sources?.some((source) => source.type === 'watchlist' && source.id === list.id && source.version === list.version)) {
      state.bookmarks.add(storeKey(row.securityId, list.id));
    }
  }
  const active = () => env.isActive() && root.isConnected;
  const current = () => rows[index];
  const viewNote = () => state.notes.get(storeKey(current().securityId, context.date)) || bundle?.note;
  const closeTooltip = () => { dismissPoint(); dismissPoint = () => false; };
  const compareUniverse = env.config.universes?.find(({ id }) => id === context.universe)?.name || context.universe;
  view.innerHTML = `<div class="chartbook-review">
    <div class="chartbook-current" data-chartbook-current aria-live="polite"></div>
    <div class="chartbook-toolbar chartbook-chart-controls"><div class="inline-stack">
      ${rangeSegment('chartbook-range', state.range)}${layerControls(layers)}</div>
      <div class="actions">${action('Previous', 'chartbook-previous', 'chevron-left')}${action('Next', 'chartbook-next', 'chevron-right')}</div></div>
    <section class="panel chartbook-panel" aria-label="Price chart"><div class="chartbook-chart" data-chartbook-chart></div>
      <div class="chartbook-caption" data-chartbook-caption></div></section>
    <div data-chartbook-metrics></div>
    <div class="chartbook-footer"><div class="inline-stack" aria-label="Keyboard shortcuts"><kbd>Space</kbd> Next <kbd>Shift Space</kbd> / <kbd>←</kbd> Previous
      <kbd>B</kbd> Bookmark <kbd>V</kbd> Longer <kbd>M</kbd> 3M <kbd>N</kbd> Note</div>${showSources}</div></div>`;
  const chartTarget = view.querySelector('[data-chartbook-chart]');
  const caption = view.querySelector('[data-chartbook-caption]');
  const metrics = view.querySelector('[data-chartbook-metrics]');
  const currentPanel = view.querySelector('[data-chartbook-current]');

  function paintSecurity() {
    const row = { ...current(), ...bundle?.stats };
    const focused = currentPanel.contains(main.ownerDocument.activeElement) ? main.ownerDocument.activeElement.dataset.action : null;
    const note = viewNote();
    const bookmarkKey = storeKey(row.securityId, list?.id);
    const bookmarked = list && state.bookmarks.has(bookmarkKey);
    currentPanel.innerHTML = `<div class="chartbook-toolbar"><div class="chartbook-identity"><h2>${safe(row.symbol)}</h2>
      <span>${safe(row.name || '')}${row.exchange ? ` · ${safe(row.exchange)}` : ''}</span></div>
      <div class="actions chartbook-security-actions">
        <a class="button" href="${safe(env.routeUrl('stock', { ...context, symbol: row.securityId }))}">${icon('arrow-up-right')} Ticker dashboard</a>
        ${tradingViewLink(row)}${action(note?.markdown ? 'Edit note' : 'Note', 'chartbook-note', 'edit')}
        ${action(bookmarked ? 'Bookmarked' : 'Bookmark', 'chartbook-bookmark', bookmarked ? 'check' : 'watchlists', {
          disabled: bookmarked || adding.has(bookmarkKey), title: list ? `Add to ${list.name || list.label}` : 'Choose a default watchlist',
        })}</div></div>
      <div class="chartbook-subtitle"><span><strong>${count(index + 1)} / ${count(review.total ?? rows.length)}</strong> · ${safe(dateLabel(context.date))} · r${safe(context.dataVersion)}${compareUniverse ? ` · ${safe(compareUniverse)}` : ''}${sortReadout(review.sort, current())}</span>
        <div class="chartbook-badges" aria-label="Matching sources" tabindex="0">${(current().sources || []).map((source) => `<span class="chip" title="${safe(source.label || source.id)}">${safe(source.label || source.id)}</span>`).join('')}</div></div>`;
    view.querySelector('[data-action="chartbook-previous"]').disabled = index === 0;
    view.querySelector('[data-action="chartbook-next"]').disabled = index === rows.length - 1;
    if (focused) [...currentPanel.querySelectorAll('button:not(:disabled)')].find((item) => item.dataset.action === focused)?.focus();
  }

  function paintPlot() {
    closeTooltip();
    const row = { ...current(), ...bundle?.stats };
    metrics.innerHTML = chartbookStats(row);
    if (!bundle) {
      chartTarget.innerHTML = pending('Reading saved price chart…');
      caption.innerHTML = '';
      return;
    }
    const preparation = bundle.chartPreparation;
    const data = buildChartbookPlot(bundle, state.range, layers);
    const chart = renderChartbookChart(data, layers, row.symbol);
    if (!chart.html) {
      const ready = !preparation || preparation.state === 'ready';
      chartTarget.innerHTML = empty(ready ? 'No usable price bars' : 'Price chart awaiting preparation',
        preparation?.error || (ready ? 'The selected range has no usable prices in this snapshot.' : 'This chart has yet to be stored for the selected date and revision.'),
        'chart', action('Try again', 'chartbook-retry-price', 'refresh'));
    } else {
      chartTarget.innerHTML = chart.html;
      dismissPoint = bindChartbookChart(chartTarget, chart);
    }
    const priority = layers.industry && bundle.industry?.state === 'pending' ? action('Check status', 'chartbook-retry-price', 'refresh')
      : layers.industry && bundle.industry?.canPrepare ? action('Prepare industry proxy', 'chartbook-prepare-industry', 'refresh', { disabled: preparingIndustry }) : '';
    caption.innerHTML = `<p class="muted" data-chartbook-actual-range>${safe(actualRange(data.rows, state.range, bundle))}</p>
      <div class="chartbook-comparisons" aria-label="Comparison status">${comparisonReadout(data.comparisons, data.anchor, layers)}${priority}</div>`;
  }

  function evict(key) {
    const item = cache.get(key);
    if (item && !item.data) item.controller.abort();
    cache.delete(key);
  }

  function fetchBundle(row, range) {
    const found = [...cache].find(([, item]) => item.securityId === row.securityId && item.range >= range);
    if (found) {
      cache.delete(found[0]);
      cache.set(...found);
      return found[1].promise;
    }
    const key = storeKey(row.securityId, range);
    const controller = new AbortController();
    const item = { securityId: row.securityId, range, controller };
    item.promise = env.api(`${path}/stocks/${pathPart(row.securityId)}`, { signal: controller.signal, params: { ...context, lookback: range } })
      .then((data) => {
        item.data = data;
        if (data.chartPreparation?.state && data.chartPreparation.state !== 'ready' && cache.get(key) === item) cache.delete(key);
        return data;
      }).catch((error) => {
        if (cache.get(key) === item) cache.delete(key);
        throw error;
      });
    cache.set(key, item);
    while (cache.size > cacheLimit) evict(cache.keys().next().value);
    return item.promise;
  }

  function prefetch() {
    for (const row of rows.slice(index + 1, index + 1 + readAhead)) fetchBundle(row, state.range).catch(() => {});
  }

  function cancelDistantRequests() {
    const nearby = new Set(rows.slice(Math.max(0, index - 1), index + 1 + readAhead).map(({ securityId }) => securityId));
    for (const [key, item] of cache) {
      if (!item.data && (!nearby.has(item.securityId) || item.range < state.range)) evict(key);
    }
  }

  async function loadCurrent() {
    const run = ++requestId;
    cancelDistantRequests();
    const row = current();
    const range = state.range;
    paintSecurity();
    paintPlot();
    if (bundle) {
      chartTarget.setAttribute('aria-busy', 'true');
      caption.querySelector('[data-chartbook-actual-range]').textContent = 'Reading saved prices for the selected range…';
    }
    try {
      const result = await fetchBundle(row, range);
      if (!active() || run !== requestId) return;
      bundle = result;
      paintSecurity();
      paintPlot();
      if (!bundle.chartPreparation?.state || bundle.chartPreparation.state === 'ready') prefetch();
    } catch (error) {
      if (active() && run === requestId && error.name !== 'AbortError') {
        chartTarget.innerHTML = notice('Price chart unavailable', error.message, action('Retry', 'chartbook-retry-price', 'refresh'), true);
        caption.innerHTML = '';
      }
    } finally {
      if (active() && run === requestId) chartTarget.removeAttribute('aria-busy');
    }
  }

  function move(step) {
    const next = index + step;
    if (next < 0 || next >= rows.length) return;
    index = next;
    bundle = null;
    state.securityId = current().securityId;
    env.replaceParams?.({ book: book.id, symbol: state.securityId });
    return loadCurrent();
  }

  function selectRange(range) {
    if (!rangeValues.includes(range) || state.range === range) return;
    state.range = range;
    for (const control of view.querySelectorAll('[data-action="chartbook-range"]')) control.setAttribute('aria-pressed', String(Number(control.dataset.value) === range));
    return loadCurrent();
  }

  async function bookmark() {
    if (!list) return bookEditor(env, catalog, book, { watchlist: true });
    const row = current();
    const key = storeKey(row.securityId, list.id);
    if (state.bookmarks.has(key) || adding.has(key)) return;
    adding.add(key);
    paintSecurity();
    try {
      await env.api(`watchlists/${pathPart(list.id)}/members`, { signal, plain: true, body: { add: [row.securityId] } });
      state.bookmarks.add(key);
      if (active()) env.toast(`${row.symbol} added to ${list.name || list.label}`);
    } catch (error) {
      if (active() && error.name !== 'AbortError') env.toast(error.message);
    } finally {
      adding.delete(key);
      if (active()) paintSecurity();
    }
  }

  async function editNote() {
    const row = current();
    const key = storeKey(row.securityId, context.date);
    const path = `chartbooks/notes/${pathPart(row.securityId)}`;
    const shown = viewNote();
    const body = env.showDialog(env.modal, `${row.symbol} note`, `<form class="stack chartbook-editor">
      ${field('Note', `<textarea name="note" rows="8" maxlength="20000" autofocus>${safe(state.noteDrafts.get(key) ?? shown?.markdown ?? '')}</textarea>`)}
      <p class="form-error" role="alert" hidden></p><div class="actions"><button type="submit" class="button primary">${icon('check')} Save note</button>
      <button type="button" class="button" data-action="close-dialog">Cancel</button></div></form>`, dateLabel(context.date));
    const input = body.querySelector('[name="note"]');
    const submit = body.querySelector('[type="submit"]');
    input.oninput = () => state.noteDrafts.set(key, input.value);
    body.onsubmit = async (event) => {
      event.preventDefault();
      submit.disabled = true;
      try {
        const note = await env.api(path, { method: 'PUT', signal, params: context, body: { markdown: input.value } });
        state.notes.set(key, note);
        state.noteDrafts.delete(key);
        if (!active()) return;
        if (body.isConnected && env.modal.open) env.modal.close();
        paintSecurity();
        env.toast(`Saved ${row.symbol} note`);
      } catch (error) {
        if (error.name !== 'AbortError') showFormError(body, error);
      } finally {
        submit.disabled = false;
      }
    };
    if (shown == null && !state.noteDrafts.has(key)) {
      submit.disabled = true;
      try {
        const note = await env.api(path, { signal, params: context });
        if (!body.isConnected || !env.modal.open) return;
        if (note) state.notes.set(key, note);
        if (!state.noteDrafts.has(key)) input.value = note?.markdown || '';
      } catch (error) {
        if (error.name !== 'AbortError' && error.status !== 404) showFormError(body, error);
      } finally {
        submit.disabled = false;
      }
    }
  }

  function refreshPrice() {
    for (const [key, item] of cache) if (item.securityId === current().securityId) evict(key);
    bundle = null;
    return loadCurrent();
  }

  async function prepareIndustry() {
    if (preparingIndustry || !bundle?.industry?.canPrepare) return;
    preparingIndustry = true;
    paintPlot();
    try {
      await env.api(`${path}/prepare`, { signal, body: { context: reviewContext }, params: context });
      if (active()) return refreshPrice();
    } catch (error) {
      if (active() && error.name !== 'AbortError') env.toast(error.message);
    } finally {
      preparingIndustry = false;
      if (active()) paintPlot();
    }
  }

  Object.assign(actions, {
    'chartbook-next': () => move(1),
    'chartbook-previous': () => move(-1),
    'chartbook-range': (value) => selectRange(Number(value)),
    'chartbook-layer': (key, button) => {
      if (!Object.hasOwn(layers, key)) return;
      layers[key] = !layers[key];
      button.setAttribute('aria-pressed', String(layers[key]));
      paintPlot();
    },
    'chartbook-bookmark': bookmark,
    'chartbook-note': editNote,
    'chartbook-retry-price': refreshPrice,
    'chartbook-prepare-industry': prepareIndustry,
  });
  const shortcuts = { next: () => move(1), previous: () => move(-1), bookmark, note: editNote,
    longer: () => selectRange(rangeValues[Math.min(rangeValues.length - 1, rangeValues.indexOf(state.range) + 1)]),
    'three-months': () => selectRange(63) };
  function handleKey(event) {
    if (!active()) return;
    const document = main.ownerDocument;
    const blocked = document.querySelector('dialog[open]') || document.body.classList.contains('nav-open');
    const key = chartbookShortcut(event, Boolean(blocked));
    if (key === 'dismiss') {
      if (dismissPoint()) event.preventDefault();
      return;
    }
    if (!shortcuts[key]) return;
    event.preventDefault();
    shortcuts[key]();
  }
  const owner = main.ownerDocument;
  const settledJobs = new Set();
  function followIndustry(event) {
    const id = bundle?.industry?.preparation?.jobId;
    if (!active() || !id || settledJobs.has(id) || owner.querySelector('dialog[open]')) return;
    const job = event.detail?.find((item) => item.id === id && ['complete', 'failed', 'cancelled'].includes(item.status));
    if (!job) return;
    settledJobs.add(id);
    for (const [key, item] of cache) if (item.data?.industry?.preparation?.jobId === id) evict(key);
    refreshPrice();
  }
  owner.addEventListener('keydown', handleKey);
  owner.addEventListener('warehouse:jobs', followIndustry);
  signal?.addEventListener('abort', () => {
    owner.removeEventListener('keydown', handleKey);
    owner.removeEventListener('warehouse:jobs', followIndustry);
    for (const key of cache.keys()) evict(key);
  }, { once: true });
  state.securityId = current().securityId;
  env.replaceParams?.({ book: book.id, symbol: state.securityId });
  await loadCurrent();
}
