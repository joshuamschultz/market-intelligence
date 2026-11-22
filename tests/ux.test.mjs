import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { marketUniverses } from '../frontend/coverage.js';

const html = await readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
const guide = await readFile(new URL('../frontend/help-content.json', import.meta.url), 'utf8');
const stylesheet = await readFile(new URL('../frontend/styles.css', import.meta.url), 'utf8');

test('workspace search, route help, backdrop dismissal, and preparation preserve active context', async (t) => {
  const host = 'http://localhost';
  const date = '2026-11-18';
  const params = `universe=us-extended&date=${date}&dataVersion=11&model=composite&benchmark=VTI&classification=provider`;
  const dom = new JSDOM(html, { url: `${host}/#overview?${params}`, pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;
  if (!window.HTMLDialogElement.prototype.showModal) {
    window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    window.HTMLDialogElement.prototype.close = function () {
      this.open = false;
      queueMicrotask(() => this.dispatchEvent(new window.Event('close')));
    };
  }
  const records = [];
  let healthPrepared = false;
  let showHealthCoverageGates = false;
  let showMoverPaging = false;
  let delayHighPage = false;
  let releasedHighPage = false;
  let releaseHighPage;
  const highPageWait = new Promise((resolve) => { releaseHighPage = resolve; });
  let breadthQueued = true;
  let activeJobs = [];
  const screens = [{ id: 'income', name: 'Income candidates', definition: {} }];
  const watchlists = [{ id: 'leaders', name: 'Commanders list', definition: { members: [] } }];
  const status = { latestDate: '2026-11-20', dataVersion: 19, state: 'available', calculationVersion: '2',
    lastSuccess: '2026-11-20T22:00:00Z', preparation: { dataVersion: 19, total: 7, complete: 4, queued: 3, universes: [] },
    runs: [{ dataset: 'bulk-eod', provider: 'eodhd', status: 'complete', scope: 'full', dates: ['2026-11-20', '2026-11-20'],
      rows: 5000, imported: 4999, detail: { invalid: 0, unresolved: 0 }, finishedAt: '2026-11-20T22:00:00Z' }] };
  const config = { status, automaticPreparation: true, availableBenchmarks: ['SPY', 'VTI'],
    benchmarks: ['SPY', 'VTI'], universes: marketUniverses.map(({ id, name }) => ({ id, name, version: 1 })),
    models: [{ id: 'composite', name: 'Composite RS', version: 1 }], classificationSystems: ['provider', 'nasdaq', 'sec-sic'] };
  const movers = (prefix, length, direction = 1) => Array.from({ length }, (_, index) => {
    const symbol = `${prefix}${String(index + 1).padStart(2, '0')}`;
    return { symbol, securityId: `fixture:${symbol}`, name: `${symbol} Company`, return_1d: direction * (.5 - index / 200),
      rsPercentile: 82, industry: 'Fixture Banking and Investments', industryId: 'fixture:industry' };
  });
  const gainers = movers('GAIN', 57);
  const highs = movers('HIGH', 30);
  const lows = movers('LOW', 27, -1);
  const moverPage = (rows, page, perPage) => ({ rows: rows.slice((page - 1) * perPage, page * perPage), total: rows.length, page, perPage });
  const verifiedCoverage = { state: 'partial', traded: 5_162, listed: 5_469, ranked: 5_085, received: 5_151, expected: 5_258,
    ratio: 5_151 / 5_258, completenessThreshold: .98 };
  const coveragePart = (id, observed, expected, threshold) => ({ id, score: null, value: 42, weight: .2, denominator: observed,
    reason: 'insufficient_comparable_coverage', adequacy: { observed, expected, threshold, ratio: observed / expected, sufficient: false } });
  function gatedHealth(query, coverageMode) {
    const verified = coverageMode === 'verified';
    const sec = query.get('classification') === 'sec-sic';
    const observedThreshold = Number(query.get('observedThreshold') ?? .8);
    const observedMinimum = Number(query.get('observedMinimum') ?? 20);
    const events = Array.from({ length: 24 }, (_, index) => ({ label: 'Benchmark rises while new lows expand',
      date: `2026-10-${String(index + 1).padStart(2, '0')}` }));
    if (!verified && sec && observedThreshold === .785) {
      return { state: 'available', score: 57, coverageMode, observedThreshold, observedMinimum, history: [{ date, score: 57 }], events };
    }
    const threshold = verified ? .98 : observedThreshold;
    const state = verified ? 'insufficient_coverage' : 'insufficient_inputs';
    const components = [coveragePart('longBreadth', sec ? 4_372 : 4_124, sec ? 5_469 : 5_162, threshold),
      coveragePart('highsLows', sec ? 4_297 : 4_053, sec ? 5_469 : 5_162, threshold)];
    if (!sec) components.push({ id: 'industryLeadership', value: null, denominator: 0, score: null, weight: .1, reason: 'input_unavailable' });
    return { state, reason: state, coverageMode, observedThreshold, observedMinimum, ...(!verified && { events }),
      coverage: { ...verifiedCoverage, ready: !verified }, components, missingComponents: components.map(({ id }) => id) };
  }
  async function request(path, options = {}) {
    const url = new URL(path, host);
    const body = options.body && JSON.parse(options.body);
    records.push({ path: url.pathname, params: Object.fromEntries(url.searchParams), body });
    if (options.signal?.aborted) options.signal.throwIfAborted();
    const respond = (value, code = 200) => new Response(JSON.stringify(value), { status: code });
    switch (url.pathname) {
      case '/help-content.json': return new Response(guide);
      case '/api/v1/config': return respond(config);
      case '/api/v1/data/status': return respond(status);
      case '/api/v1/build': return respond({ appVersion: '0.2.1', version: '2.token', releaseId: 'release-r2',
        buildHash: 'abcdef123', calculationVersion: '2', builtAt: '2026-11-21T01:00:00Z', deployment: 'preview' });
      case '/api/v1/screens': return respond(screens);
      case '/api/v1/chartbooks': return respond({ books: [], builtins: [], screens, watchlists });
      case '/api/v1/watchlists': return respond(watchlists);
      case '/api/v1/watchlists/leaders/members': return respond({ rows: [], total: 0, page: 1, perPage: 50 });
      case '/api/v1/jobs': return respond(activeJobs);
      case '/api/v1/market/overview': return respond({ date: url.searchParams.get('date') || date, benchmark: 'VTI',
        breadth: { above_50d: { numerator: 5, denominator: 8, value: 62.5 } }, aggregates: {},
        dataVersion: Number(url.searchParams.get('dataVersion') || status.dataVersion), model: { name: 'Composite RS' },
        movers: showMoverPaging ? { gainers: gainers.slice(0, 5), losers: [], counts: { gainers: gainers.length, losers: 0 } }
          : { gainers: [], losers: [], counts: { gainers: 0, losers: 0 } },
        ...(showHealthCoverageGates ? { coverage: verifiedCoverage, health: gatedHealth(url.searchParams, 'verified') }
          : { coverage: { state: 'complete', listed: 10, traded: 8, ranked: 6 } }), preparation: { preparationState: 'unregistered' } });
      case '/api/v1/screens/query':
        if (showMoverPaging && body?.sort?.[0]?.field === 'return_1d') return respond(moverPage(gainers, body.page, body.perPage));
        break;
      case '/api/v1/market/breadth/new_high_20d/contributors':
      case '/api/v1/market/breadth/new_low_20d/contributors': {
        const high = url.pathname.includes('new_high_20d');
        const page = Number(url.searchParams.get('page'));
        const perPage = Number(url.searchParams.get('perPage'));
        if (high && page === 2 && delayHighPage) {
          await highPageWait;
          releasedHighPage = true;
        }
        return respond({ ...moverPage(high ? highs : lows, page, perPage), metric: { denominator: 80 }, date });
      }
      case '/api/v1/market/health':
        if (showHealthCoverageGates) return respond(gatedHealth(url.searchParams, url.searchParams.get('coverageMode')));
        return respond(healthPrepared
          ? { state: 'available', score: 57, components: [], history: [{ date, score: 57 }] }
          : { state: 'unprepared', components: [], materialization: { prepareAction: 'health' },
            ...(breadthQueued && { contextPreparation: { pending: true, jobId: 'breadth-prerequisite', status: 'queued' } }) });
      case '/api/v1/market/health/prepare': return respond({ id: 'health-prepare', status: 'queued' }, 202);
      case '/api/v1/jobs/health-prepare':
        healthPrepared = true;
        return respond({ id: 'health-prepare', status: 'complete' });
      case '/api/v1/data/quality': return respond({ ...status, date, asOf: date, coverage: { state: 'complete' }, qualityOverrides: [] });
      case '/api/v1/data/preparation': return respond({ queued: 0, jobs: [] }, 202);
      case '/api/v1/stocks/search': {
        const query = url.searchParams.get('q').toLowerCase();
        if (query === 'failure') return respond({ error: 'Fixture stock search offline' }, 503);
        if (query === 'slow') await delay(280);
        return respond({ date, dataVersion: 11, rows: ['test', 'fixture company', 'slow', 'oldtest'].includes(query)
          ? [{ securityId: 'fixture:TEST', symbol: 'TEST', name: 'Fixture Company', exchange: 'NYSE',
            ...(query === 'oldtest' && { matchedAlias: 'OLDTEST' }) }] : [] });
      }
      case '/api/v1/stocks/fixture%3ATEST': return respond({ symbol: 'TEST', name: 'Fixture Company', securityId: 'fixture:TEST',
        exchange: 'NYSE', date: url.searchParams.get('date') || status.latestDate,
        dataVersion: Number(url.searchParams.get('dataVersion') ?? status.dataVersion), chartBars: [] });
    }
    return respond({ error: 'Fixture route unavailable' }, 404);
  }
  const bound = { window, document, location: window.location, history: window.history, FormData: window.FormData, fetch: request };
  const originals = Object.fromEntries(Object.keys(bound).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(bound)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  const interval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  t.after(() => {
    dom.window.close();
    globalThis.setInterval = interval;
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const $ = (selector) => document.querySelector(selector);
  const modal = $('#modal');
  const help = $('#help');
  const search = $('#ticker-search');
  const key = (target, value, extra) => target.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra }));
  async function until(condition, label) {
    for (let i = 0; i < 150; i++) {
      if (condition()) return;
      await delay(20);
    }
    assert.fail(`Timed out: ${label}`);
  }
  const enterSearch = (query) => {
    const input = $('#ticker-input');
    input.value = query;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    return input;
  };
  const posts = () => records.filter(({ path, body }) => path === '/api/v1/data/preparation' && body);
  const change = (selector, value) => {
    const control = $(selector);
    control.value = value;
    control.dispatchEvent(new window.Event('change', { bubbles: true }));
  };

  await import('../frontend/app.js');
  await until(() => $('[data-action="prepare-context"]') && $('#footer-build').textContent.includes('App v0.2.1'), 'initial replay context');
  const sharedContext = $('#context-bar');
  const contextToggle = $('#context-toggle');
  assert.equal(sharedContext.hidden, false);
  assert.equal(contextToggle.hidden, true);
  assert.equal(posts().length, 0);
  assert.deepEqual([...document.querySelectorAll('#footer-build span, #footer-data span')].map((element) => element.textContent),
    ['App v0.2.1', 'Built Nov 21, 2026', 'Prices through Nov 20, 2026', 'Last import Nov 20, 2026', 'Analysis preparing']);
  assert.doesNotMatch($('.workspace-footer').textContent, /release-r2|abcdef123|Calculation 2|preview|revision|queued|failed/i);
  const style = document.createElement('style');
  style.textContent = stylesheet;
  document.head.append(style);
  const footerStyle = window.getComputedStyle($('.workspace-footer'));
  assert.equal(footerStyle.flexWrap, 'nowrap');
  assert.equal(footerStyle.whiteSpace, 'nowrap');
  assert.equal(footerStyle.overflowX, 'auto');
  style.remove();
  assert.equal($('#historical-replay').hidden, false);
  assert.match($('#historical-replay').textContent, /Historical replay · Nov 18, 2026.*Return to latest/s);
  assert.equal(new URL($('#footer-jobs').href).hash.includes('dataVersion='), false);
  assert.equal($('[data-value="classification"]').getAttribute('aria-label'), 'Industry data');
  assert.match($('#context-price-source').textContent, /Prices: EODHD/);
  const fetchStart = records.length;
  const coverageOpener = $('[data-action="universe-counts"]');
  coverageOpener.click();
  await until(() => $('#detail [data-universe-count="us-core"] [data-count="eligible"]')?.textContent === '10', 'opens dated universe counts');
  const countReads = records.slice(fetchStart).filter(({ path }) => path === '/api/v1/market/overview');
  assert.equal(countReads.length, 7);
  assert.ok(countReads.every(({ params, body }) => params.date === date && params.dataVersion === '11' && !body));
  key(document.activeElement, 'Escape');
  await until(() => !$('#detail').open && document.activeElement === coverageOpener, 'universe counts restores focus');

  const dateInput = $('[data-value="date"]');
  key(dateInput, 'k', { ctrlKey: true });
  key(dateInput, '/');
  assert.equal(modal.open, false);
  search.focus();
  key(search, 'k', { metaKey: true });
  assert.equal(modal.open, true);
  assert.equal(document.activeElement.id, 'ticker-input');

  enterSearch('Market Monitor');
  await until(() => $('[data-search-kind="pages"]'), 'page search');
  assert.equal($('[data-search-kind="pages"]').textContent, 'Market Monitor');
  enterSearch('Income candidates');
  await until(() => $('[data-search-kind="screens"]'), 'saved screen search');
  enterSearch('Commanders list');
  await until(() => $('[data-search-kind="watchlists"]'), 'watchlist search');
  enterSearch('breadth percentage');
  await until(() => $('[data-search-kind="help"]'), 'definition search');
  $('[data-search-kind="help"]').click();
  await until(() => help.open && document.activeElement?.id.startsWith('help-definition-'), 'definition focus');
  assert.equal(modal.open, false);
  key(document.activeElement, 'Escape');
  await until(() => !help.open && document.activeElement === search, 'tooltip drawer focus return');

  $('#context-help').click();
  await until(() => help.querySelector('h2')?.textContent === 'Market overview', 'route help');
  assert.equal(help.querySelector('[data-help-topic]').value, 'overview');
  change('[data-help-topic]', 'rankings');
  await until(() => help.querySelector('h2')?.textContent === 'Relative-strength rankings', 'guide topic navigation');
  const mouse = (target, type, x, y) =>
    target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
  help.getBoundingClientRect = () => ({ left: 500, right: 900, top: 0, bottom: 600, width: 400, height: 600 });
  mouse(help.querySelector('.dialog-body'), 'click', 600, 100);
  mouse(help, 'pointerdown', 600, 100);
  mouse(help, 'click', 100, 100);
  assert.equal(help.open, true, 'drag from inside remains open');
  mouse(help, 'pointerdown', 100, 100);
  mouse(help, 'click', 100, 100);
  await until(() => !help.open && document.activeElement.id === 'context-help', 'backdrop focus return');

  search.click();
  enterSearch('slow');
  await until(() => records.some(({ params }) => params.q === 'slow'), 'first search dispatched');
  enterSearch('nothing here');
  await until(() => $('#search-status').textContent.includes('No matching items'), 'empty search results');
  await delay(150);
  assert.equal($('[data-search-kind="stocks"]'), null, 'stale search response discarded');
  enterSearch('failure');
  await until(() => $('#search-status').textContent.includes('Fixture stock search offline'), 'search error');
  enterSearch('OLDTEST');
  await until(() => $('[data-search-kind="stocks"]')?.textContent.includes('Former ticker OLDTEST'), 'former ticker resolves to selected-session identity');
  const input = enterSearch('Fixture Company');
  await until(() => $('[data-search-kind="stocks"]'), 'company result');
  key(input, 'ArrowDown');
  assert.ok(input.getAttribute('aria-activedescendant'));
  assert.equal($('[role="option"][aria-selected="true"] strong').textContent, 'TEST');
  assert.match($('#search-scope').textContent, /Securities as of Nov 18, 2026 · revision 11 · newer warehouse revision 19 available/);
  key(input, 'Enter');
  await until(() => $('#ticker-dashboard'), 'ticker dashboard');
  assert.equal(modal.open, false);
  const tickerParams = new URLSearchParams(window.location.hash.split('?')[1]);
  assert.equal(tickerParams.get('symbol'), 'fixture:TEST');
  assert.equal(tickerParams.get('date'), date);
  assert.equal(tickerParams.get('dataVersion'), '11');
  assert.equal(tickerParams.get('benchmark'), 'VTI');
  assert.equal($('#historical-replay').hidden, false, 'replay remains visible on the ticker');
  assert.equal(posts().length, 0, 'render and navigation did not register preparation');
  window.history.back();
  await until(() => window.location.hash.startsWith('#overview?') && $('[data-action="prepare-context"]'), 'replay retained after back');

  $('[data-action="prepare-context"]').click();
  await until(() => posts().length === 1, 'explicit legacy preparation');
  assert.equal(posts()[0].body.context.followLatest, false);
  assert.equal(posts()[0].body.context.dataVersion, '11');
  assert.equal(posts()[0].body.context.benchmark, 'VTI');
  $('[data-action="current"]').click();
  await until(() => posts().length === 2 && !window.location.hash.includes('dataVersion='), 'live context registration');
  assert.equal(posts()[1].body.context.followLatest, true);
  assert.equal(posts()[1].body.context.date, undefined);
  change('[data-value="benchmark"]', 'SPY');
  await until(() => posts().length === 3 && window.location.hash.includes('benchmark=SPY'), 'explicit benchmark registration');
  change('[data-value="benchmark"]', 'VTI');
  await until(() => window.location.hash.includes('benchmark=VTI'), 'return to registered context');
  assert.equal(posts().length, 3, 'repeated context choice deduplicated');
  await until(() => !$('main').hasAttribute('aria-busy'), 'settled replacement view');

  const menuToggle = $('.menu-toggle');
  menuToggle.click();
  assert.equal(menuToggle.getAttribute('aria-expanded'), 'true');
  key(document.activeElement, 'Escape');
  assert.equal(menuToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, menuToggle);
  menuToggle.click();
  $('main').click();
  assert.equal(menuToggle.getAttribute('aria-expanded'), 'false');
  await delay(0);

  $('[data-action="breadth"][data-value="above_50d"]').click();
  await until(() => $('#breadth-reading')?.textContent.includes('Fixture route unavailable'), 'failed breadth request ends loading');
  assert.match($('#breadth-list').textContent, /Contributors unavailable/);
  assert.ok($('[data-action="breadth-drawer-export-list"]').disabled);
  key(document.activeElement, 'Escape');
  await until(() => !$('#detail').open, 'research drawer closes');

  showMoverPaging = true;
  window.location.hash = `#overview?${params}&tab=overview`;
  const moverPanel = () => $('#market-movers [data-mover-preview]');
  const moverScroll = () => moverPanel()?.querySelector('.market-mover-scroll');
  const firstMover = () => moverScroll()?.querySelector('tbody .stock-link')?.textContent;
  const moverCount = () => moverScroll()?.querySelectorAll('tbody tr').length;
  const moverNext = (page) => moverPanel().querySelector(`[data-action="mover-preview-page"][data-value="${page}"]`);
  const changeMover = (axis, value) => $(`#market-movers [data-action="mover-${axis}"][data-value="${value}"]`).click();
  await until(() => firstMover() === 'GAIN01', 'first daily movers page');
  assert.equal(moverCount(), 25);
  assert.match(moverPanel().textContent, /57 qualifying stocks.*1–25 of 57/s);
  assert.equal(moverScroll().getAttribute('role'), 'region');
  assert.equal(moverScroll().getAttribute('aria-label'), 'Daily movers');
  assert.equal(moverScroll().tabIndex, 0);
  assert.match(stylesheet, /\.market-mover-scroll\s*\{[^}]*max-height:\s*clamp\([^)]*\);[^}]*overscroll-behavior-y:\s*contain/);
  assert.equal(moverPanel().querySelector('[data-action="daily-mover-list"]').textContent.trim(), 'Full list');
  assert.match(moverScroll().querySelector('tbody tr').textContent, /Fixture Banking and Investments/);
  moverNext(2).focus();
  moverNext(2).click();
  await until(() => firstMover() === 'GAIN26', 'second daily movers page');
  assert.equal(document.activeElement, moverScroll());
  assert.equal(moverCount(), 25);
  const secondMoverQuery = records.findLast(({ path }) => path === '/api/v1/screens/query');
  assert.equal(secondMoverQuery.body.page, 2);
  assert.equal(secondMoverQuery.body.perPage, 25);
  assert.deepEqual(secondMoverQuery.body.filter.filters, [{ field: 'return_1d', op: 'gt', value: .1 + Number.EPSILON }]);
  assert.deepEqual(secondMoverQuery.body.sort, [{ field: 'return_1d', direction: 'desc' }]);
  assert.deepEqual(secondMoverQuery.body.columns, ['symbol', 'name', 'return_1d', 'rsPercentile', 'industry']);
  assert.equal(secondMoverQuery.body.context.date, date);
  assert.equal(secondMoverQuery.body.context.dataVersion, 11);
  assert.equal(secondMoverQuery.body.context.universe, 'us-extended');
  assert.equal(secondMoverQuery.body.context.classification, 'provider');
  const moverStock = new URLSearchParams(moverScroll().querySelector('tbody .stock-link').hash.split('?')[1]);
  assert.equal(moverStock.get('date'), date);
  assert.equal(moverStock.get('dataVersion'), '11');
  moverNext(3).click();
  await until(() => firstMover() === 'GAIN51', 'final daily movers page');
  assert.equal(moverCount(), 7);
  assert.equal(moverNext(4).disabled, true);
  changeMover('view', '20');
  await until(() => firstMover() === 'HIGH01', 'first highs page');
  assert.equal(moverCount(), 25);
  assert.equal(moverPanel().querySelector('[data-action="breadth"]').dataset.value, 'new_high_20d');
  moverNext(2).click();
  await until(() => firstMover() === 'HIGH26', 'second highs page');
  assert.equal(moverCount(), 5);
  const secondHighQuery = records.findLast(({ path }) => path.endsWith('/new_high_20d/contributors'));
  assert.equal(secondHighQuery.params.include, 'numerator');
  assert.equal(secondHighQuery.params.page, '2');
  assert.equal(secondHighQuery.params.perPage, '25');
  assert.equal(secondHighQuery.params.date, date);
  assert.equal(secondHighQuery.params.dataVersion, '11');
  moverNext(1).click();
  await until(() => firstMover() === 'HIGH01', 'previous highs page');
  delayHighPage = true;
  const nextHighPage = moverNext(2);
  nextHighPage.click();
  await until(() => nextHighPage.getAttribute('aria-disabled') === 'true', 'in-flight highs page');
  changeMover('side', 'low');
  await until(() => firstMover() === 'LOW01', 'changed high/low scope while an old page loads');
  releaseHighPage();
  await until(() => releasedHighPage && !nextHighPage.hasAttribute('aria-disabled'), 'old highs response settled');
  assert.equal(firstMover(), 'LOW01', 'outdated highs page cannot replace the lows list');
  assert.equal(moverCount(), 25);
  assert.match(moverPanel().textContent, /27 qualifying stocks/);
  showMoverPaging = false;

  showHealthCoverageGates = true;
  const nasdaqParams = params.replace('classification=provider', 'classification=nasdaq');
  window.location.hash = `#overview?${nasdaqParams}&reference=latest&tab=health`;
  await until(() => $('#health-availability')?.textContent.includes('97.965%'), 'verified health shows the source shortfall');
  const healthForm = () => $('#health-coverage-form');
  const applyHealth = () => healthForm().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const healthPosts = () => records.filter(({ path }) => path === '/api/v1/market/health/prepare');
  assert.equal(healthForm().elements.coverageMode.value, 'verified');
  assert.equal(healthForm().querySelector('details').hidden, true);
  assert.equal(healthPosts().length, 0);
  $('[data-action="observe-health"]').click();
  await until(() => $('#health-availability')?.textContent.includes('below the 80% minimum'), 'explicit observed policy reports comparable-input shortfalls');
  assert.match($('#health-availability').textContent, /4,124 of 5,162 comparable securities \(79\.892%\)/);
  assert.doesNotMatch($('#health-availability').textContent, /Provider source coverage|98%/);
  assert.equal($('#health-coverage-policy').textContent, '80% comparable · 20 traded minimum');
  const datedGroups = $('#health-availability a');
  const datedContext = new URLSearchParams(datedGroups.hash.split('?')[1]);
  assert.equal(datedContext.get('classification'), 'sec-sic');
  assert.equal(datedContext.get('reference'), 'as-of');
  assert.equal(datedContext.get('coverage'), 'observed');
  assert.equal(datedContext.get('date'), date);
  assert.equal(datedContext.get('dataVersion'), '11');
  assert.equal(datedContext.get('universe'), 'us-extended');
  datedGroups.click();
  await until(() => $('#health-availability')?.textContent.includes('4,372 of 5,469'), 'dated groups use the explicit observed policy');
  assert.equal($('#health-availability a'), null);
  const rules = healthForm().querySelector('details');
  assert.equal(rules.open, false);
  assert.equal(rules.hidden, false);
  assert.equal(rules.querySelector('summary').textContent.trim(), 'Coverage rules');
  rules.querySelector('summary').click();
  assert.equal(rules.open, true);
  assert.equal(healthForm().elements.observedThreshold.valueAsNumber, 80);
  assert.match(healthForm().elements.observedThreshold.labels[0].textContent, /Comparable coverage \(%\)/);
  healthForm().elements.observedThreshold.value = '78.5';
  healthForm().elements.observedMinimum.value = '25';
  applyHealth();
  await until(() => $('#current-health .summary-value')?.textContent === '57.0', 'positive composite comes from the API');
  assert.equal($('#health-availability'), null);
  assert.equal($('.summary-card[data-value="health"] .summary-value').textContent, '57.0');
  assert.equal($('#health-coverage-policy').textContent, '78.5% comparable · 25 traded minimum');
  const lastHealthQuery = records.filter(({ path }) => path === '/api/v1/market/health').at(-1).params;
  assert.equal(lastHealthQuery.observedThreshold, '0.785');
  assert.equal(lastHealthQuery.observedMinimum, '25');
  assert.equal(healthPosts().length, 0, 'prepared variants need no calculation request');
  const divergenceList = $('.health-divergence-list[role="region"][aria-label="Dated breadth divergence events"]');
  assert.equal(divergenceList.tabIndex, 0);
  divergenceList.focus();
  assert.equal(document.activeElement, divergenceList);
  assert.equal(divergenceList.querySelectorAll('li').length, 24);
  assert.equal(divergenceList.querySelector('time').dateTime, '2026-10-24');
  assert.match(stylesheet, /\.health-divergence-list\s*\{[^}]*max-height:[^;]+;\s*overflow-y:\s*auto;\s*overscroll-behavior-y:\s*contain;\s*scrollbar-gutter:\s*stable/);
  change('#health-coverage-form [name="coverageMode"]', 'verified');
  applyHealth();
  assert.equal(healthForm().querySelector('details').hidden, true);
  showHealthCoverageGates = false;
  window.location.hash = `#overview?${params}&tab=health&coverage=observed`;
  await until(() => $('[data-action="check-health-readiness"]'), 'queued breadth prerequisite is actionable');
  const reading = [...$('main').querySelectorAll('section h2')].find((node) => node.textContent === 'Market reading')?.closest('section');
  assert.match(reading?.textContent, /62\.5%.*5 of 8 comparable/s);
  assert.ok(reading.compareDocumentPosition($('#current-health')) & window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal($('#health-coverage-policy').textContent, '80% comparable · 20 traded minimum');
  assert.equal($('#overview-data-notes').open, false);
  assert.match($('#current-health').textContent, /Composite score unavailable/);
  assert.match($('#health-chart').textContent, /Breadth history is queued/);
  assert.equal(records.some(({ path }) => path === '/api/v1/jobs/breadth-prerequisite'), false);
  assert.equal(healthPosts().length, 0, 'opening health uses reads only');
  assert.ok($('[data-value="market-health.csv"]').disabled);
  $('#health-coverage-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !$('#health-coverage-form [type="submit"]').disabled, 'coverage waits for the prerequisite');
  assert.equal(healthPosts().length, 0);
  breadthQueued = false;
  $('[data-action="check-health-readiness"]').click();
  await until(() => $('[data-action="prepare-health"]'), 'health preparation action');
  $('#health-coverage-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => $('#health-chart [data-chart]'), 'explicit health coverage follows prepared job');
  assert.equal(healthPosts().length, 1);
  assert.equal(healthPosts()[0].body.context.dataVersion, '11');
  assert.equal(healthPosts()[0].body.coverageMode, 'observed');
  assert.equal($('[data-value="market-health.csv"]').disabled, false);

  $('#footer-jobs').click();
  await until(() => $('#preparation-progress')?.textContent.includes('Raw warehouse revision 19'), 'jobs use latest warehouse status');
  assert.equal(sharedContext.hidden, true);
  assert.equal(contextToggle.hidden, false);
  const beforeContextOpen = records.length;
  contextToggle.click();
  assert.equal($('#detail #context-bar'), sharedContext);
  assert.equal(sharedContext.hidden, false);
  assert.equal(contextToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(document.activeElement.dataset.value, 'universe');
  assert.equal(records.length, beforeContextOpen, 'opening the existing controls makes no request');
  key(document.activeElement, 'Escape');
  await until(() => sharedContext.hidden && document.activeElement === contextToggle, 'context Escape restores compact mode and focus');
  $('[data-action="settings-tab"][data-value="quality"]').click();
  await until(() => $('#import-rows'), 'latest import receipts');
  assert.match($('#import-rows').textContent, /Nov 20, 2026.*Daily prices \(all tickers\).*Market-wide capture.*4,999 new or updated · 1 unchanged/s);
  await until(() => !$('main').hasAttribute('aria-busy'), 'workspace view settled');
  assert.equal(records.filter(({ path }) => path === '/api/v1/data/status').length, 1, 'footer reuses warehouse status poll');
  const previousJobs = posts().length;
  $('[data-action="settings-tab"][data-value="config"]').click();
  await until(() => $('[data-settings-universe-count="us-core"]')?.textContent.includes('Eligible10'), 'settings list shows saved counts');
  assert.match($('[data-settings-universe-count="us-core"]').parentElement.textContent, /Operating common stocks on NYSE and Nasdaq/);
  assert.equal(posts().length, previousJobs, 'opening settings does not queue analytics');
  status.preparation.current = { phase: 'recent', progress: 32 };
  status.latestAnalysis = { date: status.latestDate, dataVersion: 19 };
  contextToggle.click();
  $('[data-action="refresh"]').click();
  await until(() => $('#data-badge').textContent.includes('Historical backfill · 32%'), 'backfill remains visible in the header');
  const footerReadiness = () => $('#footer-data span:last-child').textContent;
  assert.equal(footerReadiness(), 'Analysis preparing');
  assert.doesNotMatch($('#data-badge').textContent, /Current ready/);

  const ordinaryPlan = status.preparation;
  const complete = { total: 1, complete: 1, queued: 0, running: 0, failed: 0, superseded: 0 };
  status.preparation = { dataVersion: 19, total: 3, complete: 3, phases: { current: complete, recent: complete, history: complete } };
  status.currentReadiness = { state: 'ready', date: status.latestDate, dataVersion: 19 };
  const verifyFooter = async (text, label) => {
    $('[data-action="refresh"]').click();
    await until(() => footerReadiness() === text, label);
  };
  await verifyFooter('Analysis incomplete', 'daily publication and job completion alone do not certify full analysis');
  status.analysisReadiness = { state: 'ready', date: status.latestDate, dataVersion: 19, calculationVersion: '2' };
  status.preparation.phases.history = { ...complete, complete: 0, queued: 1 };
  await verifyFooter('Analysis preparing', 'pending historical work blocks ready');
  status.preparation.phases.history = { ...complete, complete: 0, failed: 1 };
  await verifyFooter('Analysis incomplete', 'failed historical work blocks ready');
  assert.doesNotMatch($('.workspace-footer').textContent, /failed|failure/i);
  status.preparation.phases.history = complete;
  await verifyFooter('Current analysis ready', 'exact full-generation completion is accepted');
  activeJobs = [{ id: 'external-build', type: 'optimized-five-year', status: 'building' }];
  await verifyFooter('Analysis preparing', 'active external analysis blocks ready');
  activeJobs = [];
  status.analysisReadiness.calculationVersion = 'old-calculation';
  await verifyFooter('Analysis incomplete', 'a prior calculation generation does not certify current analysis');
  status.preparation = ordinaryPlan;
  delete status.analysisReadiness;
  delete status.currentReadiness;
  key(document.activeElement, 'Escape');
  await until(() => !$('#detail').open, 'workspace context drawer closes after readiness checks');

  status.latestAnalysis = { date: status.latestDate, dataVersion: 11 };
  window.location.hash = `#watchlists?${params.replace('dataVersion=11', 'dataVersion=19')}`;
  await until(() => $('main h1')?.textContent === 'Watchlists' && !$('main').hasAttribute('aria-busy'), 'pinned watchlists');
  assert.equal($('[data-action="apply-data"]'), null, 'older publication does not offer a downgrade');
  let reportedVersion;
  document.addEventListener('warehouse:status', (event) => { reportedVersion = event.detail.dataVersion; });
  status.dataVersion = 20;
  $('[data-action="refresh"]').click();
  await until(() => reportedVersion === 20, 'raw revision recorded');
  assert.doesNotMatch($('.workspace-footer').textContent, /revision|warehouse 20/i);
  assert.equal($('[data-action="apply-data"]'), null, 'new raw but unprepared data does not offer an update');
  status.latestAnalysis = { date: status.latestDate, dataVersion: 20 };
  $('[data-action="refresh"]').click();
  await until(() => $('[data-action="apply-data"]'), 'newer published revision offered');
  assert.match($('[data-action="apply-data"]').title, /revision 20.*revision 19/);

  status.latestAnalysis = { date: status.latestDate, dataVersion: 11 };
  $('[data-action="apply-data"]').click();
  await until(() => !$('[data-action="apply-data"]'), 'stale update revalidated');
  assert.equal(new URLSearchParams(window.location.hash.split('?')[1]).get('dataVersion'), '19');
  status.latestAnalysis = { date: status.latestDate, dataVersion: 20 };
  $('[data-action="refresh"]').click();
  await until(() => $('[data-action="apply-data"]'), 'newer publication restored');
  $('[data-action="apply-data"]').click();
  await until(() => JSON.parse(window.sessionStorage.getItem('market-intelligence.analysis-revision')).dataVersion === 20
    && !new URLSearchParams(window.location.hash.split('?')[1]).has('dataVersion'), 'new ready revision applied');
  assert.equal(new URLSearchParams(window.location.hash.split('?')[1]).get('date'), date, 'the historical session stays pinned');

  const tickerRequests = () => records.filter(({ path }) => path === '/api/v1/stocks/fixture%3ATEST');
  const hashParams = () => new URLSearchParams(window.location.hash.split('?')[1]);
  window.location.hash = `#stock?${params}&symbol=fixture%3ATEST`;
  await until(() => $('#ticker-dashboard') && !$('#historical-replay').hidden, 'ticker historical replay');
  status.dataVersion = 22;
  status.latestAnalysis = { date: status.latestDate, dataVersion: 21 };
  $('#historical-replay [data-action="current"]').click();
  await until(() => $('#historical-replay').hidden && tickerRequests().at(-1)?.params.dataVersion === '21'
    && !$('main').hasAttribute('aria-busy'), 'latest ticker uses fresh prepared revision');
  assert.equal(hashParams().has('date'), false);
  assert.equal(hashParams().get('symbol'), 'fixture:TEST');
  assert.equal(hashParams().get('universe'), 'us-extended');
  assert.equal(hashParams().get('model'), 'composite');
  assert.equal(hashParams().get('benchmark'), 'VTI');
  assert.equal($('[data-action="apply-data"]'), null, 'a newer raw revision is not offered as prepared ticker data');

  window.location.hash = `#stock?${params.replace('dataVersion=11', 'dataVersion=22')}&symbol=fixture%3ATEST`;
  await until(() => !$('#historical-replay').hidden && tickerRequests().at(-1)?.params.date === date
    && !$('main').hasAttribute('aria-busy'), 'higher pinned receipt before return');
  status.latestAnalysis = { date: status.latestDate, dataVersion: 11 };
  $('#historical-replay [data-action="current"]').click();
  await until(() => $('#historical-replay').hidden && !hashParams().has('date') && !$('main').hasAttribute('aria-busy'),
    'return preserves a newer pinned receipt when preparation status is stale');
  assert.equal(hashParams().get('dataVersion'), '22');
  assert.equal(tickerRequests().at(-1).params.dataVersion, '22');

  window.location.hash = `#chartbook?${params}&book=journal-review&symbol=fixture%3ATEST`;
  await until(() => $('[data-chartbook]') && sharedContext.hidden && !contextToggle.hidden, 'ChartBook starts without the context bar');
  contextToggle.click();
  assert.equal($('#detail #context-bar'), sharedContext);
  change('#detail [data-change="context"][data-value="benchmark"]', 'SPY');
  await until(() => hashParams().get('benchmark') === 'SPY' && sharedContext.hidden && !$('#detail').open, 'changing drawer context restores compact mode');
  assert.equal(hashParams().get('symbol'), 'fixture:TEST');
  assert.equal(hashParams().get('book'), 'journal-review');
  assert.equal(hashParams().get('date'), date);
  assert.equal(hashParams().get('dataVersion'), '11');
  contextToggle.click();
  $('#detail [data-action="universe-counts"]').click();
  await until(() => $('#detail [data-universe-count="us-core"]') && sharedContext.hidden, 'replacing the drawer restores the context bar');
  assert.equal(contextToggle.getAttribute('aria-expanded'), 'false');
  key(document.activeElement, 'Escape');
  await until(() => !$('#detail').open && document.activeElement === contextToggle, 'replacement closes back to the compact control');

  contextToggle.click();
  window.location.hash = `#overview?${params}`;
  await until(() => $('#main h1')?.textContent === 'Market Overview' && !sharedContext.hidden && contextToggle.hidden, 'analysis route restores inline context');
  assert.equal(document.querySelectorAll('#context-bar').length, 1);
  assert.equal($('.workspace > #context-bar'), sharedContext);
});
