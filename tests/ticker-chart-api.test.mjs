import assert from 'node:assert/strict';
import test from 'node:test';
import { expectedSessions } from '../backend/calendar.mjs';
import { CALCULATION_VERSION, dataVersion, importDataset, openDatabase } from '../backend/database.mjs';
import { writePreparedDetail } from '../backend/prepared-details.mjs';
import { createService } from '../backend/service.mjs';

const dates = expectedSessions('2024-01-02', '2024-09-30');
const first = dates[0];
const latest = dates.at(-1);
const split = dates.at(-3);
const prior = dates.at(-4);
const id = 'fixture:common/USD';
const bar = (date, close) => ({ date, close, open: close - 1, high: close + 2, low: close - 2, traded: true,
  volume: 100, rawClose: close, knownAt: date, securityId: id });

function fixture(t, { preparedOnly = true } = {}) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const provider = new Proxy({}, { get() { assert.fail('Ticker previews cannot use a provider'); } });
  const { engine, dispatch } = createService({ db, provider, preparedOnly, workers: false });
  const { version } = importDataset(db, { provider: 'fixture', securities: [
    { id, symbol: 'NEW', exchange: 'NYSE', listingDate: first, knownAt: first, identifiers: [
      { symbol: 'OLD', validFrom: first, validTo: prior }, { symbol: 'NEW', validFrom: split },
    ] },
    { symbol: 'EARLY', exchange: 'NYSE', listingDate: split, knownAt: first },
    { symbol: 'DELAYED', exchange: 'NYSE', listingDate: first, knownAt: latest },
  ], prices: dates.map((date) => bar(date, 20)) });
  const read = (ticker, params) => dispatch({ url: `/api/v1/stocks/${encodeURIComponent(ticker)}/chart?${new URLSearchParams(params)}` });
  const save = (config, chartBars, actions = []) => writePreparedDetail(db, config, {
    securityId: id, date: config.date, dataVersion: config.dataVersion, chartBars, actions,
  }, { riskByBenchmark: { SPY: { 63: { observations: 77 } } } });
  function enforceChartOnly() {
    db.exec('PRAGMA query_only=ON');
    const prepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      assert.doesNotMatch(sql, /prepared_detail_risk|prepared_risk_history|prepared_snapshot|rank_archive|prepared_range/i);
      return prepare(sql);
    };
    for (const method of ['snapshot', 'history', 'detail', 'detailSources', 'studyPrices']) {
      engine[method] = () => assert.fail(`Unexpected engine.${method} in chart-only request`);
    }
  }
  const receipt = () => [dataVersion(db), db.prepare('SELECT count(*) AS jobs FROM jobs').get().jobs];
  return { db, engine, read, save, version, enforceChartOnly, receipt };
}

test('ticker preview reads bounded prepared OHLC and keeps missing or unsafe sessions as gaps', async (t) => {
  const { read, save, engine, version, enforceChartOnly, receipt } = fixture(t);
  const flags = new Map([[dates.at(-7), { priceQuarantined: true }], [dates.at(-6), { unverifiedSplit: true }],
    [dates.at(-5), { missing: true }], [dates.at(-2), { traded: false }], [latest, { high: null }]]);
  const chartBars = dates.map((date, index) => ({ ...bar(date, 20 + index), ...flags.get(date) }));
  save(engine.context({ date: latest, dataVersion: version }), chartBars);
  const before = receipt();
  enforceChartOnly();

  const current = await read(id, { date: latest, dataVersion: version });
  assert.equal(current.status, 200, current.body.error);
  const { state, symbol, bars, span } = current.body;
  assert.deepEqual([state, symbol, bars.length, current.body.calculationVersion], ['ready', 'NEW', 63, CALCULATION_VERSION]);
  assert.deepEqual(span, { from: dates.at(-63), through: split, observations: 58, sessionCount: 63, gaps: 5 });
  assert.deepEqual(bars.filter((row) => row.gap), [
    { date: dates.at(-7), gap: 'price-quarantined' }, { date: dates.at(-6), gap: 'unverified-split' },
    { date: dates.at(-5), gap: 'missing' }, { date: dates.at(-2), gap: 'untraded' }, { date: latest, gap: 'incomplete-ohlc' },
  ]);
  assert.deepEqual(bars[0], { date: dates.at(-63), close: chartBars.at(-63).close,
    open: chartBars.at(-63).open, high: chartBars.at(-63).high, low: chartBars.at(-63).low });
  assert.equal((await read(id, { lookback: 2000 })).body.bars.length, 126);
  assert.equal((await read(id, { lookback: 1 })).body.state, 'no-observations');
  assert.equal((await read('OLD', { date: latest })).status, 404);
  assert.equal((await read('fixture:EARLY', { date: prior })).body.state, 'outside-listing');
  assert.deepEqual(receipt(), before);
});

test('ticker preview projects verified split units to the dated alias and respects vintage restrictions', async (t) => {
  const { db, engine, read, save, version, enforceChartOnly, receipt } = fixture(t);
  save(engine.context(), dates.map((date) => bar(date, 20)), [{ date: split, type: 'split', factor: 2 }]);
  save(engine.context({ date: prior, basis: 'known' }), [bar(prior, 73)]);
  const { version: corrected } = importDataset(db, { provider: 'fixture', prices: [bar(dates.at(-12), 80)] });
  const before = receipt();
  enforceChartOnly();

  const archived = await read('OLD', { date: prior, dataVersion: version, lookback: 3 });
  assert.equal(archived.status, 200, archived.body.error);
  assert.deepEqual([archived.body.symbol, archived.body.date, archived.body.sourceDataVersion], ['OLD', prior, version]);
  assert.deepEqual(archived.body.bars.at(-1), { date: prior, open: 38, high: 44, low: 36, close: 40 });
  assert.ok(archived.body.bars.every((bar) => bar.date <= prior));
  assert.equal((await read('NEW', { date: prior, dataVersion: version })).status, 404);
  assert.equal((await read('fixture:DELAYED', { date: prior, basis: 'known', dataVersion: version })).status, 404);
  const known = await read(id, { date: prior, dataVersion: version, basis: 'known' });
  assert.deepEqual([known.body.state, known.body.basis, known.body.bars.at(-1).close], ['ready', 'known', 73]);
  assert.equal((await read(id, { date: dates.at(-5), dataVersion: version, basis: 'known' })).body.state, 'requires-exact-date');
  assert.equal((await read(id, { date: prior, dataVersion: corrected })).body.state, 'not-prepared');
  assert.equal((await read(id, { date: prior, dataVersion: corrected + 1 })).status, 400);
  assert.deepEqual(receipt(), before);
});

test('without prepared prices even calculation-enabled stock services return an empty chart without scheduling', async (t) => {
  const { db, read, enforceChartOnly, receipt } = fixture(t, { preparedOnly: false });
  const before = receipt();
  enforceChartOnly();
  const result = await read(id);
  assert.equal(result.status, 200, result.body.error);
  assert.deepEqual([result.body.state, result.body.bars], ['not-prepared', []]);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='prepared_detail_products'").get(), undefined);
  assert.deepEqual(receipt(), before);
});
