import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { expectedSessions } from '../backend/calendar.mjs';
import { chartBookIndustryJob } from '../backend/chartbook.mjs';
import { dataVersion, importDataset, openDatabase, storeWorkspace } from '../backend/database.mjs';
import { materializeHistory } from '../backend/materialization.mjs';
import { writePreparedDetail } from '../backend/prepared-details.mjs';
import { writePreparedSnapshot } from '../backend/prepared-snapshots.mjs';
import { createService, preparationWorkspaceScopes } from '../backend/service.mjs';

function chartBookFixture(t, { archive = true, disk = false, realWorkers = false, sorting = false } = {}) {
  const directory = disk ? mkdtempSync(join(tmpdir(), 'chartbook-test-')) : null;
  const path = disk ? join(directory, 'fixture.sqlite') : ':memory:';
  const db = openDatabase(path);
  t.after(() => {
    if (db.isOpen) db.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  const dates = expectedSessions('2024-01-02', '2026-11-20').slice(-300);
  const latest = dates.at(-1);
  const historical = dates.at(-2);
  const first = dates[0];
  const names = [
    { id: 'company-a', symbol: 'NEW', name: '<b>Issuer A</b>', exchange: 'NASDAQ', type: 'common',
      identifiers: [{ symbol: 'OLD', validFrom: first, validTo: dates[149] }, { symbol: 'NEW', validFrom: dates[150] }] },
    { id: 'company-b', symbol: 'BBB', name: 'Issuer B', exchange: 'NYSE', type: 'common' },
    { id: 'etf-spy', symbol: 'SPY', name: 'SPY', exchange: 'NYSE', type: 'etf' },
  ];
  if (sorting) names.push(
    { id: 'company-c', symbol: 'AAA', name: 'Issuer C', exchange: 'NASDAQ', type: 'common' },
    { id: 'company-d', symbol: 'AAA', name: 'Issuer D', exchange: 'NYSE', type: 'common' },
  );
  const prices = names.flatMap(({ id }, stock) => dates.flatMap((date, position) => {
    if (position === dates.length - 20 && stock === 0) return [];
    const close = 30 + stock * 10 + position * (stock === 1 ? -0.035 : stock === 0 ? 0.1 : 0.025);
    return [{ securityId: id, date, knownAt: date, open: close, high: 1.01 * close, low: 0.99 * close, close, volume: 250_000 }];
  }));
  const imported = importDataset(db, { provider: 'fixture', securities: names.map((row) => ({ ...row, listingDate: first, knownAt: first })),
    prices, classifications: names.slice(0, 2).flatMap(({ id }) => ['provider', 'nasdaq'].map((system) => ({
      securityId: id, system, sector: 'Technology', industry: 'Systems',
      effectiveFrom: system === 'provider' ? first : latest, knownAt: system === 'provider' ? first : latest,
    }))) });
  const context = { date: historical, dataVersion: imported.version, universe: 'us-core', model: 'composite',
    classification: 'provider', reference: 'as-of', benchmark: 'SPY' };
  const api = createService({ db, preparedOnly: true, workers: realWorkers,
    ...(!realWorkers && { provider: { async capabilities() { throw new Error('Unexpected provider call'); } } }) });
  const point = (override = {}) => api.engine.context({ ...context, ...override });
  if (archive) {
    for (const config of [point(), point({ date: latest, classification: 'nasdaq' })]) {
      api.engine.snapshot(config, { persist: true, velocity: true, persistVelocity: true });
      for (const id of names.map((row) => row.id)) writePreparedDetail(db, config, api.engine.detail(config, id, 300, { velocity: false }));
    }
  }
  const call = (method, route, body) => api.dispatch({ method, url: '/api/v1/' + route, body });
  return { db, path, api, call, context, point, latest, historical, dates };
}

test('saved sources resolve in stable order with complete pinned, deduplicated membership and permanent aliases', async (t) => {
  const f = chartBookFixture(t, { disk: true });
  const screen = storeWorkspace(f.db, 'screen', { name: '<em>All stocks</em>', definition: {
    perPage: 1, context: { universe: 'other-not-used' }, sort: [{ field: 'symbol', direction: 'desc' }],
  } });
  const watch = storeWorkspace(f.db, 'watchlist', { name: 'Review picks', definition: { members: ['company-a'], mode: 'manual' } });
  const dynamic = storeWorkspace(f.db, 'watchlist', { name: 'Live screen', definition: { screenId: screen.id, mode: 'dynamic' } });
  const catalog = await f.call('GET', 'chartbooks');
  assert.ok(catalog.body.builtins.some(({ id }) => id === 'leaders-1y'));
  assert.equal(catalog.body.watchlists.find(({ id }) => id === dynamic.id).writable, false);
  const definition = { context: f.context, defaultWatchlistId: watch.id, sources: [
    { type: 'manual', members: ['OLD', 'NEW', 'company-a', 'MISSING'], label: '<script>notes</script>' },
    { type: 'screen', id: screen.id }, { type: 'watchlist', id: watch.id }, { type: 'watchlist', id: dynamic.id },
    { type: 'builtin', id: 'leaders-1m' }, { type: 'builtin', id: 'top-100-rs' },
  ] };
  const saved = await f.call('POST', 'chartbooks', { name: 'Evening review', definition });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.definition.sources[0].members, ['company-a', 'MISSING']);
  const result = await f.call('GET', `chartbooks/${saved.body.id}/review?date=${f.latest}`);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.date, f.historical);
  assert.equal(result.body.dataVersion, f.context.dataVersion);
  assert.equal(result.body.context.universe, 'us-core');
  assert.deepEqual(result.body.rows.map(({ securityId, symbol }) => [securityId, symbol]), [['company-b', 'BBB'], ['company-a', 'NEW']]);
  assert.equal(result.body.sort.metric, 'composite-rs');
  assert.equal(result.body.total, 2);
  assert.equal(result.body.sources.find(({ id }) => id === screen.id).count, 2);
  assert.equal(result.body.sources.find(({ id }) => id === 'leaders-1m').comparable, 1);
  assert.equal(result.body.sources.find(({ id }) => id === 'leaders-1m').count, 1);
  assert.ok(result.body.rows.find(({ securityId }) => securityId === 'company-a').sources.some(({ label }) => label === '<script>notes</script>'));
  assert.equal(result.body.sources[0].unavailable[0].input, 'MISSING');
  assert.equal(result.body.state, 'partial');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);

  storeWorkspace(f.db, 'screen', screen, screen.id, true);
  const deleted = await f.call('GET', `chartbooks/${saved.body.id}/review`);
  assert.equal(deleted.body.sources.find(({ id }) => id === screen.id).state, 'error');
  assert.equal(deleted.body.sources.find(({ id }) => id === dynamic.id).state, 'error');

  const noteRoute = `chartbooks/notes/OLD?date=${f.historical}&dataVersion=${f.context.dataVersion}`;
  const note = await f.call('PUT', noteRoute, { markdown: '<img src=x onerror=alert(1)> Review gap.' });
  assert.equal(note.body.securityId, 'company-a');
  assert.equal(note.body.version, 1);
  assert.deepEqual((await f.call('PUT', noteRoute, { markdown: note.body.markdown })).body, note.body);
  const researchRoute = `research-notes?subjectType=stock&subjectId=company-a&date=${f.historical}&dataVersion=${f.context.dataVersion}`;
  const allNotes = await f.call('GET', researchRoute);
  assert.deepEqual(allNotes.body.notes.map(({ markdown }) => markdown), [note.body.markdown]);
  const updatedNote = await f.call('PUT', researchRoute, { subjectType: 'stock', subjectId: 'company-a',
    date: f.historical, expectedVersion: 1, markdown: 'Edited through shared notes' });
  assert.equal(updatedNote.body.version, 2);
  assert.equal(dataVersion(f.db), f.context.dataVersion);
  const listRoute = `watchlists/${watch.id}/members`;
  const firstAdd = await f.call('POST', listRoute, { add: ['company-b'] });
  const repeated = await f.call('POST', listRoute, { add: ['company-b'] });
  assert.equal(repeated.body.version, firstAdd.body.version);
  assert.deepEqual((await f.call('GET', `watchlists/${watch.id}`)).body.definition.members, ['company-a', 'company-b']);
  f.db.close();
  const reopened = openDatabase(f.path);
  t.after(() => reopened.close());
  const api = createService({ db: reopened, workers: false, preparedOnly: true });
  assert.equal((await api.dispatch({ url: '/api/v1/' + noteRoute })).body.markdown, updatedNote.body.markdown);
  assert.equal((await api.dispatch({ url: '/api/v1/chartbooks' })).body.books[0].definition.defaultWatchlistId, watch.id);
});

