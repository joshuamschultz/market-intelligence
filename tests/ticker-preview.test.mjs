import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { mountTickerPreview, setTickerPreviewContext } from '../frontend/ticker-preview.js';

const baseDate = '2024-04-02';
const baseContext = { date: baseDate, dataVersion: 17, basis: 'reconstructed', reference: 'latest', calculationVersion: '2-test' };
const CSS = readFileSync(new URL('../frontend/ticker-preview.css', import.meta.url), 'utf8');
const button = (symbol, descriptor = '') => `<button id="${symbol}" data-action="stock" data-value="fixture:${symbol}"
  ${descriptor ? `aria-describedby="${descriptor}"` : ''}><span>${symbol}</span></button>`;

async function until(check, label) {
  const timeout = Date.now() + 1200;
  while (Date.now() < timeout) {
    if (check()) return;
    await wait(5);
  }
  assert.fail(label);
}

function payload(path, params, override) {
  const securityId = decodeURIComponent(path.split('/')[1]);
  const bars = [{ date: '2024-01-03', open: 10, high: 14, low: 8, close: 13 },
    { date: '2024-02-05', gap: 'price-quarantined' },
    { date: params.date, open: 13, high: 16, low: 7, close: 9 }];
  return { securityId, symbol: securityId.split(':').at(-1), requestedDate: params.date, date: params.date,
    dataVersion: params.dataVersion, calculationVersion: baseContext.calculationVersion, basis: params.basis, state: 'ready', bars,
    span: { from: bars[0].date, through: params.date, observations: 2, sessionCount: 3, gaps: 1 }, ...override };
}

function fixture(t, options = {}) {
  const dom = new JSDOM(`<style>${CSS}</style><main>${button('ALFA', 'owner-tip')}${button('BRAVO')}${button('CHARLIE')}</main>
    <dialog open><div id="drawer-list">${button('DRAWER')}</div>
    <input id="search"><div id="search-results"><button id="stock-option" data-ticker-preview="fixture:RESULT" role="option"><strong>RESULT</strong><span>Company</span></button>
    <button id="page-option" role="option">Market Overview</button></div></dialog>`, { url: 'http://localhost/#rankings' });
  const { window } = dom;
  const { document } = window;
  const calls = [];
  let context = baseContext;
  let generation = 0;
  const controller = mountTickerPreview({ document, delay: 0, getContext: () => context, getGeneration: () => generation,
    api(path, settings) {
      calls.push({ path, ...settings });
      return options.api ? options.api(path, settings) : Promise.resolve(payload(path, settings.params));
    },
    ...('cacheSize' in options && { cacheSize: options.cacheSize }),
  });
  t.after(() => { controller.destroy(); window.close(); });
  const $ = (selector) => document.querySelector(selector);
  function pointer(target, type, { relatedTarget = null, pointerType = 'mouse' } = {}) {
    const event = new window.MouseEvent(type, { bubbles: true, relatedTarget });
    Object.defineProperty(event, 'pointerType', { value: pointerType });
    $(target).dispatchEvent(event);
  }
  return { window, document, calls, $, pointer, tooltip: () => $('[role="tooltip"]'), controller,
    setContext(next) { context = next; }, advanceGeneration() { generation++; } };
}

