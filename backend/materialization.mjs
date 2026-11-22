import { createHash } from 'node:crypto';
import { referenceArchiveScopes, reusableArchiveVersions, usableArchiveRow } from './archive-lineage.mjs';
import { prepareRankArchiveWriter } from './rank-archive.mjs';
import { leadershipStatistics, topDecileIds } from './ranking.mjs';
import { expectedSessions, shiftDate, weekEnd } from './calendar.mjs';
import { CALCULATION_VERSION, isoDate, listWorkspace } from './database.mjs';
import { compressStoredJson, decodeStoredJson } from './storage-codec.mjs';

const PROJECTION_VERSION = 2;
const MAX_SESSIONS = 7560;
const sharedGroupsFormat = 'market-history-groups-1';
const cachedGroupProjections = new WeakMap();

const createMarketHistory = `
  CREATE TABLE IF NOT EXISTS market_history (
    universe TEXT NOT NULL,
    model TEXT NOT NULL,
    data_version INTEGER NOT NULL,
    calculation_version TEXT NOT NULL,
    definition_key TEXT NOT NULL,
    date TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (universe, model, data_version, calculation_version, definition_key, date)
  ) WITHOUT ROWID
`;
const createGroupBlocks = `CREATE TABLE IF NOT EXISTS market_history_group_blocks (
  calculation_version TEXT NOT NULL,
  data_version INTEGER NOT NULL,
  basis TEXT NOT NULL,
  date TEXT NOT NULL,
  blob TEXT NOT NULL,
  value BLOB NOT NULL,
  PRIMARY KEY(calculation_version,data_version,basis,date,blob)
) WITHOUT ROWID`;

function archiveRows(db, config, key, dates, withValues = false) {
  const [universe, model, dataVersion, calculationVersion, definitionKey] = key.values;
  const common = 'universe=? AND model=? AND calculation_version=? AND definition_key=? AND data_version<=?';
  const context = [universe, model, calculationVersion, definitionKey, dataVersion];
  const candidates = db.prepare(`SELECT DISTINCT data_version FROM market_history WHERE ${common}`).all(...context).map((row) => row.data_version);
  const bounds = reusableArchiveVersions(db, config, candidates);
  const output = [];
  const seen = new Set();
  const columns = withValues ? 'date,data_version,value,created_at' : 'date,data_version';
  for (const row of db.prepare(`
    SELECT ${columns} FROM market_history WHERE ${common} AND data_version IN (SELECT value FROM json_each(?))
    AND date IN (SELECT value FROM json_each(?)) ORDER BY date,data_version DESC
  `).iterate(...context, JSON.stringify([...bounds.keys()]), JSON.stringify(dates))) {
    if (!seen.has(row.date) && usableArchiveRow(bounds, row)) {
      seen.add(row.date);
      output.push(row);
    }
  }
  return output;
}

const thinGroupFields = [
  'id', 'level', 'name', 'parent', 'count', 'rankedCount', 'rank', 'percentile', 'medianRS', 'meanRS',
  'equalWeight', 'dailyReturn', 'capWeightedDaily', 'relativeReturn', 'parentRelativeRS', 'parentRelativeReturn', 'marketCap',
  'topDecile', 'above50', 'above200', 'positiveMomentum', 'newHighBreadth', 'upDownDollar', 'upDollar', 'downDollar',
  'leadingConcentration', 'largestPositiveDollarShare', 'emergingLeaderCount', 'emergingLeaderObservations',
  'counts', 'velocity4w', 'velocity12w', 'rankChange4w', 'rankChange12w', 'breadthChange',
  'medianRSChange4w', 'topDecileChange4w', 'relativeReturnChange4w', 'emerging',
];

