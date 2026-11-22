import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectedSessions } from '../backend/calendar.mjs';
import { CALCULATION_VERSION, importDataset, openDatabase } from '../backend/database.mjs';
import { appendSummation, calculateSummation, prepareSummation, readPreparedSummation } from '../backend/summation.mjs';

const sessions = expectedSessions('2024-01-02', '2024-12-31');
const balanced = (date) => ({ date, advancers: 50, decliners: 50, comparable: 100, traded: 100 });
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `Expected ${actual} to be near ${expected}`);

test('summation appends exactly one row across legacy warmup, crossover and gap states', (t) => {
  for (const length of [72, 103, 107]) {
    const db = openDatabase(':memory:');
    t.after(() => db.close());
    const dates = sessions.slice(0, length + 2);
    const breadth = dates.map((date, index) => ({ ...balanced(date), advancers: 48 + index % 7,
      decliners: 51 - index % 7, ...(index === 106 && { advancers: 0, decliners: 0 }) }));
    const ingest = (date) => importDataset(db, { provider: 'fixture', prices: [{ symbol: 'AAA', date, knownAt: date,
      open: 10, high: 10, low: 10, close: 10, volume: 1000 }] }).version;
    const parent = { universe: { id: 'nyse', version: 1 }, basis: 'reconstructed', referenceMode: 'as-of',
      dataVersion: ingest(dates[length - 1]), earliestDate: dates[0], date: dates[length - 1] };
    prepareSummation(db, parent, dates.slice(0, length), breadth.slice(0, length));
    const current = { ...parent, date: dates[length], dataVersion: ingest(dates[length]) };
    assert.equal(appendSummation(db, current, parent, breadth[length]).written, 1);
    assert.equal(appendSummation(db, current, parent, breadth[length]).written, 0);
    const next = { ...current, date: dates[length + 1], dataVersion: ingest(dates[length + 1]) };
    assert.equal(appendSummation(db, next, current, breadth[length + 1]).written, 1);
    assert.deepEqual(readPreparedSummation(db, next).rows, calculateSummation(dates, breadth));
    assert.equal(db.prepare('SELECT count(*) AS n FROM prepared_nyse_summation WHERE data_version=?').get(next.dataVersion).n, 1);
  }
});

test('ratio adjustment, zero EMA initialization, cumulative oscillator, and warmup match known values', () => {
  const dates = sessions.slice(0, 105);
  const breadth = dates.map(balanced);
  breadth[0] = { date: dates[0], advancers: 30, decliners: 10, comparable: 45, traded: 50 };
  const rows = calculateSummation(dates, breadth);
  assert.equal(rows[0].ratioAdjustedNet, 500);
  assert.equal(rows[0].comparableFraction, 0.9);
  assert.deepEqual([rows[0].fastEMA, rows[0].slowEMA, rows[0].oscillator], [50, 25, 25]);
  assert.deepEqual([rows[1].fastEMA, rows[1].slowEMA, rows[1].oscillator], [45, 23.75, 21.25]);
  assert.equal(rows[79].state, 'warmup');
  assert.equal(rows[79].value, null);
  assert.equal(rows[80].state, 'available');
  assert.equal(rows[80].slope, null);
  const impulseResponse = (n) => 19 * 25 * 0.95 ** n - 9 * 50 * 0.9 ** n;
  closeTo(rows[80].value, impulseResponse(80));
  closeTo(rows[81].slope, impulseResponse(81) - impulseResponse(80));
  assert.equal(rows[88].sma10, null);
  assert.equal(rows[98].sma20, null);
  closeTo(rows[89].sma10, rows.slice(80, 90).reduce((sum, _, index) => sum + impulseResponse(80 + index), 0) / 10);
  closeTo(rows[99].sma20, rows.slice(80, 100).reduce((sum, _, index) => sum + impulseResponse(80 + index), 0) / 20);
});

test('10- and 20-session averages report positions, slopes, and dated crossovers', () => {
  const dates = sessions.slice(0, 105);
  const breadth = dates.map(balanced);
  breadth[100] = { ...breadth[100], advancers: 60, decliners: 40 };
  breadth[101] = { ...breadth[101], advancers: 0, decliners: 100 };
  breadth[102] = { ...breadth[102], advancers: 100, decliners: 0 };
  breadth[103] = { ...breadth[103], advancers: 100, decliners: 0 };
  const rows = calculateSummation(dates, breadth);
  assert.equal(rows[99].position20, 'equal');
  assert.equal(rows[100].value, 10);
  assert.equal(rows[100].sma10, 1);
  assert.equal(rows[100].sma20, 0.5);
  assert.equal(rows[100].position10, 'above');
  assert.equal(rows[100].cross10, null);
  assert.equal(rows[101].value, -31.5);
  assert.equal(rows[101].slope, -41.5);
  assert.equal(rows[101].sma10, -2.15);
  assert.equal(rows[101].sma20, -1.075);
  for (const period of [10, 20]) {
    assert.equal(rows[101][`position${period}`], 'below');
    assert.equal(rows[101][`cross${period}`], 'below');
    assert.equal(rows[102][`cross${period}`], null);
    assert.deepEqual(rows[102][`lastCross${period}`], { date: dates[101], direction: 'below' });
    assert.equal(rows[103][`cross${period}`], 'above');
    assert.deepEqual(rows[103][`lastCross${period}`], { date: dates[103], direction: 'above' });
  }
});

