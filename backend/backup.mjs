import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, rmdir, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';

const kind = 'market-intelligence.sqlite-gzip';
const archiveName = 'market.sqlite.gz';
const manifestName = 'manifest.json';
const bundlePattern = /^market-sqlite-gzip-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f\d-]{36}$/;
const hashPattern = /^[a-f\d]{64}$/;
const essential = ['meta', 'securities', 'daily_prices', 'price_revisions', 'workspace'];
const optional = ['classifications', 'fundamentals', 'daily_publications', 'journal_entries', 'journal_notes'];
const MiB = 1024 ** 2;
const defaultReserveBytes = 1024n ** 3n;
const defaultDiskCheckBytes = 8 * MiB;
const pendingWriteAllowance = BigInt(MiB);
const sha = () => createHash('sha256');

export function backupRetention(value) {
  if (value == null) return null;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 1000 || (typeof value !== 'number' && typeof value !== 'string')) {
    throw new RangeError('Backup retention must be an integer from 1 to 1,000');
  }
  return count;
}

function bytesForCopy(db) {
  const pages = BigInt(db.prepare('PRAGMA page_count').get().page_count);
  const size = BigInt(db.prepare('PRAGMA page_size').get().page_size);
  return pages * size;
}

export function backupSpaceRequired(rawBytes, reserveBytes = defaultReserveBytes) {
  const raw = BigInt(rawBytes);
  const reserve = BigInt(reserveBytes);
  if (raw < 0n || reserve <= 0n) throw new RangeError('SQLite copy size must be nonnegative and its disk reserve positive');
  return raw + reserve;
}

async function freeBytes(directory) {
  const fs = await statfs(directory, { bigint: true });
  return fs.bavail * fs.bsize;
}

