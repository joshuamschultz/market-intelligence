import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { expectedSessions } from '../backend/calendar.mjs';

const dates = expectedSessions('2025-11-01', '2026-11-20').slice(-185);
const point = { date: dates.at(-1), dataVersion: 7, universe: 'us-core', universeVersion: 1, basis: 'reconstructed',
  classification: 'sec-sic', reference: 'as-of', benchmark: 'SPY', model: 'composite', modelVersion: 1 };

function useBrowser(t) {
  const browser = new JSDOM('<main></main><dialog id="modal"></dialog>', { url: 'http://localhost/#chartbook?mode=market' });
  const { window } = browser;
  const prior = { document: globalThis.document, FormData: globalThis.FormData };
  globalThis.document = window.document;
  globalThis.FormData = window.FormData;
  t.after(() => {
    if (prior.document === undefined) delete globalThis.document;
    else globalThis.document = prior.document;
    globalThis.FormData = prior.FormData;
    browser.window.close();
  });
  return browser;
}

const pointValue = (series, day, value) => ({ id: series, subjectType: 'market', subjectId: 'journal', date: day,
  markdown: value, version: 1, source: 'journal-note', createdAt: '2026-11-22T00:00:00Z', updatedAt: '2026-11-22T00:00:00Z' });

async function eventually(predicate, label) {
  for (let index = 0; index < 50; index++) {
    if (predicate()) return;
    await setTimeout(2);
  }
  assert.fail(label);
}

