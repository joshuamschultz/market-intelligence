import { createHash } from 'node:crypto';
import { CALCULATION_VERSION, isoDate } from './database.mjs';
import { referenceArchiveScopes, reusableArchiveVersions, usableArchiveRow } from './archive-lineage.mjs';
import { expectedSessions, weekEnd } from './calendar.mjs';

const schema = `
  CREATE TABLE IF NOT EXISTS rank_archive_dates (
    recipe TEXT NOT NULL, date TEXT NOT NULL, data_version INTEGER NOT NULL,
    calculation_version TEXT NOT NULL, observations INTEGER NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (recipe, data_version, calculation_version, date)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS stock_rank_history (
    recipe TEXT NOT NULL, date TEXT NOT NULL, data_version INTEGER NOT NULL, calculation_version TEXT NOT NULL,
    security_id TEXT NOT NULL, symbol TEXT NOT NULL, rank INTEGER, percentile REAL, score REAL,
    PRIMARY KEY (recipe, data_version, calculation_version, date, security_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS stock_rank_by_security ON stock_rank_history(recipe, data_version, calculation_version, security_id, date);
`;

function requestedDates(config, { from, to, limit = 260, cadence = 'daily' } = {}) {
  for (const date of [from, to]) if (date && !isoDate(date)) throw new Error('Ranking dates must be YYYY-MM-DD');
  if (!['daily', 'weekly'].includes(cadence)) throw new Error('Ranking cadence must be daily or weekly');
  if (!config.earliestDate || !config.date) return [];
  const lower = from && from > config.earliestDate ? from : config.earliestDate;
  const upper = to && to < config.date ? to : config.date;
  const sessions = expectedSessions(lower, upper);
  const dates = cadence === 'daily' ? sessions : sessions.filter((date, i) => !sessions[i + 1] || weekEnd(date) !== weekEnd(sessions[i + 1]));
  const count = Number(limit);
  if (!Number.isInteger(count) || count < 1 || count > 7560) throw new Error('Ranking limit must be 1–7,560 sessions');
  return dates.slice(-count);
}

// These methods score only after eligibility and before classification, grouping, or breadth is evaluated.
const priceOnlyMethods = new Set(['weighted', 'percentile', 'zscore', 'benchmark', 'risk', 'nonoverlapping']);

function recipeKey(engine, config) {
  const reference = config.referenceMode === 'latest' ? ['latest', config.observedReferenceDate] : ['as-of'];
  const ranking = priceOnlyMethods.has(config.model.definition?.method)
    ? createHash('sha256').update(JSON.stringify(['rank-price-v1', config.basis, config.benchmark, reference])).digest('hex').slice(0, 24)
    : engine.definitionKey(config);
  return [`${config.universe.id}@${config.universe.version}/${config.model.id}@${config.model.version}/${ranking}`,
    config.dataVersion, CALCULATION_VERSION];
}

function archiveBounds(db, config, key) {
  const candidates = db.prepare('SELECT DISTINCT data_version FROM rank_archive_dates WHERE recipe=? AND calculation_version=? AND data_version<=?')
    .all(key[0], key[2], key[1]).map((row) => row.data_version);
  return reusableArchiveVersions(db, config, candidates);
}