async function acquireBackup(source) {
  const filename = join(dirname(source), `.${basename(source)}.backup-lock.sqlite`);
  const handle = await open(filename, constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  await handle.close();
  const lock = new DatabaseSync(filename);
  try { lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
  catch (error) {
    lock.close();
    if ([5, 6].includes(error.errcode) || /locked|busy/i.test(error.message)) {
      throw Object.assign(new Error('A backup is already running for this warehouse'), { code: 'BACKUP_BUSY', status: 409 });
    }
    throw error;
  }
  return lock;
}

function inspectCopy(filename) {
  const copy = new DatabaseSync(filename, { readOnly: true });
  try {
    const checked = copy.prepare('PRAGMA quick_check').all();
    if (checked.length !== 1 || checked[0].quick_check !== 'ok') throw new Error('SQLite backup failed quick_check');
    const tables = new Set(copy.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(({ name }) => name));
    if (essential.some((table) => !tables.has(table))) throw new Error('SQLite backup does not contain the expected warehouse tables');
    const counts = Object.fromEntries([...essential, ...optional].filter((table) => tables.has(table)).map((table) => [table,
      copy.prepare(`SELECT count(*) AS count FROM ${table}`).get().count]));
    const oldest = copy.prepare('SELECT date FROM daily_prices ORDER BY date LIMIT 1').get()?.date ?? null;
    const latest = copy.prepare('SELECT date FROM daily_prices ORDER BY date DESC LIMIT 1').get()?.date ?? null;
    const version = copy.prepare("SELECT value FROM meta WHERE key='data_version'").get()?.value;
    return { quickCheck: 'ok', dataVersion: version == null ? 0 : Number(version), counts, earliestDate: oldest, latestDate: latest };
  } finally { copy.close(); }
}

function meter(onChunk) {
  return new Transform({ transform(chunk, _encoding, done) { onChunk(chunk); done(null, chunk); } });
}

function compressionGuard(readSpace, reserve, checkBytes) {
  let initialLimit;
  let limit;
  let checkedBytes = 0;
  let checkedAt = 0;
  return async (written, chunkSize) => {
    const attempted = BigInt(written + chunkSize);
    const now = performance.now();
    if (limit === undefined || attempted > limit || written - checkedBytes + chunkSize >= checkBytes || now - checkedAt >= 1000) {
      // Account for output accepted by the pipeline but still buffered by the filesystem writer.
      const measured = BigInt(written) + await readSpace() - reserve - pendingWriteAllowance;
      initialLimit ??= measured;
      limit = measured < initialLimit ? measured : initialLimit;
      checkedBytes = written;
      checkedAt = performance.now();
    }
    if (attempted > limit) throw Object.assign(new Error('Backup compression stopped to preserve the minimum free disk reserve'), { code: 'ENOSPC' });
  };
}

async function compressCopy(raw, compressed, rawBytes, signal, report, approveChunk) {
  const rawHash = sha();
  const archiveHash = sha();
  let read = 0;
  let bytes = 0;
  await pipeline(createReadStream(raw, { highWaterMark: MiB }), meter((chunk) => {
    rawHash.update(chunk);
    read += chunk.length;
    report(0.60 + 0.22 * read / rawBytes);
  }), createGzip(), new Transform({ transform(chunk, _encoding, done) {
    approveChunk(bytes, chunk.length).then(() => {
      archiveHash.update(chunk);
      bytes += chunk.length;
      done(null, chunk);
    }, done);
  } }), createWriteStream(compressed, { flags: 'wx', mode: 0o600 }), { signal });
  if (read !== rawBytes || bytes <= 0) throw new Error('Compressed backup copy was incomplete');
  return { bytes, sha256: archiveHash.digest('hex'), rawBytes, rawSha256: rawHash.digest('hex') };
}

async function verifyArchive(filename, manifest, signal, report = () => {}) {
  const archiveHash = sha();
  const rawHash = sha();
  let compressed = 0;
  let raw = 0;
  await pipeline(createReadStream(filename, { highWaterMark: MiB }), meter((chunk) => {
    archiveHash.update(chunk);
    compressed += chunk.length;
  }), createGunzip(), new Writable({ write(chunk, _encoding, done) {
    raw += chunk.length;
    if (raw > manifest.rawBytes) { done(new Error('Backup expands beyond its recorded SQLite size')); return; }
    rawHash.update(chunk);
    report(raw / manifest.rawBytes);
    done();
  } }), { signal });
  if (compressed !== manifest.bytes || raw !== manifest.rawBytes ||
      archiveHash.digest('hex') !== manifest.sha256 || rawHash.digest('hex') !== manifest.rawSha256) {
    throw new Error('Backup archive did not match its compressed and restored checksums');
  }
}

async function committedBundle(directory) {
  const id = basename(directory);
  if (!bundlePattern.test(id) || !(await lstat(directory)).isDirectory()) return null;
  const files = await readdir(directory);
  if (files.length !== 2 || !files.includes(manifestName) || !files.includes(archiveName)) return null;
  const manifestPath = join(directory, manifestName);
  const filename = join(directory, archiveName);
  const [metadata, archive] = await Promise.all([lstat(manifestPath), lstat(filename)]);
  if (!metadata.isFile() || metadata.size > 64 * 1024 || !archive.isFile()) return null;
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch (error) { if (error instanceof SyntaxError) return null; throw error; }
  if (manifest?.kind !== kind || manifest.schemaVersion !== 1 || manifest.id !== id || manifest.filename !== archiveName ||
      !hashPattern.test(manifest.sourceId ?? '') || !hashPattern.test(manifest.sha256 ?? '') || !hashPattern.test(manifest.rawSha256 ?? '') ||
      !Number.isSafeInteger(manifest.rawBytes) || manifest.rawBytes <= 0 || manifest.bytes !== archive.size ||
      !Number.isFinite(Date.parse(manifest.completedAt))) return null;
  return { directory, filename, manifestPath, manifest };
}

export async function verifyCompressedBackup(directory, { signal } = {}) {
  const bundle = await committedBundle(resolve(directory));
  if (!bundle) throw new Error('Expected a committed Market Intelligence backup bundle');
  await verifyArchive(bundle.filename, bundle.manifest, signal);
  return bundle.manifest;
}

async function pruneBackups(directory, sourceId, retain, currentId) {
  const candidates = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !bundlePattern.test(entry.name)) continue;
    const bundle = await committedBundle(join(directory, entry.name)).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (bundle?.manifest.sourceId === sourceId) candidates.push(bundle);
  }
  candidates.sort((left, right) => Number(right.manifest.id === currentId) - Number(left.manifest.id === currentId) ||
    right.manifest.completedAt.localeCompare(left.manifest.completedAt) || right.manifest.id.localeCompare(left.manifest.id));
  const removed = [];
  for (const prior of candidates.slice(retain)) {
    // Delete only known backup artifacts. Preserve directories with additional files.
    if (!(await committedBundle(prior.directory))) continue;
    await unlink(prior.filename);
    await unlink(prior.manifestPath);
    await rmdir(prior.directory).catch((error) => { if (error.code !== 'ENOTEMPTY') throw error; });
    removed.push(prior.manifest.id);
  }
  return removed;
}

