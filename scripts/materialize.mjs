import { parseArgs } from 'node:util';
import { openDatabase } from '../backend/database.mjs';
import { createEngine } from '../backend/engine.mjs';
import { materializeHistory, readMaterializedHistory } from '../backend/materialization.mjs';
import { precomputeWorkspace } from '../backend/precompute.mjs';
import { readRankArchive, writeRankArchive } from '../backend/rank-archive.mjs';

const usage = `Usage: node scripts/materialize.mjs [write|status|workspace] [options]

  --from YYYY-MM-DD         First requested date
  --to YYYY-MM-DD           Last requested date
  --limit N                 Maximum sessions to select (default 120, maximum 7560)
  --cadence daily|weekly    Session selection (default daily)
  --universe ID             Universe (default us-core)
  --universe-version N      Select a saved universe version
  --model ID                Ranking model (default composite)
  --model-version N         Select a saved ranking-model version
  --benchmark SYMBOL        Comparison benchmark (default SPY)
  --reference as-of|latest  Current view reference clock (default as-of)
  --classification NAME     Historical classification system (default provider)
  --data-version N          Select a warehouse version (default latest)
  --basis known|reconstructed
  --threshold N             Market coverage fraction
  --metrics KEYS            Include custom breadth metrics, comma separated
  --all-models              Workspace mode includes built-in and saved models
  --daily-tail N            Workspace mode stores N recent daily sessions plus weekly history
  --ranks                   Materialize stock rank history instead of market breadth
  --with-ranks              Write breadth and stock ranks in one calculation pass
  --db FILE                 SQLite file (default data/market.sqlite or MARKET_DB)
  --force                   Rebuild previously materialized sessions
  --quiet                   Suppress progress on stderr
  --help                    Show usage`;

try {
  try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      from: { type: 'string' }, to: { type: 'string' }, limit: { type: 'string' }, cadence: { type: 'string' },
      universe: { type: 'string' }, 'universe-version': { type: 'string' }, model: { type: 'string' },
      'model-version': { type: 'string' }, benchmark: { type: 'string' }, classification: { type: 'string' },
      'data-version': { type: 'string' }, basis: { type: 'string' }, reference: { type: 'string' }, threshold: { type: 'string' }, db: { type: 'string' },
      force: { type: 'boolean' }, quiet: { type: 'boolean' }, help: { type: 'boolean' },
      metrics: { type: 'string' }, ranks: { type: 'boolean' }, 'with-ranks': { type: 'boolean' }, 'all-models': { type: 'boolean' }, 'daily-tail': { type: 'string' },
    },
  });
  const [mode = 'write'] = positionals;
  if (values.help) console.log(usage);
  else {
    if (positionals.length > 1 || !['write', 'status', 'workspace'].includes(mode)) throw new Error('Choose write, status, or workspace. Run with --help for options.');
    if (values.basis && !['known', 'reconstructed'].includes(values.basis)) throw new Error('Basis must be known or reconstructed.');
    const db = openDatabase(values.db);
    try {
      const engine = createEngine(db);
      const config = engine.context({
        universe: values.universe, universeVersion: values['universe-version'], model: values.model, modelVersion: values['model-version'],
        benchmark: values.benchmark, classification: values.classification, dataVersion: values['data-version'],
        basis: values.basis, reference: values.reference, threshold: values.threshold, breadthKeys: values.metrics,
        date: mode === 'workspace' ? values.to : undefined,
      });
      const options = { from: values.from, to: values.to, limit: values.limit ?? 120, cadence: values.cadence, force: values.force, withRanks: values['with-ranks'] };
      if (mode === 'workspace') {
        const progress = values.quiet ? undefined : (fraction) => console.error(`Workspace ${Math.round(fraction * 100)}%`);
        console.log(JSON.stringify(precomputeWorkspace(db, engine, config, {
          allModels: values['all-models'], dailyTail: Number(values['daily-tail'] ?? 1), progress,
        }), null, 2));
      } else if (values.ranks) {
        if (mode === 'status') {
          const { dates, observed } = readRankArchive(db, engine, config, options);
          console.log(JSON.stringify({ requested: dates.length, stored: observed.size,
            complete: dates.length === observed.size, missingDates: dates.filter((date) => !observed.has(date)) }, null, 2));
        } else {
          let reported = -10;
          const progress = values.quiet ? undefined : (fraction) => {
            const percent = Math.round(fraction * 100);
            if (percent === 100 || percent >= reported + 10) {
              console.error(`Ranking archive ${percent}%`);
              reported = percent;
            }
          };
          console.log(JSON.stringify(writeRankArchive(db, engine, config, { ...options, progress }), null, 2));
        }
      } else if (mode === 'status') {
        const { rows, ...status } = readMaterializedHistory(db, engine, config, options);
        console.log(JSON.stringify({ ...status, stored: rows.length }, null, 2));
      } else {
        let reported = -10;
        const onProgress = values.quiet ? undefined : ({ completed, total, date, percent }) => {
          if (percent === 100 || percent >= reported + 10) {
            console.error(`${completed}/${total} sessions (${percent}%)${date ? ` through ${date}` : ''}`);
            reported = percent;
          }
        };
        console.log(JSON.stringify(materializeHistory(db, engine, config, { ...options, onProgress }), null, 2));
      }
    } finally {
      db.close();
    }
  }
} catch (error) {
  console.error(String(error.message).replace(/((?:[?&]|--)(?:api[_-]?token|token|api[_-]?key)=)[^\s&'\"]+/gi, '$1[redacted]'));
  process.exitCode = 1;
}
