import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { referenceArchiveScopes, reusableArchiveVersions, usableArchiveRow } from './archive-lineage.mjs';
import { CALCULATION_VERSION } from './database.mjs';

const format = 'prepared-stock-2';
const bucketCount = 32;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const encode = (value) => gzipSync(JSON.stringify(value), { level: 6 });
const decode = (value) => JSON.parse(gunzipSync(value));
const baseKey = 'calculation_version=? AND data_version=? AND basis=? AND date=?';
const contextKey = `${baseKey} AND recipe=?`;
const schema = `
  CREATE TABLE IF NOT EXISTS prepared_stock_base (
    calculation_version TEXT NOT NULL,
    data_version INTEGER NOT NULL,
    basis TEXT NOT NULL,
    date TEXT NOT NULL,
    bucket INTEGER NOT NULL,
    value BLOB NOT NULL,
    PRIMARY KEY (calculation_version,data_version,basis,date,bucket)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS prepared_snapshot_layouts (
    calculation_version TEXT NOT NULL,
    data_version INTEGER NOT NULL,
    basis TEXT NOT NULL,
    date TEXT NOT NULL,
    layout TEXT NOT NULL,
    value BLOB NOT NULL,
    PRIMARY KEY (calculation_version,data_version,basis,date,layout)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS prepared_snapshot_contexts (
    calculation_version TEXT NOT NULL,
    data_version INTEGER NOT NULL,
    basis TEXT NOT NULL,
    date TEXT NOT NULL,
    recipe TEXT NOT NULL,
    layout TEXT NOT NULL,
    stock_count INTEGER NOT NULL,
    delta_mask INTEGER NOT NULL,
    header TEXT NOT NULL,
    PRIMARY KEY (calculation_version,data_version,basis,date,recipe)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS prepared_snapshot_context_history
    ON prepared_snapshot_contexts (calculation_version,basis,recipe,date,data_version);
  CREATE TABLE IF NOT EXISTS prepared_snapshot_deltas (
    calculation_version TEXT NOT NULL,
    data_version INTEGER NOT NULL,
    basis TEXT NOT NULL,
    date TEXT NOT NULL,
    recipe TEXT NOT NULL,
    bucket INTEGER NOT NULL,
    blob TEXT NOT NULL,
    PRIMARY KEY (calculation_version,data_version,basis,date,recipe,bucket)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS prepared_snapshot_blobs (
    calculation_version TEXT NOT NULL,
    data_version INTEGER NOT NULL,
    basis TEXT NOT NULL,
    date TEXT NOT NULL,
    blob TEXT NOT NULL,
    value BLOB NOT NULL,
    PRIMARY KEY (calculation_version,data_version,basis,date,blob)
  ) WITHOUT ROWID
`;

function bucketFor(id) {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  return (hash >>> 0) % bucketCount;
}

function snapshotRecipe(engine, config, velocity) {
  return digest([format, velocity ? 'velocity' : 'base', config.universe.id, config.universe.version,
    config.model.id, config.model.version, config.basis, config.referenceMode, engine.definitionKey(config)]);
}

function dateScope(config) {
  return referenceArchiveScopes(config, [config.date])[0]?.config ?? config;
}

function hasTable(db) {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='prepared_snapshot_contexts'").get();
}

export function preparedSnapshotDates(db, engine, config, dates, { velocity = false } = {}) {
  const selected = new Map();
  if (!dates.length || !hasTable(db)) return selected;
  const prefix = 'calculation_version=? AND basis=? AND recipe=? AND data_version<=? AND date IN (SELECT value FROM json_each(?))';
  const candidates = db.prepare(`SELECT DISTINCT data_version FROM prepared_snapshot_contexts WHERE ${prefix}`);
  const available = db.prepare(`SELECT date,data_version FROM prepared_snapshot_contexts WHERE ${prefix} ORDER BY date,data_version DESC`);
  for (const scope of referenceArchiveScopes(config, dates)) {
    const recipe = snapshotRecipe(engine, scope.config, velocity);
    const parameters = [CALCULATION_VERSION, scope.config.basis, recipe, scope.config.dataVersion, JSON.stringify(scope.dates)];
    const versions = candidates.all(...parameters).map((row) => row.data_version);
    const bounds = reusableArchiveVersions(db, scope.config, versions);
    for (const row of available.iterate(...parameters)) {
      if (!selected.has(row.date) && usableArchiveRow(bounds, row)) selected.set(row.date, row.data_version);
    }
  }
  return selected;
}

