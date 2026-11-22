import assert from 'node:assert/strict';
import test from 'node:test';
import { CALCULATION_VERSION, importDataset, openDatabase } from '../backend/database.mjs';
import { createEngine } from '../backend/engine.mjs';
import {
  hasPreparedSnapshot, preparedSnapshotDates, readPreparedSnapshot, readPreparedWeeklySnapshots, writePreparedSnapshot, writePreparedSnapshotBatch,
} from '../backend/prepared-snapshots.mjs';
import { readStockFrame } from '../backend/snapshot-frame.mjs';
import { compressStoredBytes, decodeStoredJson, preparedCodec } from '../backend/storage-codec.mjs';

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
    decodeStoredJson(value)[2].some(([id]) => id === 'base:B'));
  assert.ok(body);
  db.prepare('DELETE FROM prepared_stock_base WHERE bucket=?').run(body.bucket);
  assert.deepEqual(readPreparedSnapshot(db, engine, config, { securityIds: ['base:A'] }).stocks, [seeded.stocks[0]]);
  assert.throws(() => readPreparedSnapshot(db, engine, config), /stock block is missing/);
});

test('mixed legacy blocks and batched projections retain field order, colliding overlays, and arbitrary JSON', (t) => {
  const db = temporaryDb(t);
  const first = point();
  const second = point({ variant: 'composite overlay' });
  const third = point({ variant: 'alternate pricing' });
  const base = { close: 100, market_cap: null, tags: [{ field: 7 }], incomplete: NaN };
  const firstStock = { securityId: 'fixture:A', close: 101, market_cap: 999, custom: null };
  writePreparedSnapshot(db, engine, first, snapshot(first, [firstStock]), { codec: 'gzip' });
  const overlay = Object.assign(Object.create(base), { securityId: 'fixture:A', symbol: 'AAA', market_cap: 188, custom: [8, null] });
  const alternate = Object.assign(Object.create(base), { securityId: 'fixture:A', symbol: 'BBB', market_cap: 200, custom: [9] });
  const definitions = [{ config: second, snapshot: snapshot(second, [overlay]), stockRows: [{ base, baseAfter: 2 }] },
    { config: third, snapshot: snapshot(third, [alternate]), stockRows: [{ base, baseAfter: 2 }] }];
  const counts = writePreparedSnapshotBatch(db, engine, definitions, { codec: preparedCodec });
  assert.equal(counts.filter(({ written }) => written).length, 2);
  assert.deepEqual(readPreparedSnapshot(db, engine, first).stocks, [firstStock]);
  for (const { config, snapshot: context } of definitions) {
    const stock = context.stocks[0];
    const expected = jsonCopy({ securityId: stock.securityId, symbol: stock.symbol, ...base, market_cap: stock.market_cap, custom: stock.custom });
    const result = readPreparedSnapshot(db, engine, config).stocks[0];
    assert.deepEqual(result, expected);
    assert.deepEqual(Object.keys(result), Object.keys(expected));
  }
  assert.ok(db.prepare('SELECT value FROM prepared_snapshot_blobs').all().some(({ value }) => value[0] === 0x1f && value[1] === 0x8b));
  if (preparedCodec === 'zstd') assert.ok(db.prepare('SELECT value FROM prepared_snapshot_blobs').all().some(({ value }) => value[0] === 0x28));
  assert.equal(db.prepare('SELECT count(DISTINCT blob) AS n FROM prepared_snapshot_deltas').get().n, 1);
});

