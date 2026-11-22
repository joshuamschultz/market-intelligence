import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { expectedSessions } from '../backend/calendar.mjs';

const anchor = '2026-11-20';
const point = { date: anchor, dataVersion: 18914, universe: 'us-core', universeVersion: 2, model: 'composite', modelVersion: 3,
  basis: 'reconstructed', benchmark: 'SPY', classification: 'nasdaq', reference: 'latest', observedReferenceDate: '2026-11-21', healthModel: 'default' };
const calculationVersion = 'point-calculation';
const dates = expectedSessions('2026-01-05', anchor);
const small = { id: 'paint/coatings', name: 'Paints/Coatings', rank: 14, count: 3 };
const large = { id: 'biotech/medicine', name: 'Biotech', rank: 15, count: 65 };
const member = (symbol, rsRank, name = `${symbol} Corporation`) => ({ symbol, securityId: `security:${symbol}`, name,
  rsRank, rsPercentile: 100 - rsRank / 40, close: 41, return_1d: 0.014, velocity4w: 0, traded: true });
const smallRows = [member('PPG', 811), member('AXTA', 827, '<img src=x> Axalta'), member('RPM', 1548)];
const largeRows = Array.from({ length: large.count }, (_, index) => member(`B${String(index + 1).padStart(3, '0')}`, index + 1));
const stockBars = dates.slice(-63).map((date, index) => ({ date, open: 40 + index, high: 42 + index, low: 39 + index, close: 41 + index, volume: 1000 }));
const memberData = (group, params) => {
  const page = Number(params.get('page'));
  const perPage = Number(params.get('perPage'));
  const search = params.get('search')?.toLowerCase();
  const rows = (group === small.id ? smallRows : largeRows).filter((row) => !search || `${row.symbol} ${row.name}`.toLowerCase().includes(search));
  return { date: anchor, rows: rows.slice((page - 1) * perPage, page * perPage), page, perPage, total: rows.length };
};