export function hasPreparedSnapshot(db, engine, config, options) {
  return !!config.date && preparedSnapshotDates(db, engine, config, [config.date], options).has(config.date);
}

function areaKey(config, dataVersion = config.dataVersion) {
  return [CALCULATION_VERSION, dataVersion, config.basis, config.date];
}

function idForSequence(dictionary, indexes, values) {
  const name = JSON.stringify(values);
  if (!indexes.has(name)) {
    indexes.set(name, dictionary.length);
    dictionary.push(values);
  }
  return indexes.get(name);
}

function baseRows(encoded, selected) {
  if (!encoded) return new Map();
  const [names, patterns, rows] = decode(encoded);
  const desired = selected ? rows.filter(([id]) => selected.has(id)) : rows;
  return new Map(desired.map(([id, pattern, values]) => [id, new Map(patterns[pattern].map((index, column) => [names[index], values[column]]))]));
}

function encodeBase(rows) {
  const names = [];
  const patterns = [];
  const fields = new Map();
  const keysets = new Map();
  const output = [];
  for (const [id, row] of rows) {
    const indices = [];
    const values = [];
    for (const [name, value] of row) {
      if (!fields.has(name)) {
        fields.set(name, names.length);
        names.push(name);
      }
      indices.push(fields.get(name));
      values.push(value);
    }
    output.push([id, idForSequence(patterns, keysets, indices), values]);
  }
  return encode([names, patterns, output]);
}

function sameJson(left, right) {
  if (left === right) return true;
  return left != null && right != null && typeof left === 'object' && typeof right === 'object' &&
    JSON.stringify(left) === JSON.stringify(right);
}

function normalizedHeader(snapshot, config) {
  if (!snapshot || !Array.isArray(snapshot.stocks) || !config.date || snapshot.date !== config.date ||
      snapshot.dataVersion != null && snapshot.dataVersion !== config.dataVersion ||
      snapshot.basis != null && snapshot.basis !== config.basis ||
      snapshot.calculationVersion != null && snapshot.calculationVersion !== CALCULATION_VERSION ||
      snapshot.benchmark != null && snapshot.benchmark !== config.benchmark ||
      snapshot.classificationSystem != null && snapshot.classificationSystem !== config.classification ||
      snapshot.universe?.id != null && (snapshot.universe.id !== config.universe.id || snapshot.universe.version !== config.universe.version) ||
      snapshot.model?.id != null && (snapshot.model.id !== config.model.id || snapshot.model.version !== config.model.version)) {
    throw new Error('Prepared snapshot does not match the pinned calculation context');
  }
  const { stocks, ...header } = snapshot;
  return header;
}

function partitionRows(rows) {
  const buckets = Array.from({ length: bucketCount }, () => []);
  const ids = new Set();
  for (const [position, row] of rows.entries()) {
    const id = row?.securityId;
    if (typeof id !== 'string' || !id || ids.has(id)) throw new Error('Prepared stock rows require unique permanent security IDs');
    ids.add(id);
    buckets[bucketFor(id)].push(position);
  }
  return buckets;
}

