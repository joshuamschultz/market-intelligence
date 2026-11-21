import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
const guide = await readFile(new URL('../frontend/help-content.json', import.meta.url), 'utf8');

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
  let breadthQueued = true;
  const screens = [{ id: 'income', name: 'Income candidates', definition: {} }];
  const watchlists = [{ id: 'leaders', name: 'Commanders list', definition: { members: [] } }];
  const status = { latestDate: '2026-11-20', dataVersion: 19, state: 'available', calculationVersion: '2',
    lastSuccess: '2026-11-20T22:00:00Z', preparation: { dataVersion: 19, total: 7, complete: 4, queued: 3, universes: [] },
    runs: [{ dataset: 'bulk-eod', provider: 'eodhd', status: 'complete', scope: 'full', dates: ['2026-11-20', '2026-11-20'],
      rows: 5000, imported: 4999, detail: { invalid: 0, unresolved: 0 }, finishedAt: '2026-11-20T22:00:00Z' }] };
  const config = { status, automaticPreparation: true, availableBenchmarks: ['SPY', 'VTI'],
    benchmarks: ['SPY', 'VTI'], universes: [{ id: 'us-extended', name: 'US extended', version: 1 }],
    models: [{ id: 'composite', name: 'Composite RS', version: 1 }], classificationSystems: ['provider', 'sec-sic'] };
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
      case '/api/v1/build': return respond({ appVersion: '0.2.0', version: '2.token', releaseId: 'release-r2',
        buildHash: 'abcdef123', calculationVersion: '2', builtAt: '2026-11-21T01:00:00Z', deployment: 'preview' });
      case '/api/v1/screens': return respond(screens);
      case '/api/v1/watchlists': return respond(watchlists);
      case '/api/v1/watchlists/leaders/members': return respond({ rows: [], total: 0, page: 1, perPage: 50 });
      case '/api/v1/jobs': return respond([]);
      case '/api/v1/market/overview': return respond({ date, benchmark: 'VTI', breadth: {}, aggregates: {},
        model: { name: 'Composite RS' }, coverage: { state: 'complete' }, preparation: { preparationState: 'unregistered' } });
      case '/api/v1/market/health': return respond(healthPrepared
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
        exchange: 'NYSE', date, dataVersion: 11, chartBars: [] });
      default: return respond({ error: 'Fixture route unavailable' }, 404);
    }
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
  await until(() => $('[data-action="prepare-context"]') && $('#footer-build').textContent.includes('release-r2'), 'initial replay context');
  assert.equal(posts().length, 0);
  assert.match($('#footer-build').textContent, /App v0\.2\.0.*Build abcdef123.*Calculation 2.*preview/);
  assert.match($('#footer-data').textContent, /Prices through Nov 20, 2026.*View Nov 18, 2026.*View revision 11 \/ warehouse 19.*3 calculations queued/);
  assert.equal(new URL($('#footer-jobs').href).hash.includes('dataVersion='), false);

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

  window.location.hash = `#overview?${params}&tab=health&coverage=observed`;
  await until(() => $('[data-action="check-health-readiness"]'), 'queued breadth prerequisite is actionable');
  assert.match($('#health-chart').textContent, /Breadth history is queued/);
  assert.equal(records.some(({ path }) => path === '/api/v1/jobs/breadth-prerequisite'), false);
  const healthPosts = () => records.filter(({ path }) => path === '/api/v1/market/health/prepare');
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
  $('[data-action="settings-tab"][data-value="quality"]').click();
  await until(() => $('#import-rows'), 'latest import receipts');
  assert.match($('#import-rows').textContent, /Nov 20, 2026.*Daily prices \(all tickers\).*Market-wide capture.*4,999 new or updated · 1 unchanged/s);
  await until(() => !$('main').hasAttribute('aria-busy'), 'workspace view settled');
  assert.equal(records.filter(({ path }) => path === '/api/v1/data/status').length, 1, 'footer reuses warehouse status poll');

  status.latestAnalysis = { date: status.latestDate, dataVersion: 11 };
  window.location.hash = `#watchlists?${params.replace('dataVersion=11', 'dataVersion=19')}`;
  await until(() => $('main h1')?.textContent === 'Watchlists' && !$('main').hasAttribute('aria-busy'), 'pinned watchlists');
  assert.equal($('[data-action="apply-data"]'), null, 'older publication does not offer a downgrade');
  status.dataVersion = 20;
  $('[data-action="refresh"]').click();
  await until(() => $('#footer-data').textContent.includes('warehouse 20'), 'raw revision recorded');
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
});
