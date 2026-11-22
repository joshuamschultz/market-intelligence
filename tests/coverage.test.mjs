import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { marketUniverses, openCoverageDrawer } from '../frontend/coverage.js';

const point = { date: '2026-11-20', dataVersion: 14, universe: 'us-core', universeVersion: 1, model: 'composite',
  modelVersion: 2, benchmark: 'VTI', classification: 'nasdaq', basis: 'reconstructed', reference: 'latest' };

function environment(t, api) {
  const dom = new JSDOM('<dialog><h2></h2><p></p><section></section></dialog>');
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const detail = document.querySelector('dialog');
  const body = detail.querySelector('section');
  const config = { status: { securities: 10_094, dataVersion: 15, latestDate: '2026-11-23',
    runs: [{ status: 'complete', rows: 0, provider: 'nasdaq' }, { status: 'complete', rows: 5_000, provider: 'eodhd' }] },
    models: [{ id: 'composite', version: 2, name: 'Composite RS' }], universes: marketUniverses.map(({ id }) => ({ id, version: 1 })) };
  return { document, detail, body, env: { config, detail, api, routeUrl: () => '#settings?tab=jobs',
    showDialog(node, title, html, subtitle) {
      node.dispatchEvent(new dom.window.Event('workspace:dialog-change'));
      node.open = true;
      node.querySelector('h2').textContent = title;
      node.querySelector('p').textContent = subtitle;
      body.innerHTML = html;
      return body;
    } } };
}

test('drawer reads seven named universes at a single pinned date and explains source roles and totals', async (t) => {
  const requests = [];
  const { env, detail, body } = environment(t, async (path, options) => {
    requests.push({ path, ...options.params });
    const data = (listed, traded, ranked) => ({ date: point.date, dataVersion: point.dataVersion,
      coverage: { listed, traded, ranked, state: 'partial' } });
    switch (options.params.universe) {
      case 'us-core': return data(5245, 5162, 4053);
      case 'nyse': return data(1931, 1879, 1612);
      case 'us-extended': return data(5463, 5376, 4217);
      case 'us-all': return data(5796, 5709, 4484);
      case 'small-cap': return { ...data(0, 0, 0), coverage: { listed: 0, traded: 0, ranked: 0, state: 'unprepared' },
        preparation: { preparationState: 'queued' } };
      case 'liquid-us': return { ...data(12, 10, 8), date: '2026-11-19' };
      default: throw new Error('No snapshot');
    }
  });
  await openCoverageDrawer(env, point);
  assert.equal(detail.querySelector('h2').textContent, 'Universe counts');
  assert.match(detail.querySelector('p').textContent, /Nov 20, 2026 · Revision 14/);
  assert.equal(requests.length, 7);
  assert.deepEqual(requests.map(({ universe }) => universe), marketUniverses.map(({ id }) => id));
  for (const { universe, ...request } of requests) {
    const { universe: selected, ...context } = point;
    assert.deepEqual(request, { path: 'market/overview', ...context });
  }
  const row = (id) => body.querySelector(`[data-universe-count="${id}"]`);
  const values = (id) => [...row(id).querySelectorAll('[data-count]')].map((cell) => cell.textContent);
  assert.deepEqual(values('us-core'), ['5,245', '5,162', '4,053', '83']);
  assert.deepEqual(values('nyse'), ['1,931', '1,879', '1,612', '52']);
  assert.deepEqual(values('us-extended'), ['5,463', '5,376', '4,217', '87']);
  assert.deepEqual(values('us-all'), ['5,796', '5,709', '4,484', '87']);
  assert.match(row('us-core').textContent, /US Core \(selected\).*Operating common stocks on NYSE and Nasdaq/s);
  assert.match(row('us-all').textContent, /US All Listed.*supported downloaded listed types, including ETFs/s);
  assert.deepEqual(values('small-cap'), ['—', '—', '—', '—']);
  assert.match(row('small-cap').textContent, /Queued/);
  assert.match(row('liquid-us').textContent, /Requested snapshot unavailable/);
  assert.match(row('nasdaq').textContent, /Counts unavailable/);
  assert.match(body.textContent, /Prices: EODHD · Industry data: Nasdaq directory · RS model: Composite RS/);
  assert.match(body.textContent, /breadth metric can use a smaller comparable denominator/);
  assert.match(body.textContent, /Warehouse catalog · 10,094 security records at revision 15.*historical records across all dates/s);
});

test('a prepared universe reports zero missing prices when all eligible securities traded', async (t) => {
  const { env, body } = environment(t, async (path, { params }) => ({
    date: point.date, dataVersion: point.dataVersion,
    coverage: params.universe === 'liquid-us' ? { state: 'partial', listed: 2123, traded: 2123, ranked: 2046 }
      : { state: 'unprepared' },
  }));
  await openCoverageDrawer(env, point);
  assert.equal(body.querySelector('[data-universe-count="liquid-us"] [data-count="missing"]').textContent, '0');
  assert.equal(body.querySelector('[data-universe-count="small-cap"] [data-count="missing"]').textContent, '—');
});

test('replacing a coverage drawer cancels its pinned requests and prevents late updates', async (t) => {
  const requests = [];
  const { env, detail, body } = environment(t, (path, options) => new Promise((resolve) => requests.push({ signal: options.signal, resolve })));
  const loading = openCoverageDrawer(env, point);
  assert.equal(requests.length, 7);
  detail.dispatchEvent(new detail.ownerDocument.defaultView.Event('workspace:dialog-change'));
  body.innerHTML = '<strong>Another view</strong>';
  assert.ok(requests.every(({ signal }) => signal.aborted));
  for (const { resolve } of requests) resolve({ date: point.date, dataVersion: 14, coverage: { listed: 1, traded: 1, ranked: 1 } });
  await loading;
  assert.equal(body.textContent, 'Another view');
});
