import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, realpathSync, statfsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { dataVersion } from './database.mjs';
import { decodeStoredJson, encodeStoredJson } from './storage-codec.mjs';

export const preparationPublicationFormat = 'market-preparation-publication-1';
const axes = 'calculation_version:T data_version:I basis:T date:T';
const axesKey = 'calculation_version data_version basis date';
const instrument = 'calculation_version:T basis:T security_id:T data_version:I anchor_date:T';
const instrumentKey = 'calculation_version basis security_id data_version anchor_date';
const compact = 'recipe:T data_version:I date:T';
const compactKey = 'recipe data_version date';
const specs = [];

function allow(name, fields, primary, { staged = false, index, rowid = false } = {}) {
  const types = { T: 'TEXT', I: 'INTEGER', B: 'BLOB', R: 'REAL' };
  const keys = primary.split(' ');
  const columns = fields.split(' ').map((field) => {
    const [column, descriptor] = field.split(':');
    const pk = keys.indexOf(column) + 1;
    return { name: column, type: types[descriptor[0]], notnull: Number(!descriptor.includes('?')),
      pk, dflt_value: descriptor.includes('=') ? descriptor.split('=')[1] : null };
  });
  const names = columns.map(({ name }) => name);
  const definitions = columns.map(({ name, type, notnull, dflt_value }) =>
    `${name} ${type}${notnull ? ' NOT NULL' : ''}${dflt_value == null ? '' : ` DEFAULT ${dflt_value}`}`);
  specs.push({ name, columns, names, keys, staged, index, create: `CREATE TABLE IF NOT EXISTS ${name} (
    ${definitions.join(',')}, PRIMARY KEY(${keys.join(',')}))${rowid ? '' : ' WITHOUT ROWID'}` });
}

// Consume dependent directory entries before their content blocks so unaffected
// products remaining in the scratch archive still resolve their dependencies.
allow('prepared_snapshot_contexts', `${axes} recipe:T layout:T stock_count:I delta_mask:I header:T`, `${axesKey} recipe`, {
  index: 'CREATE INDEX IF NOT EXISTS prepared_snapshot_context_history ON prepared_snapshot_contexts(calculation_version,basis,recipe,date,data_version)',
});
allow('prepared_snapshot_layouts', `${axes} layout:T value:B`, `${axesKey} layout`);
allow('prepared_snapshot_deltas', `${axes} recipe:T bucket:I blob:T`, `${axesKey} recipe bucket`);
allow('prepared_snapshot_frames', `${axes} frame:T bucket:I value:B`, `${axesKey} frame bucket`);
allow('prepared_stock_base', `${axes} bucket:I value:B`, `${axesKey} bucket`);
allow('prepared_snapshot_blobs', `${axes} blob:T value:B`, `${axesKey} blob`);
allow('snapshots', 'kind:T date:T universe:T model:T data_version:I calculation_version:T definition_key:T value:T created_at:T',
  'kind date universe model data_version calculation_version definition_key', { rowid: true });
allow('prepared_rank_dates', compact, compactKey);
allow('prepared_rank_blocks', `${compact} bucket:I value:B`, `${compactKey} bucket`);
allow('rank_archive_dates', 'recipe:T date:T data_version:I calculation_version:T observations:I created_at:T', 'recipe data_version calculation_version date');
allow('stock_rank_history', 'recipe:T date:T data_version:I calculation_version:T security_id:T symbol:T rank:I? percentile:R? score:R?',
  'recipe data_version calculation_version date security_id', {
    index: 'CREATE INDEX IF NOT EXISTS stock_rank_by_security ON stock_rank_history(recipe,data_version,calculation_version,security_id,date)',
  });
allow('market_history', 'universe:T model:T data_version:I calculation_version:T definition_key:T date:T value:T created_at:T',
  'universe model data_version calculation_version definition_key date');
