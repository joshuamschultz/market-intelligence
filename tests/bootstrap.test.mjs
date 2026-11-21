import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { openDatabase } from '../backend/database.mjs';
import { runBootstrap } from '../scripts/bootstrap.mjs';

const older = '2024-05-10';
const latest = '2024-05-13';
const now = () => new Date('2024-05-14T01:00:00Z');
const defaults = { from: older, to: latest, actions: false, includeDelisted: false, benchmarks: [], concurrency: 1 };
const ticker = (symbol, extra = {}) => ({
  symbol, name: symbol, exchange: 'NASDAQ', type: 'Common Stock', listingDate: '2020-01-02', ...extra,
});
const bar = (date, volume = 200) => ({ date, open: 100, high: 105, low: 95, close: 101, adjusted_close: 101, volume });

function warehouse(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  return db;
}

function providerFixture({ active = [ticker('ABC'), ticker('DEF')], delisted = [], prices, ...overrides } = {}) {
  const calls = { active: 0, delisted: 0, symbols: [], actions: [], reference: [], listingEvents: 0 };
  const provider = {
    async getSecurities(query) {
      calls[query.delisted ? 'delisted' : 'active']++;
      return query.delisted ? delisted : active;
    },
    async getDailyPrices(query) {
      calls.symbols.push(query);
      return prices ? prices(query) : [bar(older), bar(latest)];
    },
    async getCorporateActions(query) { calls.actions.push(query); return []; },
    async getReference(symbol) {
      calls.reference.push(symbol);
      return {
        fundamentals: { float: 100, sharesOutstanding: 200, effectiveDate: '2000-01-01', knownAt: '2000-01-01' },
        classifications: { sector: 'Technology', industry: 'Software', effectiveFrom: '2000-01-01', knownAt: '2000-01-01' },
      };
    },
    async getListingEvents() { calls.listingEvents++; return []; },
    ...overrides,
  };
  return { provider, calls };
}

test('bounded per-symbol history publishes verified latest Core coverage and excludes benchmark and other instrument types', async (t) => {
  const db = warehouse(t);
  const { provider, calls } = providerFixture({ active: [ticker('ABC'), ticker('DEF'), ticker('SPY', { type: 'ETF', exchange: 'NYSE ARCA' }),
    ticker('ADR', { type: 'ADR' }), ticker('REIT', { type: 'REIT' }), ticker('AMEX', { exchange: 'AMEX' })] });
  const result = await runBootstrap({ db, provider, options: { ...defaults, benchmarks: ['SPY'], reference: true }, now });
  assert.equal(result.state, 'complete');
  assert.equal(result.coverage.published, true);
  assert.deepEqual({ expected: result.coverage.expected, received: result.coverage.received }, { expected: 2, received: 2 });
  assert.equal(result.catalog.anchorSession, latest);
  assert.equal(result.historicalPointInTimeCoverage, 'unverified');
  assert.deepEqual(result.benchmarks, { expected: 1, loaded: 1 });
  assert.deepEqual(calls.symbols.map(({ symbol }) => symbol), ['ABC.US', 'DEF.US', 'SPY.US']);
  assert.ok(calls.symbols.every(({ from, to }) => from === older && to === latest));
  assert.deepEqual(calls.reference, ['ABC.US', 'DEF.US']);
  const ledger = db.prepare("SELECT date,expected,received FROM session_imports WHERE scope='full'").all();
  assert.deepEqual(ledger.map(({ date, expected, received }) => [date, expected, received]), [[latest, 2, 2]]);

  const replayed = await runBootstrap({ db, provider, options: { ...defaults, benchmarks: ['SPY'], reference: true }, now });
  assert.equal(replayed.planId, result.planId);
  assert.equal(replayed.dataVersion, result.dataVersion);
  assert.equal(replayed.tasks.prices.skipped, 3);
  assert.equal(replayed.tasks.reference.skipped, 2);
  assert.equal(calls.active, 1);
  assert.equal(calls.symbols.length, 3);
  assert.equal(calls.reference.length, 2);
});

test('coverage stays staged if a qualified name has no latest trading bar or a run is a symbol subset', async (t) => {
  const db = warehouse(t);
  const { provider } = providerFixture({ prices: ({ symbol }) => [bar(older), bar(latest, symbol === 'ABC.US' ? 200 : 0)] });
  const incomplete = await runBootstrap({ db, provider, options: defaults, now });
  assert.equal(incomplete.state, 'partial');
  assert.equal(incomplete.tasks.completed.prices, 2);
  assert.deepEqual(incomplete.coverage, { expected: 2, received: 1, published: false, version: null });
  assert.ok(incomplete.prices.missingWithinObservedIntervals > 0);
  const subset = await runBootstrap({ db, provider, options: { ...defaults, symbols: ['ABC'] }, now });
  assert.equal(subset.state, 'complete');
  assert.equal(subset.coverage.published, false);
  assert.equal(db.prepare("SELECT count(*) AS n FROM session_imports WHERE scope='full'").get().n, 0);
});

