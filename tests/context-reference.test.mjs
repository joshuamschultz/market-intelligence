import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('Ticker routes send the explicit reference cutoff, clear it on context changes, and return to verified latest', async (t) => {
  const symbol = 'security:PPG';
  const pinnedDate = '2026-11-19';
  const cutoff = '2026-11-20';
  const latestDate = '2026-11-23';
  const latestReference = '2026-11-24';
  const recipe = { universe: 'us-core', universeVersion: 1, model: 'composite', modelVersion: 1, basis: 'reconstructed',
    benchmark: 'SPY', classification: 'nasdaq', reference: 'latest' };
  const selection = { symbol, date: pinnedDate, dataVersion: 29, observedReferenceDate: cutoff, classification: 'nasdaq', reference: 'latest' };
  const hash = `#stock?${new URLSearchParams(selection)}`;
  const dom = new JSDOM(await readFile(new URL('../frontend/index.html', import.meta.url), 'utf8'), {
    url: `http://localhost/${hash}`, pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;
  window.sessionStorage.setItem('market-intelligence.analysis-revision', JSON.stringify({ dataVersion: 29, latestDate: pinnedDate }));
  const status = { latestDate, dataVersion: 57, calculationVersion: 'fixture', preparation: { total: 1, dataVersion: 55,
    contexts: [{ ...recipe, date: latestDate, observedReferenceDate: latestReference, stages: { current: 'complete', recent: 'complete' } }] } };
  const build = { version: 'fixture' };
  const config = { status, build, automaticPreparation: true, defaultClassification: 'nasdaq', classificationSystems: ['nasdaq', 'sec-sic'],
    availableBenchmarks: ['SPY'], universes: [{ id: 'us-core', name: 'US Core', version: 1 }], models: [{ id: 'composite', name: 'Composite', version: 1 }] };
  const reads = [];
  const preparations = [];
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
  async function fetch(path, settings) {
    const { pathname, searchParams } = new URL(path, window.location.origin);
    if (pathname === '/api/v1/config') return json(config);
    if (pathname === '/api/v1/build') return json(build);
    if (pathname === '/api/v1/data/status') return json(status);
    if (['/api/v1/screens', '/api/v1/jobs'].includes(pathname)) return json([]);
    if (pathname === '/api/v1/data/preparation') {
      preparations.push(JSON.parse(settings.body));
      return json({ jobs: [], queued: 0 });
    }
    if (pathname === '/api/v1/stocks/security%3APPG') {
      reads.push(Object.fromEntries(searchParams));
      return json({ date: searchParams.get('date') || latestDate, symbol: 'PPG', pendingOnly: true });
    }
    return json({ error: 'Unexpected fixture route' }, 404);
  }
  const bindings = { window, document, location: window.location, history: window.history, FormData: window.FormData, HashChangeEvent: window.HashChangeEvent, fetch };
  const previous = new Map(Object.keys(bindings).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(bindings)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const setInterval = globalThis.setInterval;
  const timers = [];
  globalThis.setInterval = (...args) => { const timer = setInterval(...args); timers.push(timer); return timer; };
  t.after(() => {
    timers.forEach(clearInterval);
    globalThis.setInterval = setInterval;
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    window.close();
  });
  async function nextRead(operation) {
    const before = reads.length;
    operation();
    for (let index = 0; index < 100 && reads.length === before; index++) await setTimeout(5);
    assert.equal(reads.length, before + 1, `read after ${window.location.hash}`);
    return reads.at(-1);
  }
  const change = (field, value) => {
    const control = document.querySelector(`[data-change="context"][data-value="${field}"]`);
    control.value = value;
    control.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const initial = await nextRead(() => import('../frontend/app.js'));
  assert.equal(initial.observedReferenceDate, cutoff);
  assert.equal(initial.dataVersion, '29');
  assert.match(document.querySelector('a[data-route="chartbook"]').hash, /observedReferenceDate=2026-11-20/);

  let request = await nextRead(() => change('classification', 'sec-sic'));
  assert.equal(request.classification, 'sec-sic');
  assert.equal(request.observedReferenceDate, undefined);
  assert.doesNotMatch(window.location.hash, /observedReferenceDate/);
  await nextRead(() => { window.location.hash = hash; });
  request = await nextRead(() => change('reference', 'as-of'));
  assert.equal(request.reference, 'as-of');
  assert.equal(request.observedReferenceDate, undefined);
  await nextRead(() => { window.location.hash = hash; });
  request = await nextRead(() => change('date', '2026-11-18'));
  assert.equal(request.date, '2026-11-18');
  assert.equal(request.observedReferenceDate, undefined);

  const restored = await nextRead(() => { window.location.hash = hash; });
  assert.equal(restored.observedReferenceDate, cutoff);
  const latest = await nextRead(() => document.querySelector('[data-action="current"]').click());
  assert.equal(latest.date, undefined);
  assert.equal(latest.observedReferenceDate, undefined);
  assert.equal(latest.dataVersion, '55', 'default readiness can use the resolved server cutoff');
  assert.equal(preparations.at(-1).context.followLatest, true);
  assert.equal(preparations.at(-1).context.observedReferenceDate, undefined);
});