allow('market_history_group_blocks', `${axes} blob:T value:B`, `${axesKey} blob`);
allow('prepared_detail_products', `${instrument} header:B blocks:B`, instrumentKey);
allow('prepared_detail_risk', `${instrument} benchmark:T value:B`, `${instrumentKey} benchmark`);
allow('prepared_detail_batches', 'id:T cursor:T? processed:I=0 total:I written:I=0 complete:I=0', 'id');
allow('prepared_detail_blocks', 'hash:T value:B', 'hash');
allow('prepared_range_metrics', `${compact} lookback:I value:B`, `${compactKey} lookback`);
allow('prepared_range_history_runs',
  'id:T recipe:T data_version:I end_date:T starts:T cursor:T? processed:I=0 total:I written:I=0 basis_exclusions:I=0 complete:I=0',
  'id', { staged: true, index: 'CREATE INDEX IF NOT EXISTS prepared_range_history_lookup ON prepared_range_history_runs(recipe,complete,data_version,end_date)' });
allow('prepared_range_history_blocks', 'run_id:T date:T lookback:I bucket:I value:B', 'run_id date lookback bucket');
allow('prepared_risk_history_runs',
  'id:T format:T calculation_version:T basis:T data_version:I anchor_date:T first_date:T last_date:T dates:T windows:T benchmarks:T total:I cursor:T? processed:I=0 blocks:I=0 risk_keys:I=0 basis_exclusions:I=0 commits:I=0 complete:I=0',
  'id', { staged: true, index: 'CREATE INDEX IF NOT EXISTS prepared_risk_history_scope ON prepared_risk_history_runs(format,calculation_version,basis,complete,data_version,first_date,last_date)' });
allow('prepared_risk_history_blocks', 'run_id:T security_id:T benchmark:T safe_from:T? value:B', 'run_id security_id benchmark');
allow('prepared_health', 'recipe:T data_version:I calculation_version:T date:T payload:B', 'recipe data_version calculation_version date');
allow('divergence_events', 'recipe:T data_version:I calculation_version:T date:T event:T observed_at:T payload:T', 'recipe data_version calculation_version date event');
allow('prepared_nyse_summation', `${compact} value:T`, compactKey);

const analysisTables = new Map(specs.map((spec) => [spec.name, spec]));
const excludedMetadata = new Set(['meta', 'securities', 'identifiers', 'ingestion_runs', 'workspace', 'accepted_preparation_shard_dates', 'sqlite_stat1', 'sqlite_stat4']);
const tables = (db) => db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(({ name }) => name);
const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keyOf = (spec, row) => spec.keys.map((key) => row[key]);
const listOf = (spec, row) => spec.names.map((name) => row[name]);
const quoted = (identifier) => `"${identifier.replaceAll('"', '""')}"`;
const equal = (left, right) => left === right || ArrayBuffer.isView(left) && ArrayBuffer.isView(right)
  && Buffer.from(left.buffer, left.byteOffset, left.byteLength).equals(Buffer.from(right.buffer, right.byteOffset, right.byteLength));
const synced = (db) => db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL');
const defaultReserve = 1024 ** 3;

const journal = `
  CREATE TABLE IF NOT EXISTS preparation_publications (
    id TEXT PRIMARY KEY, source_inode TEXT NOT NULL, manifest TEXT NOT NULL, plan_hash TEXT NOT NULL,
    state TEXT NOT NULL, updated_at TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS preparation_publication_partitions (
    publication TEXT NOT NULL, ordinal INTEGER NOT NULL, table_name TEXT NOT NULL,
    first_key TEXT NOT NULL, last_key TEXT NOT NULL, keys BLOB NOT NULL, count INTEGER NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
    state TEXT NOT NULL, staged BLOB, PRIMARY KEY(publication,ordinal)
  ) WITHOUT ROWID
`;

function requireSchema(db, spec) {
  const actual = db.prepare(`PRAGMA table_info(${spec.name})`).all()
    .map(({ name, type, notnull, pk, dflt_value }) => ({ name, type, notnull, pk, dflt_value }));
  if (JSON.stringify(actual) !== JSON.stringify(spec.columns)) throw new Error(`Unknown schema for ${spec.name}`);
}