test('daily quota pausing preserves completed requests and validates checkpoints before a later retry', async (t) => {
  const db = warehouse(t);
  let quotaChecks = 0;
  const { provider, calls } = providerFixture({
    async getQuota() { quotaChecks++; return { remaining: quotaChecks === 1 ? 2 : 20 }; },
  });
  const options = { ...defaults, maxCalls: 10, concurrency: 3 };
  const paused = await runBootstrap({ db, provider, options, now });
  assert.equal(paused.state, 'paused');
  assert.equal(paused.reason, 'daily_call_budget');
  assert.equal(paused.quota.verified, true);
  assert.equal(paused.quota.estimatedReserved, 3);
  assert.equal(paused.tasks.completed.prices, 1);
  assert.equal(paused.coverage.published, false);
  const resumed = await runBootstrap({ db, provider, options, now });
  assert.equal(resumed.state, 'complete');
  assert.equal(resumed.planId, paused.planId);
  assert.equal(resumed.tasks.prices.skipped, 1);
  assert.deepEqual(calls.symbols.map(({ symbol }) => symbol), ['ABC.US', 'DEF.US']);
  assert.equal(calls.active, 1);
  assert.equal(quotaChecks, 2);
});

test('provider rate limits and cancellation stop work and completed requests remain resumable', async (t) => {
  const db = warehouse(t);
  let hitLimit = true;
  const { provider, calls } = providerFixture({ active: [ticker('ABC'), ticker('DEF'), ticker('GHI')], prices: ({ symbol }) => {
    if (symbol === 'DEF.US' && hitLimit) throw Object.assign(new Error('Rate limit https://example.test/?api_token=private-key'), { status: 429 });
    return [bar(older), bar(latest)];
  } });
  const paused = await runBootstrap({ db, provider, options: defaults, now });
  assert.equal(paused.reason, 'provider_rate_limit');
  assert.doesNotMatch(JSON.stringify(paused), /private-key/);
  assert.deepEqual(calls.symbols.map(({ symbol }) => symbol), ['ABC.US', 'DEF.US']);
  hitLimit = false;
  const controller = new AbortController();
  const cancelled = await runBootstrap({ db, provider, options: defaults, now, signal: controller.signal, onProgress(event) {
    if (event.phase === 'prices' && event.symbol === 'DEF') controller.abort();
  } });
  assert.equal(cancelled.state, 'paused');
  assert.equal(cancelled.reason, 'cancelled');
  assert.deepEqual(calls.symbols.map(({ symbol }) => symbol), ['ABC.US', 'DEF.US', 'DEF.US']);
  const final = await runBootstrap({ db, provider, options: defaults, now });
  assert.equal(final.state, 'complete');
  assert.equal(final.tasks.prices.skipped, 2);
  assert.deepEqual(calls.symbols.map(({ symbol }) => symbol), ['ABC.US', 'DEF.US', 'DEF.US', 'GHI.US']);
});

test('provider capture keeps old data and current references out of earlier knowledge vintages', async (t) => {
  const db = warehouse(t);
  const { provider } = providerFixture();
  const options = { ...defaults, to: older, reference: true };
  const result = await runBootstrap({ db, provider, options, now });
  assert.equal(result.state, 'complete');
  assert.equal(result.coverage.published, false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM daily_prices WHERE date=? AND known_at<=?').get(older, older).n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM daily_prices WHERE date=? AND known_at=?').get(older, latest).n, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM fundamentals WHERE effective_date<? OR known_at<?').get(latest, latest).n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM classifications WHERE effective_from=? AND known_at=?').get(latest, latest).n, 2);
});

test('ambiguous ticker reuse is quarantined and optional delisted access failures preserve active collection', async (t) => {
  const db = warehouse(t);
  const { provider, calls } = providerFixture({ delisted: [ticker('ABC', { listingDate: null, delistingDate: null })] });
  const result = await runBootstrap({ db, provider, now, options: { ...defaults, includeDelisted: true } });
  assert.equal(result.state, 'partial');
  assert.equal(result.catalog.quarantined, 2);
  assert.equal(result.catalog.historical, 1);
  assert.equal(result.coverage.published, false);
  assert.deepEqual(calls.symbols.map(({ symbol }) => symbol), ['DEF.US']);
  assert.equal(result.catalog.listingEventsAvailable, true);

  const second = warehouse(t);
  const gated = providerFixture({ async getSecurities({ delisted }) {
    if (delisted) throw Object.assign(new Error('This catalog is unavailable'), { status: 403 });
    return [ticker('ABC')];
  } });
  const access = await runBootstrap({ db: second, provider: gated.provider, now, options: { ...defaults, includeDelisted: true } });
  assert.equal(access.state, 'partial');
  assert.equal(access.catalog.delistedCatalogAvailable, false);
  assert.equal(access.tasks.completed.prices, 1);
  assert.equal(access.coverage.published, true);
});

