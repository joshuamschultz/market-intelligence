import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { createCompressedBackup, verifyCompressedBackup } from '../backend/backup.mjs';

const help = `Usage: node scripts/backup.mjs [create] [--db FILE] [--directory DIR] [--retain N] [--quiet]
       node scripts/backup.mjs verify <backup-directory>

The default archive directory is beside the database. Explicit --retain 2 keeps the newest two eligible backups.
Each private bundle contains market.sqlite.gz and its verification manifest.
Keep the journal vault separately or re-enter the API key after restoring to a new vault.`;

const controller = new AbortController();
const abort = () => controller.abort();
process.once('SIGINT', abort);
process.once('SIGTERM', abort);
try {
  try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    db: { type: 'string' }, directory: { type: 'string' }, retain: { type: 'string' },
    quiet: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  const [command = 'create', directory, ...extra] = positionals;
  if (values.help) console.log(help);
  else if (command === 'verify' && directory && !extra.length) {
    console.log(JSON.stringify(await verifyCompressedBackup(directory, { signal: controller.signal }), null, 2));
  } else if (command === 'create' && directory === undefined) {
    const filename = resolve(values.db || process.env.MARKET_DB || 'data/market.sqlite');
    const db = new DatabaseSync(filename, { readOnly: true, timeout: 10_000 });
    try {
      let shown = -10;
      const result = await createCompressedBackup(db, { directory: values.directory, retain: values.retain,
        signal: controller.signal, progress: values.quiet ? undefined : (fraction) => {
          const percent = Math.round(fraction * 100);
          if (percent >= shown + 10 || percent === 100) { console.error(`Backup ${percent}%`); shown = percent; }
        } });
      console.log(JSON.stringify(result, null, 2));
    } finally { db.close(); }
  } else throw new Error('Run with --help for backup commands');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', abort);
  process.removeListener('SIGTERM', abort);
}