function fileIdentity(path) {
  const info = lstatSync(path, { bigint: true });
  if (!info.isFile() || info.nlink !== 1n || realpathSync(path) !== path) throw new Error('Use regular, non-symlink warehouse files');
  return { inode: `${info.dev}:${info.ino}`, size: Number(info.size), modified: info.mtimeNs };
}

function verifyInputs(options) {
  const { manifest, dataVersion, calculationVersion, activeCalculationVersion } = options;
  if (manifest?.format !== preparationPublicationFormat || manifest.accepted !== true ||
    manifest.dataVersion !== dataVersion || manifest.calculationVersion !== calculationVersion ||
    !Number.isSafeInteger(dataVersion) || dataVersion < 1 || !/^2-[a-f0-9]{12}$/.test(calculationVersion) ||
    !Number.isSafeInteger(manifest.archive?.bytes) || manifest.archive.bytes <= 0 || !/^[a-f0-9]{64}$/.test(manifest.archive?.sha256 || '') ||
    !Number.isSafeInteger(manifest.verification?.sessions) || manifest.verification.sessions < 1 ||
    !Number.isSafeInteger(manifest.verification?.contexts) || manifest.verification.contexts < 1) {
    throw new Error('An explicitly accepted full-run manifest and exact source pin are required');
  }
  if (!/^2-[a-f0-9]{12}$/.test(activeCalculationVersion || '') || activeCalculationVersion === calculationVersion) {
    throw new Error('The active app must use a different calculation version until publication and release cutover');
  }
}

async function verifyFile(file, archive, signal) {
  const before = fileIdentity(file);
  if (before.size !== archive.bytes || existsSync(`${file}-wal`) && statSync(`${file}-wal`).size > 0) {
    throw new Error('Source archive must match the sealed checkpointed file');
  }
  const checksum = createHash('sha256');
  for await (const buffer of createReadStream(file, { signal })) checksum.update(buffer);
  if (checksum.digest('hex') !== archive.sha256) throw new Error('Source archive SHA-256 differs from the accepted run');
  const after = fileIdentity(file);
  if (after.modified !== before.modified || after.inode !== before.inode || after.size !== before.size) {
    throw new Error('Source changed during archive checksum verification');
  }
}

function verifyLineage(source, target, version) {
  const pin = (db) => db.prepare(`SELECT id,version,fingerprint FROM ingestion_runs
    WHERE version=? AND status='complete' ORDER BY id`).all(version);
  const left = pin(source);
  if (!left.length || !left.every(({ fingerprint }) => typeof fingerprint === 'string' && fingerprint.length > 0) ||
    JSON.stringify(left) !== JSON.stringify(pin(target)) || dataVersion(target) !== version) {
    throw new Error('Archive and destination must have identical pinned source lineage and data revision');
  }
}

