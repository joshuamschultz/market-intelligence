import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { bindChartbookChart, buildChartbookPlot, chartbookShortcut, renderChartbookChart } from '../frontend/chartbook-ui.js';
import { render } from '../frontend/chartbook.js';

const dateAt = (index) => new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
const bars = Array.from({ length: 58 }, (_, index) => ({ date: dateAt(index), close: 100, open: 99, high: 110, low: 95, traded: true }));
const layers = { sma20: true, sma50: true, benchmark: true, industry: true, moves: true };

test('ChartBook preserves split-adjusted candle gaps, MA warmup, shared anchors, and quiet daily marks', () => {
  const chartBars = bars.map((bar, index) => index === 52 ? { ...bar, unverifiedSplit: true }
    : index === 55 ? { ...bar, close: 104 } : index === 56 ? { ...bar, close: 98 } : { ...bar });
  const data = buildChartbookPlot({ chartBars, date: dateAt(57),
    benchmark: { state: 'ready', rows: bars.map(({ date }, index) => ({ date, close: 350 + index })) },
    industry: { state: 'partial', name: '<script>Industry</script>', rows: bars.slice(49).map(({ date }, index) => ({ date, value: 500 + index })) },
  }, 12, layers);
  assert.equal(data.rows.length, 12);
  assert.equal(data.anchor, dateAt(49));
  const at = (index) => data.rows.find(({ date }) => date === dateAt(index));
  assert.equal(at(48).benchmark, undefined);
  assert.equal(at(49).benchmark, 100);
  assert.equal(at(49).industry, 100);
  assert.equal(at(50).sma50, 100);
  assert.equal(at(52).close, null);
  assert.equal(at(52).industry, undefined);
  assert.equal(at(53).change, null);
  assert.equal(at(53).sma20, null);
  const chart = renderChartbookChart(data, layers, '">Injected');
  const { window } = new JSDOM(chart.html);
  const doc = window.document;
  assert.equal(doc.querySelectorAll('.chartbook-candle').length, 11);
  assert.equal(doc.querySelectorAll('.chartbook-move.rising').length, 1);
  assert.equal(doc.querySelectorAll('.chartbook-move.falling').length, 1);
  assert.equal(doc.querySelector('svg').getAttribute('aria-label').startsWith('\">Injected'), true);
  assert.equal(doc.querySelector('script'), null);
  const hide = bindChartbookChart(doc.body, chart);
  doc.querySelector('svg').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End' }));
  assert.match(doc.querySelector('[data-chartbook-point]').textContent, /Feb 27, 2026.*Close \$100\.00/s);
  assert.match(doc.querySelector('[data-chartbook-point]').textContent, /<script>Industry<\/script>/);
  assert.equal(doc.querySelector('script'), null);
  assert.equal(hide(), true);
  assert.equal(doc.querySelector('[data-chartbook-point]').hidden, true);
  window.close();
});

test('ChartBook shortcuts ignore repeat, editors, open dialogs, and operating system shortcuts', () => {
  const { window } = new JSDOM('<main><input><textarea></textarea><select></select><div contenteditable="true"><span></span></div></main>');
  const { document } = window;
  const run = (key, extra = {}, target = document.body, blocked = false) => chartbookShortcut({ key, target, ...extra }, blocked);
  assert.deepEqual([' ', 'ArrowLeft', 'b', 'v', 'm', 'n', 'Escape'].map((key) => run(key)),
    ['next', 'previous', 'bookmark', 'longer', 'three-months', 'note', 'dismiss']);
  assert.equal(run(' ', { shiftKey: true }), 'previous');
  for (const selector of ['input', 'textarea', 'select', 'span']) assert.equal(run('b', {}, document.querySelector(selector)), null);
  for (const modifier of ['altKey', 'metaKey', 'ctrlKey', 'repeat', 'isComposing', 'defaultPrevented']) assert.equal(run('b', { [modifier]: true }), null);
  assert.equal(run('n', {}, document.body, true), null);
  window.close();
});

