import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { openDatabase } from '../backend/database.mjs';
import { ingestNasdaqScreener } from '../backend/nasdaq.mjs';

try {
  try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    db: { type: 'string' }, manifest: { type: 'string' }, 'captured-at': { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) console.log('Usage: node scripts/nasdaq.mjs <screener.json> [--manifest FILE] [--captured-at ISO_TIMESTAMP] [--db FILE] [--dry-run]');
  else {
    if (positionals.length !== 1) throw new Error('Select a Nasdaq screener JSON file');
    const [file] = positionals;
    const input = await readFile(file);
    const sha256 = createHash('sha256').update(input).digest('hex');
    const manifestPath = values.manifest ?? file.replace(/\.json$/, '.manifest.json');
    const manifest = await readFile(manifestPath, 'utf8').then(JSON.parse).catch((error) => {
      if (error.code === 'ENOENT' && !values.manifest) return null;
      throw error;
    });
    if (manifest && manifest.sha256 !== sha256) throw new Error('Nasdaq screener artifact does not match its manifest checksum');
    const capturedAt = manifest?.capturedAt ?? values['captured-at'];
    if (!capturedAt) throw new Error('Provide the screener manifest or its actual capture timestamp');
    const db = openDatabase(values.db);
    try { console.log(JSON.stringify(ingestNasdaqScreener(db, { input, capturedAt, sha256, source: manifest?.source, dryRun: values['dry-run'] }), null, 2)); }
    finally { db.close(); }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