test('shared snapshot header groups retain their exact JSON after another context adds fields', (t) => {
  const db = temporaryDb(t);
  const first = point();
  const other = point({ variant: 'later fields' });
  const groups = Array.from({ length: 35 }, (_, index) => ({ id: `group:${index}`, members: [`security:${index}`], score: null }));
  const firstResult = snapshot(first, [{ securityId: 'security:4', close: 10 }], { groups, optional: undefined, nullish: null });
  const otherResult = snapshot(other, [{ securityId: 'security:4', close: 11, demand: 5 }], { groups, optional: 2 });
  writePreparedSnapshotBatch(db, engine, [{ config: first, snapshot: firstResult }, { config: other, snapshot: otherResult }]);
  assert.deepEqual(readPreparedSnapshot(db, engine, first), jsonCopy(firstResult));
  assert.deepEqual(readPreparedSnapshot(db, engine, other), jsonCopy(otherResult));
  const headerComponents = db.prepare('SELECT value FROM prepared_snapshot_blobs').all().map(({ value }) => decodeStoredJson(value));
  assert.equal(headerComponents.filter((component) => Array.isArray(component) && component[0]?.id === 'group:0').length, 1);
});

test('typed frames share base, taxonomy, and velocity layers with ordered exact values and selected columns', (t) => {
  const db = temporaryDb(t);
  const original = point();
  const variant = point({ variant: 'other facts' });
  const base = { securityId: 'global:AAA', close: 30.17, sector: null, cap: 6.7e17, absent: undefined,
    odd: NaN, observed: true, tick: -0, metadata: { nested: ['x', null, false] } };
  const own = Object.assign(Object.create(base), { sector: 'Industrials', rsRank: 3, close: 34.7 });
  const other = Object.assign(Object.create(base), { sector: null, rsRank: 1, close: undefined, extra: new Date(date) });
  const thinView = Object.create(own);
  const enriched = Object.assign(Object.create(thinView), { velocity4w: -2, customMissing: undefined });
  const plain = snapshot(original, [thinView]);
  const velocity = snapshot(original, [enriched]);
  const alternative = snapshot(variant, [other]);
  writePreparedSnapshotBatch(db, engine, [
    { config: original, snapshot: plain, stockRows: [{ base, overrides: own, baseAfter: 0 }] },
    { config: original, snapshot: velocity, velocity: true, stockRows: [{ base, parent: own, overrides: enriched, baseAfter: 0 }] },
    { config: variant, snapshot: alternative, stockRows: [{ base, overrides: other, baseAfter: 0 }] },
  ]);
  assert.equal(db.prepare('SELECT count(*) AS count FROM prepared_snapshot_frames').get().count, 1);
  assert.equal(db.prepare('SELECT count(*) AS count FROM prepared_stock_base').get().count, 0);
  for (const [point, args, expected] of [[original, {}, { ...base, ...own }], [original, { velocity: true }, { ...base, ...own, ...enriched }],
    [variant, {}, { ...base, ...other }]]) {
    const actual = readPreparedSnapshot(db, engine, point, args).stocks[0];
    assert.deepEqual(actual, jsonCopy(expected));
    assert.deepEqual(Object.keys(actual), Object.keys(jsonCopy(expected)));
  }
  assert.deepEqual(readPreparedSnapshot(db, engine, original, { velocity: true, securityIds: ['global:AAA'], stockFields: ['rsRank', 'velocity4w'] }).stocks,
    [{ securityId: 'global:AAA', rsRank: 3, velocity4w: -2 }]);
  assert.deepEqual(readPreparedSnapshot(db, engine, original, { securityIds: ['bogus'] }).stocks, []);
});

