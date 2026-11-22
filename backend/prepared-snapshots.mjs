import { createHash } from 'node:crypto';
import { referenceArchiveScopes, reusableArchiveVersions, usableArchiveRow } from './archive-lineage.mjs';
import { CALCULATION_VERSION } from './database.mjs';
import { stockBaseFields } from './engine.mjs';
import { encodeStockFrame, readStockFrame } from './snapshot-frame.mjs';
import { compressStoredJson, decodeStoredJson as decode, encodeStoredJson } from './storage-codec.mjs';

const format = 'prepared-stock-2';
const frameFormat = 'typed-stock-2';
const legacyFrameFormat = 'typed-stock-1';
const bucketCount = 32;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS prepared_snapshot_frames (
    calculation_version TEXT NOT NULL,
    data_version INTEGER NOT NULL,
    basis TEXT NOT NULL,
    date TEXT NOT NULL,
    frame TEXT NOT NULL,
    bucket INTEGER NOT NULL,
    value BLOB NOT NULL,
    PRIMARY KEY (calculation_version,data_version,basis,date,frame,bucket)
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

export function readPreparedSnapshotRankWitnesses(db, engine, config, dates, cache = new Map()) {
  const witnesses = new Map();
  const selected = preparedSnapshotDates(db, engine, config, dates);
  if (!selected.size) return witnesses;
  const layout = db.prepare(`SELECT l.value FROM prepared_snapshot_contexts AS c
    JOIN prepared_snapshot_layouts AS l USING (calculation_version,data_version,basis,date,layout)
    WHERE c.calculation_version=? AND c.data_version=? AND c.basis=? AND c.date=? AND c.recipe=?`);
  const blob = db.prepare(`SELECT value FROM prepared_snapshot_blobs WHERE ${baseKey} AND blob=?`);
  for (const scope of referenceArchiveScopes(config, dates)) {
    const recipe = snapshotRecipe(engine, scope.config, false);
    for (const date of scope.dates) {
      const version = selected.get(date);
      if (version == null) continue;
      const key = areaKey({ ...scope.config, date }, version);
      const value = layout.get(...key, recipe)?.value;
      if (!value) throw new Error('Prepared rank witness has no stock layout');
      const stored = decode(value);
      const id = typeof stored[0] === 'string' ? stored[3] : stored[2];
      if (!id) continue;
      const scopeKey = `${key.join('\0')}\0${id}`;
      if (!cache.has(scopeKey)) {
        const payload = blob.get(...key, id)?.value;
        if (!payload) throw new Error('Prepared stock rank witness block is missing');
        const witness = decode(payload);
        if (createHash('sha256').update('json:').update(JSON.stringify(witness)).digest('hex') !== id) {
          throw new Error('Prepared stock rank witness checksum differs from its manifest');
        }
        cache.set(scopeKey, witness);
      }
      witnesses.set(date, cache.get(scopeKey));
    }
  }
  return witnesses;
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

function encodeBase(rows, codec) {
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
  return encodeStoredJson([names, patterns, output], codec);
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

function partitionRows(rows, knownBuckets) {
  const buckets = Array.from({ length: bucketCount }, () => []);
  const ids = new Set();
  for (const [position, row] of rows.entries()) {
    const id = row?.securityId;
    if (typeof id !== 'string' || !id || ids.has(id)) throw new Error('Prepared stock rows require unique permanent security IDs');
    ids.add(id);
    if (!knownBuckets.has(id)) knownBuckets.set(id, bucketFor(id));
    buckets[knownBuckets.get(id)].push(position);
  }
  return buckets;
}

function stockShape(raw, { base, baseAfter, parent, additions, velocity } = {}) {
  const overrides = base ? Object.entries(parent || velocity ? { ...parent, ...velocity, ...raw } : raw) : null;
  const ordered = base && additions?.order.length ? Object.fromEntries(stockBaseFields(Object.keys(base), additions)
    .map((key) => [key, Object.hasOwn(additions.values, key) ? additions.values[key] : base[key]])) : base;
  const input = base ? { ...Object.fromEntries(overrides.slice(0, baseAfter)), ...ordered, ...Object.fromEntries(overrides.slice(baseAfter)) } : raw;
  const row = JSON.parse(JSON.stringify(input));
  if (row?.securityId !== raw.securityId || !Object.hasOwn(row, 'securityId')) {
    throw new Error('Stock JSON changed its permanent security ID');
  }
  return { names: Object.keys(row), row };
}

function jsonField(value, name) {
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (value && typeof value.toJSON === 'function') return value.toJSON(name) ?? null;
  return value;
}

function ordinaryJsonField(value) {
  return value !== undefined && typeof value !== 'function' && typeof value !== 'symbol' && typeof value?.toJSON !== 'function';
}

function writeSparseProjection(raw, parts, values, normalized, baseShapes, projected, plan, position, extend) {
  const { base, baseAfter = 0 } = parts;
  if (!base) return null;
  const parent = parts.parent && projected.get(parts.parent);
  if (parent) {
    const names = Object.keys(raw);
    let extensions = plan.extensions.get(parent.names);
    if (!extensions) plan.extensions.set(parent.names, extensions = new Map());
    const policy = JSON.stringify(names);
    let pattern = extensions.get(policy);
    if (pattern == null) {
      if (names.some((name) => parent.names.includes(name) || /^\d+$/.test(name))) return null;
      pattern = idForSequence(plan.patterns, plan.patternIds, [...parent.names, ...names]);
      extensions.set(policy, pattern);
    }
    if (names.some((name) => !ordinaryJsonField(raw[name]))) return null;
    plan.order[position] = [raw.securityId, pattern];
    const changes = parent.changes.slice();
    changes[0] = position;
    for (const [index, name] of names.entries()) {
      const value = jsonField(raw[name], name);
      if (!values.has(name)) {
        values.set(name, value);
        extend();
      } else if (!sameJson(values.get(name), value)) changes.push(parent.names.length + index, value);
    }
    return { changes };
  }
  let shared = normalized.get(base);
  if (!shared || shared.values !== values) {
    const baseNames = Object.keys(base);
    const definition = JSON.stringify(baseNames);
    if (!baseShapes.has(definition)) baseShapes.set(definition, baseNames.some((name) => /^\d+$/.test(name)) ? -1 : baseShapes.size);
    const pattern = baseShapes.get(definition);
    if (pattern < 0 || baseNames.some((name) => !ordinaryJsonField(base[name]))) return null;
    const differences = [];
    for (const [index, name] of baseNames.entries()) {
      const value = jsonField(base[name], name);
      if (!values.has(name)) {
        values.set(name, value);
        extend();
      } else if (!sameJson(values.get(name), value)) differences.push(index, value);
    }
    shared = { names: baseNames, pattern, differences, values };
    normalized.set(base, shared);
  }
  const overlay = parts.parent ? { ...parts.parent, ...raw } : raw;
  const overrideNames = Object.keys(overlay);
  if (overrideNames.some((name) => !ordinaryJsonField(raw[name]))) return null;
  const policy = `${shared.pattern}:${baseAfter}:${JSON.stringify(overrideNames)}`;
  let shape = plan.shapes.get(policy);
  if (!shape) {
    if (overrideNames.some((name) => /^\d+$/.test(name))) return null;
    const names = [...new Set([...overrideNames.slice(0, baseAfter), ...shared.names, ...overrideNames.slice(baseAfter)])];
    const indices = new Map(names.map((name, index) => [name, index]));
    const overlay = new Set(overrideNames);
    shape = { pattern: idForSequence(plan.patterns, plan.patternIds, names),
      baseIndices: shared.names.map((name) => overlay.has(name) ? -1 : indices.get(name)),
      overrideIndices: overrideNames.map((name) => indices.get(name)) };
    plan.shapes.set(policy, shape);
  }
  plan.order[position] = [raw.securityId, shape.pattern];
  const changes = [position];
  for (let index = 0; index < shared.differences.length; index += 2) {
    const column = shape.baseIndices[shared.differences[index]];
    if (column >= 0) changes.push(column, shared.differences[index + 1]);
  }
  for (const [index, name] of overrideNames.entries()) {
    const value = jsonField(raw[name], name);
    if (!values.has(name)) {
      values.set(name, value);
      extend();
    } else if (!sameJson(values.get(name), value)) changes.push(shape.overrideIndices[index], value);
  }
  if (!parts.parent) projected.set(raw, { names: plan.patterns[shape.pattern], changes });
  return { changes };
}

function poolDeltas(projections) {
  const columns = [];
  const dictionary = new Map();
  const recipes = [];
  for (const [plan, rows] of projections) {
    const fields = new Map();
    for (const row of rows) {
      const position = row[0];
      const names = plan.patterns[plan.order[position][1]];
      for (let index = 1; index < row.length; index += 2) {
        const name = names[row[index]];
        if (!fields.has(name)) fields.set(name, []);
        fields.get(name).push(position, row[index + 1]);
      }
    }
    const mapping = [];
    for (const [name, values] of fields) {
      const json = JSON.stringify(values);
      if (!dictionary.has(json)) {
        dictionary.set(json, columns.length);
        columns.push(json);
      }
      mapping.push([name, dictionary.get(json)]);
    }
    recipes.push([plan.meta.recipe, mapping]);
  }
  return `{"format":"column-pool-1","columns":[${columns.join(',')}],"recipes":${JSON.stringify(recipes)}}`;
}

function writeTypedFrames(db, key, plans, codec) {
  const id = digest([frameFormat, plans.map(({ meta }) => meta.recipe)]);
  const write = db.prepare('INSERT INTO prepared_snapshot_frames VALUES (?,?,?,?,?,?,?)');
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const slices = [];
    for (const [index, plan] of plans.entries()) {
      const positions = plan.buckets[bucket];
      if (!positions.length) continue;
      plan.deltaMask |= 1 << bucket;
      slices.push({ positions, index, parts(position) {
        const raw = plan.snapshot.stocks[position];
        const shape = plan.stockRows?.[position];
        const own = shape?.overrides ?? raw;
        if (shape?.baseAfter === 0 && shape.base?.securityId === raw.securityId && typeof shape.base.toJSON !== 'function' &&
            typeof own.toJSON !== 'function' && typeof shape.parent?.toJSON !== 'function') {
          return [shape.base, shape.additions, shape.parent, shape.velocity, own];
        }
        return [null, null, null, null, stockShape(own, shape).row];
      } });
    }
    if (!slices.length) continue;
    const value = encodeStockFrame(slices, { codec });
    write.run(...key, id, bucket, value);
    plans[0].meta.baseBytes += value.length;
  }
  for (const [index, plan] of plans.entries()) plan.frameLayout = [frameFormat, id, index];
}

function groupMemberDictionary(plans) {
  const arrays = [];
  const ids = new Map();
  const byArray = new WeakMap();
  const projections = new WeakMap();
  for (const plan of plans) {
    const groups = plan.header.groups;
    if (!Array.isArray(groups) || typeof groups.toJSON === 'function' || typeof plan.header.toJSON === 'function' ||
        groups.some((group) => typeof group?.toJSON === 'function')) continue;
    if (!projections.has(groups)) {
      let changed = false;
      const value = groups.map((group) => {
        const members = group?.memberIds;
        if (!group || Array.isArray(group) || !Object.hasOwn(group, 'memberIds') || !Array.isArray(members) || members.length < 2 ||
            typeof members.toJSON === 'function') return [group, null];
        if (!byArray.has(members)) {
          const serialized = members.every((member) => typeof member === 'string') ? JSON.stringify(members) : null;
          if (serialized && !ids.has(serialized)) {
            ids.set(serialized, arrays.length);
            arrays.push(members);
          }
          byArray.set(members, serialized ? ids.get(serialized) : null);
        }
        const index = byArray.get(members);
        if (index == null) return [group, null];
        changed = true;
        return [{ ...group, memberIds: null }, index];
      });
      projections.set(groups, changed ? value : null);
    }
    plan.groupProjection = projections.get(groups);
  }
  return arrays;
}

export function writePreparedSnapshot(db, engine, config, snapshot, options = {}) {
  const { velocity, codec } = options;
  return writePreparedSnapshotBatch(db, engine, [{ config, snapshot, velocity }], { codec })[0];
}

// An area belongs to one trading date and warehouse revision. A bucket is read and
// compressed once even when many context variants contribute fields on that date.
export function writePreparedSnapshotBatch(db, engine, entries, { codec } = {}) {
  if (!entries.length) return [];
  const key = areaKey(entries[0].config);
  const memberships = new WeakMap();
  const knownBuckets = new Map();
  const plans = entries.map(({ config, snapshot, velocity = false, stockRows, membership = snapshot.stocks, rankWitness = false }) => {
    const scoped = dateScope(config);
    if (areaKey(scoped).some((value, index) => value !== key[index])) {
      throw new Error('Prepared snapshot batch must share one date, basis, and warehouse version');
    }
    const header = normalizedHeader(snapshot, config);
    const recipe = snapshotRecipe(engine, scoped, velocity);
    const meta = { recipe, date: scoped.date, dataVersion: scoped.dataVersion, rows: snapshot.stocks.length,
      written: false, baseBytes: 0, deltaBytes: 0, layoutBytes: 0, contextBytes: 0 };
    if (membership.length !== meta.rows) throw new Error('Prepared membership has a mismatched row count');
    if (!memberships.has(membership)) memberships.set(membership, partitionRows(membership, knownBuckets));
    return { snapshot, stockRows, header, meta, membership, rankWitness, buckets: memberships.get(membership), order: Array(meta.rows),
      patterns: [], patternIds: new Map(), shapes: new Map(), extensions: new Map(), deltaMask: 0 };
  });
  db.exec(schema);
  const check = db.prepare(`SELECT 1 FROM prepared_snapshot_contexts WHERE ${contextKey}`);
  const readBase = db.prepare(`SELECT value FROM prepared_stock_base WHERE ${baseKey} AND bucket=?`);
  const writeBase = db.prepare(`INSERT INTO prepared_stock_base VALUES (?,?,?,?,?,?)
    ON CONFLICT(calculation_version,data_version,basis,date,bucket) DO UPDATE SET value=excluded.value`);
  const writeDelta = db.prepare('INSERT INTO prepared_snapshot_deltas VALUES (?,?,?,?,?,?,?)');
  const checkLayout = db.prepare(`SELECT 1 FROM prepared_snapshot_layouts WHERE ${baseKey} AND layout=?`);
  const writeLayout = db.prepare('INSERT INTO prepared_snapshot_layouts VALUES (?,?,?,?,?,?)');
  const writeContext = db.prepare('INSERT INTO prepared_snapshot_contexts VALUES (?,?,?,?,?,?,?,?,?)');
  const checkBlob = db.prepare(`SELECT 1 FROM prepared_snapshot_blobs WHERE ${baseKey} AND blob=?`);
  const writeBlob = db.prepare('INSERT INTO prepared_snapshot_blobs VALUES (?,?,?,?,?,?)');
  function internJson(json) {
    const id = createHash('sha256').update('json:').update(json).digest('hex');
    if (checkBlob.get(...key, id)) return { id, bytes: 0 };
    const encoded = compressStoredJson(json, codec);
    writeBlob.run(...key, id, encoded);
    return { id, bytes: encoded.length };
  }
  const intern = (value) => internJson(JSON.stringify(value));
  const nested = db.isTransaction;
  db.exec(nested ? 'SAVEPOINT prepare_stock_snapshot' : 'BEGIN IMMEDIATE');
  try {
    const claimed = new Set();
    const pending = plans.filter(({ meta }) => {
      if (claimed.has(meta.recipe) || check.get(...key, meta.recipe)) return false;
      claimed.add(meta.recipe);
      return true;
    });
    const typed = pending.some(({ stockRows }) => stockRows?.[0]?.baseAfter === 0 && stockRows[0].base?.securityId);
    if (typed) writeTypedFrames(db, key, pending, codec);
    const baseShapes = new Map();
    for (let bucket = 0; !typed && bucket < bucketCount; bucket++) {
      const active = pending.filter((plan) => plan.buckets[bucket].length);
      if (!active.length) continue;
      const existing = readBase.get(...key, bucket)?.value;
      const rows = baseRows(existing);
      const sparse = new WeakMap();
      const projected = new WeakMap();
      const projections = [];
      let lastExtension = null;
      for (const plan of active) {
        const overrides = [];
        const extend = () => { lastExtension = plan; };
        for (const position of plan.buckets[bucket]) {
          const raw = plan.snapshot.stocks[position];
          const id = raw.securityId;
          if (!rows.has(id)) rows.set(id, new Map());
          const values = rows.get(id);
          const parts = plan.stockRows?.[position];
          const own = parts?.overrides ?? raw;
          if (parts && !parts.additions && !parts.velocity) {
            const projection = writeSparseProjection(own, parts, values, sparse, baseShapes, projected, plan, position, extend);
            if (projection) {
              const { changes } = projection;
              if (changes.length > 1) overrides.push(changes);
              continue;
            }
          }
          const { names, row } = stockShape(own, parts);
          plan.order[position] = [id, idForSequence(plan.patterns, plan.patternIds, names)];
          const changes = [position];
          for (let index = 0; index < names.length; index++) {
            const name = names[index];
            const value = row[name];
            if (!values.has(name)) {
              values.set(name, value);
              lastExtension = plan;
            } else if (!sameJson(values.get(name), value)) changes.push(index, value);
          }
          if (changes.length > 1) overrides.push(changes);
        }
        if (overrides.length) projections.push([plan, overrides]);
      }
      if (projections.length) {
        const blob = projections.length > 1 ? internJson(poolDeltas(projections)) : intern(projections[0][1]);
        for (const [plan] of projections) {
          writeDelta.run(...key, plan.meta.recipe, bucket, blob.id);
          plan.deltaMask |= 1 << bucket;
        }
        projections[0][0].meta.deltaBytes += blob.bytes;
      }
      if (lastExtension) {
        const blob = encodeBase(rows, codec);
        writeBase.run(...key, bucket, blob);
        lastExtension.meta.baseBytes += blob.length - (existing?.length ?? 0);
      }
    }
    const memberArrays = groupMemberDictionary(pending);
    const members = memberArrays.length ? intern(memberArrays) : null;
    const rankWitnesses = new WeakMap();
    for (const [position, plan] of pending.entries()) {
      let witness;
      if (plan.rankWitness) {
        if (!rankWitnesses.has(plan.membership)) {
          const buckets = plan.buckets.flatMap((positions, bucket) => {
            const ids = positions.flatMap((index) => {
              const row = plan.membership[index];
              return row.traded ? [row.securityId] : [];
            });
            return ids.length ? [[bucket, ids.length, digest(ids)]] : [];
          });
          rankWitnesses.set(plan.membership, intern(buckets));
        }
        witness = rankWitnesses.get(plan.membership);
      }
      const layout = JSON.stringify([...(plan.frameLayout ?? [plan.patterns, plan.order]), ...(witness ? [witness.id] : [])]);
      const layoutId = createHash('sha256').update(layout).digest('hex');
      if (!checkLayout.get(...key, layoutId)) {
        const encoded = compressStoredJson(layout, codec);
        writeLayout.run(...key, layoutId, encoded);
        plan.meta.layoutBytes = encoded.length;
      }
      const shouldSplit = Array.isArray(plan.header.groups) && (plan.groupProjection || plan.header.groups.length > 30) &&
        typeof plan.header.groups.toJSON !== 'function' && typeof plan.header.toJSON !== 'function';
      const groups = shouldSplit ? intern(plan.groupProjection ?? plan.header.groups) : null;
      const scalar = groups ? JSON.parse(JSON.stringify({ ...plan.header, groups: null })) : plan.header;
      const header = intern(groups ? [plan.groupProjection ? 'prepared-header-2' : 'prepared-header-1', Object.entries(scalar).map(([name, value]) =>
        name === 'groups' ? [name, null, groups.id] : [name, value]), ...(plan.groupProjection ? [members.id] : [])] : scalar);
      writeContext.run(...key, plan.meta.recipe, layoutId, plan.order.length, plan.deltaMask >>> 0, header.id);
      plan.meta.contextBytes = header.bytes + (groups?.bytes ?? 0) + (position === 0 ? members?.bytes ?? 0 : 0);
      if (witness) {
        plan.meta.contextBytes += witness.bytes;
        witness.bytes = 0;
      }
      plan.meta.written = true;
    }
    db.exec(nested ? 'RELEASE prepare_stock_snapshot' : 'COMMIT');
    return plans.map(({ meta }) => meta);
  } catch (error) {
    if (nested) db.exec('ROLLBACK TO prepare_stock_snapshot; RELEASE prepare_stock_snapshot');
    else if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

export function readPreparedSnapshot(db, engine, config, { velocity = false, securityIds, stockFields } = {}) {
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
  const fieldsRequested = stockFields == null ? null : new Set(['securityId', ...stockFields]);
  const readBlob = db.prepare(`SELECT value FROM prepared_snapshot_blobs WHERE ${baseKey} AND blob=?`);
  const rawHeader = readBlob.get(...key, manifest.header)?.value;
  if (!rawHeader) throw new Error('Prepared snapshot header block is missing');
  const savedHeader = decode(rawHeader);
  const dictionaryHeader = Array.isArray(savedHeader) && savedHeader[0] === 'prepared-header-2';
  const header = dictionaryHeader || Array.isArray(savedHeader) && savedHeader[0] === 'prepared-header-1' ? Object.fromEntries(
    savedHeader[1].map(([name, value, blob]) => {
      if (!blob) return [name, value];
      const stored = readBlob.get(...key, blob)?.value;
      if (!stored) throw new Error('Prepared snapshot header component is missing');
      const component = decode(stored);
      if (!dictionaryHeader || name !== 'groups') return [name, component];
      const dictionary = readBlob.get(...key, savedHeader[2])?.value;
      if (!dictionary) throw new Error('Prepared snapshot group membership dictionary is missing');
      const memberships = decode(dictionary);
      return [name, component.map(([group, index]) => {
        if (index == null) return group;
        if (!Array.isArray(memberships[index])) throw new Error('Prepared snapshot group membership is missing');
        return { ...group, memberIds: memberships[index].slice() };
      })];
    })) : savedHeader;
  const provenance = source !== config.dataVersion ? { sourceDataVersion: source, requestedDataVersion: config.dataVersion } : {};
  if (selected?.size === 0 || manifest.stock_count === 0) return { ...header, stocks: [], ...provenance };
  const storedLayout = db.prepare(`SELECT value FROM prepared_snapshot_layouts WHERE ${baseKey} AND layout=?`).get(...key, manifest.layout);
  if (!storedLayout) throw new Error('Prepared snapshot layout is missing');
  const layout = decode(storedLayout.value);
  if (layout[0] === frameFormat || layout[0] === legacyFrameFormat) {
    const [, frame, index] = layout;
    const chosenBuckets = selected ? [...new Set([...selected].map(bucketFor))] : Array.from({ length: bucketCount }, (_, bucket) => bucket);
    const read = db.prepare(`SELECT value FROM prepared_snapshot_frames WHERE ${baseKey} AND frame=? AND bucket=?`);
    const ordered = Array(manifest.stock_count);
    for (const bucket of chosenBuckets) {
      if (!(manifest.delta_mask & (1 << bucket))) continue;
      const value = read.get(...key, frame, bucket)?.value;
      if (!value) throw new Error('Prepared stock frame block is missing');
      for (const [position, row] of readStockFrame(value, index, selected, fieldsRequested)) {
        if (position >= ordered.length || ordered[position]) throw new Error('Invalid prepared stock frame ordering');
        ordered[position] = row;
      }
    }
    const stocks = ordered.filter(Boolean);
    if (!selected && stocks.length !== manifest.stock_count) throw new Error('Prepared snapshot row count differs from its manifest');
    return { ...header, ...provenance, stocks };
  }
  const [patterns, order] = layout;
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
    const overrides = new Map();
    const wantedPositions = selected ? new Set(positions.map(([position]) => position)) : null;
    let keyedByField = false;
    function apply(rows) {
      for (const [position, ...changes] of rows) {
        if (!overrides.has(position)) overrides.set(position, new Map());
        const values = overrides.get(position);
        for (let index = 0; index < changes.length; index += 2) values.set(changes[index], changes[index + 1]);
      }
    }
    if (delta) {
      const projection = decode(delta);
      if (Array.isArray(projection)) apply(projection);
      else if (projection.format === 'column-pool-1') {
        keyedByField = true;
        const recipeFields = projection.recipes.find(([name]) => name === recipe)?.[1];
        if (!recipeFields) throw new Error('Prepared snapshot column projection is missing');
        for (const [name, column] of recipeFields) {
          const values = projection.columns[column];
          if (!Array.isArray(values)) throw new Error('Prepared snapshot override column is missing');
          for (let index = 0; index < values.length; index += 2) {
            const position = values[index];
            if (wantedPositions && !wantedPositions.has(position)) continue;
            if (!overrides.has(position)) overrides.set(position, new Map());
            overrides.get(position).set(name, values[index + 1]);
          }
        }
      } else throw new Error('Unsupported prepared snapshot override format');
    }
    for (const [position, id, pattern] of positions) {
      const row = base.get(id);
      const fields = patterns[pattern];
      if (!row || !fields || fields.some((name) => !row.has(name))) throw new Error('Prepared snapshot stock fields are missing');
      const changes = overrides.get(position);
      recovered[position] = Object.fromEntries(fields.flatMap((name, index) => {
        if (fieldsRequested && !fieldsRequested.has(name)) return [];
        const column = keyedByField ? name : index;
        return [[name, changes?.has(column) ? changes.get(column) : row.get(name)]];
      }));
    }
  }
  return { ...header, ...provenance, stocks: recovered.filter(Boolean) };
}