test('missing and unqualified sessions preserve gaps and restart the indicator', () => {
  const dates = sessions.slice(0, 215);
  const breadth = dates.map(balanced);
  breadth[100] = { ...breadth[100], advancers: 60, decliners: 40 };
  breadth[101] = { ...breadth[101], advancers: 0, decliners: 100 };
  breadth[106] = { ...breadth[106], comparable: 79, advancers: 39, decliners: 40 };
  breadth[107] = { ...breadth[107], advancers: 50, decliners: 51 };
  breadth[108] = { ...breadth[108], advancers: 10, decliners: 9, comparable: 19, traded: 19 };
  breadth[109] = { ...breadth[109], advancers: 0, decliners: 0 };
  breadth[110] = { ...breadth[110], advancers: 45, decliners: 35, comparable: 80 };
  const rows = calculateSummation(dates, breadth.filter(({ date }) => date !== dates[105]));
  assert.deepEqual(rows.slice(105, 110).map(({ reason }) => reason), [
    'missing-breadth', 'insufficient-comparable', 'invalid-counts', 'insufficient-traded', 'no-directional-issues',
  ]);
  assert.equal(rows[105].advancers, null);
  assert.equal(rows[105].fastEMA, null);
  assert.equal(rows[105].value, null);
  assert.equal(rows[105].sma10, null);
  assert.equal(rows[105].lastCross20, null);
  assert.equal(rows[110].state, 'warmup');
  assert.equal(rows[110].consecutiveObservations, 1);
  assert.equal(rows[110].ratioAdjustedNet, 125);
  assert.equal(rows[110].fastEMA, 12.5);
  assert.equal(rows[189].state, 'warmup');
  assert.equal(rows[190].state, 'available');
  assert.equal(rows[190].slope, null);
  assert.equal(rows[198].sma10, null);
  assert.equal(rows[208].sma20, null);
  assert.equal(rows[209].cross20, null);
});

test('prepared summation is read-only and pinned to the data version, context, and seed', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const dates = sessions.slice(0, 103);
  const context = { universe: { id: 'nyse', version: 1 }, basis: 'reconstructed', referenceMode: 'as-of',
    dataVersion: 2, earliestDate: dates[0], date: dates.at(-1) };
  const read = (overrides = {}, options = {}) => readPreparedSummation(db, { ...context, ...overrides }, options);
  assert.equal(read().status, 'unprepared');
  assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='prepared_nyse_summation'").get(), undefined);
  assert.throws(() => prepareSummation(db, context, dates.slice(1), dates.slice(1).map(balanced)), /every|all expected sessions/);
  const prefix = dates.slice(0, -1);
  assert.deepEqual(prepareSummation(db, { ...context, date: prefix.at(-1) }, prefix, prefix.map(balanced)),
    { written: prefix.length, through: prefix.at(-1) });
  assert.equal(read().status, 'partial');
  assert.equal(read().through, prefix.at(-1));
  const breadth = dates.map(balanced);
  const latest = dates.at(-1);
  breadth.pop();
  assert.deepEqual(prepareSummation(db, context, dates, breadth), { written: 1, through: latest });
  assert.deepEqual(prepareSummation(db, context, dates, breadth), { written: 0, through: latest });
  assert.deepEqual(prepareSummation(db, { ...context, date: prefix.at(-1) }, prefix, []), { written: 0, through: latest });
  const result = read({}, { limit: 2 });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.rows.map(({ date, state }) => [date, state]), [[prefix.at(-1), 'available'], [latest, 'gap']]);
  assert.equal(result.metadata.calculationVersion, CALCULATION_VERSION);
  assert.equal(result.metadata.seriesType, 'observed-proxy');
  assert.match(result.metadata.label, /NYSE common-stock summation proxy/);
  assert.equal(result.metadata.seedStart, dates[0]);
  assert.equal(result.metadata.averageMethod, 'SMA');
  assert.equal(result.metadata.methodologySources.length, 2);
  for (const override of [{ dataVersion: 1 }, { dataVersion: 3 }, { basis: 'known' },
    { universe: { id: 'nyse', version: 2 } }, { summationStart: dates[1] },
    { referenceMode: 'latest', observedReferenceDate: latest }]) {
    assert.equal(read(override).status, 'unprepared');
    assert.deepEqual(read(override).rows, []);
  }
  assert.deepEqual(read({ date: dates[96] }, { from: dates[95], to: latest }).rows.map(({ date }) => date), dates.slice(95, 97));
  assert.throws(() => read({}, { limit: 0 }), /Summation limit/);
  assert.throws(() => calculateSummation([dates[0], dates[2]], []), /every expected market session/);
  assert.throws(() => calculateSummation([dates[0]], [balanced(dates[0]), balanced(dates[0])]), /unique expected sessions/);
});