test('missing source or chart preparation stays explicit and reads create no jobs or products', async (t) => {
  const f = chartBookFixture(t, { archive: false });
  const empty = await f.call('POST', 'chartbooks/review', { context: f.context, definition: { sources: [
    { type: 'builtin', id: 'new-high-252d' }, { type: 'manual', members: ['OLD'] },
  ] } });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.sources[0].state, 'pending');
  assert.equal(empty.body.sources[0].count, null);
  assert.equal(empty.body.rows[0].securityId, 'company-a');
  assert.equal(empty.body.sort.state, 'pending');
  assert.equal(empty.body.rows[0].sortRank, null);
  const chart = await f.call('GET', `chartbooks/review/stocks/company-a?date=${f.historical}&lookback=1260`);
  assert.equal(chart.status, 200);
  assert.equal(chart.body.stats, null);
  assert.equal(chart.body.industry.state, 'unavailable');
  assert.deepEqual(chart.body.chartBars, []);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM snapshots').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
  const malformed = await f.call('POST', 'chartbooks', { name: 'Rejected', definition: { sources: [{ type: 'builtin', id: 'unknown' }] } });
  assert.equal(malformed.status, 400);
  assert.equal((await f.call('GET', 'chartbooks')).body.books.length, 0);
});

test('prepared ChartBook returns warmup bars, synchronized SPY, dated and explicit current-roster industry curves', async (t) => {
  const f = chartBookFixture(t, { disk: true, realWorkers: true });
  const historical = f.point();
  materializeHistory(f.db, f.api.engine, historical, { limit: 12 });
  const dated = await f.call('GET', `chartbooks/review/stocks/company-a?date=${f.historical}&lookback=126&classification=provider&reference=as-of`);
  assert.equal(dated.status, 200, JSON.stringify(dated.body));
  assert.equal(dated.body.chartBars.length, 176);
  assert.equal(dated.body.benchmark.rows.length, 176);
  assert.ok(dated.body.chartBars.some(({ missing }) => missing));
  assert.equal(dated.body.industry.method, 'dated-equal-weight');
  assert.equal(dated.body.industry.state, 'partial');
  assert.ok(dated.body.stats && Object.hasOwn(dated.body.stats, 'udv_50d'));

  const context = { ...f.context, date: f.latest, classification: 'nasdaq' };
  const route = `chartbooks/review/stocks/company-a?date=${f.latest}&lookback=126&classification=nasdaq&reference=as-of`;
  const unavailable = await f.call('GET', route);
  assert.equal(unavailable.body.industry.state, 'unavailable');
  assert.equal(unavailable.body.industry.canPrepare, true);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
  const book = await f.call('POST', 'chartbooks', { name: 'Today', definition: { context, sources: [{ type: 'manual', members: ['NEW'] }] } });
  assert.equal(book.status, 201);
  const job = f.db.prepare('SELECT id FROM jobs WHERE type=?').get(chartBookIndustryJob);
  let finished;
  for (let attempt = 0; !finished && attempt < 200; attempt++) {
    const row = f.db.prepare('SELECT status,result,error FROM jobs WHERE id=?').get(job.id);
    if (row.status === 'complete') finished = JSON.parse(row.result);
    else {
      assert.notEqual(row.status, 'failed', row.error);
      await setTimeout(10);
    }
  }
  assert.equal(finished?.written, 1);
  const reopened = openDatabase(f.path);
  t.after(() => reopened.close());
  const reader = createService({ db: reopened, workers: false, preparedOnly: true });
  const available = await reader.dispatch({ url: '/api/v1/' + route });
  assert.equal(available.body.industry.method, 'current-membership-proxy');
  assert.match(available.body.industry.label, /current members/);
  assert.ok(available.body.industry.rows.at(-1).value > 0);
  assert.ok(available.body.industry.rows.some(({ observations, expected }) => observations === 1 && expected === 2));
  await reader.dispatch({ url: '/api/v1/' + route });
  assert.equal(reopened.prepare('SELECT count(*) AS n FROM jobs').get().n, 1);
});

