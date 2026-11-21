import { expectedSessions, isMarketSession, shiftDate } from './calendar.mjs';
import { CALCULATION_VERSION, isoDate } from './database.mjs';

const method = 'ratio-adjusted-v1';
const warmupSessions = 80;
const minimumTraded = 20;
const minimumComparableFraction = 0.8;
const fastAlpha = 0.1;
const slowAlpha = 0.05;
const averagePeriods = [10, 20];
const precision = 1e-9;
const maximumReadSessions = 7560;

const schema = `CREATE TABLE IF NOT EXISTS prepared_nyse_summation (
  recipe TEXT NOT NULL,
  data_version INTEGER NOT NULL,
  date TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (recipe, data_version, date)
) WITHOUT ROWID`;

const methodologySources = [
  { label: 'McClellan oscillator calculation', url: 'https://www.mcoscillator.com/learning_center/kb/mcclellan_oscillator/Calculating_the_McClellan_Oscillator/' },
  { label: 'Ratio-adjusted summation methodology', url: 'https://www.mcoscillator.com/learning_center/kb/market_data/ratio_adjusted_summation_index/' },
];

const asCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

function coverage(date, row) {
  const [advancers, decliners, comparable, traded] = ['advancers', 'decliners', 'comparable', 'traded']
    .map((field) => asCount(row?.[field]));
  const comparableFraction = traded > 0 && comparable != null && comparable <= traded ? comparable / traded : null;
  const counts = { date, advancers, decliners, comparable, traded, comparableFraction };
  let reason = null;
  if (!row) reason = 'missing-breadth';
  else if ([advancers, decliners, comparable, traded].includes(null) || advancers + decliners > comparable || comparable > traded) reason = 'invalid-counts';
  else if (traded < minimumTraded) reason = 'insufficient-traded';
  else if (comparableFraction < minimumComparableFraction) reason = 'insufficient-comparable';
  else if (advancers + decliners === 0) reason = 'no-directional-issues';
  return { ...counts, reason };
}

function newSegment() {
  return { observed: 0, fast: 0, slow: 0, sum: 0, values: [], side: {}, lastCross: {} };
}

function averageSignal(segment, date, value, period) {
  const available = value != null && segment.values.length >= period;
  const average = available ? segment.values.slice(-period).reduce((total, item) => total + item, 0) / period : null;
  let position = null;
  let crossover = null;
  if (available) {
    const spread = value - average;
    position = spread > precision ? 'above' : spread < -precision ? 'below' : 'equal';
    if (position !== 'equal') {
      if (segment.side[period] && segment.side[period] !== position) {
        crossover = position;
        segment.lastCross[period] = { date, direction: position };
      }
      segment.side[period] = position;
    }
  }
  return { [`sma${period}`]: average, [`position${period}`]: position, [`cross${period}`]: crossover,
    [`lastCross${period}`]: segment.lastCross[period] ?? null };
}

export function calculateSummation(sessions, breadthRows) {
  if (!sessions.length && !breadthRows.length) return [];
  if (!isoDate(sessions[0]) || !isoDate(sessions.at(-1)) || sessions[0] > sessions.at(-1)) {
    throw new RangeError('Supply an ordered range of expected NYSE sessions');
  }
  const expected = expectedSessions(sessions[0], sessions.at(-1));
  if (expected.length !== sessions.length || expected.some((date, index) => date !== sessions[index])) {
    throw new RangeError('Summation sessions must include every expected market session in order');
  }
  const dates = new Set(sessions);
  const byDate = new Map();
  for (const row of breadthRows) {
    if (!dates.has(row.date) || byDate.has(row.date)) throw new RangeError('Breadth rows must match unique expected sessions');
    byDate.set(row.date, row);
  }

  let segment = newSegment();
  return sessions.map((date) => {
    const counts = coverage(date, byDate.get(date));
    let ratioAdjustedNet = null;
    let oscillator = null;
    let value = null;
    let slope = null;
    if (counts.reason) {
      segment = newSegment();
    } else {
      const { advancers, decliners } = counts;
      ratioAdjustedNet = 1000 * (advancers - decliners) / (advancers + decliners);
      segment.fast += fastAlpha * (ratioAdjustedNet - segment.fast);
      segment.slow += slowAlpha * (ratioAdjustedNet - segment.slow);
      oscillator = segment.fast - segment.slow;
      segment.sum += oscillator;
      segment.observed++;
      if (segment.observed > warmupSessions) {
        value = segment.sum;
        const previous = segment.values.at(-1);
        if (previous != null) slope = value - previous;
        segment.values.push(value);
        if (segment.values.length > averagePeriods.at(-1)) segment.values.shift();
      }
    }
    const state = counts.reason ? 'gap' : value == null ? 'warmup' : 'available';
    return {
      ...counts, state, consecutiveObservations: segment.observed, ratioAdjustedNet,
      fastEMA: counts.reason ? null : segment.fast, slowEMA: counts.reason ? null : segment.slow,
      oscillator, value, slope: slope != null && Math.abs(slope) <= precision ? 0 : slope,
      ...averageSignal(segment, date, value, 10), ...averageSignal(segment, date, value, 20),
    };
  });
}

