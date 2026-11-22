import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { gzipSync, gunzipSync } from 'node:zlib';
import { expectedSessions } from '../backend/calendar.mjs';
import { CALCULATION_VERSION, importDataset, openDatabase } from '../backend/database.mjs';
import { createEngine } from '../backend/engine.mjs';
import { stockMetrics } from '../backend/metrics.mjs';
import { createPreparedDetailWriter, riskMetrics } from '../backend/prepared-details.mjs';
import { prepareRangeHistoryBatch } from '../backend/range-metrics.mjs';
import { createRiskHistoryWriter, detailRiskWindows, readRiskHistory, riskHistoryManifest } from '../backend/risk-history.mjs';

const { values } = parseArgs({ options: {
  securities: { type: 'string', default: '16' }, sessions: { type: 'string', default: '756' },
} });
const size = Number(values.securities);
const count = Number(values.sessions);
if (![size, count].every((value) => Number.isInteger(value) && value > 0)) throw new Error('Supply positive integer securities and sessions');
const warmup = detailRiskWindows.at(-1) - 1;
const sessions = expectedSessions('2000-01-03', '2026-11-20').slice(0, count + warmup);
if (sessions.length !== count + warmup) throw new Error('The fixture calendar does not contain the requested output sessions');
const dates = sessions.slice(warmup);
const config = { basis: 'reconstructed', date: dates.at(-1), earliestDate: sessions[0], dataVersion: 1, benchmark: 'SPY' };
const ids = Array.from({ length: size }, (_, index) => `fixture:S${String(index).padStart(8, '0')}`);
const tickers = ['SPY', 'VTI'];

function prices(offset) {
  return sessions.map((date, i) => {
    const close = 30 + offset * 0.033 + i * 0.048 + 6 * Math.sin(i * (1.9 + offset / 30)) + 9 * Math.sin(i / 15 + offset);
    if ((i * 17 + offset) % 419 === 0) return { date, traded: false, missing: true };
    return { date, open: close, close, high: close * 1.018, low: close * 0.985, volume: 40_000 + i, traded: true };
  });
}

const stocks = ids.map((securityId, i) => ({ securityId, chartBars: prices(i + tickers.length) }));
const benchmarkBars = new Map(tickers.map((ticker, i) => [ticker, prices(i)]));
const benchmarkDates = new Map([...benchmarkBars].map(([ticker, bars]) => [ticker, new Map(bars.map(({ date, close }) => [date, close]))]));
const directory = mkdtempSync(join(tmpdir(), 'market-risk-benchmark-'));
const oldPath = join(directory, 'legacy.sqlite');
const riskPath = join(directory, 'rolling.sqlite');
const rangePath = join(directory, 'range.sqlite');
const seconds = (started) => (performance.now() - started) / 1000;