test('pure preparation workspace discovery includes active alert dependencies without queuing', (t) => {
  const f = chartBookFixture(t, { archive: false });
  storeWorkspace(f.db, 'alert-rule', { name: 'Price leader', definition: {
    type: 'stocks', active: true, context: { universe: 'nasdaq' }, filter: { field: 'return_37d', op: 'gt', value: 0 },
  } });
  const scopes = preparationWorkspaceScopes(f.db, f.api.engine, { date: f.historical, version: f.context.dataVersion });
  assert.ok(scopes.custom.some((context) => context.universe === 'nasdaq' && context.windows.includes(37)));
  assert.deepEqual(scopes.rangeInputs[0], { rangeWindows: [20, 252] });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
});

test('saved ChartBook sort uses pinned Composite, selected-model, and price values with stable ties and missing last', async (t) => {
  const f = chartBookFixture(t, { sorting: true, disk: true });
  const config = { ...f.context, model: 'short-momentum' };
  const overrides = {
    'company-a': { rsRank: 1, rsScore: 0.3, return_21d: null },
    'company-b': { rsRank: 4, rsScore: 0.1, return_21d: -0.02 },
    'company-c': { rsRank: 2, rsScore: 0.3, return_21d: 0.15 },
    'company-d': { rsRank: 3, rsScore: 0.3, return_21d: 0.15 },
  };
  for (const model of ['composite', 'short-momentum']) {
    const point = f.point({ model });
    const market = f.api.engine.snapshot(point, { persist: false, cache: false });
    const stocks = market.stocks.map((stock) => {
      const values = overrides[stock.securityId];
      return { ...stock, ...values, ...(model === 'short-momentum' && {
        rsRank: 5 - values.rsRank, rsScore: -values.rsScore,
      }) };
    });
    writePreparedSnapshot(f.db, f.api.engine, point, { ...market, stocks });
  }
  const list = storeWorkspace(f.db, 'watchlist', { name: 'Momentum notes', definition: {
    members: ['company-d', 'company-a'], mode: 'manual',
  } });
  const sources = [
    { type: 'manual', label: 'My review', members: ['company-d', 'etf-spy', 'company-a', 'company-b', 'company-c', 'OLD'] },
    { type: 'watchlist', id: list.id },
  ];
  const definition = { context: config, sources };
  // Exercise existing stored books that have never saved a sort setting.
  const book = storeWorkspace(f.db, 'chartbook', { name: 'Review', definition });
  const ids = ({ body }) => body.rows.map(({ securityId }) => securityId);
  const route = `chartbooks/${book.id}`;
  const byComposite = await f.call('GET', `${route}/review?date=${f.latest}`);
  assert.equal(byComposite.body.date, f.historical);
  assert.equal(byComposite.body.context.model, 'short-momentum');
  assert.deepEqual(ids(byComposite), ['company-c', 'company-d', 'company-a', 'company-b', 'etf-spy']);
  assert.deepEqual(byComposite.body.sort, { metric: 'composite-rs', direction: 'desc', label: 'Composite RS', comparable: 4, rankScope: 'universe', state: 'partial' });
  assert.equal(byComposite.body.rows.find(({ securityId }) => securityId === 'company-a').sources.length, 2);

  const savedModel = await f.call('PUT', route, { name: book.name, definition: { ...definition, sort: { metric: 'selected-rs' } } });
  assert.equal(savedModel.status, 200);
  assert.deepEqual(ids(await f.call('GET', `${route}/review`)), ['company-b', 'company-c', 'company-d', 'company-a', 'etf-spy']);
  const ascending = { metric: 'price-performance', period: '1m', direction: 'asc' };
  const savedPrice = await f.call('PUT', route, { name: book.name, definition: { ...definition, sort: ascending } });
  assert.deepEqual(savedPrice.body.definition.sort, ascending);
  const byPrice = await f.call('GET', `${route}/review`);
  assert.deepEqual(ids(byPrice), ['company-b', 'company-c', 'company-d', 'company-a', 'etf-spy']);
  assert.deepEqual(byPrice.body.rows.map(({ sortRank, sortValue }) => [sortRank, sortValue]),
    [[3, -0.02], [1, 0.15], [1, 0.15], [null, null], [null, null]]);
  assert.equal(byPrice.body.sort.rankScope, 'book');
  const invalid = await f.call('PUT', route, { name: book.name, definition: { ...definition, sort: { ...ascending, period: '2m' } } });
  assert.equal(invalid.status, 400);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
  f.db.close();
  const reopened = openDatabase(f.path);
  t.after(() => reopened.close());
  const api = createService({ db: reopened, preparedOnly: true, workers: false });
  assert.deepEqual((await api.dispatch({ url: `/api/v1/${route}` })).body.definition.sort, ascending);
  assert.deepEqual(ids(await api.dispatch({ url: `/api/v1/${route}/review` })), ids(byPrice));
});