function identity(context) {
  const { universe, basis, dataVersion, earliestDate, referenceMode = 'as-of', observedReferenceDate } = context;
  if (universe?.id !== 'nyse' || !Number.isInteger(universe.version) || universe.version < 1) {
    throw new TypeError('Summation requires a versioned NYSE Common universe');
  }
  if (!Number.isInteger(dataVersion) || dataVersion < 0 || !['known', 'reconstructed'].includes(basis)) {
    throw new TypeError('Summation requires a valid data version and price basis');
  }
  if (!['latest', 'as-of'].includes(referenceMode) || (referenceMode === 'latest' && !isoDate(observedReferenceDate))) {
    throw new TypeError('Summation requires a valid reference mode');
  }
  const seedStart = context.summationStart ?? earliestDate ?? null;
  if (seedStart != null && !isoDate(seedStart)) throw new TypeError('Summation seed date must be YYYY-MM-DD');
  const referenceDate = referenceMode === 'latest' ? observedReferenceDate : null;
  const recipe = JSON.stringify([CALCULATION_VERSION, method, universe.id, universe.version, basis, referenceMode, referenceDate, seedStart]);
  const metadata = {
    label: 'Observed NYSE common-stock summation proxy',
    source: 'Warehouse NYSE Common advance and decline counts from consecutive split-adjusted closes',
    universe: { id: universe.id, version: universe.version }, basis, referenceMode, referenceDate, seedStart,
    calculationVersion: CALCULATION_VERSION, method, seriesType: 'observed-proxy', units: 'ratio-adjusted index points',
    input: '1000 × (advancers − decliners) / (advancers + decliners)',
    fastAlpha, slowAlpha, warmupSessions, averagePeriods: [...averagePeriods], averageMethod: 'SMA',
    minimumTraded, minimumComparableFraction,
    initialization: 'Both EMAs and the oscillator sum start at zero. Each gap resets the calculation and warmup.',
    methodologySources: methodologySources.map((source) => ({ ...source })),
  };
  return { recipe, dataVersion, seedStart, metadata };
}

export function prepareSummation(db, context, sessions, breadthRows) {
  const { recipe, dataVersion, seedStart } = identity(context);
  if (!seedStart || !isoDate(context.date) || seedStart > context.date) {
    if (!sessions.length && !breadthRows.length) return { written: 0, through: null };
    throw new RangeError('Summation requires a seed date on or before the prepared end date');
  }
  const expected = expectedSessions(seedStart, context.date);
  if (sessions.length !== expected.length || sessions.some((date, index) => date !== expected[index])) {
    throw new RangeError('Summation preparation must cover all expected sessions from the configured seed to the end date');
  }
  const rows = calculateSummation(sessions, breadthRows);
  if (!rows.length) return { written: 0, through: null };
  const through = rows.at(-1).date;
  db.exec(schema);
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare('SELECT max(date) AS date FROM prepared_nyse_summation WHERE recipe=? AND data_version=?').get(recipe, dataVersion).date;
    let written = 0;
    if (!current || through >= current) {
      const save = db.prepare(`INSERT INTO prepared_nyse_summation VALUES (?, ?, ?, ?)
        ON CONFLICT(recipe, data_version, date) DO UPDATE SET value=excluded.value
        WHERE value!=excluded.value`);
      for (const row of rows) written += save.run(recipe, dataVersion, row.date, JSON.stringify(row)).changes;
    }
    db.exec('COMMIT');
    return { written, through: current && current > through ? current : through };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

export function readPreparedSummation(db, context, { from, to, limit = 252 } = {}) {
  const { recipe, dataVersion, seedStart, metadata } = identity(context);
  const date = context.date ?? null;
  if ([from, to, date].some((value) => value != null && !isoDate(value))) throw new TypeError('Summation dates must be YYYY-MM-DD');
  if (from && to && from > to) throw new RangeError('Summation start must be on or before end');
  const count = Number(limit);
  if (!Number.isInteger(count) || count < 1 || count > maximumReadSessions) {
    throw new RangeError(`Summation limit must be an integer from 1 to ${maximumReadSessions}`);
  }
  const result = { date, dataVersion, metadata, status: 'empty', through: null, rows: [] };
  if (!date || !seedStart) return result;
  const start = from && from > seedStart ? from : seedStart;
  let end = to && to < date ? to : date;
  while (end >= start && !isMarketSession(end)) end = shiftDate(end, -1);
  if (start > end) return result;
  const present = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='prepared_nyse_summation'").get();
  if (!present) return { ...result, status: 'unprepared' };
  const stored = db.prepare(`SELECT value FROM prepared_nyse_summation WHERE recipe=? AND data_version=?
    AND date BETWEEN ? AND ? ORDER BY date DESC LIMIT ?`).all(recipe, dataVersion, start, end, count);
  const rows = stored.reverse().map(({ value }) => JSON.parse(value));
  const through = rows.at(-1)?.date ?? null;
  const status = through === end ? 'ready' : through ? 'partial' : 'unprepared';
  return { ...result, status, through, rows };
}