test('ChartBook stock notes appear only on plotted sessions and yield to the note tooltip and cleanup', (t) => {
  const data = buildChartbookPlot({ chartBars: bars, date: dateAt(57) }, 7, layers);
  const note = { id: 'dated-note', date: dateAt(53), markdown: 'Watch <em>volume</em>', version: 1,
    createdAt: '2026-02-27T22:00:00.000Z', updatedAt: '2026-02-27T22:00:00.000Z' };
  const chart = renderChartbookChart(data, layers, 'TEST', [note, { ...note, date: dateAt(6) }, { ...note, date: dateAt(58) }]);
  const { window } = new JSDOM(chart.html);
  t.after(() => window.close());
  const { document } = window;
  const marker = document.querySelector('[data-research-note-marker]');
  assert.equal(document.querySelectorAll('[data-research-note-marker]').length, 1);
  assert.equal(marker.dataset.researchNoteMarker, note.date);
  assert.equal(marker.getAttribute('transform'), `translate(${chart.x(data.rows.findIndex((row) => row.date === note.date))} 21)`);
  const controller = new AbortController();
  const edits = [];
  const hide = bindChartbookChart(document.body, chart, { onNoteEdit: (item) => edits.push(item), signal: controller.signal });
  const svg = document.querySelector('svg');
  const key = (node, key) => node.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  key(svg, 'End');
  assert.equal(document.querySelector('[data-chartbook-point]').hidden, false);
  marker.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true }));
  assert.equal(document.querySelector('[data-chartbook-point]').hidden, true);
  const tooltip = () => document.querySelector('.research-note-tooltip');
  assert.equal(tooltip().querySelector('.research-note-copy').textContent, note.markdown);
  assert.equal(tooltip().querySelector('em'), null);
  assert.equal(key(marker, 'Enter'), false);
  assert.deepEqual(edits, [note]);
  assert.equal(tooltip(), null);
  marker.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true }));
  controller.abort();
  assert.equal(tooltip(), null);
  assert.equal(key(svg, 'End'), true);
  assert.equal(key(marker, 'Enter'), true);
  assert.deepEqual(edits, [note]);
  assert.equal(hide(), false);
});

