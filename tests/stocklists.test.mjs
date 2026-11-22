import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const context = { date: '2026-11-20', dataVersion: 14, universe: 'nyse', universeVersion: 1, model: 'model', modelVersion: 3 };
const config = { models: [], screens: [], rankingPeriods: [{ id: '1m', label: '1M', sessions: 21 }, { id: '6m', label: '6M', sessions: 126 }],
  rankingLists: [{ id: 'fast-improvers', label: 'Fast Improvers', rankField: 'velocity4w', direction: 'desc' }] };

async function display(t, page, params = {}) {
  const dom = new JSDOM('<main></main>');
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  t.after(() => { globalThis.document = previous; dom.window.close(); });
  const requests = [];
  const moves = [];
  const main = document.querySelector('main');
  const env = { main, page, params, config, state: {}, signal: new AbortController().signal, context, isActive: () => true,
    setActions(actions) { this.actions = actions; }, routeUrl: (target, patch = {}) => `#${target}?${new URLSearchParams({ ...context, ...patch })}`,
    go(target, patch, replace) { moves.push({ target, patch, replace }); },
    async api(path) { assert.equal(path, 'market/breadth'); return { coverage: { state: 'complete' } }; },
    async publishedSeries(path, { body }) {
      assert.equal(path, 'screens/query');
      requests.push(body);
      return { date: context.date, total: 1, universeCount: 1, page: 1, perPage: 50, rows: [{ symbol: 'ACME', name: 'Acme', securityId: 'one', rsRank: 1 }],
        ...(body.rankingPeriod ? { period: { topPercent: body.topPercent, cutoff: 1, comparable: 12, sessions: 21 } } : {}) };
    },
  };
  const { render } = await import('../frontend/screener.js');
  await render(env);
  return { main, env, requests, moves };
}

test('stock lists default to 1M top 2% and preserve the pinned query context', async (t) => {
  const { main, env, requests, moves } = await display(t, 'stocklists');
  assert.equal(main.querySelector('h1').textContent, 'Stock Lists');
  assert.equal(main.querySelector('[data-action="ranking-list"][aria-pressed="true"]').dataset.value, '1m');
  assert.equal(main.querySelector('#result-table .stock-link').textContent, 'ACME');
  assert.equal(requests[0].rankingPeriod, '1m');
  assert.equal(requests[0].topPercent, 2);
  assert.deepEqual(requests[0].context, context);
  env.actions['ranking-list']('6m');
  assert.equal(moves[0].target, 'stocklists');
  assert.equal(moves[0].patch.rankList, '6m');
});

test('RS Rankings opens the warehouse without list or model configuration panels', async (t) => {
  const { main, requests } = await display(t, 'rankings');
  assert.equal(main.querySelector('.results-head h2').textContent, 'Ranking warehouse');
  assert.equal(main.querySelector('.ranking-lists, .model-summary'), null);
  assert.match(main.querySelector('a[href^="#settings"]').getAttribute('href'), /tab=config/);
  assert.equal(requests[0].rankingPeriod, undefined);
  assert.equal(requests[0].rankingList, undefined);
  assert.deepEqual(requests[0].context, context);
});

test('legacy list URLs transfer to Stock Lists before querying the warehouse', async (t) => {
  const { requests, moves } = await display(t, 'rankings', { period: '6m', topPercent: '7' });
  assert.equal(requests.length, 0);
  assert.deepEqual(moves, [{ target: 'stocklists', patch: { rankList: '6m', topPercent: '7' }, replace: true }]);
});

test('top 100 uses an ordinary saved-screen filter and keeps RS sort', async (t) => {
  const { main, requests } = await display(t, 'stocklists', { rankList: 'top-100' });
  assert.equal(main.querySelector('.results-head h2').textContent, 'Top 100 by RS rank');
  assert.deepEqual(requests[0].filter, { field: 'rsRank', op: 'lte', value: 100 });
  assert.deepEqual(requests[0].sort, [{ field: 'rsRank', direction: 'asc' }]);
  assert.equal(requests[0].rankingList, undefined);
});
