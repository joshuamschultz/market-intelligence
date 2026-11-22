import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expectedSessions } from '../backend/calendar.mjs';
import { importDataset, openDatabase } from '../backend/database.mjs';
import { createEngine, UNIVERSES } from '../backend/engine.mjs';

const [rawStockCount, rawSessionCount, rawSourcePath, rawVariants, rowMode] = process.argv.slice(2);
const stockCount = Number(rawStockCount ?? 128);
const sessionCount = Number(rawSessionCount ?? 60);
const variants = Number(rawVariants ?? 1);
const sourcePath = rawSourcePath && rawSourcePath !== '-' ? rawSourcePath : null;
if (!Number.isInteger(stockCount) || stockCount < 2 || stockCount > 256
  || !Number.isInteger(sessionCount) || sessionCount < 2 || sessionCount > 120
  || !Number.isInteger(variants) || variants < 1 || variants > 42) {
  throw new Error('Use 2–256 securities, 2–120 measured sessions, and 1–42 context variants');
}

function syntheticSample() {
  const dates = expectedSessions('2023-01-03', '2026-11-20').slice(-(sessionCount + 460));
  const securities = Array.from({ length: stockCount }, (_, index) => ({
    id: `stock-${index}`, symbol: `BENCH${index}`, name: `Benchmark security ${index}`, listingDate: dates[0],
    type: index === 0 ? 'etf' : 'common', exchange: index % 4 === 0 ? 'NYSE' : 'NASDAQ', knownAt: dates[0],
  }));
  const prices = securities.flatMap(({ id }, position) => dates.flatMap((date, index) => {
    if (position !== 0 && (position * 3 + index) % 103 === 0) return [];
    const close = (30 + position) * (1 + index / 1500 + 0.035 * Math.sin(index / (3 + position % 13) + position));
    const volume = 50000 + (index * 7919 + position * 67) % 180000;
    return [{ securityId: id, date, knownAt: date, open: close * 1.002, high: close * 1.01,
      low: close * 0.99, close, adjustedClose: close, volume }];
  }));
  return { securities, prices, dates, benchmark: securities[0].symbol };
}

function readOnlySample(filename) {
  const source = new DatabaseSync(filename, { readOnly: true });
  try {
    const last = source.prepare('SELECT max(date) AS date FROM daily_prices').get().date;
    const dates = expectedSessions('2015-01-02', last).slice(-(sessionCount + 460));
    const readSecurities = source.prepare(`SELECT s.id,s.name,s.type,i.symbol,i.exchange FROM identifiers i
      JOIN securities s ON s.id=i.security_id JOIN daily_prices p ON p.security_id=s.id AND p.date=?
      WHERE i.valid_from<=? AND (i.valid_to IS NULL OR i.valid_to>=?)
      AND (i.symbol='SPY' OR (s.type='common' AND i.exchange IN ('NYSE','NASDAQ'))) AND p.volume>0
      ORDER BY i.symbol<>'SPY',s.id LIMIT ?`).all(last, last, last, stockCount);
    const securities = [...new Map(readSecurities.map((row) => [row.id, row])).values()].map((row) =>
      ({ ...row, listingDate: dates[0], knownAt: dates[0] }));
    const pricesFor = source.prepare(`SELECT security_id AS securityId,date,open,high,low,close,adjusted_close AS adjustedClose,
      volume,known_at AS knownAt,volume_adjusted AS volumeAdjusted,volume_basis AS volumeBasis,split_close AS splitClose
      FROM daily_prices WHERE security_id=? AND date BETWEEN ? AND ? ORDER BY date`);
    const prices = securities.flatMap(({ id }) => pricesFor.all(id, dates[0], last));
    return { securities, prices, dates, benchmark: 'SPY' };
  } finally { source.close(); }
}

const { securities, prices, dates, benchmark } = sourcePath ? readOnlySample(sourcePath) : syntheticSample();
const db = openDatabase(':memory:');
try {
  importDataset(db, { provider: 'benchmark-fixture', securities, prices });
  const referenceModule = process.env.MARKET_REFERENCE_ENGINE;
  const factory = referenceModule ? (await import(pathToFileURL(resolve(referenceModule)))).createEngine : createEngine;
  const engine = factory(db);
  const universes = variants === 1 ? ['sample'] : UNIVERSES.filter(({ id }) => id !== 'sample').map(({ id }) => id);
  const contexts = universes.flatMap((universe) =>
    ['composite', 'short-momentum', 'benchmark-relative'].flatMap((model) =>
      ['provider', 'sec-sic'].map((classification) => ({ universe, model, classification, benchmark, reference: 'as-of' }))))
    .slice(0, variants).map((input) => engine.context(input));
  const measured = dates.slice(-sessionCount);
  const started = performance.now();
  const sparseRows = rowMode === 'sparse';
  const histories = !engine.batchSnapshots || variants === 1 ? contexts.map((context) => engine.historyBatch(context, measured)) : null;
  const batches = histories ? measured.map((date) => ({ date })) : engine.batchSnapshots(contexts, { dates: measured, sparseRows });
  let observations = 0;
  let checksum = 0;
  for (const { date, results } of batches) {
    const rows = results?.map(({ snapshot }) => snapshot)
      || histories.map((context) => engine.snapshot({ ...context, date, requestedDate: date }, { persist: false, cache: false }));
    for (const row of rows) {
      observations += row.coverage.traded;
      checksum += row.stocks.reduce((total, stock) => total + (stock.ema_50d || 0) + (stock.rsScore || 0), 0);
    }
  }
  console.log(JSON.stringify({ sample: sourcePath ? 'read-only warehouse copy' : 'synthetic', securities: securities.length,
    sessions: measured.length, variants: contexts.length, mode: referenceModule ? 'reference' : sparseRows ? 'sparse' : 'canonical',
    observations, checksum, elapsedMs: Math.round(performance.now() - started),
    peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) }));
} finally { db.close(); }
