import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dataVersion, importDataset, openDatabase, storeWorkspace } from '../backend/database.mjs';
import { createEngine } from '../backend/engine.mjs';
import { importProviderData, importProviderReference } from '../backend/provider.mjs';
import { applyVerifiedCorrection } from '../scripts/apply-verified-correction.mjs';
import { auditPriceJumps } from '../scripts/audit-price-jumps.mjs';
import { latestFinalizableSession } from '../backend/calendar.mjs';
import { createService } from '../backend/service.mjs';
import { analyzeCohort } from '../backend/research.mjs';

const manifest = JSON.parse(readFileSync(new URL('../scripts/corrections/2026-11-21-reitar.json', import.meta.url)));
const quote = (symbol, date, close, volume = 100) => ({ symbol, date, close, open: close, high: close, low: close,
  adjusted_close: close, volume, knownAt: manifest.reviewedAt });
const security = (symbol, id = `eodhd:${symbol}`, name = manifest.issuer, exchange = 'NASDAQ') =>
  ({ symbol, id, name, exchange, type: 'common', knownAt: manifest.reviewedAt });

function fixture(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  importDataset(db, { provider: 'eodhd', securities: [security('RITR'), security('RITRF'), security('RITRD'), security('OKAY', 'eodhd:OKAY', 'Other Company')],
    prices: [
      quote('RITR', '2024-08-23', 100), quote('RITR', '2026-09-16', 0.0761, 1000),
      quote('RITRF', '2024-08-23', 100), quote('RITRF', '2026-11-10', 4.875), quote('RITRF', '2026-11-11', 4.75),
      quote('RITRD', '2024-08-23', 100), quote('RITRD', '2026-11-11', 0.019, 84500),
      quote('RITRD', '2026-11-12', 3.4, 2100), quote('RITRD', '2026-11-20', 2.1),
      quote('OKAY', '2026-11-20', 20),
    ] });
  return db;
}

test('verified correction is audited and idempotent and respects pinned reconstruction', (t) => {
  const db = fixture(t);
  const dry = applyVerifiedCorrection(db, manifest, { dryRun: true });
  assert.equal(dataVersion(db), 1);
  assert.equal(dry.earliestAffectedDate, '2024-08-23');
  const applied = applyVerifiedCorrection(db, manifest);
  assert.equal(applied.version, 2);
  assert.equal(applied.rows, applied.revised);
  assert.equal(applyVerifiedCorrection(db, manifest).duplicate, true);
  const engine = createEngine(db);
  const snapshot = (dataVersion, date = '2026-11-20') => engine.snapshot(engine.context({ dataVersion, date })).stocks.map((row) => row.symbol);
  assert.ok(snapshot(1).includes('RITRD'));
  assert.ok(!snapshot(2).some((symbol) => symbol.startsWith('RITR')));
  assert.deepEqual(snapshot(2, '2026-09-16').filter((symbol) => symbol.startsWith('RITR')), ['RITR']);
  const detail = engine.detail(engine.context({ dataVersion: 2 }), 'RITRD', 60);
  assert.equal(detail.securityId, 'eodhd:RITR');
  assert.equal(detail.exchange, 'PINK');
  assert.deepEqual(detail.aliases.map(({ symbol, exchange, valid_from, valid_to }) => [symbol, exchange, valid_from, valid_to]), [
    ['RITR', 'NASDAQ', '0001-01-01', '2026-09-16'], ['RITRF', 'PINK', '2026-09-17', '2026-11-11'],
    ['RITRD', 'PINK', '2026-11-12', null],
  ]);
  const prior = detail.bars.find(({ date }) => date === '2026-11-11');
  const after = detail.bars.find(({ date }) => date === '2026-11-12');
  assert.equal(prior.traded, true);
  assert.equal(prior.volume, null);
  assert.equal(prior.dollarVolume, null);
  assert.equal(db.prepare("SELECT volume FROM daily_prices WHERE security_id='eodhd:RITR' AND date='2026-11-11'").get().volume, 84500);
  assert.equal(prior.vendorAdjustedClose, null);
  assert.equal(after.volume, 2100);
  assert.equal(after.totalGross, after.close / prior.close);
  assert.ok(Math.abs(after.totalGross - 0.7157894736842105) < 1e-10);
  assert.equal(detail.actions[0].known_at, manifest.reviewedAt);
  const earlier = engine.detail(engine.context({ dataVersion: 2, date: '2026-09-16' }), 'RITR');
  assert.equal(earlier.bars.at(-1).rawVolume, 1000);
  assert.equal(earlier.bars.at(-1).dollarVolume, 76.1);
  const detailLog = JSON.parse(db.prepare('SELECT detail FROM ingestion_runs WHERE version=2').get().detail);
  assert.equal(detailLog.archiveImpactFrom, '2024-08-23');
  assert.ok(detailLog.warnings.some((item) => item.includes('000121390026118258')));
});