test('delegated preview draws OHLC with dated gaps, clamps the card, preserves descriptions and click behavior', async (t) => {
  const { window, $, pointer, tooltip, calls } = fixture(t);
  window.innerWidth = 280;
  window.innerHeight = 270;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.getAttribute('role') === 'tooltip' ? { width: 200, height: 190 } : { left: 250, top: 245, bottom: 258 };
  };
  pointer('#ALFA span', 'pointerover');
  await until(() => tooltip()?.querySelector('svg'), 'rendered candle preview');
  assert.equal(calls[0].path, 'stocks/fixture%3AALFA/chart');
  assert.deepEqual(calls[0].params, { basis: baseContext.basis, dataVersion: 17, date: baseDate, reference: 'latest', lookback: 63 });
  assert.equal(calls[0].plain, true);
  assert.equal(tooltip().style.left, '72px');
  assert.equal(tooltip().style.top, '47px');
  assert.equal(window.getComputedStyle(tooltip()).pointerEvents, 'none');
  assert.deepEqual([...tooltip().querySelectorAll('.ticker-preview-candle')].map((node) => [node.dataset.date, node.classList.contains('up')]),
    [['2024-01-03', true], [baseDate, false]]);
  assert.match(tooltip().textContent, /As of Apr 2, 2024/);
  assert.match(tooltip().textContent, /Jan 3 – Apr 2, 2024/);
  assert.match(tooltip().textContent, /2 candles · 1 gap/);
  assert.equal($('#ALFA').getAttribute('aria-describedby'), `owner-tip ${tooltip().id}`);
  pointer('#ALFA span', 'pointerout', { relatedTarget: $('#ALFA') });
  assert.ok(tooltip(), 'moving within a ticker keeps the preview');
  $('#ALFA').setAttribute('aria-describedby', `owner-tip ${tooltip().id} inserted-tip`);
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(tooltip(), null);
  assert.equal($('#ALFA').getAttribute('aria-describedby'), 'owner-tip inserted-tip');
  pointer('#ALFA', 'pointerover');
  assert.ok(tooltip(), 'cached preview appears immediately');
  let clicks = 0;
  $('#ALFA').addEventListener('click', (event) => { assert.equal(event.defaultPrevented, false); clicks++; });
  pointer('#ALFA', 'pointerdown');
  $('#ALFA').click();
  assert.equal(clicks, 1);
  assert.equal(tooltip(), null);
  assert.equal(calls.length, 1);
});

test('rapid hover changes abort previous reads and ignore stale responses even if fetch resolves after abort', async (t) => {
  const pending = [];
  const { pointer, tooltip, calls, setContext, advanceGeneration } = fixture(t, {
    api: (path, settings) => new Promise((resolve) => pending.push(() => resolve(payload(path, settings.params)))),
  });
  pointer('#ALFA', 'pointerover');
  await until(() => calls.length === 1, 'first request');
  pointer('#ALFA', 'pointerout');
  pointer('#BRAVO', 'pointerover');
  await until(() => calls.length === 2, 'second request');
  assert.equal(calls[0].signal.aborted, true);
  pending[1]();
  await until(() => tooltip()?.querySelector('svg'), 'new chart');
  pending[0]();
  await wait(10);
  assert.equal(tooltip().querySelector('strong').textContent, 'BRAVO');
  pointer('#BRAVO', 'pointerout');
  pointer('#ALFA', 'pointerover');
  await until(() => calls.length === 3, 'aborted response was not cached');
  setContext({ ...baseContext, date: '2024-03-12', dataVersion: 18, basis: 'known', reference: 'as-of' });
  advanceGeneration();
  pending[2]();
  await until(() => !tooltip(), 'stale generation resets visible loading');
  pointer('#ALFA', 'pointerover');
  await until(() => calls.length === 4, 'request in new context');
  assert.deepEqual(calls[3].params, { lookback: 63, basis: 'known', dataVersion: 18, date: '2024-03-12', reference: 'as-of' });
});

test('preview scopes historical mover links, contributor rows and keyboard search inside their dialogs', async (t) => {
  const { window, $, pointer, tooltip, calls, controller } = fixture(t);
  const drawerDate = '2024-03-12';
  setTickerPreviewContext($('#drawer-list'), { date: drawerDate, basis: 'known', dataVersion: 11, reference: 'as-of' });
  setTickerPreviewContext($('#search-results'), { date: '2024-03-05', dataVersion: 12 });
  $('#drawer-list').insertAdjacentHTML('beforeend', button('ADDED'));
  $('#ADDED').focus();
  await until(() => tooltip()?.querySelector('svg'), 'keyboard-focused newly inserted contributor');
  assert.equal(tooltip().parentElement, $('dialog'));
  assert.deepEqual([calls[0].params.date, calls[0].params.dataVersion, calls[0].params.basis], [drawerDate, 11, 'known']);
  $('#search').focus();
  assert.equal(tooltip(), null);
  controller.focusOption($('#stock-option'), $('#search'));
  await until(() => tooltip()?.querySelector('svg'), 'active search stock option');
  assert.equal(tooltip().parentElement, $('dialog'));
  assert.equal(calls[1].params.date, '2024-03-05');
  controller.focusOption($('#page-option'), $('#search'));
  assert.equal(tooltip(), null);

  $('main').insertAdjacentHTML('beforeend', `<a id="mover" class="stock-link"
    href="#stock?symbol=fixture%3AMOVER&amp;universe=us-all&amp;date=2024-03-12&amp;dataVersion=14&amp;basis=known">MOVER</a>`);
  pointer('#mover', 'pointerover');
  await until(() => tooltip()?.querySelector('svg'), 'historical mover link preview');
  assert.equal(calls[2].path, 'stocks/fixture%3AMOVER/chart');
  assert.deepEqual([calls[2].params.date, calls[2].params.dataVersion, calls[2].params.universe], [drawerDate, '14', 'us-all']);
  window.dispatchEvent(new window.Event('resize'));
  assert.equal(tooltip(), null);
});