test('ChartBook reuses read-ahead, ignores a late ticker response, and aborts work on exit', async () => {
  const { window } = new JSDOM('<main></main><dialog></dialog><dialog></dialog>');
  const controller = new AbortController();
  const rows = ['A', 'B', 'C', 'D'].map((symbol) => ({ securityId: symbol, symbol, sources: [] }));
  const calls = [];
  const waiting = new Map();
  const card = { chartBars: bars, date: dateAt(57), chartPreparation: { state: 'ready' } };
  const main = window.document.querySelector('main');
  await render({ main, state: {}, signal: controller.signal, params: {}, config: {},
    isActive: () => !controller.signal.aborted, setActions() {}, routeUrl: () => '#chartbook',
    async api(path, options) {
      if (path === 'chartbooks') return { books: [{ id: 'book', name: 'Test book', definition: {} }] };
      if (path === 'research-notes') return { notes: [] };
      if (path.endsWith('/review')) return { date: card.date, dataVersion: 7, rows, total: rows.length };
      const id = path.split('/').at(-1);
      calls.push({ id, signal: options.signal });
      if (id === 'A') return card;
      return new Promise((resolve, reject) => {
        waiting.set(id, resolve);
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    },
  });
  const title = () => main.querySelector('.chartbook-identity h2').textContent;
  const candleName = () => main.querySelector('[data-chartbook-plot] svg')?.getAttribute('aria-label');
  const next = () => window.document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls.map(({ id }) => id), ['A', 'B', 'C']);
  next();
  next();
  assert.equal(title(), 'C');
  waiting.get('B')(card);
  await settle();
  assert.equal(candleName(), undefined);
  waiting.get('C')(card);
  await settle();
  assert.match(candleName(), /^C candlestick chart/);
  assert.deepEqual(calls.map(({ id }) => id), ['A', 'B', 'C', 'D']);
  controller.abort();
  assert.equal(calls.at(-1).signal.aborted, true);
  assert.equal(next(), true, 'route exit removes the shortcut listener');
  assert.equal(title(), 'C');
  window.close();
});

test('ChartBook editor retains sort settings and keeps the selected ticker when ranked order changes', async (t) => {
  const { window } = new JSDOM('<main></main><dialog></dialog><dialog></dialog>');
  t.after(() => window.close());
  const oldFormData = globalThis.FormData;
  globalThis.FormData = window.FormData;
  t.after(() => { globalThis.FormData = oldFormData; });
  const main = window.document.querySelector('main');
  const modal = window.document.querySelector('dialog');
  modal.close = () => modal.removeAttribute('open');
  const state = {};
  const leaf = (id) => ({ securityId: id, symbol: id, sources: [{ type: 'manual', id: 'manual', label: 'My tickers' }] });
  let book = { id: 'book', name: 'Test book', definition: { sources: [{ type: 'manual', id: 'manual', members: ['A', 'B', 'C'] }] } };
  let actions;
  let controller = new AbortController();
  const config = { snapshotContext: {}, date: dateAt(57), dataVersion: 7 };
  const env = { main, modal, state, params: {}, config, snapshotContext: {}, get signal() { return controller.signal; },
    isActive: () => !controller.signal.aborted, setActions(value) { actions = value; }, toast() {}, routeUrl: () => '#chartbook',
    showDialog(dialog, _title, html) { dialog.innerHTML = html; dialog.setAttribute('open', ''); return dialog; },
    go(_route, params) { this.params = { ...this.params, ...params }; },
    async api(path, options) {
      if (path === 'chartbooks') return { books: [book] };
      if (path === 'research-notes') return { notes: [] };
      if (path === 'chartbooks/book' && options.method === 'PUT') {
        book = { ...book, ...options.body };
        return book;
      }
      if (path.endsWith('/review')) {
        const priceSort = book.definition.sort?.metric === 'price-performance';
        return { ...config, rows: priceSort ? ['B', 'C', 'A'].map(leaf) : ['A', 'B', 'C'].map(leaf), total: 3,
          sort: priceSort ? { ...book.definition.sort, label: '3M price performance', rankScope: 'book' }
            : { metric: 'composite-rs', direction: 'desc', label: 'Composite RS', rankScope: 'universe' } };
      }
      return { chartBars: bars, date: dateAt(57), chartPreparation: { state: 'ready' } };
    },
  };
  await render(env);
  await actions['chartbook-next']();
  const current = () => main.querySelector('.chartbook-identity h2').textContent;
  assert.equal(current(), 'B');
  actions['chartbook-edit']();
  const form = modal.querySelector('form');
  const metric = form.elements.namedItem('sortMetric');
  assert.equal(metric.value, 'composite-rs');
  assert.equal(form.elements.namedItem('sortDirection').value, 'desc');
  assert.equal(form.querySelector('[data-chartbook-sort-period]').hidden, true);
  metric.value = 'price-performance';
  metric.dispatchEvent(new window.Event('change'));
  assert.equal(form.querySelector('[data-chartbook-sort-period]').hidden, false);
  form.elements.namedItem('sortDirection').value = 'asc';
  form.elements.namedItem('sortPeriod').value = '3m';
  await modal.onsubmit({ preventDefault() {}, target: form });
  assert.deepEqual(book.definition.sort, { metric: 'price-performance', direction: 'asc', period: '3m' });
  controller.abort();
  controller = new AbortController();
  await render(env);
  assert.equal(current(), 'B');
  assert.match(main.querySelector('.chartbook-subtitle').textContent, /3M price performance ↑/);
  assert.match(main.querySelector('.chartbook-subtitle').textContent, /Ranking unavailable/);
  assert.match(main.querySelector('.chartbook-badges').textContent, /My tickers/);
  await actions['chartbook-next']();
  assert.equal(current(), 'C');
  controller.abort();
});