test('quote audit flags a 179x raw gap and nightly catalog cannot reopen corrected Nasdaq aliases', async (t) => {
  const db = fixture(t);
  const report = auditPriceJumps(db, { asOf: '2026-11-20' });
  assert.ok(report.candidates.some(({ symbol, economicGross }) => symbol === 'RITRD' && economicGross > 178));
  applyVerifiedCorrection(db, manifest);
  const date = latestFinalizableSession();
  const provider = {
    getSecurities: async () => [
      { ...security('RITRD'), listingDate: '2026-11-12', isin: 'KYG7486B1068' },
      { ...security('RITR'), listingDate: '2024-08-23', isin: 'KYG7486B1068' },
      security('OKAY', 'eodhd:OKAY', 'Other Company'),
    ],
    getDailyPrices: async () => [quote('RITRD', date, 16), quote('RITR', date, 17), quote('OKAY', date, 20)],
  };
  const fresh = await importProviderData({ bulk: true, date, actions: false }, { db, provider });
  assert.equal(fresh.captures[0].eligibleReceived, 1);
  assert.ok(fresh.captures[0].identityExclusions.ambiguousIdentity >= 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM identifiers WHERE symbol='RITRD' AND exchange='NASDAQ' AND valid_to IS NULL").get().count, 0);
  const staleReference = await importProviderReference({ symbols: ['RITRD'] }, { db,
    provider: { getReference: async () => ({
      securities: { ...security('RITRD'), listingDate: '2026-11-12' },
      fundamentals: { symbol: 'RITRD', sharesOutstanding: 5 },
      classifications: { symbol: 'RITRD', industry: 'Wrong listing' },
    }) }, write: () => assert.fail('Stale reference must be isolated from the warehouse') });
  assert.ok(staleReference.warnings.some((warning) => /independently verified/.test(warning)));
  const updated = auditPriceJumps(db, { asOf: '2026-11-20' });
  assert.ok(!updated.candidates.some(({ symbol }) => symbol.startsWith('RITR')));
});

test('price quarantine blocks rank windows and forward research, volume quarantine preserves price returns, and a clear is versioned', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const dates = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'];
  importDataset(db, { provider: 'eodhd', securities: ['PRICE', 'VOLUME'].map((symbol) => ({
    ...security(symbol), listingDate: dates[0], knownAt: dates[0],
  })), prices: dates.flatMap((date, i) => [
    { ...quote('PRICE', date, [100, 120, 5000, 130, 150][i]), knownAt: date },
    { ...quote('VOLUME', date, 100 + i), knownAt: date },
  ]) });
  const model = storeWorkspace(db, 'ranking-model', { name: 'Fixture four sessions',
    definition: { method: 'weighted', windows: [{ kind: 'sessions', length: 4, weight: 1 }] } }, 'test');
  const { dispatch, engine } = createService({ db });
  const request = { method: 'POST', url: '/api/v1/data/quality/overrides' };
  const evidenceUrl = manifest.evidence[0].url;
  const mutePrice = { id: 'price-review', securityId: 'eodhd:PRICE', kind: 'price', from: dates[2],
    knownAt: dates[3], reason: 'Provider price basis is unverified', evidenceUrl };
  const muteVolume = { id: 'volume-review', securityId: 'eodhd:VOLUME', kind: 'volume', from: dates[4],
    knownAt: dates[4], reason: 'Share basis not independently verified', evidenceUrl };
  const inserted = await dispatch({ ...request, body: { overrides: [mutePrice, muteVolume] } });
  assert.equal(inserted.status, 201);
  const pinned = (dataVersion, basis = 'reconstructed', date = dates[4]) => engine.context({
    dataVersion, date, basis, windows: [1, 5], reference: 'as-of', model: model.id,
  });
  const ranks = (version) => engine.snapshot(pinned(version)).stocks.map(({ symbol, rsRank }) => [symbol, rsRank]);
  assert.deepEqual(ranks(1), [['PRICE', 1], ['VOLUME', 2]]);
  assert.deepEqual(ranks(2), [['PRICE', null], ['VOLUME', 1]]);
  const priceDetail = engine.detail(pinned(2), 'PRICE');
  assert.equal(priceDetail.chartBars.find(({ date }) => date === dates[2]).close, null);
  assert.equal(priceDetail.chartBars.find(({ date }) => date === dates[2]).priceQuarantined, true);
  assert.equal(engine.detail(pinned(2, 'known', dates[2]), 'PRICE').chartBars.at(-1).close, 5000);
  assert.equal(engine.detail(pinned(2, 'known', dates[3]), 'PRICE').chartBars.at(-2).close, null);
  const volumeDetail = engine.detail(pinned(2), 'VOLUME');
  assert.ok(volumeDetail.return_1d > 0);
  assert.equal(volumeDetail.traded, true);
  assert.equal(volumeDetail.volume, null);
  assert.equal(volumeDetail.dollar_volume, null);
  assert.equal(volumeDetail.obv, null);
  const research = analyzeCohort({ sessions: dates, date: dates[0], members: [{ securityId: 'PRICE' }],
    securityPrices: engine.studyPrices(pinned(2), ['PRICE'], dates[0], dates[4]), horizons: [4], asOf: dates[4] });
  assert.equal(research.results[0].summary.counts.quarantinedPrice, 1);
  assert.equal(research.results[0].summary.count, 0);
  const api = await dispatch({ url: '/api/v1/data/quality?dataVersion=2' });
  assert.equal(api.body.qualityOverrides.length, 2);
  const cleared = await dispatch({ ...request, body: { ...mutePrice, knownAt: dates[4], active: false, reason: 'Independently verified release' } });
  assert.equal(cleared.status, 201);
  assert.equal(engine.detail(pinned(3), 'PRICE').chartBars.at(-3).close, 5000);
  assert.equal(engine.detail(pinned(2), 'PRICE').chartBars.at(-3).close, null);
  const audit = await dispatch({ url: '/api/v1/data/quality/overrides?includeCleared=1' });
  assert.equal(audit.body.overrides.find(({ id }) => id === mutePrice.id).active, 0);
});