export function writePreparedSnapshot(db, engine, config, snapshot, { velocity = false } = {}) {
  const scoped = dateScope(config);
  const header = normalizedHeader(snapshot, config);
  const recipe = snapshotRecipe(engine, scoped, velocity);
  const key = areaKey(scoped);
  const meta = { recipe, date: scoped.date, dataVersion: scoped.dataVersion, rows: snapshot.stocks.length };
  const grouped = partitionRows(snapshot.stocks);
  db.exec(schema);
  const check = db.prepare(`SELECT 1 FROM prepared_snapshot_contexts WHERE ${contextKey}`);
  const readBase = db.prepare(`SELECT value FROM prepared_stock_base WHERE ${baseKey} AND bucket=?`);
  const writeBase = db.prepare(`INSERT INTO prepared_stock_base VALUES (?,?,?,?,?,?)
    ON CONFLICT(calculation_version,data_version,basis,date,bucket) DO UPDATE SET value=excluded.value`);
  const writeDelta = db.prepare('INSERT INTO prepared_snapshot_deltas VALUES (?,?,?,?,?,?,?)');
  const writeLayout = db.prepare('INSERT OR IGNORE INTO prepared_snapshot_layouts VALUES (?,?,?,?,?,?)');
  const writeContext = db.prepare('INSERT INTO prepared_snapshot_contexts VALUES (?,?,?,?,?,?,?,?,?)');
  const writeBlob = db.prepare('INSERT OR IGNORE INTO prepared_snapshot_blobs VALUES (?,?,?,?,?,?)');
  function intern(value) {
    const id = createHash('sha256').update(value).digest('hex');
    return { id, bytes: writeBlob.run(...key, id, value).changes ? value.length : 0 };
  }
  const nested = db.isTransaction;
  db.exec(nested ? 'SAVEPOINT prepare_stock_snapshot' : 'BEGIN IMMEDIATE');
  try {
    if (check.get(...key, recipe)) {
      db.exec(nested ? 'RELEASE prepare_stock_snapshot' : 'COMMIT');
      return { ...meta, written: false, baseBytes: 0, deltaBytes: 0, layoutBytes: 0, contextBytes: 0 };
    }
    const order = Array(snapshot.stocks.length);
    const patterns = [];
    const patternIds = new Map();
    let deltaMask = 0;
    let baseBytes = 0;
    let deltaBytes = 0;
    for (const [bucket, positions] of grouped.entries()) {
      if (!positions.length) continue;
      const existing = readBase.get(...key, bucket)?.value;
      const rows = baseRows(existing);
      const overrides = [];
      let updated = false;
      for (const position of positions) {
        const raw = snapshot.stocks[position];
        const row = JSON.parse(JSON.stringify(raw));
        const id = raw.securityId;
        if (row?.securityId !== id || !Object.hasOwn(row, 'securityId')) throw new Error('Stock JSON changed its permanent security ID');
        const names = Object.keys(row);
        order[position] = [id, idForSequence(patterns, patternIds, names)];
        if (!rows.has(id)) rows.set(id, new Map());
        const values = rows.get(id);
        const changes = [position];
        for (const [index, name] of names.entries()) {
          if (!values.has(name)) {
            values.set(name, row[name]);
            updated = true;
          } else if (!sameJson(values.get(name), row[name])) changes.push(index, row[name]);
        }
        if (changes.length > 1) overrides.push(changes);
      }
      if (updated) {
        const blob = encodeBase(rows);
        writeBase.run(...key, bucket, blob);
        baseBytes += blob.length - (existing?.length ?? 0);
      }
      if (overrides.length) {
        const blob = intern(encode(overrides));
        writeDelta.run(...key, recipe, bucket, blob.id);
        deltaMask |= 1 << bucket;
        deltaBytes += blob.bytes;
      }
    }
    const layout = [patterns, order];
    const layoutId = digest(layout);
    const layoutBlob = encode(layout);
    const layoutBytes = writeLayout.run(...key, layoutId, layoutBlob).changes ? layoutBlob.length : 0;
    const headerBlob = intern(encode(header));
    writeContext.run(...key, recipe, layoutId, order.length, deltaMask >>> 0, headerBlob.id);
    db.exec(nested ? 'RELEASE prepare_stock_snapshot' : 'COMMIT');
    return { ...meta, written: true, baseBytes, deltaBytes, layoutBytes, contextBytes: headerBlob.bytes };
  } catch (error) {
    if (nested) db.exec('ROLLBACK TO prepare_stock_snapshot; RELEASE prepare_stock_snapshot');
    else if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

export function readPreparedSnapshot(db, engine, config, { velocity = false, securityIds } = {}) {
  if (!config.date) return null;
  const source = preparedSnapshotDates(db, engine, config, [config.date], { velocity }).get(config.date);
  if (source == null) return null;
  const scoped = dateScope(config);
  const recipe = snapshotRecipe(engine, scoped, velocity);
  const key = areaKey(scoped, source);
  const manifest = db.prepare(`SELECT layout,stock_count,delta_mask,header FROM prepared_snapshot_contexts WHERE ${contextKey}`)
    .get(...key, recipe);
  if (!manifest) return null;
  const selected = securityIds == null ? null : new Set(typeof securityIds === 'string' ? [securityIds] : securityIds);
  const readBlob = db.prepare(`SELECT value FROM prepared_snapshot_blobs WHERE ${baseKey} AND blob=?`);
  const rawHeader = readBlob.get(...key, manifest.header)?.value;
  if (!rawHeader) throw new Error('Prepared snapshot header block is missing');
  const header = decode(rawHeader);
  const provenance = source !== config.dataVersion ? { sourceDataVersion: source, requestedDataVersion: config.dataVersion } : {};
  if (selected?.size === 0 || manifest.stock_count === 0) return { ...header, stocks: [], ...provenance };
  const storedLayout = db.prepare(`SELECT value FROM prepared_snapshot_layouts WHERE ${baseKey} AND layout=?`).get(...key, manifest.layout);
  if (!storedLayout) throw new Error('Prepared snapshot layout is missing');
  const [patterns, order] = decode(storedLayout.value);
  if (order.length !== manifest.stock_count) throw new Error('Prepared snapshot row count differs from its manifest');
  const grouped = Array.from({ length: bucketCount }, () => []);
  for (const [position, [id, pattern]] of order.entries()) {
    if (!selected || selected.has(id)) grouped[bucketFor(id)].push([position, id, pattern]);
  }
  const readBase = db.prepare(`SELECT value FROM prepared_stock_base WHERE ${baseKey} AND bucket=?`);
  const readDelta = db.prepare(`SELECT blob FROM prepared_snapshot_deltas WHERE ${contextKey} AND bucket=?`);
  const recovered = [];
  for (const [bucket, positions] of grouped.entries()) {
    if (!positions.length) continue;
    const stored = readBase.get(...key, bucket)?.value;
    if (!stored) throw new Error('Prepared snapshot stock block is missing');
    const base = baseRows(stored, selected ? new Set(positions.map(([, id]) => id)) : null);
    const expectedOverrides = (manifest.delta_mask & (1 << bucket)) !== 0;
    const blob = expectedOverrides ? readDelta.get(...key, recipe, bucket)?.blob : null;
    const delta = blob ? readBlob.get(...key, blob)?.value : null;
    if (expectedOverrides && !delta) throw new Error('Prepared snapshot override block is missing');
    const overrides = new Map(delta ? decode(delta).map(([position, ...changes]) => {
      const values = new Map();
      for (let index = 0; index < changes.length; index += 2) values.set(changes[index], changes[index + 1]);
      return [position, values];
    }) : []);
    for (const [position, id, pattern] of positions) {
      const row = base.get(id);
      const fields = patterns[pattern];
      if (!row || !fields || fields.some((name) => !row.has(name))) throw new Error('Prepared snapshot stock fields are missing');
      const changes = overrides.get(position);
      recovered[position] = Object.fromEntries(fields.map((name, index) =>
        [name, changes?.has(index) ? changes.get(index) : row.get(name)]));
    }
  }
  return { ...header, ...provenance, stocks: recovered.filter(Boolean) };
}