function validateArchive(source, target, expected) {
  if (source.prepare('PRAGMA auto_vacuum').get().auto_vacuum !== 2) throw new Error('Source archive must use INCREMENTAL auto-vacuum');
  for (const table of tables(source)) {
    const spec = analysisTables.get(table);
    if (spec) {
      requireSchema(source, spec);
      if (hasTable(target, table)) requireSchema(target, spec);
      const clauses = [];
      const values = [];
      if (spec.names.includes('data_version')) { clauses.push('data_version<>?'); values.push(expected.dataVersion); }
      if (spec.names.includes('calculation_version')) { clauses.push('calculation_version<>?'); values.push(expected.calculationVersion); }
      if (clauses.length && source.prepare(`SELECT 1 FROM ${table} WHERE ${clauses.join(' OR ')} LIMIT 1`).get(...values)) {
        throw new Error(`Archive contains a different data or calculation version in ${table}`);
      }
    } else if (!excludedMetadata.has(table) && source.prepare(`SELECT 1 FROM ${quoted(table)} LIMIT 1`).get()) {
      throw new Error(`Archive contains an unsupported or raw table with rows: ${table}`);
    }
  }
  for (const table of ['prepared_detail_batches', 'prepared_risk_history_runs', 'prepared_range_history_runs']) {
    if (hasTable(source, table) && source.prepare(`SELECT 1 FROM ${table} WHERE complete<>1 LIMIT 1`).get()) {
      throw new Error(`Archive contains unfinished ${table} manifests`);
    }
  }
  for (const kind of ['risk', 'range']) {
    const runs = `prepared_${kind}_history_runs`;
    const blocks = `prepared_${kind}_history_blocks`;
    const count = kind === 'risk' ? 'blocks' : 'written';
    if (!hasTable(source, runs) && !hasTable(source, blocks)) continue;
    if (!hasTable(source, runs) || !hasTable(source, blocks) ||
      source.prepare(`SELECT 1 FROM ${blocks} b LEFT JOIN ${runs} r ON r.id=b.run_id WHERE r.id IS NULL LIMIT 1`).get() ||
      source.prepare(`SELECT 1 FROM ${runs} r WHERE r.${count}<>(SELECT count(*) FROM ${blocks} b WHERE b.run_id=r.id) LIMIT 1`).get()) {
      throw new Error(`Archive contains mismatched ${kind} history manifests or blocks`);
    }
  }
  if (hasTable(source, 'prepared_risk_history_runs') &&
    source.prepare("SELECT 1 FROM prepared_risk_history_runs WHERE format<>'risk-history-1-le' LIMIT 1").get()) {
    throw new Error('Archive contains an unsupported risk history encoding');
  }
  if (!hasTable(source, 'market_history') || source.prepare('SELECT count(DISTINCT date) AS count FROM market_history').get().count < expected.manifest.verification.sessions) {
    throw new Error('Archive does not contain the accepted number of prepared market sessions');
  }
  for (const [table, count] of Object.entries(expected.manifest.verification.tables ?? {})) {
    if (!analysisTables.has(table) || !Number.isSafeInteger(count) || count < 0 ||
      (hasTable(source, table) ? source.prepare(`SELECT count(*) AS count FROM ${table}`).get().count : 0) !== count) {
      throw new Error('Archive table totals do not match the accepted run');
    }
  }
}

function writeRow(checksum, spec, row) {
  let bytes = 0;
  for (const name of spec.names) {
    const value = row[name];
    const binary = ArrayBuffer.isView(value);
    const buffer = binary ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.from(value == null ? '' : String(value));
    checksum.update(`${binary ? 'blob' : typeof value}:${buffer.length}:`).update(buffer);
    bytes += buffer.length;
  }
  return bytes;
}

function newPartition(table) {
  return { table, keys: [], bytes: 0, checksum: createHash('sha256') };
}

function describePartitions(source, maxBytes, signal) {
  const partitions = [];
  for (const spec of specs) {
    if (!hasTable(source, spec.name)) continue;
    let part = newPartition(spec.name);
    function close() {
      if (!part.keys.length) return;
      partitions.push({ ordinal: partitions.length, table: part.table, first: part.keys[0], last: part.keys.at(-1),
        count: part.keys.length, bytes: part.bytes, keys: encodeStoredJson(part.keys), sha256: part.checksum.digest('hex') });
      part = newPartition(spec.name);
    }
    for (const row of source.prepare(`SELECT ${spec.names.join(',')} FROM ${spec.name} ORDER BY ${spec.keys.join(',')}`).iterate()) {
      signal?.throwIfAborted();
      const size = listOf(spec, row).reduce((sum, value) => sum + (ArrayBuffer.isView(value) ? value.byteLength : Buffer.byteLength(String(value ?? ''))), 0);
      if (size > maxBytes) throw new Error(`One ${spec.name} row is larger than the requested partition byte limit`);
      if (part.bytes + size > maxBytes || part.keys.length === 4096) close();
      part.bytes += writeRow(part.checksum, spec, row);
      part.keys.push(keyOf(spec, row));
    }
    close();
  }
  return partitions;
}

