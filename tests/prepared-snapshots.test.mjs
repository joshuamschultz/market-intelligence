import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { CALCULATION_VERSION, importDataset, openDatabase } from '../backend/database.mjs';
import { createEngine } from '../backend/engine.mjs';
import {
  hasPreparedSnapshot, preparedSnapshotDates, readPreparedSnapshot, writePreparedSnapshot,
} from '../backend/prepared-snapshots.mjs';

const date = '2024-01-05';
const jsonCopy = (value) => JSON.parse(JSON.stringify(value));
const engine = { definitionKey: (point) => JSON.stringify([point.classification, point.benchmark,
  point.referenceMode === 'latest' ? point.observedReferenceDate : null, point.variant]) };

function temporaryDb(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  return db;
}

function point(options = {}) {
  return {
    dataVersion: 0, date, latestDate: date, basis: 'reconstructed', classification: 'nasdaq', benchmark: 'SPY', referenceMode: 'as-of',
    universe: { id: 'core', version: 1 }, model: { id: 'composite', version: 1 }, ...options,
  };
}

function snapshot(config, stocks, extra) {
  return {
    date: config.date, dataVersion: config.dataVersion, calculationVersion: CALCULATION_VERSION, basis: config.basis,
    universe: config.universe, model: config.model, classificationSystem: config.classification,
    benchmark: config.benchmark, groups: [{ name: 'Example', feature: null }], coverage: { listed: stocks.length },
    stocks, ...extra,
  };
}

test('shared bases and sparse context overrides retain original row fields, ordering and JSON values', (t) => {
  const db = temporaryDb(t);
  const first = point();
  const alternative = point({ model: { id: 'fast', version: 2 }, universe: { id: 'liquid', version: 1 }, classification: 'sec-sic' });
  const later = point({ classification: 'provider' });
  const one = snapshot(first, [
    { securityId: 'base:B', close: 50, analyst: null, tags: [null, { nesting: [true, 24] }], odd: undefined },
    { securityId: 'base:A', close: 100, rsRank: 1, sector: 'Technology', normalized: NaN },
  ], { requestedDate: '2024-01-06' });
  const two = snapshot(alternative, [
    { securityId: 'base:A', close: 100, rsRank: 4, sector: 'Services', newField: [1, 'x', null] },
    { securityId: 'base:B', close: 50, analyst: 'offshore', signed: -0, tags: [false, {}] },
    { securityId: 'base:C', bornLater: true },
  ]);
  const three = snapshot(later, [
    { securityId: 'base:B', close: 50, analyst: 1, tags: [null, { nesting: [true, 24] }], odd: undefined },
    { securityId: 'base:A', close: 100, rsRank: 2, sector: 'Health', normalized: 0 },
  ]);
  assert.equal(readPreparedSnapshot(db, engine, first), null);
  assert.equal(hasPreparedSnapshot(db, engine, first), false);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='prepared_snapshot_contexts'").get().n, 0);
  const a = writePreparedSnapshot(db, engine, first, one);
  const b = writePreparedSnapshot(db, engine, alternative, two);
  const c = writePreparedSnapshot(db, engine, later, three);
  assert.ok(a.baseBytes > 0);
  assert.equal(a.deltaBytes, 0);
  assert.ok(b.baseBytes > 0 && b.deltaBytes > 0);
  assert.ok(c.deltaBytes > 0);
  assert.equal(c.baseBytes, 0);
  assert.equal(c.layoutBytes, 0);
  assert.deepEqual(readPreparedSnapshot(db, engine, first), jsonCopy(one));
  assert.deepEqual(readPreparedSnapshot(db, engine, alternative), jsonCopy(two));
  assert.deepEqual(readPreparedSnapshot(db, engine, later), jsonCopy(three));
  assert.deepEqual(Object.keys(readPreparedSnapshot(db, engine, first).stocks[1]), ['securityId', 'close', 'rsRank', 'sector', 'normalized']);
  assert.deepEqual(readPreparedSnapshot(db, engine, first, { securityIds: ['base:A', 'missing', 'base:B'] }).stocks, jsonCopy(one.stocks));
  assert.deepEqual(readPreparedSnapshot(db, engine, alternative, { securityIds: 'base:C' }).stocks, [two.stocks[2]]);
  assert.deepEqual(readPreparedSnapshot(db, engine, alternative, { securityIds: [] }).stocks, []);
  assert.equal(writePreparedSnapshot(db, engine, first, one).written, false);
});

