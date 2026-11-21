import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { marketDay, openDatabase } from '../backend/database.mjs';
import { ingestNasdaqScreener, parseNasdaqScreener } from '../backend/nasdaq.mjs';

export const NASDAQ_SCREENER = 'https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&download=true';

export async function refreshNasdaq(db, { fetcher = fetch, now = () => new Date(), archiveDir } = {}) {
  let response;
  try {
    response = await fetcher(NASDAQ_SCREENER, { redirect: 'error', signal: AbortSignal.timeout(45_000),
      headers: { Accept: 'application/json', 'User-Agent': 'Market Intelligence local workspace' } });
  } catch {
    throw new Error('Nasdaq reference data could not be reached');
  }
  if (!response.ok) throw new Error(`Nasdaq reference request failed (HTTP ${response.status})`);
  const content = Buffer.from(await response.arrayBuffer());
  if (!content.length || content.length > 32 * 1024 * 1024) throw new Error('Nasdaq reference response has an invalid size');
  const input = JSON.parse(content.toString('utf8'));
  const { rows } = parseNasdaqScreener(input);
  if (!rows.length) throw new Error('Nasdaq screener did not return stocks');
  const capturedAt = now().toISOString();
  const captureDate = marketDay(capturedAt);
  const sha256 = createHash('sha256').update(content).digest('hex');
  if (archiveDir == null && db.location()) archiveDir = resolve(dirname(db.location()), 'raw', 'nasdaq');
  if (archiveDir) {
    await mkdir(archiveDir, { recursive: true, mode: 0o700 });
    const filename = resolve(archiveDir, `screener-${captureDate}-${sha256.slice(0, 12)}`);
    await writeFile(`${filename}.json`, content, { mode: 0o600 });
    await writeFile(`${filename}.manifest.json`, JSON.stringify({
      source: NASDAQ_SCREENER, capturedAt, sha256, rows: input.data.rows.length,
      referenceBasis: 'current observed source; historical availability not asserted',
    }, null, 2) + '\n', { mode: 0o600 });
  }
  const result = ingestNasdaqScreener(db, { input, capturedAt, sha256, source: NASDAQ_SCREENER });
  if (!result.matched) throw new Error('Nasdaq reference capture had no unambiguous warehouse matches');
  return { ...result, captureDate };
}

async function main() {
  try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const db = openDatabase();
  try { console.log(JSON.stringify(await refreshNasdaq(db), null, 2)); }
  finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
