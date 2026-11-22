import { chart, chartColors, disposeChartNoteBindings } from './charts.js';
import { chartRanges, rangeSegment } from './chart-ranges.js';
import { chartbookDefaultRange, chartbookShortcut } from './chartbook-ui.js';
import { loadResearchNotes, noteSubject, openResearchNoteEditor } from './research-notes.js';
import { setTickerPreviewContext } from './ticker-preview.js';
import { action, compact, count, dateLabel, empty, field, icon, notice, number, numeric, option, pagination, pathPart, pending, percent, ratio, safe, segment, table } from './ui.js';

const ranges = chartRanges.map(([value]) => value);
const scopes = [['combined', 'Combined'], ['market', 'Market'], ['industries', 'Industries']];
const contextKeys = ['date', 'dataVersion', 'universe', 'universeVersion', 'model', 'modelVersion', 'basis', 'benchmark',
  'classification', 'reference', 'observedReferenceDate', 'healthModel'];
const memberColumns = ['symbol', 'name', 'close', 'return_1d', 'rsPercentile', 'velocity4w'];
const membersPerPage = 30;
const mint = '#58e2c3', red = '#ff8c94', blue = '#84a9fa';
const pairing = (key, title, up, down, description) => ({ key, title, description, kind: 'breadth',
  series: [{ key: up, label: up.startsWith('new_high') ? 'New highs' : 'Up', color: mint },
    { key: down, label: down.startsWith('new_low') ? 'New lows' : 'Down', color: red }] });
const momentum = (key, window, threshold, title) => {
  const suffix = window > 1 ? `_${window}d` : '';
  return pairing(key, title, `up_${threshold}pct${suffix}`, `down_${threshold}pct${suffix}`,
    `Share of comparable stocks up at least ${threshold}% or down at least ${threshold}% over ${window} trading ${window === 1 ? 'session' : 'sessions'}.`);
};

export function marketReviewCards(metrics = []) {
  const cards = [
    momentum('daily-4', 1, 4, 'Daily 4% movers'),
    { key: 'participation-ratios', title: '5- and 10-session participation ratios', kind: 'ratios',
      description: 'Sum of daily percentages of comparable stocks up at least 4%, divided by the sum for stocks down at least 4%. Each session carries equal weight.',
      series: [5, 10].map((n, index) => ({ key: `ratio${n}`, label: `${n} sessions`, color: chartColors[index], format: ratio })) },
    momentum('quarter-25', 63, 25, 'Quarterly 25% moves · 63 sessions'),
    momentum('month-25', 20, 25, 'Monthly 25% moves · 20 sessions'),
    momentum('month-50', 20, 50, 'Monthly 50% moves · 20 sessions'),
    momentum('rolling-13-34', 34, 13, '34-session 13% moves'),
    { key: 'sma-participation', title: 'Moving-average participation', description: 'Share of comparable stocks above each simple moving average.',
      kind: 'breadth', series: [10, 20, 50, 100, 150, 200].map((n) => ({ key: `above_${n}d`, label: `${n}D SMA` })) },
    { key: 'advance-decline', title: 'Advancers and decliners', description: 'Positive, negative, and unchanged close-to-close returns.',
      kind: 'breadth', series: ['advancers', 'decliners', 'unchanged'].map((key, index) => ({ key, label: key, color: [mint, red, blue][index] })) },
    { key: 'ad-spread', title: 'Advance / decline spread', description: 'Advancing share minus declining share in percentage points.', kind: 'breadth',
      series: [{ key: 'adSpread', label: 'Advance / decline spread', format: (value) => numeric(value) ? `${number(value)} pp` : '—' }] },
    ...[20, 252].map((n) => pairing(`highlow-${n}`, `New ${n === 252 ? '52-week' : '20-session'} highs and lows`,
      `new_high_${n}d`, `new_low_${n}d`, 'Share of comparable stocks reaching a new high or low.')),
    ...[['dollar', 'Dollar volume'], ['shares', 'Share volume']].map(([key, title]) => ({
      key: `${key}-volume`, title, kind: 'volume', description: `${title} in advancing and declining stocks with usable volume.`,
      series: ['up', 'down'].map((side, index) => ({ key: side + (key === 'dollar' ? 'Dollar' : 'Volume'),
        label: index ? 'Declining' : 'Advancing', color: index ? red : mint, format: (value) => compact(value, key === 'dollar') })),
    })),
    { key: 'nyse-summation', title: 'NYSE Summation Index proxy', description: 'Observed NYSE common-stock summation and its 10- and 20-session SMAs.',
      kind: 'summation', series: [{ key: 'value', label: 'Observed NYSE proxy', color: mint },
        { key: 'sma10', label: '10D SMA', color: '#8cafac' }, { key: 'sma20', label: '20D SMA', color: '#97a5c7', dash: true }] },
    { key: 'market-health', title: 'Market health', description: 'Stored composite from the selected health model.', kind: 'health',
      series: [{ key: 'score', label: 'Composite score', color: mint, format: (value) => numeric(value) ? `${number(value)} / 100` : '—' }] },
  ];
  const represented = new Set(cards.flatMap(({ series }) => series.map(({ key }) => key)));
  for (const [key, label, definition] of metrics.map(({ key, label, definition }) => [key, label, definition])) {
    if (!key || represented.has(key)) continue;
    cards.push({ key: `breadth-${key}`, title: label, description: definition, kind: 'breadth', series: [{ key, label }] });
    represented.add(key);
  }
  return cards;
}