test('dynamic watchlist member previews use the saved screen and resolved member receipt', async (t) => {
  const { $, document, pointer, tooltip, calls } = fixture(t);
  globalThis.document = document;
  t.after(() => { delete globalThis.document; });
  const { render: renderLibrary } = await import('../frontend/library.js');
  const list = { id: 'saved', name: 'Dated entries', definition: { screenId: 'replay' } };
  const screen = { id: 'replay', name: 'Dated screen', definition: { dateMode: 'fixed',
    context: { date: '2024-03-10', dataVersion: 11, basis: 'known', reference: 'as-of' } } };
  await renderLibrary({ page: 'watchlists', main: $('main'), params: {}, state: {}, context: baseContext,
    snapshotContext: baseContext, config: { screens: [screen] }, api: async () => [list], isActive: () => true,
    setActions() {}, routeUrl: () => '#screener',
    publishedSeries: async () => ({ date: '2024-03-08', dataVersion: 11, total: 1, page: 1, perPage: 50,
      rows: [{ symbol: 'SAVED', securityId: 'fixture:SAVED', name: 'Saved', exchange: 'NYSE' }] }),
  });
  pointer('#members [data-action="stock"]', 'pointerover');
  await until(() => tooltip()?.querySelector('svg'), 'watchlist member preview');
  assert.deepEqual(calls[0].params, { date: '2024-03-08', dataVersion: 11, lookback: 63, basis: 'known', reference: 'as-of' });
});

test('cache is bounded and context-specific and touch hover never fetches', async (t) => {
  const { window, $, pointer, tooltip, calls, setContext } = fixture(t, { cacheSize: 2 });
  pointer('#ALFA', 'pointerover', { pointerType: 'touch' });
  window.matchMedia = () => ({ matches: true });
  pointer('#ALFA', 'pointerover');
  await wait(15);
  assert.equal(calls.length, 0);
  window.matchMedia = () => ({ matches: false });
  for (const id of ['ALFA', 'BRAVO', 'ALFA', 'CHARLIE']) {
    pointer(`#${id}`, 'pointerover');
    await until(() => tooltip()?.querySelector('svg'), `${id} preview`);
    pointer(`#${id}`, 'pointerout');
  }
  assert.equal(calls.length, 3, 'existing cache hit updates the eviction order');
  pointer('#BRAVO', 'pointerover');
  await until(() => tooltip()?.querySelector('svg'), 'evicted entry loads again');
  assert.equal(calls.length, 4);
  pointer('#BRAVO', 'pointerout');
  setContext({ ...baseContext, basis: 'known', reference: 'as-of' });
  pointer('#BRAVO', 'pointerover');
  await until(() => tooltip()?.querySelector('svg'), 'same symbol and revision with a different price basis');
  assert.equal(calls.length, 5);
  $('#BRAVO').remove();
  await until(() => !tooltip(), 'removed anchor cleans up portal');
});

test('unprepared or mismatched responses show a placeholder without caching a missing chart', async (t) => {
  let requests = 0;
  const { pointer, tooltip } = fixture(t, { api(path, { params }) {
    requests++;
    if (requests === 1) return Promise.resolve(payload(path, params, { dataVersion: 15 }));
    if (requests === 2) return Promise.resolve(payload(path, params, { state: 'requires-exact-date', bars: [], span: null }));
    return Promise.resolve(payload(path, params));
  } });
  pointer('#ALFA', 'pointerover');
  await until(() => tooltip()?.textContent.includes('unavailable for this analysis context'), 'mismatched archive placeholder');
  assert.equal(tooltip().querySelector('svg'), null);
  pointer('#ALFA', 'pointerout');
  pointer('#ALFA', 'pointerover');
  await until(() => tooltip()?.textContent.includes('this exact session'), 'exact-session placeholder');
  assert.equal(tooltip().querySelector('svg'), null);
  pointer('#ALFA', 'pointerout');
  pointer('#ALFA', 'pointerover');
  await until(() => tooltip()?.querySelector('svg'), 'new archive becomes available');
  assert.equal(requests, 3);
});