function historyDates(config, { from, to, limit = 120, cadence = 'daily' }) {
  if (!['daily', 'weekly'].includes(cadence)) throw new TypeError('History cadence must be daily or weekly');
  for (const date of [from, to]) {
    if (date != null && !isoDate(date)) throw new TypeError('History dates must be YYYY-MM-DD');
  }
  if (from && to && from > to) throw new RangeError('History start must be on or before end');
  const count = Number(limit);
  if (!Number.isInteger(count) || count < 1 || count > MAX_SESSIONS) {
    throw new RangeError(`History limit must be an integer from 1 to ${MAX_SESSIONS}`);
  }
  if (!config.date || !config.earliestDate) return { dates: [], cadence };
  const first = from && from > config.earliestDate ? from : config.earliestDate;
  const last = to && to < config.date ? to : config.date;
  if (first > last) return { dates: [], cadence };
  const sessions = expectedSessions(first, last);
  const selected = cadence === 'weekly' ? sessions.filter((date, index) =>
    !sessions[index + 1] || weekEnd(date) !== weekEnd(sessions[index + 1])) : sessions;
  return { dates: selected.slice(-count), cadence };
}

function materializationKey(db, engine, config) {
  const universe = `${config.universe.id}@${config.universe.version}`;
  const model = `${config.model.id}@${config.model.version}`;
  const themes = config.themes ?? listWorkspace(db, 'theme');
  // Revision tables keep the selected warehouse version stable during concurrent ingestion.
  const pinned = { ...config, themes, currentVersion: false };
  const calculationVersion = CALCULATION_VERSION;
  const definition = engine.definitionKey?.(pinned) ?? {
    benchmark: pinned.benchmark, basis: pinned.basis, classification: pinned.classification,
    averages: pinned.averages, windows: pinned.windows, volume: pinned.volumeWindows, breadth: pinned.breadthKeys,
    threshold: pinned.threshold, themes: themes.map(({ id, version }) => [id, version]),
  };
  const definitionKey = createHash('sha256').update(JSON.stringify([PROJECTION_VERSION, definition])).digest('hex');
  return { pinned, definitionKey, values: [universe, model, pinned.dataVersion, calculationVersion, definitionKey] };
}

function narrowGroups(groups, shareGroups) {
  if (shareGroups && cachedGroupProjections.has(groups)) return cachedGroupProjections.get(groups);
  const value = groups.map((group) => Object.fromEntries(thinGroupFields.filter((key) =>
    Object.hasOwn(group, key)).map((key) => [key, group[key]])));
  const json = JSON.stringify(value);
  const projection = { value, json, blob: json.length >= 1024 ? createHash('sha256').update(json).digest('hex') : null };
  if (shareGroups) cachedGroupProjections.set(groups, projection);
  return projection;
}

function narrowSnapshot(snapshot, date, leaders, leadership, groups) {
  if (snapshot.date !== date) throw new Error('The market engine returned a different session than requested');
  return {
    date, universe: snapshot.universe, model: snapshot.model, benchmark: snapshot.benchmark, basis: snapshot.basis,
    classificationSystem: snapshot.classificationSystem, referenceMode: snapshot.referenceMode, referenceDate: snapshot.referenceDate,
    dataVersion: snapshot.dataVersion, calculationVersion: snapshot.calculationVersion, knownAt: snapshot.knownAt ?? null,
    coverage: snapshot.coverage, breadth: snapshot.breadth, aggregates: { ...snapshot.aggregates, ...leadership },
    topDecileIds: leaders,
    groups,
  };
}

function decodeProjection(value, groupBlock, dataVersion, date) {
  const stored = decodeStoredJson(value);
  if (!Array.isArray(stored) || stored[0] !== sharedGroupsFormat) return stored;
  const [, basis, projection] = stored;
  if (groupBlock === undefined) return projection;
  if (!groupBlock) throw new Error('Prepared market history group block is missing');
  const linked = groupBlock.get(CALCULATION_VERSION, dataVersion, basis, date, projection.groups)?.value;
  if (!linked) throw new Error('Prepared market history group block is missing');
  return { ...projection, groups: decodeStoredJson(linked) };
}