function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function checkedRows(db, spec, part, consume) {
  const keys = decodeStoredJson(part.keys);
  if (keys.length !== part.count) throw new Error('Publication key manifest is inconsistent');
  const get = db.prepare(`SELECT ${spec.names.join(',')} FROM ${spec.name} WHERE ${spec.keys.map((key) => `${key}=?`).join(' AND ')}`);
  const checksum = createHash('sha256');
  let missing = 0;
  for (const key of keys) {
    const row = get.get(...key);
    if (!row) { missing++; continue; }
    writeRow(checksum, spec, row);
    consume?.(row, key);
  }
  if (missing && missing !== keys.length || !missing && checksum.digest('hex') !== part.sha256) {
    throw new Error(`Publication partition contents differ in ${spec.name} #${part.ordinal}`);
  }
  return { missing, keys };
}

function savePart(target, spec, part, source) {
  const where = spec.keys.map((key) => `${key}=?`).join(' AND ');
  const exists = target.prepare(`SELECT ${spec.names.join(',')} FROM ${spec.name} WHERE ${where}`);
  const put = target.prepare(`INSERT INTO ${spec.name} (${spec.names.join(',')}) VALUES (${spec.names.map(() => '?').join(',')})`);
  const staged = spec.staged ? [] : null;
  const { missing } = checkedRows(source, spec, part, (row, key) => {
    const previous = exists.get(...key);
    if (previous && !spec.names.every((name) => equal(previous[name], row[name]))) {
      throw new Error(`Conflicting destination row in ${spec.name} #${part.ordinal}`);
    }
    if (staged) staged.push(listOf(spec, row));
    else {
      if (!previous) put.run(...listOf(spec, row));
      const inserted = exists.get(...key);
      if (!spec.names.every((name) => equal(inserted[name], row[name]))) throw new Error(`Destination readback differs in ${spec.name}`);
    }
  });
  if (missing) throw new Error(`Source partition is absent before durable copy in ${spec.name}`);
  return staged ? encodeStoredJson(staged) : null;
}

function checkStaged(spec, part) {
  const data = decodeStoredJson(part.staged);
  const checksum = createHash('sha256');
  const rows = data.map((values) => Object.fromEntries(spec.names.map((name, index) => [name, values[index]])));
  for (const row of rows) writeRow(checksum, spec, row);
  if (rows.length !== part.count || checksum.digest('hex') !== part.sha256) throw new Error(`Staged manifest differs in ${spec.name}`);
  return rows;
}

const writePartState = (db, state, publication, ordinal) =>
  db.prepare('UPDATE preparation_publication_partitions SET state=? WHERE publication=? AND ordinal=?').run(state, publication, ordinal);

function spaceFor(destination, source, bytes, reserve) {
  for (const path of new Set([dirname(source), dirname(destination)])) {
    const { bavail, bsize } = statfsSync(path, { bigint: true });
    // SQLite may need rollback pages for the in-flight copy or source deletion.
    if (bavail * bsize < BigInt(reserve) + 2n * BigInt(bytes)) throw new Error('Publication would consume the configured free-space reserve');
  }
}

function plannedState(rows) {
  return hash(rows.map(({ ordinal, table, count, bytes, sha256, first, last, keys }) =>
    [ordinal, table, count, bytes, sha256, first, last, createHash('sha256').update(keys).digest('hex')]));
}

function readPlan(target, id) {
  return target.prepare(`SELECT ordinal,table_name AS "table",first_key,last_key,keys,count,bytes,sha256,state,staged
    FROM preparation_publication_partitions WHERE publication=? ORDER BY ordinal`).all(id)
    .map(({ first_key, last_key, ...part }) => ({ ...part, first: JSON.parse(first_key), last: JSON.parse(last_key) }));
}

