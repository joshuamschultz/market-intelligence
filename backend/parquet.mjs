import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { backup, DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { CALCULATION_VERSION, dataVersion } from './database.mjs';

const execute = promisify(execFile);
const stringLiteral = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const command = () => process.env.MARKET_DUCKDB_BIN || 'duckdb';
let checked;

export async function parquetAvailable() {
  if (!checked) checked = execute(command(), ['--version'], { timeout: 5_000, maxBuffer: 32_000 }).then(() => true, () => false);
  return checked;
}

async function requireDuckDB() {
  if (!await parquetAvailable()) {
    throw Object.assign(new Error('Parquet export requires the DuckDB command-line client on the workspace server'), { status: 503 });
  }
}

function safeColumnTypes(columns) {
  const valid = new Set(['VARCHAR', 'DOUBLE', 'BIGINT', 'BOOLEAN', 'DATE']);
  return '{' + Object.entries(columns).map(([name, type]) => {
    if (!valid.has(type)) throw new Error('Unsupported Parquet output type');
    return `${stringLiteral(name)}:${stringLiteral(type)}`;
  }).join(',') + '}';
}

async function convert(source, destination, columns) {
  const query = `COPY (SELECT * FROM read_json(${stringLiteral(source)}, format='newline_delimited', columns=${safeColumnTypes(columns)}))
    TO ${stringLiteral(destination)} (FORMAT PARQUET, COMPRESSION ZSTD)`;
  try { await execute(command(), ['-batch', ':memory:', '-c', query], { timeout: 300_000, maxBuffer: 64_000 }); }
  catch { throw new Error('DuckDB could not write the Parquet export'); }
  const file = await open(destination, 'r');
  try {
    const metadata = await file.stat();
    const header = Buffer.alloc(4);
    const footer = Buffer.alloc(4);
    if (metadata.size < 12) throw new Error('Parquet export is incomplete');
    await file.read(header, 0, 4, 0);
    await file.read(footer, 0, 4, metadata.size - 4);
    if (header.toString() !== 'PAR1' || footer.toString() !== 'PAR1') throw new Error('Unexpected Parquet file format');
  } finally { await file.close(); }
}

function* exportRows(rows, keys) {
  for (const row of rows) yield JSON.stringify(Object.fromEntries(keys.map((key) => [key, row[key] ?? null]))) + '\n';
}

export async function parquetRows(rows, keys) {
  await requireDuckDB();
  const columns = Object.fromEntries(keys.map((key) => {
    const value = rows.find((row) => row[key] != null)?.[key];
    const type = typeof value === 'boolean' ? 'BOOLEAN' : typeof value === 'number' ? 'DOUBLE' : 'VARCHAR';
    return [key, type];
  }));
  const temp = await mkdtemp(join(tmpdir(), 'market-parquet-'));
  try {
    const source = join(temp, 'rows.ndjson');
    const destination = join(temp, 'rows.parquet');
    if (rows.length) await pipeline(Readable.from(exportRows(rows, keys)), createWriteStream(source));
    else await writeFile(source, '', 'utf8');
    await convert(source, destination, columns);
    return await readFile(destination);
  } finally { await rm(temp, { recursive: true, force: true }); }
}

const prices = {
  security_id: 'VARCHAR', date: 'DATE', open: 'DOUBLE', high: 'DOUBLE', low: 'DOUBLE', close: 'DOUBLE',
  adjusted_close: 'DOUBLE', split_close: 'DOUBLE', volume: 'DOUBLE', source: 'VARCHAR', known_at: 'DATE',
  ingested_at: 'VARCHAR', version: 'BIGINT', volume_adjusted: 'BOOLEAN', volume_basis: 'DATE',
};

export async function parquetBackup(db, progress = () => {}) {
  await requireDuckDB();
  if (db.location() === null) throw new Error('A disk-backed warehouse is required for backup');
  const base = resolve(dirname(db.location()), 'backups');
  await mkdir(base, { recursive: true });
  const staging = await mkdtemp(join(base, '.parquet-'));
  const capture = join(staging, 'source.sqlite');
  let archive;
  try {
    await backup(db, capture);
    archive = new DatabaseSync(capture, { readOnly: true });
    const bounds = archive.prepare('SELECT min(date) AS first,max(date) AS last FROM daily_prices').get();
    const lower = bounds.first ? Number(bounds.first.slice(0, 4)) : null;
    const upper = bounds.last ? Number(bounds.last.slice(0, 4)) : null;
    const written = [];
    const select = archive.prepare('SELECT * FROM price_revisions WHERE date>=? AND date<? ORDER BY date, security_id, version');
    if (upper != null) {
      for (let year = lower; year <= upper; year++) {
        const partition = join(staging, `year=${year}`);
        await mkdir(partition);
        const source = join(partition, 'rows.ndjson');
        const output = join(partition, 'price-revisions.parquet');
        const key = `${year}-01-01`;
        const limit = `${year + 1}-01-01`;
        await pipeline(Readable.from(exportRows(select.iterate(key, limit), Object.keys(prices))), createWriteStream(source));
        await convert(source, output, prices);
        await rm(source);
        written.push(`year=${year}/price-revisions.parquet`);
        progress((year - lower + 1) / (upper - lower + 1));
      }
    }
    const manifest = {
      type: 'price-revisions', firstDate: bounds.first, lastDate: bounds.last,
      dataVersion: dataVersion(archive), calculationVersion: CALCULATION_VERSION, partitions: written,
    };
    archive.close();
    archive = null;
    await rm(capture);
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    const folder = join(base, `market-parquet-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await rename(staging, folder);
    return { folder, ...manifest };
  } catch (error) {
    archive?.close();
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