test('weekly archive reads decode each physical bucket once and preserve matching dated projections', (t) => {
  const db = temporaryDb(t);
  const first = point();
  const second = point({ variant: 'different ranks' });
  const legacy = point({ variant: 'legacy snapshot' });
  const groups = [{ id: 'group:a', rank: 1, above50: null, memberIds: ['global:A', 'global:B'] }];
  const base = [
    { securityId: 'global:A', rsRank: 1, rsPercentile: 99.9, rsScore: 12, udv_50d: null, up_volume_50d: 15, ignored: { nested: true } },
    { securityId: 'global:B', rsRank: null, udv_50d: 0.7, up_volume_50d: 5 },
  ];
  const typed = (config, rows) => ({ config, snapshot: snapshot(config, rows.map((row) => row.overrides), { groups }), stockRows: rows });
  writePreparedSnapshotBatch(db, engine, [
    typed(first, base.map((row) => ({ base: row, overrides: Object.create(row), baseAfter: 0 }))),
    typed(second, base.toReversed().map((row) => ({ base: row,
      overrides: Object.assign(Object.create(row), { rsRank: 3, up_volume_50d: undefined }), baseAfter: 0 }))),
  ]);
  writePreparedSnapshot(db, engine, legacy, snapshot(legacy, base.toReversed(), { groups }));
  const quote = (session, close) => ({ symbol: 'AAA', date: session, knownAt: session,
    open: close, high: close, low: close, close, volume: 10_000 });
  const next = '2024-01-08';
  const { version } = importDataset(db, { provider: 'fixture', prices: [quote(next, 100)] });
  const pinned = [first, second, legacy].map((config) => ({ ...config, dataVersion: version, latestDate: next, referenceMode: 'latest' }));
  const stockFields = ['rsRank', 'rsPercentile', 'rsScore', 'udv_50d', 'up_volume_50d'];
  const groupFields = ['id', 'rank', 'percentile', 'above50', 'medianRS', 'topDecile', 'relativeReturn'];
  const stats = { frameBuckets: 0, frameProjections: 0, compressedBytes: 0, decodedBytes: 0, headerBlobs: 0, legacySnapshots: 0 };
  const options = { stockFields, groupFields };
  const actual = readPreparedWeeklySnapshots(db, engine, pinned, { ...options, stats });
  assert.deepEqual(actual, pinned.map((config) => ({ stocks: readPreparedSnapshot(db, engine, config, { stockFields }).stocks,
    groups: [{ id: 'group:a', rank: 1, percentile: undefined, above50: null, medianRS: undefined, topDecile: undefined, relativeReturn: undefined }] })));
  assert.deepEqual(actual[1].stocks.map(({ securityId }) => securityId), ['global:B', 'global:A']);
  assert.equal(Object.hasOwn(actual[1].stocks[0], 'up_volume_50d'), false);
  const physical = db.prepare('SELECT count(*) AS count, sum(length(value)) AS bytes FROM prepared_snapshot_frames').get();
  assert.equal(stats.frameBuckets, physical.count);
  assert.equal(stats.frameProjections, physical.count * 2);
  assert.equal(stats.compressedBytes, physical.bytes);
  assert.ok(stats.decodedBytes > 0 && stats.headerBlobs > 0);
  assert.equal(stats.legacySnapshots, 1);

  db.exec('SAVEPOINT remove_bucket');
  db.exec('DELETE FROM prepared_snapshot_frames');
  assert.throws(() => readPreparedWeeklySnapshots(db, engine, pinned, options), /stock frame block is missing/);
  db.exec('ROLLBACK TO remove_bucket; RELEASE remove_bucket');
  const header = db.prepare('SELECT value FROM prepared_snapshot_blobs').all().map(({ value }) => decodeStoredJson(value))
    .find((value) => value[0] === 'prepared-header-2');
  db.exec('SAVEPOINT remove_members');
  db.prepare('DELETE FROM prepared_snapshot_blobs WHERE blob=?').run(header[2]);
  assert.throws(() => readPreparedWeeklySnapshots(db, engine, pinned, options), /membership dictionary is missing/);
  db.exec('ROLLBACK TO remove_members; RELEASE remove_members');
  db.exec("SAVEPOINT bad_count; UPDATE prepared_snapshot_contexts SET stock_count='bad',delta_mask=0");
  assert.throws(() => readPreparedWeeklySnapshots(db, engine, pinned, options), /stock count is invalid/);
  assert.throws(() => readPreparedSnapshot(db, engine, pinned[0]), /stock count is invalid/);
  db.exec('ROLLBACK TO bad_count; RELEASE bad_count');
  const corrected = importDataset(db, { provider: 'fixture', prices: [quote(date, 95)] }).version;
  assert.deepEqual(readPreparedWeeklySnapshots(db, engine, pinned.map((config) => ({ ...config, dataVersion: corrected })), options), [null, null, null]);
});