async function eventually(check, description) {
  const until = Date.now() + 2400;
  while (Date.now() < until) {
    if (check()) return;
    await setTimeout(5);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function workspace(t) {
  const page = new JSDOM(await readFile(new URL('../frontend/index.html', import.meta.url), 'utf8'), {
    url: `http://localhost/#chartbook?${new URLSearchParams({ mode: 'market', reviewView: 'industries', card: `industry:${small.id}`,
      observedReferenceDate: point.observedReferenceDate })}`,
    pretendToBeVisual: true,
  });
  const { window } = page;
  const { document } = window;
  if (!window.HTMLDialogElement.prototype.showModal) {
    window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    window.HTMLDialogElement.prototype.close = function () {
      this.open = false;
      queueMicrotask(() => this.dispatchEvent(new window.Event('close')));
    };
  }
  const calls = [];
  let nextMember;
  const status = { latestDate: '2026-11-23', dataVersion: 19000, calculationVersion: 'other-calculation' };
  const build = { version: 'fixture' };
  const config = { status, build, defaultClassification: 'nasdaq', classificationSystems: ['nasdaq', 'sec-sic'], availableBenchmarks: ['SPY'],
    universes: [{ id: 'us-core', name: 'US Core', version: 1 }], models: [{ id: 'composite', name: 'Composite RS', version: 1 }] };
  const json = (result, status = 200) => new Response(JSON.stringify(result), { status, headers: { 'Content-Type': 'application/json' } });

  async function fetch(path, options = {}) {
    const url = new URL(path, window.location.origin);
    const resource = url.pathname.slice('/api/v1/'.length);
    const params = url.searchParams;
    calls.push({ resource, params, signal: options.signal, method: options.method });
    if (resource === 'config') return json(config);
    if (resource === 'build') return json(build);
    if (resource === 'data/status') return json(status);
    if (resource === 'jobs' || resource === 'screens') return json([]);
    if (resource === 'chartbooks/market') return json({ date: anchor, dataVersion: point.dataVersion, context: { ...point, calculationVersion },
      industries: [small, large], metrics: [], decks: [] });
    if (resource === 'chartbooks/market/history') return json({ rows: dates.map((date) => ({ date, breadth: { up_4pct: [12, 12, 100], down_4pct: [6, 6, 100] } })) });
    if (resource.startsWith('chartbooks/market/industries/')) return json({ sessions: dates,
      industry: { label: 'Industry equal-weight proxy', state: 'ready', rows: dates.map((date, index) => ({ date, value: 100 + index / 2 })) },
      benchmark: { state: 'ready', rows: dates.map((date, index) => ({ date, close: 400 + index })) } });
    if (resource === 'research-notes') return json({ notes: [] });
    if (resource.startsWith('industries/') && resource.endsWith('/members')) {
      const group = decodeURIComponent(resource.split('/')[1]);
      if (nextMember) {
        const serve = nextMember;
        nextMember = null;
        return serve(group, params);
      }
      return json(memberData(group, params));
    }
    if (resource.startsWith('stocks/')) {
      const id = decodeURIComponent(resource.split('/')[1]);
      const row = [...smallRows, ...largeRows].find(({ securityId }) => securityId === id);
      if (resource.endsWith('/chart')) return json({ ...row, requestedDate: anchor, date: anchor, dataVersion: point.dataVersion,
        calculationVersion, basis: point.basis, state: 'ready', bars: stockBars,
        span: { from: stockBars[0].date, through: anchor, observations: stockBars.length, gaps: 0 } });
      return json({ ...row, date: anchor, dataVersion: point.dataVersion, chartBars: stockBars, calculationVersion });
    }
    return json({ error: `Unexpected fixture request ${resource}` }, 404);
  }

  const bindings = { window, document, location: window.location, history: window.history, FormData: window.FormData, HashChangeEvent: window.HashChangeEvent, fetch };
  const prior = new Map(Object.keys(bindings).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(bindings)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const setInterval = globalThis.setInterval;
  const intervals = [];
  globalThis.setInterval = (...args) => { const timer = setInterval(...args); intervals.push(timer); return timer; };
  t.after(() => {
    for (const timer of intervals) clearInterval(timer);
    globalThis.setInterval = setInterval;
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    window.close();
  });
  const $ = (selector) => document.querySelector(selector);
  const detail = $('#detail');
  const click = (selector) => { const element = $(selector); assert.ok(element, selector); element.click(); };
  const key = (value, target = document.body, options = {}) => target.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options }));
  const search = (value) => {
    detail.querySelector('input[name="search"]').value = value;
    detail.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  };
  const requests = () => calls.filter(({ resource }) => resource.startsWith('industries/') && resource.endsWith('/members'));
  await import('../frontend/app.js');
  await eventually(() => $('[data-review-card] [data-plot]'), 'the first industry chart');
  return { $, window, document, detail, click, key, search, calls, requests,
    respond(result, status) { nextMember = () => json(result, status); },
    hold() {
      let release;
      const response = new Promise((resolve) => { release = (result) => resolve(json(result)); });
      nextMember = () => response;
      return release;
    } };
}