test('ChartBook mode pins reads, reuses breadth history on Space, and adds market/industry notes without scrolling', async (t) => {
  const { window } = useBrowser(t);
  const { render } = await import('../frontend/chartbook.js');
  const { document } = window;
  const main = document.querySelector('main'), modal = document.querySelector('#modal');
  const controller = new AbortController();
  t.after(() => controller.abort());
  modal.close = () => modal.removeAttribute('open');
  const calls = [];
  const saved = new Map();
  let journal = pointValue(`journal:${point.date}`, point.date, 'Manual journal line');
  let notesOffline = false;
  const params = { mode: 'market' };
  let actions;
  const env = { main, modal, params, state: {}, snapshotContext: point, signal: controller.signal, config: { automaticPreparation: true },
    isActive: () => !controller.signal.aborted, setActions: (value) => { actions = value; }, toast() {},
    routeUrl: (name, next) => `#${name}?${new URLSearchParams(Object.entries(next).filter(([, value]) => value != null))}`,
    go() {}, render() {}, replaceParams(patch) { Object.assign(params, patch); },
    showDialog(dialog, title, markup) { dialog.innerHTML = markup; dialog.setAttribute('open', ''); return dialog; },
    async api(path, options = {}) {
      calls.push({ path, ...options });
      const requested = options.params || {};
      if (path === 'chartbooks/market') return { ...point, context: point, metrics: [], decks: [],
        industries: [{ id: 'networking', name: 'Networking', rank: 1, count: 32 }, { id: 'transport', name: 'Transport', rank: 2, count: 20 }] };
      if (path === 'chartbooks/market/history') {
        assert.ok([21, 63, 126].includes(requested.lookback));
        assert.equal(requested.date, point.date);
        assert.equal(requested.dataVersion, point.dataVersion);
        return { rows: dates.slice(-(requested.lookback + 9)).map((date) => ({ date, breadth: { up_4pct: [12, 12, 100], down_4pct: [6, 6, 100] } })), state: 'ready' };
      }
      if (path.startsWith('chartbooks/market/industries/')) {
        assert.equal(requested.classification, 'sec-sic');
        assert.equal(requested.lookback, 126);
        return { ...point, sessions: dates.slice(-176), industry: { name: 'Stored group', label: 'Industry equal-weight proxy · dated membership',
          state: 'ready', rows: dates.slice(-176).map((date, i) => ({ date, value: 100 + i / 2 })) },
        benchmark: { symbol: 'SPY', state: 'ready', rows: dates.slice(-176).map((date, i) => ({ date, close: 400 + i })) } };
      }
      if (path === 'research-notes') {
        if (options.method === 'PUT') {
          const note = { ...options.body, id: options.body.noteId || `new:${options.body.subjectId}`,
            version: options.body.expectedVersion + 1, source: 'research-note',
            createdAt: '2026-11-22T00:00:00Z', updatedAt: '2026-11-22T00:00:00Z' };
          if (options.body.subjectId === 'journal') journal = { ...note, source: 'journal-note' };
          else saved.set(options.body.subjectId, note);
          return note;
        }
        if (requested.subjectId === 'journal') return { notes: [
          journal,
          { ...pointValue('journal-ai', point.date, 'Generated content'), source: 'journal-entry' },
        ] };
        if (notesOffline) throw new Error('Notes fixture is offline');
        return { notes: saved.has(requested.subjectId) ? [saved.get(requested.subjectId)] : [] };
      }
      assert.fail(`Unexpected route ${path}`);
    },
  };
  const key = (value, options = {}, target = document.body) => {
    const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  await render(env);
  const title = () => main.querySelector('[data-review-card] h2')?.textContent;
  assert.equal(title(), 'Daily 4% movers');
  assert.match(main.querySelector('nav a').href, /dataVersion=7/);
  assert.equal(main.querySelector('[data-action="market-review-range"][aria-pressed="true"]').dataset.value, '126');
  assert.equal(main.querySelector('[data-research-note-marker]').getAttribute('aria-label').includes('1 research note'), true);
  assert.equal(key(' ', { code: 'Space' }), true);
  await eventually(() => title()?.startsWith('5- and 10-'), 'Space did not advance');
  assert.equal(key(' ', { code: 'Space', shiftKey: true }), true);
  await eventually(() => title() === 'Daily 4% movers' && !!main.querySelector('[data-plot]'), 'Shift+Space did not go back');
  assert.equal(calls.filter(({ path }) => path === 'chartbooks/market/history').length, 1);
  assert.equal(calls.filter(({ params, path }) => path === 'research-notes' && params.subjectId === 'journal').length, 1);
  await actions['market-review-range']('63');
  await actions['market-review-range']('126');
  assert.equal(key('n'), true);
  await eventually(() => modal.open && !modal.querySelector('[type=submit]').disabled, 'market note editor unavailable');
  assert.equal(key(' ', { code: 'Space' }, modal.querySelector('textarea')), false);
  assert.equal(title(), 'Daily 4% movers');
  modal.querySelector('textarea').value = 'Manual chart note';
  modal.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await eventually(() => !modal.open && saved.has('daily-4'), 'Market note did not save');
  assert.equal(saved.get('daily-4').date, point.date);
  await actions['market-review-range']('63');
  const marker = () => main.querySelector('[data-research-note-marker]');
  assert.match(marker().getAttribute('aria-label'), /2 research notes/);
  function showNotes() {
    marker().dispatchEvent(new window.Event('pointerover', { bubbles: true }));
    return main.querySelector('[aria-label="Research notes for this session"]');
  }
  await actions['market-review-range']('126');
  const notes = showNotes();
  assert.match(notes.textContent, /Manual journal line/);
  [...notes.querySelectorAll('button')].find((button) => /Edit market journal/.test(button.textContent)).click();
  await eventually(() => modal.open && !modal.querySelector('[type=submit]').disabled, 'journal note editor unavailable');
  modal.querySelector('textarea').value = 'Updated manual journal line';
  modal.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await eventually(() => !modal.open && journal.version === 2, 'Journal note did not save');
  await actions['market-review-range']('63');
  assert.match(showNotes().textContent, /Updated manual journal line/);
  assert.doesNotMatch(showNotes().textContent, /Generated content/);

  notesOffline = true;
  await actions['market-review-range']('21');
  assert.ok(main.querySelector('[data-plot]'));
  assert.match(main.querySelector('[data-review-note-error]').textContent, /Notes fixture is offline/);
  notesOffline = false;
  const historyReads = calls.filter(({ path }) => path === 'chartbooks/market/history').length;
  await actions['market-review-retry-notes']();
  assert.equal(main.querySelector('[data-review-note-error]'), null);
  assert.match(marker().getAttribute('aria-label'), /2 research notes/);
  assert.equal(calls.filter(({ path }) => path === 'chartbooks/market/history').length, historyReads);
  await actions['market-review-range']('126');
  await actions['market-review-view']('industries');
  assert.equal(title(), 'Networking');
  assert.match(main.querySelector('[data-review-card]').textContent, /SPY · S&P 500 ETF/);
  assert.match(main.querySelector('[data-review-card]').textContent, /20D industry SMA/);
  assert.equal(key('n'), true);
  await eventually(() => modal.open && !modal.querySelector('[type=submit]').disabled, 'industry note editor unavailable');
  const noteRequest = calls.findLast(({ path, params }) => path === 'research-notes' && params.subjectId === 'networking');
  assert.equal(noteRequest.params.subjectType, 'industry');
  assert.equal(noteRequest.params.dataVersion, 7);
  assert.equal(calls.filter(({ path, method }) => path !== 'research-notes' && method && method !== 'GET').length, 0);
});

test('industry index uses SPY at a common date, warmup SMAs, and exact gaps without synthetic OHLC', async (t) => {
  useBrowser(t);
  const { buildIndustryReview, buildMarketReviewRows, marketReviewCards } = await import('../frontend/market-review.js');
  const bundle = { sessions: dates, industry: { rows: dates.map((date, index) => ({ date, value: index === 121 ? null : 100 + index })) },
    benchmark: { rows: dates.map((date, index) => ({ date, close: index === 100 ? null : 400 + index * 2 })) } };
  const industry = buildIndustryReview(bundle, 126);
  assert.equal(industry.rows.length, 126);
  assert.equal(industry.anchor, dates[59]);
  assert.equal(industry.rows[0].industry, 100);
  assert.equal(industry.rows[0].benchmark, 100);
  assert.ok(industry.rows[0].sma50 < 100);
  assert.equal(industry.rows.find(({ date }) => date === dates[100]).benchmark, null);
  assert.equal(industry.rows.find(({ date }) => date === dates[121]).industry, null);
  assert.equal(industry.rows.find(({ date }) => date === dates[121]).benchmark, null);
  assert.equal(industry.rows.find(({ date }) => date === dates[140]).sma20, null);
  assert.ok(industry.rows.find(({ date }) => date === dates[141]).sma20 > 0);
  assert.equal(industry.rows.find(({ date }) => date === dates[170]).sma50, null);
  assert.ok(industry.rows.find(({ date }) => date === dates[171]).sma50 > 0);
  assert.ok(industry.rows.every((row) => !Object.hasOwn(row, 'open')));
  const card = marketReviewCards().find(({ kind }) => kind === 'ratios');
  const history = dates.slice(-15).map((date, i) => ({ date, breadth: {
    up_4pct: i === 10 ? [null, null, null] : [10, 1, 10], down_4pct: [5, 1, 20],
  } }));
  const ratios = buildMarketReviewRows(history, card, 6);
  assert.equal(ratios[0].ratio10, 2);
  assert.equal(ratios.at(-1).ratio5, null);
  assert.equal(ratios.at(-1).ratio10, null);

  const unequal = dates.slice(-10).map((date, index) => {
    const counts = index % 2 ? { up_4pct: [20, 2, 10], down_4pct: [10, 1, 10] }
      : { up_4pct: [5, 5, 100], down_4pct: [10, 10, 100] };
    return { date, breadth: counts };
  });
  const [latest] = buildMarketReviewRows(unequal, card, 1);
  assert.equal(latest.ratio5, 1.4);
  assert.equal(latest.ratio10, 1.25);
  assert.notEqual(latest.ratio10, 35 / 55);
  assert.match(card.description, /Each session carries equal weight/);
});
