import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { expectedSessions } from '../backend/calendar.mjs';
import { CALCULATION_VERSION, dataVersion, importDataset, openDatabase } from '../backend/database.mjs';
import { materializeHistory } from '../backend/materialization.mjs';
import { writePreparedDetail } from '../backend/prepared-details.mjs';
import { writePreparedSnapshot } from '../backend/prepared-snapshots.mjs';
import { DEFAULT_HEALTH_MODEL } from '../backend/research.mjs';
import { createService } from '../backend/service.mjs';

function fixture(t, { prepared = true, preparedOnly = true } = {}) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const dates = expectedSessions('2024-09-01', '2026-11-20').slice(-320);
  const previous = dates.at(-2);
  const securities = [
    { id: 'slow', symbol: 'SLOW', exchange: 'NYSE', type: 'common' },
    { id: 'fast', symbol: 'FAST', exchange: 'NASDAQ', type: 'common' },
    { id: 'spy', symbol: 'SPY', exchange: 'NYSE', type: 'etf' },
  ];
  const run = importDataset(db, { provider: 'fixture',
    securities: securities.map((stock) => ({ ...stock, listingDate: dates[0], knownAt: dates[0] })),
    prices: securities.flatMap((stock, ticker) => dates.map((date, index) => {
      const close = 100 * (1 + index / 1000 * (ticker + 1));
      return { securityId: stock.id, date, close, adjustedClose: close, open: close, high: close + 1, low: close - 1, volume: 15_000, knownAt: date };
    })),
    classifications: securities.slice(0, 2).map(({ id }, position) => ({
      securityId: id, effectiveFrom: dates[0], knownAt: dates[0], system: 'provider', sector: 'Technology',
      industry: position === 0 ? 'Components' : 'Networking',
    })),
  });
  const provider = { getDailyPrices() { assert.fail('Market ChartBook reads must not call the provider'); } };
  const service = createService({ db, provider, workers: false, preparedOnly });
  const context = { date: previous, dataVersion: run.version, universe: 'us-core', classification: 'provider', reference: 'as-of', benchmark: 'SPY' };
  const point = service.engine.context(context);
  if (prepared) {
    const snapshot = service.engine.snapshot(point, { persist: false });
    writePreparedSnapshot(db, service.engine, point, snapshot);
    writePreparedDetail(db, point, service.engine.detail(point, 'spy', 250, { velocity: false }));
    materializeHistory(db, service.engine, point, { limit: 66 });
    const monitor = service.engine.context({ ...context, breadthKeys: ['up_13pct_34d', 'down_13pct_34d'] });
    materializeHistory(db, service.engine, monitor, { limit: 60 });
  }
  const call = (route, query = {}, method = 'GET', body = {}) => service.dispatch({ method,
    url: `/api/v1/chartbooks/market${route}${method === 'GET' ? '?' + new URLSearchParams({ ...context, ...query }) : ''}`, body });
  return { db, dates, previous, context, point, service, call };
}

test('Market ChartBook reads all prepared breadth, volume, and real sorted dated-industry histories without writes', async (t) => {
  const f = fixture(t);
  const totals = f.db.prepare('SELECT total_changes() AS n');
  const before = totals.get().n;
  const catalog = await f.call('');
  assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
  assert.equal(catalog.body.date, f.previous);
  assert.equal(catalog.body.dataVersion, f.context.dataVersion);
  assert.deepEqual(catalog.body.industries.map(({ name }) => name), ['Networking', 'Components']);
  assert.ok(catalog.body.metrics.some(({ key }) => key === 'above_150d'));
  const history = await f.call('/history', { lookback: 60 });
  assert.equal(history.status, 200, JSON.stringify(history.body));
  assert.equal(history.body.state, 'ready');
  assert.equal(history.body.rows.length, 69);
  assert.equal(history.body.rows.filter(({ state }) => state === 'unprepared').length, 3);
  assert.equal(history.body.monitorPrepared, 60);
  assert.equal(history.body.rows.at(-1).date, f.previous);
  assert.deepEqual(history.body.rows.at(-1).breadth.above_50d, [100, 2, 2]);
  assert.equal(history.body.rows.at(-1).volume.upVolume, 30_000);
  assert.ok(Array.isArray(history.body.rows.at(-1).breadth.up_13pct_34d));
  const { id } = catalog.body.industries[0];
  const industry = await f.call(`/industries/${encodeURIComponent(id)}`, { lookback: 20 });
  assert.equal(industry.status, 200, JSON.stringify(industry.body));
  assert.equal(industry.body.sessions.length, 70);
  assert.equal(industry.body.industry.method, 'dated-equal-weight');
  assert.equal(industry.body.industry.rows.length, industry.body.benchmark.rows.length);
  assert.ok(industry.body.industry.rows.at(-1).value > 100);
  assert.ok(!Object.hasOwn(industry.body.industry.rows.at(-1), 'open'));
  assert.ok(industry.body.benchmark.rows.at(-1).close > 100);
  assert.equal(totals.get().n, before);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
  assert.equal((await f.call('/industries/unknown')).status, 404);
  assert.equal((await f.call('/history', { lookback: 1261 })).status, 400);
});

