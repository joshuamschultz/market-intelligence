import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { openDatabase, warehouseStatus } from '../backend/database.mjs';
import { createEngine } from '../backend/engine.mjs';
import { calculateMarketHealth } from '../backend/research.mjs';
import { generateJournal, getJournalSettings, journalDueDate, journalFactorSeries, listJournalPrompts, saveJournalPrompt, saveJournalSettings } from '../backend/journal.mjs';

const help = `Usage: node scripts/journal.mjs status|generate|daily|series|prompt|set-key [options]

  --db FILE             SQLite warehouse (default data/market.sqlite or MARKET_DB)
  --date YYYY-MM-DD     Generate for a market session (defaults to latest warehouse session)
  --universe ID         Analytics universe
  --benchmark SYMBOL    Comparison benchmark
  --rs-model ID         Canonical relative-strength model
  --prompt-version N    Select an immutable journal prompt version
  --force               Save a new journal revision
  --retrospective       Label generation as retrospective
  --from YYYY-MM-DD     Series start
  --to YYYY-MM-DD       Series end
  --csv                 Export factor series as CSV
  --include-retrospective  Include retrospective factor rows
  --prompt-file FILE    Explicit Markdown input for a new prompt revision
  --name NAME           Display name of new prompt revision

  set-key reads a credential from stdin. The Settings screen can also store it in the local journal vault.
  daily generates once after the published market-data session if journal scheduling is enabled.`;

function exportCsv(rows) {
  const custom = [...new Set(rows.flatMap((row) => row.factors.map((factor) => factor.key)))].sort();
  const headers = ['asOfDate', 'availableAt', 'tradableDate', 'retrospective', 'sentimentScore', 'marketHealth', 'riskPosture', 'confidence'];
  const quote = (value) => typeof value === 'string' ? `"${value.replaceAll('"', '""')}"` : value ?? '';
  return [[...headers, ...custom.map((name) => `factor.${name}`)].join(','), ...rows.map((row) => {
    const values = new Map(row.factors.map((item) => [item.key, item.value]));
    return [...headers.map((header) => row[header]), ...custom.map((name) => values.get(name))].map(quote).join(',');
  })].join('\n');
}

function contextFor(engine, input) {
  const config = engine.context(input);
  const snapshot = engine.snapshot(config, { persist: false, cache: false });
  const historic = engine.history(config, { limit: 45, project: ({ date, breadth, aggregates, coverage, groups, universe, model, benchmark }) =>
    ({ date, breadth, aggregates, coverage, groups: groups.map(({ id, level, percentile }) => ({ id, level, percentile })), universe, model, benchmark }) });
  const leaders = snapshot.stocks.filter((row) => row.rsRank != null).sort((a, b) => a.rsRank - b.rsRank).slice(0, 25)
    .map(({ symbol, rsRank, rsPercentile, return_1d, return_21d }) => ({ symbol, rsRank, rsPercentile, return_1d, return_21d }));
  const groups = snapshot.groups.filter((row) => row.level === 'industry').slice(0, 30)
    .map(({ name, percentile, rank, above50, dailyReturn }) => ({ name, percentile, rank, above50, dailyReturn }));
  const history = historic.slice(-20).map(({ date, aggregates, coverage, breadth }) => ({ date, benchmarkReturn: aggregates.benchmarkReturn,
    advanceDeclineSpread: breadth.adSpread?.value, above50: breadth.above_50d?.value, above200: breadth.above_200d?.value, coverage: coverage.state }));
  return { date: snapshot.date, universe: snapshot.universe, benchmark: snapshot.benchmark, basis: snapshot.basis, model: snapshot.model,
    calculationVersion: snapshot.calculationVersion, dataVersion: snapshot.dataVersion, coverage: snapshot.coverage,
    aggregates: snapshot.aggregates, breadth: snapshot.breadth, leaders, groups, history,
    health: calculateMarketHealth(snapshot, { history: historic }) };
}

try {
  try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    db: { type: 'string' }, date: { type: 'string' }, universe: { type: 'string' }, benchmark: { type: 'string' },
    'rs-model': { type: 'string' }, 'prompt-version': { type: 'string' }, name: { type: 'string' }, 'prompt-file': { type: 'string' },
    force: { type: 'boolean' }, retrospective: { type: 'boolean' }, from: { type: 'string' }, to: { type: 'string' },
    csv: { type: 'boolean' }, 'include-retrospective': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  const [command = 'status'] = positionals;
  if (values.help) console.log(help);
  else {
    if (positionals.length > 1 || !['status', 'generate', 'daily', 'series', 'prompt', 'set-key'].includes(command)) throw new Error('Invalid journal command. Run with --help.');
    const db = openDatabase(values.db);
    try {
      if (command === 'status') console.log(JSON.stringify(getJournalSettings(db), null, 2));
      else if (command === 'set-key') {
        if (process.stdin.isTTY) throw new Error('Use the Settings screen or supply the key securely through stdin');
        let key = '';
        for await (const chunk of process.stdin) {
          key += chunk;
          if (key.length > 1024) throw new Error('The key input is too long');
        }
        console.log(JSON.stringify(saveJournalSettings(db, { apiKey: key.trim() }), null, 2));
      } else if (command === 'prompt') {
        const report = values['prompt-file'] ? saveJournalPrompt(db, { name: values.name, prompt: await readFile(values['prompt-file'], 'utf8') })
          : listJournalPrompts(db);
        console.log(JSON.stringify(report, null, 2));
      } else if (command === 'series') {
        const rows = journalFactorSeries(db, { from: values.from, to: values.to, includeRetrospective: values['include-retrospective'] });
        console.log(values.csv ? exportCsv(rows) : JSON.stringify({ rows }, null, 2));
      } else {
        const status = warehouseStatus(db);
        const date = command === 'daily' ? journalDueDate(db, { publishedDate: status.state === 'available' ? status.latestDate : null })
          : values.date ?? status.latestDate;
        if (!date && command === 'daily') console.log(JSON.stringify({ state: 'not_due' }));
        else {
          if (!date) throw new Error('Import market data before generating a journal');
          const engine = createEngine(db);
          const context = contextFor(engine, { date, universe: values.universe, benchmark: values.benchmark, model: values['rs-model'] });
          if (context.coverage.state === 'empty') throw new Error('Market data is unavailable for the selected session');
          const entry = await generateJournal(db, { asOfDate: date, context, promptVersion: values['prompt-version'],
            force: values.force, retrospective: values.retrospective });
          console.log(JSON.stringify(entry, null, 2));
        }
      }
    } finally { db.close(); }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