test('verified split correction suppresses the old action and ignores vendor returns on its stale adjustment date', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const sos = JSON.parse(readFileSync(new URL('../scripts/corrections/2026-11-21-sos.json', import.meta.url)));
  const dates = ['2026-11-18', '2026-11-19', '2026-11-20'];
  const [previous, wrong, effective] = dates;
  importDataset(db, { provider: 'eodhd', securities: [security('SOS')], prices: [
    { ...quote('SOS', previous, 0.2145), adjusted_close: 4.29 },
    quote('SOS', wrong, 0.2045), quote('SOS', effective, 4),
  ], corporateActions: [{ symbol: 'SOS', date: wrong, type: 'split', factor: 0.05, knownAt: manifest.reviewedAt }] });
  applyVerifiedCorrection(db, sos);
  importDataset(db, { provider: 'eodhd', corporateActions: [{ symbol: 'SOS', date: wrong, type: 'split', factor: 0.05,
    knownAt: manifest.reviewedAt }], prices: [quote('SOS', effective, 4)] });
  const engine = createEngine(db);
  const result = engine.detail(engine.context({ date: effective }), 'SOS');
  assert.deepEqual(result.actions.map(({ date, factor }) => [date, factor]), [[effective, 0.05]]);
  assert.equal(db.prepare('SELECT count(*) AS count FROM corporate_actions WHERE date=?').get(wrong).count, 2);
  assert.equal(result.bars.at(-2).volume, null);
  assert.ok(Math.abs(result.return_1d - (4 / 4.09 - 1)) < 1e-10);
  assert.ok(Math.abs(result.bars.at(-1).totalGross - 4 / 4.09) < 1e-10);
});

test('issuer venue and merger corrections preserve raw quote revisions and never create a terminal market bar', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  importDataset(db, { provider: 'eodhd', securities: [
    security('PCRX', 'eodhd:PCRX', 'Pacira BioSciences, Inc.'),
    security('RBOT', 'eodhd:RBOT', 'Vicarious Surgical Inc.', 'NYSE'),
  ], prices: [
    quote('PCRX', '2026-11-11', 36.46), quote('PCRX', '2026-11-12', 0.41), quote('PCRX', '2026-11-20', 0.4),
    quote('RBOT', '2026-03-03', 8), quote('RBOT', '2026-03-04', 4), quote('RBOT', '2026-11-20', 0.15),
  ] });
  for (const symbol of ['pcrx', 'rbot']) {
    const correction = JSON.parse(readFileSync(new URL(`../scripts/corrections/2026-11-21-${symbol}.json`, import.meta.url)));
    assert.equal(applyVerifiedCorrection(db, correction, { dryRun: true }).dryRun, true);
    applyVerifiedCorrection(db, correction);
  }
  const engine = createEngine(db);
  const current = engine.context();
  assert.equal(engine.snapshot(current).stocks.length, 0);
  const pacira = engine.detail(current, 'eodhd:PCRX');
  assert.ok(pacira.quality.some(({ reason }) => reason.includes('$36.50')));
  assert.equal(pacira.bars.at(-1).close, null);
  assert.equal(db.prepare("SELECT close FROM daily_prices WHERE security_id='eodhd:PCRX' AND date='2026-11-20'").get().close, 0.4);
  assert.equal(db.prepare("SELECT close FROM daily_prices WHERE security_id='eodhd:PCRX' AND date='2026-11-17'").get(), undefined);
  assert.equal(engine.detail(current, 'RBOT').exchange, 'OTCID');
  assert.equal(engine.detail(engine.context({ date: '2026-03-03' }), 'RBOT').exchange, 'NYSE');
});