test('missing products stay explicit, and saving a market deck changes no data version or jobs', async (t) => {
  const f = fixture(t, { prepared: false });
  const rev = dataVersion(f.db);
  const catalog = await f.call('');
  const byDay = await f.call('/history', { lookback: 21 });
  assert.equal(catalog.body.state, 'unprepared');
  assert.equal(byDay.body.state, 'unprepared');
  assert.ok(byDay.body.rows.every(({ state }) => state === 'unprepared'));
  const hidden = await f.call('/industries/any');
  assert.equal(hidden.body.state, 'unprepared');
  const invalid = await f.call('/decks', {}, 'POST', { name: 'Invalid', definition: { view: 'wrong' } });
  assert.equal(invalid.status, 400);
  const saved = await f.call('/decks', {}, 'POST', { name: 'Only two', definition: { view: 'industries', industryIds: ['two', 'two', 'one'] } });
  assert.equal(saved.status, 201);
  assert.deepEqual(saved.body.definition.industryIds, ['two', 'one']);
  assert.equal((await f.call('')).body.decks[0].id, saved.body.id);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
  assert.equal(dataVersion(f.db), rev);
});

test('Market ChartBook reads pinned stored health in manual mode and keeps unprepared sessions as gaps', async (t) => {
  const f = fixture(t, { prepared: false, preparedOnly: false });
  const coverage = { coverageMode: 'observed', observedMinimum: 20, observedThreshold: 0.75 };
  const recipe = createHash('sha256').update(JSON.stringify([
    f.service.engine.definitionKey(f.point), f.point.universe.id, f.point.universe.version,
    f.point.model.id, f.point.model.version, DEFAULT_HEALTH_MODEL, coverage,
  ])).digest('hex');
  f.db.exec(`CREATE TABLE prepared_health (
    recipe TEXT NOT NULL, data_version INTEGER NOT NULL, calculation_version TEXT NOT NULL, date TEXT NOT NULL,
    payload BLOB NOT NULL, PRIMARY KEY (recipe,data_version,calculation_version,date)
  ) WITHOUT ROWID;`);
  const put = f.db.prepare('INSERT INTO prepared_health VALUES (?,?,?,?,?)');
  for (const [date, score] of [[f.dates.at(-4), 22], [f.dates.at(-2), 31]]) {
    put.run(recipe, f.context.dataVersion, CALCULATION_VERSION, date, gzipSync(JSON.stringify({ date, score })));
  }
  const changes = f.db.prepare('SELECT total_changes() AS n');
  const before = changes.get().n;
  const result = await f.call('/health', { lookback: 3, ...coverage });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.state, 'partial');
  assert.equal(result.body.coverageMode, 'observed');
  assert.equal(result.body.observedThreshold, 0.75);
  assert.deepEqual(result.body.rows.map(({ score }) => score), [22, null, 31]);
  assert.equal((await f.call('/health', { lookback: 3 })).body.state, 'unprepared');
  assert.equal(changes.get().n, before);
});