async function sync(filename, directory = false) {
  const handle = await open(filename, 'r');
  try { await handle.sync(); }
  catch (error) { if (!directory || !['EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error; }
  finally { await handle.close(); }
}

export async function createCompressedBackup(db, { directory, retain, sourceDate = null, progress = () => {}, signal,
  spaceAvailable = freeBytes, reserveBytes = defaultReserveBytes, diskCheckBytes = defaultDiskCheckBytes } = {}) {
  const location = db.location();
  if (!location) throw new Error('A disk-backed warehouse is required for backup');
  if (db.isTransaction) throw new Error('Finish the source transaction before starting a backup');
  const retention = backupRetention(retain);
  const reserve = backupSpaceRequired(0, reserveBytes);
  if (typeof spaceAvailable !== 'function' || !Number.isSafeInteger(diskCheckBytes) || diskCheckBytes <= 0) {
    throw new TypeError('Backup space checks require a disk reading function and positive byte interval');
  }
  const source = await realpath(location);
  const sourceId = sha().update(source).digest('hex');
  const root = resolve(directory ?? join(dirname(source), 'backups'));
  const readSpace = async () => BigInt(await spaceAvailable(root));
  const lock = await acquireBackup(source);
  let stage;
  let lastPercent = -1;
  const report = (value) => {
    const percent = Math.min(100, Math.floor(value * 100));
    if (percent > lastPercent) {
      lastPercent = percent;
      try { progress(percent / 100); } catch { /* Progress storage must not interrupt SQLite's backup callback. */ }
    }
  };
  try {
    signal?.throwIfAborted();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const required = backupSpaceRequired(bytesForCopy(db), reserve);
    const available = await readSpace();
    if (available < required) throw Object.assign(new Error(`Insufficient disk space for a verified backup. Need ${required} bytes and have ${available}.`), { code: 'ENOSPC' });
    stage = await mkdtemp(join(root, '.market-sqlite-stage-'));
    await chmod(stage, 0o700);
    const createdAt = new Date().toISOString();
    const id = `market-sqlite-gzip-${createdAt.replace(/[:.]/g, '-')}-${randomUUID()}`;
    const raw = join(stage, 'staging.sqlite');
    const bundle = join(stage, 'commit');
    await mkdir(bundle, { mode: 0o700 });
    report(0);
    signal?.throwIfAborted();
    await backup(db, raw, { rate: 4096, progress: ({ totalPages, remainingPages }) => {
      if (!signal?.aborted && totalPages > 0) report(0.55 * (totalPages - remainingPages) / totalPages);
    } });
    signal?.throwIfAborted();
    await chmod(raw, 0o600);
    const copy = inspectCopy(raw);
    const rawBytes = (await stat(raw)).size;
    report(0.60);
    const pending = join(bundle, `${archiveName}.tmp`);
    const archive = await compressCopy(raw, pending, rawBytes, signal, report, compressionGuard(readSpace, reserve, diskCheckBytes));
    await verifyArchive(pending, archive, signal, (fraction) => report(0.82 + 0.16 * fraction));
    signal?.throwIfAborted();
    await sync(pending);
    await rename(pending, join(bundle, archiveName));
    const manifest = { kind, schemaVersion: 1, id, filename: archiveName, sourceId, database: basename(source),
      createdAt, completedAt: new Date().toISOString(), scheduledFor: sourceDate, ...archive, ...copy,
      verification: 'SQLite quick_check and gzip read-back SHA-256',
      journalVault: 'The encrypted credential is backed up. Keep the original local vault separately or re-enter the API key after restore.' };
    await writeFile(join(bundle, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await sync(join(bundle, manifestName));
    await sync(bundle, true);
    const committed = join(root, id);
    await rename(bundle, committed);
    await sync(root, true);
    let removed = [];
    let retentionWarning = null;
    if (retention !== null) {
      try { removed = await pruneBackups(root, sourceId, retention, id); }
      catch { retentionWarning = 'The new backup was verified and committed. Older backup retention could not finish.'; }
    }
    report(1);
    return { ...manifest, filenameInBundle: archiveName, filename: join(committed, archiveName),
      manifestPath: join(committed, manifestName), directory: committed, removed, retentionWarning };
  } finally {
    try { if (stage) await rm(stage, { recursive: true, force: true }); }
    finally { lock.close(); }
  }
}