test('dated aliases supported by the same ISIN share prices without marking the active issue delisted', async (t) => {
  const db = warehouse(t);
  const isin = 'US1234567890';
  const { provider } = providerFixture({ active: [ticker('NEW', { isin })], delisted: [
    ticker('OLD', { isin, exchange: 'NYSE', delistingDate: latest }),
  ], async getListingEvents() {
    return [{ oldSymbol: 'OLD', newSymbol: 'NEW', effectiveDate: latest, exchange: 'NASDAQ' }];
  } });
  const result = await runBootstrap({ db, provider, now, options: { ...defaults, includeDelisted: true } });
  assert.equal(result.state, 'complete');
  assert.equal(result.catalog.linkedAliases, 1);
  assert.equal(result.catalog.quarantined, 0);
  assert.equal(result.coverage.published, true);
  const identity = db.prepare('SELECT id,status,delisting_date FROM securities').get();
  assert.equal(identity.status, 'active');
  assert.equal(identity.delisting_date, null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM securities').get().n, 1);
  assert.deepEqual(db.prepare('SELECT symbol,valid_to FROM identifiers ORDER BY valid_from').all().map(({ symbol, valid_to }) =>
    [symbol, valid_to]), [['OLD', '2024-05-12'], ['NEW', null]]);
  assert.deepEqual(db.prepare('SELECT date FROM daily_prices WHERE security_id=? ORDER BY date').all(identity.id).map(({ date }) => date), [older, latest]);
});

test('default history covers at least ten years and concurrent requests stay under the configured cap', async (t) => {
  const db = warehouse(t);
  let inflight = 0;
  let max = 0;
  const { provider } = providerFixture({ active: ['ABC', 'DEF', 'GHI', 'JKL'].map((symbol) => ticker(symbol, { listingDate: '2000-01-01' })),
    async prices() {
      inflight++;
      max = Math.max(inflight, max);
      await new Promise((resolve) => setImmediate(resolve));
      inflight--;
      return [bar(older), bar(latest)];
    } });
  const result = await runBootstrap({ db, provider, now, options: { ...defaults, from: undefined, to: undefined, concurrency: 2 } });
  assert.equal(result.state, 'complete');
  assert.ok(result.from <= '2014-05-13');
  assert.equal(result.to, latest);
  assert.equal(max, 2);
  assert.ok(result.prices.missingWithinObservedIntervals > 0);
});

test('CLI help is usable without contacting a provider', () => {
  const command = spawnSync(process.execPath, ['scripts/bootstrap.mjs', '--help'], { encoding: 'utf8' });
  assert.equal(command.status, 0, command.stderr);
  assert.match(command.stdout, /--max-calls/);
  assert.match(command.stdout, /ten years/);
});

test('an unambiguous delisted history can be imported by ISIN without inventing its terminal date', async (t) => {
  const db = warehouse(t);
  const { provider } = providerFixture({
    active: [ticker('ABC')], delisted: [ticker('LATE', { isin: 'US1234567890', delistingDate: null })],
    prices: ({ symbol }) => symbol === 'LATE.US' ? [bar(older)] : [bar(older), bar(latest)],
  });
  const result = await runBootstrap({ db, provider, options: { ...defaults, includeDelisted: true }, now });
  assert.equal(result.state, 'complete');
  assert.equal(result.catalog.quarantined, 0);
  assert.equal(result.prices.unknownDelistingDates, 1);
  assert.equal(result.prices.missingWithinObservedIntervals, 0);
  const record = db.prepare("SELECT status,delisting_date,last_seen FROM securities WHERE isin='US1234567890'").get();
  assert.deepEqual({ ...record }, { status: 'delisted', delisting_date: null, last_seen: older });
});

test('current coverage publishes at the 98% positive-volume threshold and keeps its actual received count on resume', async (t) => {
  const db = warehouse(t);
  const active = Array.from({ length: 50 }, (_, index) => ticker(`TICK${index}`));
  const { provider } = providerFixture({ active, prices: ({ symbol }) => [bar(older), bar(latest, symbol === 'TICK0.US' ? 0 : 100)] });
  const result = await runBootstrap({ db, provider, options: defaults, now });
  assert.equal(result.state, 'complete');
  assert.deepEqual(result.coverage, { expected: 50, received: 49, published: true, version: result.dataVersion });
  const resumed = await runBootstrap({ db, provider, options: defaults, now });
  assert.deepEqual(resumed.coverage, result.coverage);
});