function legacy() {
  const started = performance.now();
  const db = new DatabaseSync(oldPath);
  let calculationMs = 0;
  let encodingMs = 0;
  let sqlMs = 0;
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE risk (security TEXT NOT NULL,date TEXT NOT NULL,benchmark TEXT NOT NULL,value BLOB NOT NULL,
      PRIMARY KEY(security,date,benchmark)) WITHOUT ROWID`);
  const put = db.prepare('INSERT INTO risk VALUES (?,?,?,?)');
  db.exec('BEGIN IMMEDIATE');
  for (const { securityId, chartBars } of stocks) {
    for (let i = warmup; i < sessions.length; i++) {
      const anchor = stockMetrics({}, chartBars.slice(i - 20, i + 1), { averages: [], windows: [], volumeWindows: [] });
      for (const [ticker, benchmark] of benchmarkDates) {
        let lap = performance.now();
        const row = Object.fromEntries(detailRiskWindows.map((window) => [window, riskMetrics({
          ...anchor, chartBars: chartBars.slice(i - window + 1, i + 1),
        }, benchmark)]));
        calculationMs += performance.now() - lap;
        lap = performance.now();
        const payload = gzipSync(JSON.stringify(row), { level: 6 });
        encodingMs += performance.now() - lap;
        lap = performance.now();
        put.run(securityId, sessions[i], ticker, payload);
        sqlMs += performance.now() - lap;
      }
    }
  }
  const commit = performance.now();
  db.exec('COMMIT');
  const commitSeconds = seconds(commit);
  db.close();
  const reopened = new DatabaseSync(oldPath, { readOnly: true });
  try {
    const rows = reopened.prepare('SELECT count(*) AS count FROM risk').get().count;
    const sample = reopened.prepare('SELECT value FROM risk WHERE security=? AND date=? AND benchmark=?')
      .get(ids[0], config.date, 'SPY').value;
    return { seconds: seconds(started), rows, keys: rows * detailRiskWindows.length, bytes: statSync(oldPath).size,
      calculationSeconds: calculationMs / 1000, serializationSeconds: encodingMs / 1000, sqliteSeconds: sqlMs / 1000,
      commitSeconds, sample: JSON.parse(gunzipSync(sample))[126] };
  } finally { reopened.close(); }
}

function rolling() {
  const started = performance.now();
  const db = new DatabaseSync(riskPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
  const writer = createRiskHistoryWriter(db, config, { dates, securityIds: ids, benchmarkBars });
  for (const security of stocks) writer.writeSecurity(security);
  const completed = writer.finish();
  db.close();
  const reopened = new DatabaseSync(riskPath, { readOnly: true });
  try {
    const manifest = riskHistoryManifest(reopened, completed.runId);
    const result = readRiskHistory(reopened, config, ids[0], { lookback: 126, benchmark: 'SPY' });
    assert.equal(manifest.actualBlocks, manifest.expectedBlocks);
    assert.equal(manifest.riskKeys, manifest.expectedKeys);
    assert.equal(result.state, 'ready');
    return { seconds: seconds(started), rows: manifest.actualBlocks, keys: manifest.riskKeys, bytes: statSync(riskPath).size,
      commits: manifest.commits, format: manifest.format, sample: result.risk };
  } finally { reopened.close(); }
}

function ranges() {
  const source = openDatabase(':memory:');
  const target = new DatabaseSync(rangePath);
  target.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
  const rows = stocks.map(({ securityId, chartBars }) => ({ symbol: securityId.slice('fixture:'.length), chartBars }));
  importDataset(source, {
    provider: 'fixture',
    securities: rows.map(({ symbol }) => ({ symbol, listingDate: sessions[0], knownAt: sessions[0], exchange: 'NYSE', type: 'common' })),
    prices: rows.flatMap(({ symbol, chartBars }) => chartBars.filter(({ traded }) => traded).map((bar) => ({ ...bar, symbol, knownAt: bar.date }))),
  });
  const engine = createEngine(source);
  const point = engine.context();
  const started = performance.now();
  const writeDetail = createPreparedDetailWriter(target, engine, point, { sourceDb: source, riskWindows: [] });
  let chartWriteMs = 0;
  const onSecurity = (detail) => {
    const lap = performance.now();
    writeDetail(detail);
    chartWriteMs += performance.now() - lap;
  };
  let result;
  do { result = prepareRangeHistoryBatch(target, engine, point, [20, 252], { sourceDb: source, dates, bucketSize: 32, onSecurity }); } while (!result.done);
  assert.equal(result.processedSecurities, size);
  target.close();
  source.close();
  const reopened = new DatabaseSync(rangePath, { readOnly: true });
  try {
    const persisted = reopened.prepare('SELECT count(*) AS blocks,count(DISTINCT date) AS dates FROM prepared_range_history_blocks').get();
    const chartProducts = reopened.prepare('SELECT count(*) AS count FROM prepared_detail_products').get().count;
    const chartBlocks = reopened.prepare('SELECT count(*) AS count FROM prepared_detail_blocks').get().count;
    assert.equal(persisted.blocks, result.written);
    assert.equal(chartProducts, size);
    return { seconds: seconds(started), bytes: statSync(rangePath).size, securities: result.totalSecurities, windows: result.windows,
      ...persisted, chartProducts, chartBlocks, chartWriteSeconds: chartWriteMs / 1000 };
  } finally { reopened.close(); }
}

try {
  const baseline = legacy();
  const candidate = rolling();
  for (const [key, value] of Object.entries(baseline.sample)) {
    if (value == null || Number.isInteger(value)) assert.equal(candidate.sample[key], value);
    else assert.ok(Math.abs(candidate.sample[key] - value) < 1e-10, key);
  }
  assert.equal(candidate.keys, baseline.keys);
  delete baseline.sample;
  delete candidate.sample;
  console.log(JSON.stringify({ scope: { synthetic: true, securities: size, sessions: count, warmup, windows: detailRiskWindows,
    benchmarks: tickers, calculationVersion: CALCULATION_VERSION }, legacy: baseline, rolling: candidate, range: ranges(),
    speedup: baseline.seconds / candidate.seconds }, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
