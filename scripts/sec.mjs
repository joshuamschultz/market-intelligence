import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { openDatabase } from '../backend/database.mjs';
import { createSecDownloader, ingestSecEnrichment, parseSecSicList, secArtifactUrl } from '../backend/sec.mjs';

const help = `Usage: node scripts/sec.mjs import|download [options]

  import
    --catalog FILE       SEC ticker and exchange JSON (default data/sec-company-tickers-exchange.json)
    --sic FILE           Official SEC SIC labels HTML
    --sub FILE           Extracted quarterly sub.txt, repeatable. Shell-expanded paths are accepted.
    --sub-dir DIR        Include all YYYYqN-sub.txt files in this directory
    --facts FILE         SEC companyfacts JSON, repeatable
    --facts-dir DIR      Include CIK##########.json and CIK##########-facts.json files
    --db FILE            SQLite warehouse (default data/market.sqlite or MARKET_DB)
    --dry-run            Calculate identity, coverage and quarantine counts without importing

  download
    --catalog            Download the ticker and exchange concordance
    --sic                Download the SIC labels
    --quarter YYYYqN     Download a quarterly statements ZIP, repeatable
    --facts CIK          Download companyfacts JSON for an issuer, repeatable
    --submissions CIK    Download EDGAR issuer submissions JSON, repeatable
    --output-dir DIR     Artifact directory (default data/raw/sec)
    --force              Refresh existing artifacts

  Set SEC_USER_AGENT to your application name and contact email for SEC downloads.
  Quarterly imports use the extracted sub.txt only.`;

const sha = (value) => createHash('sha256').update(value).digest('hex');

function artifactSource(filename) {
  const name = basename(filename);
  const quarter = /^(20\d{2}q[1-4])-sub\.txt$/.exec(name)?.[1];
  if (quarter) return secArtifactUrl('quarter', quarter);
  const cik = /^CIK(\d{10})(?:-facts)?\.json$/.exec(name)?.[1];
  if (cik) return secArtifactUrl('companyfacts', cik);
  return name;
}

async function readArtifact(filename) {
  const metaFile = /-sub\.txt$/.test(filename) ? filename.replace(/-sub\.txt$/, '.manifest.json') : `${filename}.manifest.json`;
  const info = await stat(filename);
  if (!info.isFile() || info.size > 128 * 1024 * 1024) throw new Error(`Invalid SEC input file ${basename(filename)}`);
  const data = await readFile(filename);
  const checksum = sha(data);
  const manifest = await readFile(metaFile, 'utf8').then(JSON.parse).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (manifest && (manifest.sha256 !== checksum || (manifest.bytes != null && manifest.bytes !== data.length))) {
    throw new Error(`SEC artifact checksum or size differs from its manifest for ${basename(filename)}`);
  }
  return { data, sha256: checksum, source: manifest?.source ?? artifactSource(filename), capturedAt: manifest?.capturedAt ?? info.mtime.toISOString() };
}

async function importCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    catalog: { type: 'string', default: 'data/sec-company-tickers-exchange.json' }, sic: { type: 'string' },
    sub: { type: 'string', multiple: true, default: [] }, 'sub-dir': { type: 'string' },
    facts: { type: 'string', multiple: true, default: [] }, 'facts-dir': { type: 'string' },
    db: { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(help); return; }
  const files = [...values.sub, ...positionals];
  const factFiles = [...values.facts];
  if (values['sub-dir']) {
    const dir = values['sub-dir'];
    for (const file of await readdir(dir)) if (/^20\d{2}q[1-4]-sub\.txt$/.test(file)) files.push(join(dir, file));
  }
  if (values['facts-dir']) {
    const dir = values['facts-dir'];
    for (const file of await readdir(dir)) if (/^CIK\d{10}(?:-facts)?\.json$/.test(file)) factFiles.push(join(dir, file));
  }
  if (!files.length && !factFiles.length) throw new Error('Select at least one SEC submissions or companyfacts input');
  if (files.some((file) => !file.endsWith('.txt'))) throw new Error('SEC submissions input must be an extracted .txt file');
  const catalog = await readArtifact(values.catalog);
  const labels = values.sic ? parseSecSicList((await readArtifact(values.sic)).data) : new Map();
  const submissions = [];
  const companyFacts = [];
  for (const file of [...new Set(files)].sort()) submissions.push(await readArtifact(file));
  for (const file of [...new Set(factFiles)].sort()) companyFacts.push(await readArtifact(file));
  const db = openDatabase(values.db);
  try {
    const report = ingestSecEnrichment(db, { catalog: catalog.data, catalogCapturedAt: catalog.capturedAt, catalogSha256: catalog.sha256,
      submissions, companyFacts, labels, dryRun: values['dry-run'] });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    db.close();
  }
}

async function downloadCommand(args) {
  const { values } = parseArgs({ args, options: {
    catalog: { type: 'boolean' }, sic: { type: 'boolean' }, quarter: { type: 'string', multiple: true, default: [] },
    facts: { type: 'string', multiple: true, default: [] }, submissions: { type: 'string', multiple: true, default: [] },
    'output-dir': { type: 'string', default: 'data/raw/sec' }, force: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(help); return; }
  const jobs = [];
  if (values.catalog) jobs.push([secArtifactUrl('catalog'), 'company_tickers_exchange.json']);
  if (values.sic) jobs.push([secArtifactUrl('sic'), 'sic-codes.html']);
  for (const quarter of new Set(values.quarter)) jobs.push([secArtifactUrl('quarter', quarter), `${quarter}.zip`]);
  for (const id of new Set(values.facts)) jobs.push([secArtifactUrl('companyfacts', id), `CIK${String(Number(id)).padStart(10, '0')}-facts.json`]);
  for (const id of new Set(values.submissions)) jobs.push([secArtifactUrl('submissions', id), `CIK${String(Number(id)).padStart(10, '0')}-submissions.json`]);
  if (!jobs.length) throw new Error('Select one or more SEC artifacts to download');
  const download = createSecDownloader({ userAgent: process.env.SEC_USER_AGENT });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    for (const [url, file] of jobs) {
      const result = await download(url, join(values['output-dir'], file), { force: values.force, signal: controller.signal });
      if (!result.skipped) {
        const { source, bytes, sha256, capturedAt } = result;
        await writeFile(`${result.destination}.manifest.json`, `${JSON.stringify({ source, bytes, sha256, capturedAt }, null, 2)}\n`);
      }
      console.log(JSON.stringify(result));
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const [command, ...args] = process.argv.slice(2);
    if (command === 'import') await importCommand(args);
    else if (command === 'download') await downloadCommand(args);
    else if (!command || command === '--help') console.log(help);
    else throw new Error('SEC command must be import or download');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
