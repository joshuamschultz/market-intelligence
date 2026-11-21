import assert from 'node:assert/strict';
import test from 'node:test';
import { importDataset, openDatabase } from '../backend/database.mjs';
import { ingestNasdaqScreener, parseNasdaqScreener } from '../backend/nasdaq.mjs';

const date = '2024-06-01';
const file = (...rows) => ({ data: { rows } });
const pld = { symbol: 'PLD', name: 'Prologis Inc. Common Stock', sector: 'Real Estate', industry: 'Real Estate Investment Trusts', marketCap: '100.00' };
const baba = { symbol: 'BABA', name: 'Alibaba Group Holding Limited American Depositary Shares each representing eight Ordinary share',
  sector: 'Consumer Discretionary', industry: 'Business Services', marketCap: '200.00' };

function fixture(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const issue = (id, symbol, name, extra = {}) => ({ securityId: id, symbol, name, type: 'common', exchange: 'NYSE',
    listingDate: '2020-01-01', knownAt: '2020-01-01', status: 'active', ...extra });
  importDataset(db, { provider: 'fixture', securities: [
    issue('issue:pld', 'PLD', 'Prologis Inc'), issue('issue:baba', 'BABA', 'Alibaba Group Holding Ltd'),
    issue('issue:old', 'PLD', 'Old Corp', { status: 'delisted', listingDate: '2010-01-01', delistingDate: '2018-01-01' }),
    issue('issue:other', 'XYZ', 'Other Corp'),
  ] });
  return db;
}

test('current matched Nasdaq classifications and caps are dated and keep explicit subtype evidence separate', (t) => {
  const db = fixture(t);
  const payload = { input: file(pld, baba), capturedAt: `${date}T17:00:00Z`, sha256: 'fixture' };
  const dry = ingestNasdaqScreener(db, { ...payload, dryRun: true });
  assert.equal(dry.classifications, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM classifications').get().n, 0);
  const report = ingestNasdaqScreener(db, payload);
  assert.deepEqual(report.subtypeEvidence, { adr: 1, reit: 1 });
  assert.equal(report.marketCaps, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM classifications WHERE known_at<? OR effective_from<?').get(date, date).n, 0);
  const cap = db.prepare("SELECT market_cap,float,shares FROM fundamentals WHERE security_id='issue:baba'").get();
  assert.deepEqual([cap.market_cap, cap.float, cap.shares], [200, null, null]);
  assert.equal(db.prepare("SELECT type FROM securities WHERE id='issue:baba'").get().type, 'common');
  assert.equal(db.prepare("SELECT type FROM securities WHERE id='issue:pld'").get().type, 'common');
  assert.equal(db.prepare('SELECT count(*) AS n FROM nasdaq_reference_evidence').get().n, 2);
  assert.equal(ingestNasdaqScreener(db, payload).duplicate, true);
});

test('conflicting symbol, mismatched legal names, and missing caps remain explicit', (t) => {
  const db = fixture(t);
  const result = ingestNasdaqScreener(db, { capturedAt: date, input: file(pld, { ...pld, marketCap: 500 },
    { ...baba, symbol: 'XYZ' }, { ...baba, symbol: 'ZZZ' }) });
  assert.equal(result.matched, 0);
  assert.equal(result.quarantine.conflictingScreener, 1);
  assert.equal(result.quarantine.issuerMismatch, 1);
  assert.equal(result.quarantine.missingWarehouse, 1);
  assert.equal(parseNasdaqScreener(file({ ...pld, marketCap: 'N/A' })).rows[0].marketCap, null);
});

test('subtype-only evidence advances the warehouse atomically and can be withdrawn in a later revision', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const date = '2025-06-13';
  const capture = '2025-06-14';
  importDataset(db, { provider: 'eodhd', securities: [{
    symbol: 'TEST', name: 'Test Issuer', type: 'common', exchange: 'NYSE', status: 'active', listingDate: '2020-01-02',
    knownAt: '2020-01-02',
  }], prices: [{ symbol: 'TEST', date, open: 100, high: 101, low: 99, close: 100, volume: 5, knownAt: date }] });
  const source = { capturedAt: capture, sha256: 'initial', input: { data: { rows: [{ symbol: 'TEST', name: 'Test Issuer American Depositary Shares' }] } } };
  db.exec("CREATE TRIGGER reject_type BEFORE INSERT ON instrument_type_observations BEGIN SELECT RAISE(ABORT, 'Rejected'); END");
  assert.throws(() => ingestNasdaqScreener(db, source), /Rejected/);
  assert.equal(Number(db.prepare("SELECT value FROM meta WHERE key='data_version'").get().value), 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM instrument_type_observations').get().n, 0);
  db.exec('DROP TRIGGER reject_type');
  const added = ingestNasdaqScreener(db, source);
  assert.equal(added.warehouseVersion, 2);
  assert.equal(ingestNasdaqScreener(db, source).duplicate, true);
  assert.equal(db.prepare('SELECT subtype FROM instrument_type_observations WHERE version=2').get().subtype, 'adr');
  assert.equal(db.prepare("SELECT json_extract(detail,'$.archiveImpactFrom') AS impact FROM ingestion_runs WHERE version=2 AND status='complete'").get().impact, capture);
  const removed = ingestNasdaqScreener(db, { capturedAt: '2025-06-15', sha256: 'later',
    input: { data: { rows: [{ symbol: 'TEST', name: 'Test Issuer Common Stock' }] } } });
  assert.equal(removed.warehouseVersion, 3);
  assert.equal(db.prepare('SELECT subtype FROM instrument_type_observations WHERE version=3').get().subtype, null);
  assert.equal(db.prepare('SELECT type FROM securities').get().type, 'common');
});