function ratioAt(rows, index, length) {
  if (index + 1 < length) return null;
  const pairs = rows.slice(index - length + 1, index + 1).map(({ breadth }) => [breadth?.up_4pct?.[0], breadth?.down_4pct?.[0]]);
  if (pairs.some((pair) => !pair.every(numeric))) return null;
  const [up, down] = pairs.reduce(([a, b], [left, right]) => [a + left, b + right], [0, 0]);
  return down > 0 ? up / down : up > 0 ? 'infinity' : null;
}

export function buildMarketReviewRows(history, card, lookback) {
  return history.map((row, index) => {
    if (card.kind === 'ratios') {
      const value = { date: row.date };
      for (const n of [5, 10]) {
        const reading = ratioAt(history, index, n);
        value[`ratio${n}`] = numeric(reading) ? reading : null;
        if (reading === 'infinity') value[`ratio${n}State`] = 'infinity';
      }
      return value;
    }
    if (card.kind === 'volume') return { date: row.date, ...row.volume };
    const reading = { date: row.date };
    for (const { key } of card.series) {
      const [value, numerator, denominator] = row.breadth?.[key] ?? [];
      reading[key] = value ?? null;
      if (numeric(denominator)) reading[`${key}Sample`] = [numerator, denominator];
    }
    return reading;
  }).slice(-lookback);
}

export function buildIndustryReview(bundle, lookback) {
  const values = new Map((bundle.industry?.rows || []).map((row) => [row.date, row]));
  const spy = new Map((bundle.benchmark?.rows || []).map(({ date, close }) => [date, close]));
  const positive = (value) => numeric(value) && value > 0;
  const samples = [];
  const points = (bundle.sessions || [...values.keys()]).map((date) => {
    const source = values.get(date);
    const level = positive(source?.value) ? source.value : null;
    const point = { date, level, benchmark: positive(spy.get(date)) ? spy.get(date) : null,
      expected: source?.expected ?? null, observations: source?.observations ?? null };
    if (level == null) samples.length = 0;
    else {
      samples.push(level);
      if (samples.length > 50) samples.shift();
      for (const n of [20, 50]) point[`sma${n}`] = samples.length >= n
        ? samples.slice(-n).reduce((sum, item) => sum + item, 0) / n : null;
    }
    return point;
  }).slice(-lookback);
  const shared = points.filter(({ level, benchmark }) => positive(level) && positive(benchmark));
  const compare = shared.length >= 2;
  const anchor = compare ? shared[0] : points.find(({ level }) => positive(level));
  const rows = points.map(({ date, level, benchmark, sma20, sma50, expected, observations }) => {
    const shown = anchor && date >= anchor.date && level != null;
    return { date, industry: shown ? 100 * level / anchor.level : null,
      benchmark: shown && compare && benchmark != null ? 100 * benchmark / anchor.benchmark : null,
      sma20: shown && sma20 != null ? 100 * sma20 / anchor.level : null, sma50: shown && sma50 != null ? 100 * sma50 / anchor.level : null,
      expected, observations };
  });
  return { rows, anchor: anchor?.date ?? null, compare };
}