export async function publishPreparation({ sourcePath, destinationPath, manifest, dataVersion: version, calculationVersion,
  activeCalculationVersion, consume = false, maxPartitionBytes = 64 * 1024 ** 2, reserveBytes = defaultReserve, signal, onProgress } = {}) {
  signal?.throwIfAborted();
  if (!sourcePath || !destinationPath || typeof consume !== 'boolean' || !Number.isSafeInteger(maxPartitionBytes) ||
    maxPartitionBytes < 1024 || maxPartitionBytes > 512 * 1024 ** 2 || !Number.isSafeInteger(reserveBytes) || reserveBytes < 0) {
    throw new TypeError('Provide a source, destination and valid partition and reserve byte limits');
  }
  const expected = { manifest, dataVersion: version, calculationVersion, activeCalculationVersion };
  verifyInputs(expected);
  const sourceFile = resolve(sourcePath);
  const destinationFile = resolve(destinationPath);
  const identity = fileIdentity(sourceFile);
  if (identity.inode === fileIdentity(destinationFile).inode) throw new Error('Source and destination must be distinct warehouse files');
  const publication = hash(manifest);
  const url = pathToFileURL(sourceFile);
  url.search = '?mode=ro&immutable=1';
  let source = new DatabaseSync(url.href, { readOnly: true });
  let target = new DatabaseSync(destinationFile, { readOnly: !consume });
  try {
    source.exec('PRAGMA trusted_schema=OFF');
    target.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=10000');
    verifyLineage(source, target, version);
    const saved = hasTable(target, 'preparation_publications') ? target.prepare('SELECT * FROM preparation_publications WHERE id=?').get(publication) : null;
    if (!saved && hasTable(target, 'preparation_publications') &&
      target.prepare('SELECT 1 FROM preparation_publications WHERE source_inode=? LIMIT 1').get(identity.inode)) {
      throw new Error('Source has an existing publication. Resume using the same accepted manifest');
    }
    let parts;
    if (saved) {
      if (saved.source_inode !== identity.inode || saved.manifest !== JSON.stringify(manifest)) throw new Error('Publication cannot resume from a different source file or manifest');
      parts = readPlan(target, publication);
      if (plannedState(parts) !== saved.plan_hash) throw new Error('Stored publication partition plan does not match its sealed journal');
    } else {
      await verifyFile(sourceFile, manifest.archive, signal);
      validateArchive(source, target, expected);
      parts = describePartitions(source, maxPartitionBytes, signal);
      if (!parts.length || !parts.some(({ table }) => table === 'market_history' || table === 'prepared_snapshot_contexts')) {
        throw new Error('Accepted archive has no prepared market products');
      }
    }
    const summary = Object.values(parts.reduce((all, part) => {
      all[part.table] ??= { table: part.table, rows: 0, bytes: 0, partitions: 0 };
      all[part.table].rows += part.count;
      all[part.table].bytes += part.bytes;
      all[part.table].partitions++;
      return all;
    }, {}));
    const result = { publication, calculationVersion, dataVersion: version, state: saved?.state ?? 'dry-run',
      consumedPartitions: parts.filter(({ state }) => state === 'consumed').length, totalPartitions: parts.length, tables: summary,
      sourceBytesBefore: identity.size, sourceBytesAfter: identity.size, releasedSourceBytes: 0, reserveBytes,
      largestPartitionBytes: Math.max(...parts.map(({ bytes }) => bytes)) };
    if (!consume || saved?.state === 'verified-awaiting-cutover') return result;
    const beforeWrite = fileIdentity(sourceFile);
    if (!saved && (beforeWrite.inode !== identity.inode || beforeWrite.size !== identity.size || beforeWrite.modified !== identity.modified)) {
      throw new Error('Sealed archive changed after the publication plan was read');
    }
    spaceFor(destinationFile, sourceFile, result.largestPartitionBytes, reserveBytes);

    synced(target);
    if (!saved) inTransaction(target, () => {
      target.exec(journal);
      for (const spec of specs) if (hasTable(source, spec.name)) {
        target.exec(spec.create);
        if (spec.index) target.exec(spec.index);
        requireSchema(target, spec);
      }
      target.prepare('INSERT INTO preparation_publications VALUES (?,?,?,?,?,?)').run(publication, identity.inode,
        JSON.stringify(manifest), plannedState(parts), 'copying', new Date().toISOString());
      const insert = target.prepare(`INSERT INTO preparation_publication_partitions
        (publication,ordinal,table_name,first_key,last_key,keys,count,bytes,sha256,state) VALUES (?,?,?,?,?,?,?,?,?,?)`);
      for (const part of parts) insert.run(publication, part.ordinal, part.table, JSON.stringify(part.first), JSON.stringify(part.last),
        part.keys, part.count, part.bytes, part.sha256, 'planned');
    });
    source.close();
    source = new DatabaseSync(sourceFile);
    synced(source);
    source.exec('PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT');

    for (const part of parts) {
      signal?.throwIfAborted();
      if (part.state === 'consumed') continue;
      const spec = analysisTables.get(part.table);
      if (!spec) throw new Error('Stored publication plan has an unsupported partition');
      spaceFor(destinationFile, sourceFile, part.bytes, reserveBytes);
      if (part.state !== 'copied') {
        part.staged = inTransaction(target, () => {
          target.exec(spec.create);
          if (spec.index) target.exec(spec.index);
          requireSchema(target, spec);
          const staged = savePart(target, spec, part, source);
          target.prepare(`UPDATE preparation_publication_partitions SET state='copied',staged=?
            WHERE publication=? AND ordinal=?`).run(staged, publication, part.ordinal);
          return staged;
        });
        onProgress?.({ phase: 'copied', table: part.table, partition: part.ordinal + 1, ...result });
      }
      signal?.throwIfAborted();
      if (spec.staged) checkStaged(spec, part);
      else if (checkedRows(target, spec, part).missing) throw new Error('Durably copied destination rows are missing');
      inTransaction(source, () => {
        const { keys, missing } = checkedRows(source, spec, part);
        if (missing === keys.length) return;
        const remove = source.prepare(`DELETE FROM ${spec.name} WHERE ${spec.keys.map((key) => `${key}=?`).join(' AND ')}`);
        for (const key of keys) if (remove.run(...key).changes !== 1) throw new Error('Accepted source partition could not be consumed exactly');
      });
      source.exec('PRAGMA incremental_vacuum');
      inTransaction(target, () => writePartState(target, 'consumed', publication, part.ordinal));
      result.consumedPartitions++;
      result.sourceBytesAfter = statSync(sourceFile).size;
      result.releasedSourceBytes = result.sourceBytesBefore - result.sourceBytesAfter;
      onProgress?.({ phase: 'consumed', table: part.table, partition: part.ordinal + 1, ...result });
    }
    const completed = readPlan(target, publication);
    if (completed.some(({ state }) => state !== 'consumed')) throw new Error('Publication has unconsumed partitions');
    for (const part of completed) {
      signal?.throwIfAborted();
      const spec = analysisTables.get(part.table);
      if (!spec.staged && checkedRows(target, spec, part).missing) throw new Error('A published partition is incomplete');
      if (source.prepare(`SELECT 1 FROM ${spec.name} LIMIT 1`).get()) throw new Error('Source archive has unexpected remaining payload rows');
    }
    inTransaction(target, () => {
      for (const part of completed) {
        const spec = analysisTables.get(part.table);
        if (!spec.staged) continue;
        const rows = checkStaged(spec, part);
        const get = target.prepare(`SELECT ${spec.names.join(',')} FROM ${spec.name} WHERE ${spec.keys.map((key) => `${key}=?`).join(' AND ')}`);
        const put = target.prepare(`INSERT INTO ${spec.name} (${spec.names.join(',')}) VALUES (${spec.names.map(() => '?').join(',')})`);
        for (const row of rows) {
          const key = keyOf(spec, row);
          const existed = get.get(...key);
          if (!existed) put.run(...listOf(spec, row));
          const saved = existed || get.get(...key);
          if (!spec.names.every((name) => equal(saved[name], row[name]))) throw new Error(`Final manifest conflicts in ${spec.name}`);
        }
      }
      verifyLineage(source, target, version);
      target.prepare("UPDATE preparation_publications SET state='verified-awaiting-cutover',updated_at=? WHERE id=?")
        .run(new Date().toISOString(), publication);
    });
    return { ...result, state: 'verified-awaiting-cutover' };
  } finally {
    if (source.isOpen) source.close();
    if (target.isOpen) target.close();
  }
}