test('base, velocity, knowledge, reference and versioned recipes stay isolated', (t) => {
  const db = temporaryDb(t);
  const base = point();
  const strict = point({ basis: 'known' });
  const observed = point({ referenceMode: 'latest', observedReferenceDate: '2024-01-06' });
  const row = { securityId: 'base:A', close: 100 };
  writePreparedSnapshot(db, engine, base, snapshot(base, [row]));
  writePreparedSnapshot(db, engine, base, snapshot(base, [{ ...row, velocity4w: 4 }]), { velocity: true });
  assert.deepEqual(readPreparedSnapshot(db, engine, base).stocks, [row]);
  assert.deepEqual(readPreparedSnapshot(db, engine, base, { velocity: true }).stocks, [{ ...row, velocity4w: 4 }]);
  assert.equal(readPreparedSnapshot(db, engine, strict), null);
  assert.equal(hasPreparedSnapshot(db, engine, observed), false);
  assert.equal(hasPreparedSnapshot(db, engine, point({ model: { id: 'composite', version: 2 } })), false);
  assert.equal(hasPreparedSnapshot(db, engine, point({ benchmark: 'QQQ' })), false);
  writePreparedSnapshot(db, engine, observed, snapshot(observed, [{ ...row, sector: 'Observed today' }]));
  assert.deepEqual(readPreparedSnapshot(db, engine, observed).stocks, [{ ...row, sector: 'Observed today' }]);
  const historical = { ...observed, latestDate: '2024-01-08' };
  assert.deepEqual(readPreparedSnapshot(db, engine, historical).stocks, [row]);
  assert.throws(() => writePreparedSnapshot(db, engine, strict, snapshot(base, [row])), /pinned calculation context/);
});

test('identical overrides, headers and layouts are shared by compatible context recipes', (t) => {
  const db = temporaryDb(t);
  const base = point();
  const one = point({ variant: 'first view' });
  const two = point({ variant: 'second view' });
  writePreparedSnapshot(db, engine, base, snapshot(base, [{ securityId: 'base:A', close: 100, rsRank: 2 }]));
  const updated = snapshot(one, [{ securityId: 'base:A', close: 100, rsRank: 1 }]);
  const first = writePreparedSnapshot(db, engine, one, updated);
  const shared = writePreparedSnapshot(db, engine, two, updated);
  assert.ok(first.deltaBytes > 0);
  assert.equal(shared.written, true);
  assert.deepEqual([shared.baseBytes, shared.deltaBytes, shared.layoutBytes, shared.contextBytes], [0, 0, 0, 0]);
  assert.deepEqual(readPreparedSnapshot(db, engine, one), updated);
  assert.deepEqual(readPreparedSnapshot(db, engine, two), updated);
  assert.throws(() => writePreparedSnapshot(db, engine, point({ classification: 'provider' }), updated), /pinned calculation context/);
});