const industrySeries = [
  { key: 'industry', label: 'Industry equal-weight', color: mint }, { key: 'benchmark', label: 'SPY · S&P 500 ETF', color: blue, dash: true },
  { key: 'sma20', label: '20D industry SMA', color: '#8cafac' }, { key: 'sma50', label: '50D industry SMA', color: '#a2a9bd', dash: true },
];

function enableStyles(document) {
  if (document.querySelector('link[data-market-review-style]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/market-review.css';
  link.dataset.marketReviewStyle = '';
  document.head.append(link);
}

function noteIdentity(card, context) {
  return noteSubject(card.kind === 'industry' ? 'industry' : 'market', card.kind === 'industry' ? card.group.id : card.key, context);
}

function breadthDescription(row, card) {
  if (card.kind === 'ratios') return [5, 10].flatMap((n) => row[`ratio${n}State`] === 'infinity'
    ? [`${n} sessions: no down-4% share in the comparison window`] : []);
  const samples = card.series.filter(({ key }) => Array.isArray(row[`${key}Sample`]));
  return samples.map(({ key, label }) => `${label}: ${row[`${key}Sample`].map(count).join(' / ')}`);
}

function frameCaption(rows, keys, requested) {
  const dated = rows.filter((row) => keys.some((key) => numeric(row[key])));
  return dated.length ? `${count(dated.length)} of ${count(requested)} requested sessions · ${dateLabel(dated[0].date)} – ${dateLabel(dated.at(-1).date)}`
    : `No prepared readings in the ${count(requested)}-session range`;
}

function constituentDrawer(env, context, calculationVersion, activeCard) {
  const { detail } = env;
  let drawer;

  function close(dismiss = true) {
    if (!drawer) return;
    const { body, request, onClose, onReplace } = drawer;
    drawer = null;
    request?.abort();
    detail.removeEventListener('close', onClose);
    detail.removeEventListener('workspace:dialog-change', onReplace);
    body.replaceChildren();
    if (dismiss && detail.open && detail.contains(body)) detail.close();
  }

  async function load(item, focusResults = false) {
    const { card, body, results, status, clear } = item;
    item.request?.abort();
    const request = item.request = new AbortController();
    const current = () => drawer === item && item.request === request && !request.signal.aborted &&
      detail.open && body.isConnected && activeCard(card);
    const retry = action('Retry', 'market-review-members-retry', 'refresh');
    status.textContent = '';
    clear.hidden = !item.search;
    results.innerHTML = pending('Loading constituent rankings…');
    try {
      const result = await env.api(`industries/${pathPart(card.group.id)}/members`, { plain: true, signal: request.signal,
        params: { ...context, page: item.page, perPage: membersPerPage, ...(item.search && { search: item.search }) } });
      if (!current()) return;
      if (result.pendingOnly) {
        results.innerHTML = notice('Constituent rankings unavailable', 'Member rankings are awaiting preparation for this session and revision.', retry);
      } else {
        if (result.date !== context.date || result.dataVersion != null && Number(result.dataVersion) !== Number(context.dataVersion) ||
          !Array.isArray(result.rows) || !Number.isSafeInteger(result.total)) throw new Error('Member rankings did not match this analysis session.');
        if (result.rows.length) {
          results.innerHTML = table(result.rows, memberColumns, { label: `${card.title} constituents`, cells: {
            symbol: (row) => `<a class="stock-link mono" href="${safe(env.routeUrl('stock', { ...context, symbol: row.securityId || row.symbol }))}">${safe(row.symbol || row.securityId)}</a>`,
          } }) + pagination(result, 'market-review-members-page');
          status.textContent = `${count(result.total)} ${item.search ? 'matching' : 'constituent'} stocks · Page ${count(result.page)}`;
        } else {
          results.innerHTML = item.search ? empty('No matching stocks', 'Try a different ticker or company name.', 'search')
            : empty('No constituent stocks', 'There are no traded members for this industry in the selected analysis session.', 'layers');
        }
      }
    } catch (error) {
      if (!current() || error.name === 'AbortError') return;
      results.innerHTML = notice('Could not load constituent rankings', error.message, retry, true);
    } finally {
      if (current()) {
        item.request = null;
        if (focusResults && !detail.contains(body.ownerDocument.activeElement))
          (results.querySelector('.table-scroll, [data-action="market-review-members-retry"]') || item.input).focus({ preventScroll: true });
      }
    }
  }

  function open(card, opener) {
    if (card?.kind !== 'industry' || !context.date || !detail || detail.open || !activeCard(card)) return;
    close(false);
    const body = env.showDialog(detail, `${card.title} · Stocks`, `<div class="market-review-members">
      <form class="market-review-members-search" role="search" aria-label="Search industry stocks">
        ${field('Ticker or company', '<input type="search" name="search" maxlength="100" autocomplete="off">')}
        <button class="button" type="submit">Search</button>
        <button class="button ghost" type="button" data-review-members-clear hidden>Clear search</button>
      </form>
      <p class="muted market-review-members-hint">Sorted by RS rank. Hover or focus a ticker for a 3M chart, or select it for full stats.</p>
      <p class="sr-only" role="status" data-review-members-status></p>
      <div data-review-members-results></div></div>`, `Session ${dateLabel(context.date)} · r${context.dataVersion}`, opener);
    setTickerPreviewContext(body, { ...context, ...(calculationVersion && { calculationVersion }) });
    const form = body.querySelector('form');
    const input = form.elements.namedItem('search');
    const item = drawer = { card, body, input, page: 1, search: '', clear: body.querySelector('[data-review-members-clear]'),
      results: body.querySelector('[data-review-members-results]'), status: body.querySelector('[data-review-members-status]'),
      onClose: () => { if (!detail.open && drawer === item) close(false); },
      onReplace: () => { if (drawer === item) close(false); } };
    detail.addEventListener('close', item.onClose);
    detail.addEventListener('workspace:dialog-change', item.onReplace);
    function search(next) {
      if (drawer !== item || !detail.open || !activeCard(card) || (next === item.search && item.page === 1)) return;
      item.search = next;
      item.page = 1;
      return load(item);
    }
    form.addEventListener('submit', (event) => { event.preventDefault(); search(input.value.trim()); });
    item.clear.addEventListener('click', () => { input.value = ''; input.focus({ preventScroll: true }); search(''); });
    return load(item);
  }

  return {
    open, close,
    page(value) {
      const page = Number(value);
      if (!drawer || !detail.open || !Number.isSafeInteger(page) || page < 1 || page === drawer.page) return;
      drawer.page = page;
      return load(drawer, true);
    },
    retry() { if (drawer && detail.open) return load(drawer, true); },
  };
}

export async function renderMarketReview(env, tabs) {
  const { main, signal, params, state } = env;
  const document = main.ownerDocument;
  enableStyles(document);
  main.innerHTML = `<section class="chartbook-workspace market-review" data-market-review tabindex="-1">
    <header class="chartbook-toolbar"><h1>ChartBook</h1><div data-review-tabs>${tabs()}</div></header><div data-review-view>${pending('Reading the Market and Industry ChartBook…')}</div></section>`;
  const root = main.querySelector('[data-market-review]');
  const view = root.querySelector('[data-review-view]');
  const catalog = await env.api('chartbooks/market', { signal });
  if (!env.isActive()) return;
  const resultContext = { ...env.snapshotContext, ...catalog.context, date: catalog.date, dataVersion: catalog.dataVersion };
  const context = Object.fromEntries(contextKeys.filter((key) => resultContext[key] != null).map((key) => [key, resultContext[key]]));
  root.querySelector('[data-review-tabs]').innerHTML = tabs(context);
  const selectedDeck = catalog.decks?.find(({ id }) => id === params.deck);
  const included = selectedDeck?.definition.industryIds && new Set(selectedDeck.definition.industryIds);
  const marketCards = marketReviewCards(catalog.metrics);
  const groups = (catalog.industries || []).filter(({ id }) => !included || included.has(id));
  const industries = groups.map((group) => ({ key: `industry:${group.id}`, title: group.name, group, kind: 'industry' }));
  const sources = new Map(), noteCache = new Map();
  const controllers = new Set();
  const active = () => env.isActive() && root.isConnected && !signal?.aborted;
  let scope = scopes.find(([id]) => id === params.reviewView)?.[0] || selectedDeck?.definition.view || 'combined';
  let deck, current = null, index, frame, notes, noteError, loadNumber = 0, noteRead = 0;
  let range = ranges.includes(state.marketReviewRange) ? state.marketReviewRange : chartbookDefaultRange;
  let preparing = false;
  const constituents = constituentDrawer(env, context, catalog.context?.calculationVersion, (card) => active() && current === card);
  const visibleDeck = () => [...(scope !== 'industries' ? marketCards : []), ...(scope !== 'market' ? industries : [])];
  function selectDeck(wanted) {
    deck = visibleDeck();
    index = Math.max(0, deck.findIndex(({ key }) => key === wanted));
    current = deck[index];
  }
  selectDeck(params.card);

  function cached(path, requested, extra = {}, retry = false) {
    const key = JSON.stringify([path, requested, extra]);
    if (retry) sources.delete(key);
    if (sources.has(key)) return sources.get(key);
    const controller = new AbortController();
    controllers.add(controller);
    const request = env.api(path, { signal: controller.signal, params: { ...context, ...extra, ...(requested && { lookback: requested }) } })
      .catch((error) => { sources.delete(key); throw error; }).finally(() => controllers.delete(controller));
    sources.set(key, request);
    if (sources.size > 12) sources.delete(sources.keys().next().value);
    return request;
  }

  async function cardFrame(card, retry) {
    if (card.kind === 'industry') {
      const result = await cached(`chartbooks/market/industries/${pathPart(card.group.id)}`, range, {}, retry);
      const projected = buildIndustryReview(result, range);
      return { ...projected, source: result.industry, series: industrySeries.filter(({ key }) => key !== 'benchmark' || projected.compare),
        benchmarkState: result.benchmark?.state, description: result.industry?.label || 'Stored industry comparison', state: result.state };
    }
    if (card.kind === 'summation') {
      const result = await cached('market/summation', null, { limit: range }, retry);
      return { rows: result.rows || [], series: card.series, description: card.description, state: result.status };
    }
    if (card.kind === 'health') {
      const coverageMode = params.coverage === 'observed' ? 'observed' : 'verified';
      const result = await cached('chartbooks/market/health', range, { coverageMode,
        ...(coverageMode === 'observed' && params.observedMinimum && { observedMinimum: params.observedMinimum }),
        ...(coverageMode === 'observed' && params.observedThreshold && { observedThreshold: params.observedThreshold }) }, retry);
      return { rows: result.rows || [], series: card.series, description: coverageMode === 'observed'
        ? 'Observed universe · descriptive health' : 'Verified coverage · stored market health', state: result.state };
    }
    const result = await cached('chartbooks/market/history', range, {}, retry);
    return { rows: buildMarketReviewRows(result.rows || [], card, range), state: result.state,
      series: card.series.map((line) => ({ format: percent, ...line })), description: card.description };
  }

  const noteKey = (subject) => JSON.stringify([subject.type, subject.id]);

  function notesForRange(subject, from) {
    const key = noteKey(subject);
    if (!noteCache.has(key)) noteCache.set(key, new Map());
    const cachedRanges = noteCache.get(key);
    if (!cachedRanges.has(from)) {
      cachedRanges.set(from, loadResearchNotes(env, subject, { from, to: catalog.date, signal }).catch((error) => {
        cachedRanges.delete(from);
        throw error;
      }));
    }
    return cachedRanges.get(from);
  }

  async function refreshNotes(card, rows, run = loadNumber) {
    if (!catalog.date) return;
    const read = ++noteRead;
    const from = rows[0]?.date ?? catalog.date;
    const subjects = [noteIdentity(card, context)];
    if (card.kind !== 'industry') subjects.push(noteSubject('market', 'journal', context));
    const results = await Promise.allSettled(subjects.map((subject) => notesForRange(subject, from)));
    if (!active() || loadNumber !== run || noteRead !== read) return;
    notes = results.flatMap((result, index) => result.status === 'fulfilled'
      ? result.value.filter((note) => index === 0 || note.source === 'journal-note') : []);
    const problem = results.find((result) => result.status === 'rejected' && result.reason?.name !== 'AbortError');
    noteError = problem?.reason?.message || (problem && 'Some chart notes could not be loaded.');
    if (notes.length || noteError || view.querySelector('[data-review-note-error]')) paint();
  }

  function paint() {
    disposeChartNoteBindings(view);
    if (!current) {
      view.querySelector('[data-review-card]').innerHTML = empty('No prepared industries', 'Industry groups have yet to be stored for this selection.', 'chart',
        action('Check again', 'market-review-reload', 'refresh'));
      return;
    }
    const body = view.querySelector('[data-review-card]');
    const { title, kind, group } = current;
    const intro = group ? [group.parent, numeric(group.rank) && `Rank ${count(group.rank)}`].filter(Boolean).join(' · ') : '';
    const members = kind === 'industry' && catalog.date ? `<button class="button market-review-stocks" type="button" data-action="market-review-members"
      aria-haspopup="dialog" aria-controls="detail">${icon('layers')}Stocks${numeric(group.count) ? ` (${count(group.count)})` : ''}</button>` : '';
    const toolbar = `<div class="chartbook-toolbar"><div><h2>${safe(title)}</h2>${intro ? `<p class="muted">${safe(intro)}</p>` : ''}</div>
      <div class="actions">${action('Previous', 'market-review-prev', 'chevron-left', { disabled: index === 0 })}
      ${action('Next', 'market-review-next', 'chevron-right', { disabled: index === deck.length - 1 })}
      ${members}${action('Note', 'market-review-note', 'edit', { disabled: !catalog.date })}</div></div>
      <div class="market-review-range">${rangeSegment('market-review-range', range)}<span class="muted">${count(index + 1)} / ${count(deck.length)} · ${safe(dateLabel(catalog.date))} · r${safe(catalog.dataVersion)}</span></div>`;
    if (!frame) { body.innerHTML = toolbar + pending('Reading prepared chart history…'); return; }
    if (frame.error) {
      body.innerHTML = toolbar + notice('History unavailable', frame.error, action('Check again', 'market-review-reload', 'refresh'), true);
      return;
    }
    const { rows, series, source, anchor } = frame;
    const hasReadings = rows.some((row) => series.some(({ key }) => numeric(row[key])));
    const domain = kind === 'breadth' ? current.key === 'ad-spread' ? [-100, 100] : [0, 100] : kind === 'health' ? [0, 100] : null;
    const infiniteRatio = kind === 'ratios' && [5, 10].filter((n) => rows.at(-1)?.[`ratio${n}State`] === 'infinity').map((n) => `${n} sessions: ∞`);
    const whyMissing = infiniteRatio?.length ? 'The down side was zero in the latest comparison window.'
      : frame.state === 'unprepared' || source?.state === 'pending' ? 'This history is awaiting preparation for the selected date and revision.'
        : source?.reason || 'No comparable prepared values for this range.';
    const proxyAction = source?.canPrepare && kind === 'industry'
      ? action('Prepare current-membership proxies', 'market-review-prepare', 'refresh', { disabled: preparing }) : '';
    const secLink = kind === 'industry' && !hasReadings && context.classification === 'nasdaq' &&
      env.config.classificationSystems?.includes('sec-sic')
      ? `<a class="button" href="${safe(env.routeUrl('chartbook', { ...context, classification: 'sec-sic', reference: 'as-of', observedReferenceDate: null,
        mode: 'market', reviewView: 'industries' }))}">Use filing-dated SEC industries</a>` : '';
    const description = [frame.description, infiniteRatio?.length && infiniteRatio.join(' · '), kind === 'industry' && anchor && `Rebased to 100 on ${dateLabel(anchor)}`,
      kind === 'industry' && !frame.compare && 'SPY comparison unavailable', source?.reason].filter(Boolean).join(' · ');
    const plot = hasReadings ? chart(rows, series, {
      label: title, width: 1080, height: 375, ...(domain && { domain }), notes, onNoteEdit: editNote, noteSignal: signal,
      describePoint: (row) => kind === 'industry' && numeric(row.expected)
        ? [numeric(row.observations) ? `${count(row.observations)} / ${count(row.expected)} stocks` : `${count(row.expected)} industry members`]
        : breadthDescription(row, current),
    }) : empty(infiniteRatio?.length ? 'No finite ratios to plot' : 'No comparable observations', whyMissing, 'chart',
      action('Check again', 'market-review-reload', 'refresh'));
    body.innerHTML = toolbar + `<div class="market-review-plot">${plot}</div>` +
      `<div class="market-review-caption"><p class="muted">${safe(frameCaption(rows, series.map(({ key }) => key), range))}</p>
      ${description ? `<p class="muted">${safe(description)}</p>` : ''}${proxyAction}${secLink}</div>` +
      (noteError ? `<div data-review-note-error>${notice('Chart notes unavailable', noteError,
        action('Retry notes', 'market-review-retry-notes', 'refresh'), true)}</div>` : '');
  }

  async function load(retry = false) {
    const run = ++loadNumber;
    frame = null;
    notes = [];
    noteError = null;
    paint();
    const card = current;
    if (!card) return;
    try {
      const data = await cardFrame(card, retry);
      if (!active() || run !== loadNumber) return;
      frame = data;
      paint();
      const nearby = deck[index + 1];
      if (nearby?.kind === 'industry' && card.kind === 'industry' && data.rows.some((row) => numeric(row.industry))) {
        cached(`chartbooks/market/industries/${pathPart(nearby.group.id)}`, range).catch(() => {});
      }
      await refreshNotes(card, data.rows, run);
    } catch (error) {
      if (!active() || run !== loadNumber || error.name === 'AbortError') return;
      frame = { error: error.message };
      paint();
    }
  }

  function editNote(note) {
    if (!current || !catalog.date) return;
    const card = current;
    const subject = note?.source === 'journal-note' ? noteSubject('market', 'journal', context) : noteIdentity(card, context);
    const date = note?.date || catalog.date;
    openResearchNoteEditor(env, { subject, date, note: note || notes?.find((item) => item.source !== 'journal-note' && item.date === date),
      onSave: (saved) => {
        noteCache.delete(noteKey(subject));
        if (!active() || !frame?.rows || !(current === card || subject.id === 'journal' && current?.kind !== 'industry')) return;
        notes = [...notes.filter(({ id }) => id !== saved.id), saved];
        paint();
        void refreshNotes(current, frame.rows);
      } });
  }

  function move(offset) {
    if (!deck[index + offset]) return;
    constituents.close();
    index += offset;
    current = deck[index];
    env.replaceParams?.({ card: current.key });
    return load();
  }

  function changeRange(next) {
    if (!ranges.includes(next) || next === range) return;
    range = state.marketReviewRange = next;
    root.focus({ preventScroll: true });
    return load();
  }

  function saveDeck() {
    const old = selectedDeck?.definition;
    const chosen = old?.industryIds == null ? null : new Set(old.industryIds);
    const body = env.showDialog(env.modal, selectedDeck ? 'Edit review deck' : 'Save review deck', `<form class="stack market-review-editor">
      ${field('Deck name', `<input name="name" required maxlength="100" value="${safe(selectedDeck?.name || '')}" autofocus>`)}
      ${field('Part of ChartBook', `<select name="view">${scopes.map(([id, label]) => option(id, label, scope)).join('')}</select>`)}
      <label class="checkbox-label"><input name="all" type="checkbox"${chosen ? '' : ' checked'}> All available industries</label>
      <fieldset class="market-review-picker"><legend>Specific industries</legend>
        ${(catalog.industries || []).map(({ id, name }) => `<label class="checkbox-label"><input type="checkbox" name="industry" value="${safe(id)}"${chosen?.has(id) ? ' checked' : ''}> ${safe(name)}</label>`).join('')}</fieldset>
      <p class="form-error" role="alert" hidden></p><div class="actions"><button class="button primary" type="submit">Save deck</button>
      <button class="button" type="button" data-action="close-dialog">Cancel</button></div></form>`);
    body.onsubmit = async (event) => {
      event.preventDefault();
      const form = new FormData(event.target);
      const button = event.target.querySelector('[type=submit]');
      button.disabled = true;
      try {
        const result = await env.api(`chartbooks/market/decks${selectedDeck ? '/' + pathPart(selectedDeck.id) : ''}`,
          { signal, method: selectedDeck ? 'PUT' : 'POST', body: { name: String(form.get('name')).trim(),
            definition: { view: form.get('view'), industryIds: form.has('all') ? null : form.getAll('industry') } } });
        if (!active()) return;
        env.modal.close();
        env.go('chartbook', { ...context, mode: 'market', deck: result.id, reviewView: null, card: null });
      } catch (error) {
        if (error.name === 'AbortError') return;
        const alert = body.querySelector('[role=alert]');
        alert.textContent = error.message;
        alert.hidden = false;
      } finally { button.disabled = false; }
    };
  }

  view.innerHTML = `<div class="chartbook-toolbar market-review-controls"><div class="actions">${segment('market-review-view', scopes, scope)}
    <label><span class="sr-only">ChartBook deck</span><select data-change="market-review-deck" aria-label="ChartBook deck">
      ${option('', 'All Market and Industry charts', selectedDeck?.id || '')}${(catalog.decks || []).map(({ id, name }) => option(id, name, selectedDeck?.id)).join('')}</select></label>
    ${action(selectedDeck ? 'Edit deck' : 'Save deck', 'market-review-save-deck', 'edit')}</div>
    <p class="muted market-review-shortcuts"><kbd>Space</kbd> Next · <kbd>Shift + Space</kbd> Previous · <kbd>N</kbd> Note · <kbd>V</kbd> Longer · <kbd>M</kbd> 3M</p></div>
    <section class="panel panel-body" data-review-card></section>`;
  const actions = {
    'market-review-next': () => move(1), 'market-review-prev': () => move(-1),
    'market-review-members': (_value, opener) => constituents.open(current, opener),
    'market-review-members-page': constituents.page, 'market-review-members-retry': constituents.retry,
    'market-review-range': (value) => changeRange(Number(value)), 'market-review-note': () => editNote(),
    'market-review-retry-notes': () => current && frame?.rows && refreshNotes(current, frame.rows),
    'market-review-reload': () => current ? load(true) : env.render(),
    'market-review-save-deck': saveDeck,
    'change:market-review-deck': (id) => env.go('chartbook', { ...context, mode: 'market', deck: id || null, reviewView: null, card: null }),
    'market-review-view': (value) => {
      if (!scopes.some(([id]) => id === value) || value === scope) return;
      constituents.close();
      scope = value;
      selectDeck(current?.key);
      env.replaceParams?.({ reviewView: scope, card: current?.key ?? null });
      for (const button of view.querySelectorAll('[data-action="market-review-view"]')) button.setAttribute('aria-pressed', String(button.dataset.value === scope));
      root.focus({ preventScroll: true });
      return load();
    },
    async 'market-review-prepare'() {
      if (preparing) return;
      preparing = true;
      paint();
      try {
        await env.api('chartbooks/market/prepare', { signal, method: 'POST', body: { context } });
        env.toast('Industry proxy preparation requested');
        if (active()) await load(true);
      } catch (error) {
        if (active() && error.name !== 'AbortError') env.toast(error.message);
      } finally { preparing = false; if (active()) paint(); }
    },
  };
  env.setActions(actions);
  const shortcuts = { next: () => move(1), previous: () => move(-1), note: () => editNote(),
    longer: () => changeRange(ranges[Math.min(ranges.length - 1, ranges.indexOf(range) + 1)]), 'three-months': () => changeRange(63) };
  const keydown = (event) => {
    if (!active() || !current || (event.key === ' ' && event.target?.closest?.('button, a, summary'))) return;
    const blocked = !!document.querySelector('dialog[open]') || document.body.classList.contains('nav-open');
    const command = chartbookShortcut(event, blocked);
    if (!blocked && event.key === 'ArrowRight' && !event.defaultPrevented && !event.target?.closest?.('input, textarea, select, [contenteditable], [role=textbox]') &&
        !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing) {
      event.preventDefault();
      move(1);
    } else if (shortcuts[command]) { event.preventDefault(); shortcuts[command](); }
  };
  document.addEventListener('keydown', keydown);
  signal?.addEventListener('abort', () => {
    document.removeEventListener('keydown', keydown);
    constituents.close();
    for (const controller of controllers) controller.abort();
    disposeChartNoteBindings(view);
  }, { once: true });
  if (current) env.replaceParams?.({ card: current.key });
  await load();
}