test('typed frames insert multiple Monitor fields in order and reuse independent layers', (t) => {
  const db = temporaryDb(t);
  const standard = point();
  const monitor = point({ variant: 'ordered monitor' });
  const base = { securityId: 'global:AAA', return_21d: 0.2, return_50d: 0.3, return_63d: 0.4, sector: null };
  const additions = { order: [['return_21d', 'return_34d'], ['return_34d', 'return_40d']], values: { return_34d: 0.21, return_40d: null } };
  const own = Object.assign(Object.create(base), { sector: 'A', rsRank: 5 });
  const velocity = { rankChange4w: 2, lifecycle: 'Established Leader' };
  const industry = Object.assign(Object.create(own), { industryVelocity: null });
  const monitorStock = Object.assign(Object.create(industry), additions.values);
  writePreparedSnapshotBatch(db, engine, [
    { config: standard, snapshot: snapshot(standard, [own]), stockRows: [{ base, overrides: own, baseAfter: 0 }] },
    { config: monitor, snapshot: snapshot(monitor, [monitorStock]), velocity: true,
      stockRows: [{ base, additions, parent: own, velocity, overrides: industry, baseAfter: 0 }] },
  ]);
  const result = readPreparedSnapshot(db, engine, monitor, { velocity: true });
  assert.equal(JSON.stringify(result.stocks[0]), JSON.stringify({ securityId: 'global:AAA', return_21d: 0.2,
    return_34d: 0.21, return_40d: null, return_50d: 0.3, return_63d: 0.4, sector: 'A', rsRank: 5,
    rankChange4w: 2, lifecycle: 'Established Leader', industryVelocity: null }));
  assert.deepEqual(readPreparedSnapshot(db, engine, monitor, { velocity: true, stockFields: ['return_34d', 'lifecycle'] }).stocks,
    [{ securityId: 'global:AAA', return_34d: 0.21, lifecycle: 'Established Leader' }]);
});

test('previous MSF1 binary frames reopen without field or type changes', () => {
  const payload = Buffer.from(JSON.stringify([[[0, 1]], [[['securityId', 'close'], [['token', 4], ['constant', 7]], 1]], ['legacy:AAA']]));
  const prefix = Math.ceil((payload.length + 8) / 8) * 8;
  const value = Buffer.alloc(prefix + 16);
  value.write('MSF1');
  value.writeUInt32LE(payload.length, 4);
  payload.copy(value, 8);
  value.writeUInt32LE(1, prefix + 4);
  assert.deepEqual(readStockFrame(compressStoredBytes(value, 'gzip'), 0), [[0, { securityId: 'legacy:AAA', close: 7 }]]);
});

test('group membership dictionaries share exact ordered arrays and keep original keys', (t) => {
  const db = temporaryDb(t);
  const core = point();
  const alternate = point({ variant: 'alternate group metrics' });
  const first = ['security:C', 'security:A', 'security:B'];
  const second = ['security:B', 'security:A', 'security:C'];
  const groups = [{ group: 'First', memberIds: first, ratio: null }, { group: 'Second', memberIds: second, ratio: 1 }];
  const later = [{ group: 'First', memberIds: first.slice(), ratio: 3 }, { group: 'Second', memberIds: second.slice(), ratio: null }];
  const one = snapshot(core, [], { groups });
  const two = snapshot(alternate, [], { groups: later });
  writePreparedSnapshotBatch(db, engine, [{ config: core, snapshot: one }, { config: alternate, snapshot: two }]);
  assert.equal(JSON.stringify(readPreparedSnapshot(db, engine, core).groups), JSON.stringify(groups));
  assert.equal(JSON.stringify(readPreparedSnapshot(db, engine, alternate).groups), JSON.stringify(later));
  const blobs = db.prepare('SELECT value FROM prepared_snapshot_blobs').all().map(({ value }) => decodeStoredJson(value));
  assert.equal(blobs.filter((value) => JSON.stringify(value) === JSON.stringify([first, second])).length, 1);
  assert.equal(blobs.filter((value) => value[0] === 'prepared-header-2').length, 2);
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