test('writes roll back base and context changes atomically while an outer transaction can continue', (t) => {
  const db = temporaryDb(t);
  const base = point();
  const malformed = point({ classification: 'damaged' });
  const initial = snapshot(base, [{ securityId: 'base:A', close: 10 }]);
  writePreparedSnapshot(db, engine, base, initial);
  const countBefore = db.prepare('SELECT count(*) AS n FROM prepared_stock_base').get().n;
  const doomed = snapshot(malformed, [
    { securityId: 'base:A', close: 10, newField: 'should roll back' },
    { securityId: 'later', unsupported: 1n },
  ]);
  db.exec('BEGIN IMMEDIATE');
  assert.throws(() => writePreparedSnapshot(db, engine, malformed, doomed), /BigInt/);
  assert.equal(db.isTransaction, true);
  assert.equal(hasPreparedSnapshot(db, engine, malformed), false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM prepared_stock_base').get().n, countBefore);
  assert.deepEqual(readPreparedSnapshot(db, engine, base), initial);
  db.exec('COMMIT');
  const usable = snapshot(malformed, [{ securityId: 'base:A', close: 10, newField: 'actual replacement' }]);
  assert.ok(writePreparedSnapshot(db, engine, malformed, usable).baseBytes > 0);
  assert.deepEqual(readPreparedSnapshot(db, engine, malformed), usable);
  assert.throws(() => writePreparedSnapshot(db, engine, malformed, snapshot(malformed, [usable.stocks[0], usable.stocks[0]])), /unique permanent/);
});

test('selected-ID reads decompress only the relevant buckets and fail closed on a missing block', (t) => {
  const db = temporaryDb(t);
  const config = point();
  const seeded = snapshot(config, [{ securityId: 'base:A', close: 100 }, { securityId: 'base:B', close: 120 }]);
  writePreparedSnapshot(db, engine, config, seeded);
  const body = db.prepare('SELECT bucket,value FROM prepared_stock_base').all().find(({ value }) =>
    JSON.parse(gunzipSync(value))[2].some(([id]) => id === 'base:B'));
  assert.ok(body);
  db.prepare('DELETE FROM prepared_stock_base WHERE bucket=?').run(body.bucket);
  assert.deepEqual(readPreparedSnapshot(db, engine, config, { securityIds: ['base:A'] }).stocks, [seeded.stocks[0]]);
  assert.throws(() => readPreparedSnapshot(db, engine, config), /stock block is missing/);
});

test('lineage reuses unaffected exact contexts and withholds modified sessions', (t) => {
  const db = temporaryDb(t);
  const sec = { symbol: 'AAA', type: 'common', exchange: 'NYSE', listingDate: '2024-01-04', knownAt: '2024-01-04' };
  const quote = (session, close) => ({ symbol: 'AAA', date: session, knownAt: session,
    open: close, high: close, low: close, close, adjustedClose: close, volume: 10_000 });
  const first = '2024-01-04';
  const second = date;
  const next = '2024-01-08';
  importDataset(db, { provider: 'fixture', securities: [sec], prices: [quote(first, 98), quote(second, 100)] });
  const canonical = createEngine(db);
  const v1 = canonical.context({ date: second });
  const earlier = { ...v1, date: first };
  const initial = canonical.snapshot(v1, { persist: false });
  writePreparedSnapshot(db, canonical, v1, initial);
  writePreparedSnapshot(db, canonical, earlier, canonical.snapshot(earlier, { persist: false }));
  importDataset(db, { provider: 'fixture', prices: [quote(next, 102)] });
  const v2 = canonical.context({ date: next });
  assert.deepEqual([...preparedSnapshotDates(db, canonical, v2, [first, second, next])], [[first, v1.dataVersion], [second, v1.dataVersion]]);
  const reused = readPreparedSnapshot(db, canonical, { ...v2, date: second });
  assert.deepEqual(reused.stocks, initial.stocks);
  assert.equal(reused.dataVersion, v1.dataVersion);
  assert.equal(reused.requestedDataVersion, v2.dataVersion);
  importDataset(db, { provider: 'fixture', prices: [quote(second, 97)] });
  const v3 = canonical.context({ date: next });
  assert.deepEqual([...preparedSnapshotDates(db, canonical, v3, [first, second, next])], [[first, v1.dataVersion]]);
  assert.equal(readPreparedSnapshot(db, canonical, { ...v3, date: second }), null);
  assert.deepEqual(readPreparedSnapshot(db, canonical, v1), initial);
});
