import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { EodhdProvider, importProviderData } from '../backend/provider.mjs';
import { bulkSessionStatus, openDatabase, importDataset, warehouseStatus } from '../backend/database.mjs';

try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    symbols: { type: 'string' }, date: { type: 'string' }, from: { type: 'string' },
    to: { type: 'string' }, bulk: { type: 'boolean' }, 'no-actions': { type: 'boolean' },
    reference: { type: 'boolean' }, delisted: { type: 'boolean' }, force: { type: 'boolean' },
    db: { type: 'string' }, help: { type: 'boolean' },
  },
});

const [mode, filename] = positionals;
if (values.help || !mode) {
  console.log('Usage: npm run ingest -- file <dataset.json|-> | eodhd [--symbols AAPL.US,SPY.US] [--from YYYY-MM-DD --to YYYY-MM-DD] [--bulk --date YYYY-MM-DD] [--reference] [--force] | probe | status');
} else {
  try {
    if (mode === 'probe') {
      console.log(JSON.stringify(await EodhdProvider().capabilities({ date: values.date }), null, 2));
    } else {
      const db = openDatabase(values.db);
      try {
        const write = (batch) => importDataset(db, batch);
        const hasBulkDate = (date) => !!bulkSessionStatus(db, date);
        if (mode === 'status') console.log(JSON.stringify(warehouseStatus(db), null, 2));
        else if (mode === 'file' && filename) {
          const source = filename === '-' ? 0 : isAbsolute(filename) ? filename : new URL(filename, `file://${process.cwd()}/`);
          if (source === 0) {
            let contents = '';
            for await (const chunk of process.stdin) contents += chunk;
            console.log(JSON.stringify(write(JSON.parse(contents)), null, 2));
          } else {
            console.log(JSON.stringify(write(JSON.parse(await readFile(source, 'utf8'))), null, 2));
          }
        } else if (mode === 'eodhd') {
          const result = await importProviderData({ ...values, actions: !values['no-actions'] }, { db, write, hasBulkDate });
          console.log(JSON.stringify(result, null, 2));
        } else throw new Error('Unknown import command. Run npm run ingest -- --help');
      } finally {
        db.close();
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