export function prepareRankArchiveWriter(db, engine, config) {
  db.exec(schema);
  const key = recipeKey(engine, config);
  const exists = db.prepare('SELECT 1 FROM rank_archive_dates WHERE recipe=? AND data_version=? AND calculation_version=? AND date=?');
  const bounds = archiveBounds(db, config, key);
  const addDate = db.prepare('INSERT INTO rank_archive_dates VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING');
  const addRank = db.prepare('INSERT INTO stock_rank_history VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING');
  function write(snapshot) {
    const { date } = snapshot;
    const candidates = snapshot.stocks.filter((row) => row.traded);
    db.exec('BEGIN IMMEDIATE');
    try {
      const committed = addDate.run(key[0], date, key[1], key[2], candidates.length, new Date().toISOString());
      if (committed.changes) {
        for (const row of candidates) {
          addRank.run(key[0], date, key[1], key[2], row.securityId, row.symbol, row.rsRank, row.rsPercentile, row.rsScore);
        }
      }
      db.exec('COMMIT');
      return committed.changes ? candidates.length : null;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }
  return { has: (date) => [...bounds].some(([version, before]) => (!before || date < before) && exists.get(key[0], version, key[2], date)), write };
}

export function writeRankArchive(db, engine, config, { from, to, cadence, limit, progress = () => {} } = {}) {
  const dates = requestedDates(config, { from, to, cadence, limit });
  if (!dates.length) return { requested: 0, written: 0, skipped: 0, ranks: 0 };
  const writers = new Map();
  for (const scope of referenceArchiveScopes(config, dates)) {
    const writer = prepareRankArchiveWriter(db, engine, scope.config);
    for (const date of scope.dates) writers.set(date, writer);
  }
  let written = 0;
  let skipped = 0;
  let ranks = 0;
  let timeline = { ...config, currentVersion: false };
  for (const [index, date] of dates.entries()) {
    if (index % 60 === 0 && engine.historyBatch) timeline = engine.historyBatch(config, dates.slice(index, index + 60));
    const writer = writers.get(date);
    if (writer.has(date)) skipped++;
    else {
      const snapshot = engine.snapshot({ ...timeline, date }, { persist: false, cache: false });
      const count = writer.write(snapshot);
      if (count == null) skipped++;
      else {
        written++;
        ranks += count;
      }
    }
    progress((index + 1) / dates.length);
  }
  return { requested: dates.length, written, skipped, ranks, from: dates[0], to: dates.at(-1),
    dataVersion: config.dataVersion, calculationVersion: CALCULATION_VERSION };
}

function readScope(db, engine, config, dates, options) {
  const key = recipeKey(engine, config);
  const bounds = archiveBounds(db, config, key);
  const active = new Map();
  const input = [key[0], key[2], JSON.stringify([...bounds.keys()]), JSON.stringify(dates)];
  for (const row of db.prepare(`SELECT date,data_version FROM rank_archive_dates WHERE recipe=? AND calculation_version=?
    AND data_version IN (SELECT value FROM json_each(?)) AND date IN (SELECT value FROM json_each(?))
    ORDER BY date,data_version DESC`).iterate(...input)) {
    if (!active.has(row.date) && usableArchiveRow(bounds, row)) active.set(row.date, row.data_version);
  }
  const id = options.securityId || options.symbol;
  const field = options.securityId ? 'security_id' : 'symbol';
  const rows = id ? db.prepare(`SELECT date,data_version,rank,percentile,score FROM stock_rank_history WHERE recipe=? AND calculation_version=?
    AND data_version IN (SELECT value FROM json_each(?)) AND date IN (SELECT value FROM json_each(?))
    AND ${field}=? ORDER BY date`).all(...input, id)
    .filter((row) => active.get(row.date) === row.data_version)
    .map(({ data_version, ...row }) => ({
      ...row, ...(data_version !== config.dataVersion ? { sourceDataVersion: data_version, requestedDataVersion: config.dataVersion } : {}),
    })) : [];
  return { observed: [...active.keys()], rows, reused: [...active.values()].filter((version) => version !== config.dataVersion).length };
}

export function readRankArchive(db, engine, config, options = {}) {
  const dates = requestedDates(config, options);
  const present = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='rank_archive_dates'").get();
  if (!present || !dates.length) return { dates, observed: new Set(), rows: [], reused: 0 };
  const scopes = referenceArchiveScopes(config, dates).map((scope) => readScope(db, engine, scope.config, scope.dates, options));
  return { dates, observed: new Set(scopes.flatMap(({ observed }) => observed)),
    rows: scopes.flatMap(({ rows }) => rows).sort((left, right) => left.date.localeCompare(right.date)),
    reused: scopes.reduce((total, { reused }) => total + reused, 0) };
}