export function createMaterializedHistoryWriter(db, engine, config, dates, { force = false, codec, shareGroups = false } = {}) {
  db.exec(createMarketHistory);
  db.exec(createGroupBlocks);
  const plans = new Map();
  for (const scope of referenceArchiveScopes(config, dates)) {
    const archive = materializationKey(db, engine, scope.config);
    const existing = force ? new Set() : new Set(archiveRows(db, scope.config, archive, scope.dates).map((row) => row.date));
    for (const date of scope.dates) plans.set(date, { archive, existing });
  }
  const insert = db.prepare(`
    INSERT INTO market_history VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(universe, model, data_version, calculation_version, definition_key, date)
    DO ${force ? 'UPDATE SET value=excluded.value, created_at=excluded.created_at' : 'NOTHING'}
  `);
  const groupArguments = 'calculation_version=? AND data_version=? AND basis=? AND date=? AND blob=?';
  const groupExists = db.prepare(`SELECT 1 FROM market_history_group_blocks WHERE ${groupArguments}`);
  const writeGroup = db.prepare('INSERT OR IGNORE INTO market_history_group_blocks VALUES (?,?,?,?,?,?)');
  const asOf = { ...config, referenceMode: 'as-of' };
  const dated = materializationKey(db, engine, asOf);
  return {
    has(date) { return plans.get(date)?.existing.has(date) ?? false; },
    previousLeaders(dates) {
      return new Map(archiveRows(db, asOf, dated, dates, true).map(({ date, value }) => [date, decodeProjection(value).topDecileIds]));
    },
    write(snapshot, previousDate, previousIds, currentIds = topDecileIds(snapshot)) {
      const plan = plans.get(snapshot.date);
      if (!plan || plan.existing.has(snapshot.date)) return false;
      const leadership = leadershipStatistics(snapshot, previousDate, previousIds);
      const groups = narrowGroups(snapshot.groups ?? [], shareGroups);
      const projection = narrowSnapshot(snapshot, snapshot.date, currentIds, leadership, groups.blob ?? groups.value);
      const json = JSON.stringify(groups.blob ? [sharedGroupsFormat, config.basis, projection] : projection);
      const value = json.length < 65536 ? json : compressStoredJson(json, codec);
      const write = () => !!insert.run(...plan.archive.values, snapshot.date, value, new Date().toISOString()).changes;
      if (!groups.blob) return write();
      const nested = db.isTransaction;
      db.exec(nested ? 'SAVEPOINT prepare_thin_groups' : 'BEGIN IMMEDIATE');
      try {
        const written = write();
        if (written) {
          const key = [CALCULATION_VERSION, config.dataVersion, config.basis, snapshot.date, groups.blob];
          if (!groupExists.get(...key)) writeGroup.run(...key, compressStoredJson(groups.json, codec));
        }
        db.exec(nested ? 'RELEASE prepare_thin_groups' : 'COMMIT');
        return written;
      } catch (error) {
        if (nested) db.exec('ROLLBACK TO prepare_thin_groups; RELEASE prepare_thin_groups');
        else if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function rangeMetadata(dates, cadence, config, definitionKey) {
  return {
    requested: dates.length, from: dates[0] ?? null, to: dates.at(-1) ?? null, cadence,
    dataVersion: config.dataVersion, definitionKey,
  };
}

function ensureActive({ signal, shouldCancel }) {
  if (signal?.aborted || shouldCancel?.()) {
    throw new DOMException('Market history materialization was cancelled', 'AbortError');
  }
}

export function materializeHistory(db, engine, config, options = {}) {
  ensureActive(options);
  const { dates, cadence } = historyDates(config, options);
  const key = materializationKey(db, engine, config);
  const summary = rangeMetadata(dates, cadence, config, key.definitionKey);
  const { force = false, onProgress, withRanks = false } = options;
  if (!dates.length) {
    onProgress?.({ completed: 0, total: 0, written: 0, skipped: 0, date: null, percent: 100 });
    return { ...summary, written: 0, skipped: 0 };
  }
  const writer = createMaterializedHistoryWriter(db, engine, config, dates, { force });
  const scopes = new Map();
  for (const scope of referenceArchiveScopes(config, dates)) {
    const archive = materializationKey(db, engine, scope.config);
    const rankWriter = withRanks ? prepareRankArchiveWriter(db, engine, archive.pinned) : null;
    for (const date of scope.dates) scopes.set(date, rankWriter);
  }
  let written = 0;
  let skipped = 0;
  let rankDates = 0;
  let rankRows = 0;
  const progress = (date) => {
    const completed = written + skipped;
    onProgress?.({ completed, total: dates.length, written, skipped, date, percent: Math.floor(100 * completed / dates.length) });
  };
  progress(null);
  let timeline = key.pinned;
  let prior = null;
  const dated = materializationKey(db, engine, { ...config, referenceMode: 'as-of' });
  for (const [index, date] of dates.entries()) {
    ensureActive(options);
    if (index % 60 === 0 && engine.historyBatch) timeline = engine.historyBatch(key.pinned, dates.slice(index, index + 60));
    const rankWriter = scopes.get(date);
    const breadthExists = writer.has(date);
    const ranksPending = rankWriter && !rankWriter.has(date);
    if (breadthExists && !ranksPending) skipped++;
    else {
      const snapshot = engine.snapshot({ ...timeline, date, requestedDate: date }, { persist: false, cache: false });
      ensureActive(options);
      if (!breadthExists) {
        const previousDate = expectedSessions(shiftDate(date, -12), shiftDate(date, -1)).at(-1);
        let previousIds = prior?.date === previousDate ? prior.ids : null;
        if (previousIds == null && previousDate >= config.earliestDate) {
          const stored = archiveRows(db, dated.pinned, dated, [previousDate], true)[0];
          previousIds = stored ? decodeProjection(stored.value).topDecileIds : topDecileIds(engine.snapshot({
            ...dated.pinned, date: previousDate, requestedDate: previousDate,
          }, { persist: false, cache: false }));
        }
        const currentIds = topDecileIds(snapshot);
        prior = { date, ids: currentIds };
        if (writer.write(snapshot, previousDate, previousIds, currentIds)) written++;
        else skipped++;
      } else skipped++;
      if (ranksPending) {
        const count = rankWriter.write(snapshot);
        if (count != null) {
          rankDates++;
          rankRows += count;
        }
      }
    }
    progress(date);
  }
  return { ...summary, written, skipped, ...(withRanks ? { rankDates, rankRows } : {}) };
}

export function readMaterializedHistory(db, engine, config, options = {}) {
  const { dates, cadence } = historyDates(config, options);
  const key = materializationKey(db, engine, config);
  const summary = rangeMetadata(dates, cadence, config, key.definitionKey);
  const present = dates.length && db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='market_history'").get();
  const stored = present ? referenceArchiveScopes(config, dates).flatMap((scope) =>
    archiveRows(db, scope.config, materializationKey(db, engine, scope.config), scope.dates, true)).sort((a, b) => a.date.localeCompare(b.date)) : [];
  const available = new Set(stored.map((row) => row.date));
  const missingDates = dates.filter((date) => !available.has(date));
  const groups = stored.length && db.prepare("SELECT 1 FROM sqlite_schema WHERE name='market_history_group_blocks'").get()
    ? db.prepare('SELECT value FROM market_history_group_blocks WHERE calculation_version=? AND data_version=? AND basis=? AND date=? AND blob=?') : null;
  return {
    ...summary,
    complete: missingDates.length === 0,
    missingDates,
    reused: stored.filter((row) => row.data_version !== config.dataVersion).length,
    rows: stored.map((row) => {
      const { topDecileIds: _internal, ...projection } = decodeProjection(row.value, groups, row.data_version, row.date);
      return { ...projection, materializedAt: row.created_at,
        ...(row.data_version !== config.dataVersion ? { sourceDataVersion: row.data_version, requestedDataVersion: config.dataVersion } : {}) };
    }),
  };
}