test('ChartBook constituent rankings use the shared stock preview, preserve the chart, and link to pinned ticker stats', async (t) => {
  const { $, window, document, detail, click, key, search, calls, requests, respond, hold } = await workspace(t);
  const opener = '[data-action="market-review-members"]';
  const rows = () => [...detail.querySelectorAll('a.stock-link')].map((entry) => entry.textContent);
  const chart = $('[data-review-card] [data-plot]');
  const range = $('[data-action="market-review-range"][aria-pressed="true"]').dataset.value;
  const initialHash = window.location.hash;
  $('#main').scrollTop = 54;
  assert.equal($(opener).textContent.trim(), 'Stocks (3)');
  assert.equal(requests().length, 0);
  assert.equal(calls.find(({ resource }) => resource === 'chartbooks/market').params.get('observedReferenceDate'), point.observedReferenceDate);
  click(opener);
  await eventually(() => rows().length === 3, 'three Paints/Coatings stocks');
  assert.deepEqual(rows(), ['PPG', 'AXTA', 'RPM']);
  assert.match(detail.getAttribute('aria-label'), /Paints\/Coatings · Stocks/);
  assert.match(detail.textContent, /\$41.00.*\+1.40%/s);
  assert.match(detail.textContent, /<img src=x> Axalta/);
  assert.equal(detail.querySelector('img'), null);
  assert.deepEqual(Object.fromEntries(requests()[0].params), { ...Object.fromEntries(Object.entries(point).map(([key, value]) => [key, String(value)])), page: '1', perPage: '30' });
  assert.equal(requests()[0].method, 'GET');
  assert.equal(window.location.hash, initialHash);
  assert.equal($('[data-review-card] [data-plot]'), chart);
  assert.equal($('#main').scrollTop, 54);
  for (const command of [' ', 'ArrowRight', 'n', 'v', 'm']) assert.equal(key(command), true);
  assert.equal($('#modal').open, false);
  assert.equal($('[data-action="market-review-range"][aria-pressed="true"]').dataset.value, range);

  const ppg = detail.querySelector('a.stock-link');
  assert.equal(ppg.getAttribute('href').startsWith('#stock?'), true);
  const stockRoute = new URLSearchParams(ppg.getAttribute('href').slice(7));
  for (const [key, value] of Object.entries(point)) assert.equal(stockRoute.get(key), String(value));
  assert.equal(stockRoute.get('symbol'), 'security:PPG');
  ppg.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true }));
  await eventually(() => $('#workspace-ticker-preview svg'), 'shared hover candle preview');
  assert.equal($('#workspace-ticker-preview').parentElement, detail);
  assert.match($('#workspace-ticker-preview').textContent, /3M daily candles.*63 candles/s);
  const hover = calls.find(({ resource }) => resource === 'stocks/security%3APPG/chart');
  assert.equal(hover.params.get('lookback'), '63');
  for (const [key, value] of Object.entries(point)) assert.equal(hover.params.get(key), String(value));
  ppg.dispatchEvent(new window.MouseEvent('pointerout', { bubbles: true }));
  const axta = detail.querySelectorAll('a.stock-link')[1];
  axta.focus();
  await eventually(() => $('#workspace-ticker-preview .ticker-preview-title strong')?.textContent === 'AXTA' && $('#workspace-ticker-preview svg'), 'focus candle preview');
  assert.equal(axta.getAttribute('aria-describedby'), 'workspace-ticker-preview');
  assert.equal(key('Escape', axta), false);
  await eventually(() => !detail.open && document.activeElement === $(opener), 'Escape dismissal and restored focus');
  assert.equal($('#workspace-ticker-preview'), null);
  assert.equal(detail.querySelector('table'), null);
  assert.equal($('[data-review-card] [data-plot]'), chart);

  click(opener);
  await eventually(() => rows().length === 3, 'reopened member list');
  detail.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: -1, clientY: -1 }));
  detail.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: -1, clientY: -1 }));
  await eventually(() => !detail.open && document.activeElement === $(opener), 'backdrop dismissal');
  assert.equal($('#main').scrollTop, 54);

  click('[data-action="market-review-next"]');
  await eventually(() => $('[data-review-card] h2')?.textContent === 'Biotech' && $('[data-review-card] [data-plot]'), 'second industry');
  assert.equal($(opener).textContent.trim(), 'Stocks (65)');
  click(opener);
  await eventually(() => rows().length === 30, 'first page of the larger industry');
  assert.deepEqual([rows()[0], rows().at(-1)], ['B001', 'B030']);
  assert.match(detail.querySelector('.pagination').textContent, /1–30 of 65/);
  click('#detail [data-action="market-review-members-page"][data-value="2"]');
  await eventually(() => rows()[0] === 'B031', 'second server page');
  assert.match(detail.querySelector('.pagination').textContent, /31–60 of 65/);
  click('#detail [data-action="market-review-members-page"][data-value="3"]');
  await eventually(() => rows()[0] === 'B061', 'last server page');
  assert.deepEqual(rows(), ['B061', 'B062', 'B063', 'B064', 'B065']);
  assert.equal(detail.querySelector('[data-action="market-review-members-page"][data-value="4"]').disabled, true);
  search('B001 Corporation');
  await eventually(() => rows().length === 1 && rows()[0] === 'B001', 'matching company from another page');
  assert.equal(requests().at(-1).params.get('page'), '1');
  assert.equal(requests().at(-1).params.get('search'), 'B001 Corporation');
  search('not present');
  await eventually(() => detail.textContent.includes('No matching stocks'), 'no search matches');
  click('#detail [data-review-members-clear]');
  await eventually(() => rows().length === 30, 'cleared member search');
  assert.equal(requests().at(-1).params.has('search'), false);

  respond({ error: 'Fixture member service was offline' }, 503);
  search('B017');
  await eventually(() => detail.querySelector('[role="alert"]')?.textContent.includes('Fixture member service was offline'), 'inline load error');
  respond({ date: anchor, pendingOnly: true, rows: [], total: null }, 202);
  click('#detail [data-action="market-review-members-retry"]');
  await eventually(() => detail.textContent.includes('awaiting preparation'), 'pending prepared backend result');
  assert.doesNotMatch(detail.textContent, /No matching stocks|No constituent stocks/);
  click('#detail [data-action="market-review-members-retry"]');
  await eventually(() => rows().length === 1 && rows()[0] === 'B017', 'retried both states with the same search');

  const finishSearch = hold();
  search('B002');
  const abandonedSearch = requests().at(-1);
  search('B018');
  await eventually(() => rows()[0] === 'B018', 'newer search');
  assert.equal(abandonedSearch.signal.aborted, true);
  finishSearch({ date: anchor, rows: [largeRows[1]], page: 1, perPage: 30, total: 1 });
  await setTimeout(0);
  assert.deepEqual(rows(), ['B018']);

  const finishClose = hold();
  search('B019');
  const closeRequest = requests().at(-1);
  key('Escape');
  await eventually(() => !detail.open && closeRequest.signal.aborted, 'dismissed pending request');
  finishClose({ date: anchor, rows: [largeRows[18]], page: 1, perPage: 30, total: 1 });
  await setTimeout(0);
  assert.deepEqual(rows(), []);

  const finishReplacement = hold();
  click(opener);
  const replacedRequest = requests().at(-1);
  click('#context-toggle');
  await eventually(() => detail.open && detail.getAttribute('aria-label') === 'Analysis context', 'replacement drawer owner');
  assert.equal(replacedRequest.signal.aborted, true);
  finishReplacement({ date: anchor, rows: [largeRows[19]], page: 1, perPage: 30, total: 1 });
  await setTimeout(0);
  assert.equal(detail.getAttribute('aria-label'), 'Analysis context');
  assert.deepEqual(rows(), []);
  key('Escape');
  await eventually(() => !detail.open, 'context drawer closed');

  const finishNavigation = hold();
  click(opener);
  const routeRequest = requests().at(-1);
  window.location.hash = '#chartbook?mode=market&reviewView=market';
  await eventually(() => !detail.open && routeRequest.signal.aborted && $('[data-review-card] h2')?.textContent === 'Daily 4% movers', 'new route canceled member read');
  finishNavigation({ date: anchor, rows: [largeRows[20]], page: 1, perPage: 30, total: 1 });
  await setTimeout(0);
  assert.equal($(opener), null);
  assert.deepEqual(rows(), []);

  window.location.hash = initialHash;
  await eventually(() => $(opener)?.textContent.trim() === 'Stocks (3)', 'industry card restored');
  click(opener);
  await eventually(() => rows()[0] === 'PPG', 'member link ready for click-through');
  click('#detail a.stock-link');
  await eventually(() => $('#ticker-dashboard h1')?.textContent.startsWith('PPG'), 'full ticker dashboard after click');
  const ticker = calls.find(({ resource }) => resource === 'stocks/security%3APPG');
  assert.equal(ticker.params.get('date'), anchor);
  assert.equal(ticker.params.get('dataVersion'), String(point.dataVersion));
  assert.equal(ticker.params.get('observedReferenceDate'), point.observedReferenceDate);
  assert.equal(detail.open, false);
  window.history.back();
  await eventually(() => $(opener)?.textContent.trim() === 'Stocks (3)' && $('[data-review-card] [data-plot]'), 'Back to the same industry chart');
  assert.equal($('[data-action="market-review-range"][aria-pressed="true"]').dataset.value, range);
  assert.ok(calls.every(({ method }) => method === 'GET'));
});
