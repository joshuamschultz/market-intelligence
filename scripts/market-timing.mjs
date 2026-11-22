import { parseArgs } from 'node:util';
import { openDatabase } from '../backend/database.mjs';
import { createEngine } from '../backend/engine.mjs';
import { prepareMarketTiming } from '../backend/market-timing.mjs';

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  db: { type: 'string' }, date: { type: 'string' }, 'data-version': { type: 'string' }, force: { type: 'boolean' },
} });
if (positionals.length !== 1 || positionals[0] !== 'prepare') {
  throw new Error('Usage: node scripts/market-timing.mjs prepare [--db path] [--date YYYY-MM-DD] [--data-version N] [--force]');
}
const db = openDatabase(values.db);
try {
  const engine = createEngine(db);
  const config = engine.context({ date: values.date, dataVersion: values['data-version'] });
  if (values.date && config.date !== values.date) throw new Error('Choose a loaded exchange session');
  console.log(JSON.stringify(prepareMarketTiming(db, engine, config, { force: values.force }), null, 2));
} finally {
  db.close();
}
