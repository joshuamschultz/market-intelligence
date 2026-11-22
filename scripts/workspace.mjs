import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { isMarketSession, latestFinalizableSession, shiftDate } from '../backend/calendar.mjs';
import { bulkSessionStatus, dataVersion, isoDate, marketDay } from '../backend/database.mjs';
import { marketSyncAfter, rawBulkReceipt } from '../backend/service.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const commands = ['start', 'open', 'status', 'stop', 'update', 'help'];
const dateLimit = 5;
const currentRosterDays = 7;
const captureTypes = new Set(['provider-bootstrap', 'provider-import']);
const pendingStatuses = new Set(['queued', 'running']);
const usage = `Market Intelligence workspace

npm run app -- start [--no-open] [--workspace]
npm run app -- open
npm run app -- status
npm run app -- stop
npm run update -- [--date YYYY-MM-DD ...] [--wait]

Start reuses the macOS managed service and opens the local workspace.
On a fresh clone it uses workspace source. --workspace requires no active release.
Update defaults to the latest finalized exchange session at 16:30 Eastern
(or MARKET_SYNC_AFTER). Repeat --date for up to five recent sessions.
The provider's current-roster verification window is seven calendar days.
Existing captures stay local. A pinned five-year build defers new updates.
--wait follows daily jobs. Full analysis is reported separately.
A clean append can reuse unaffected dated analysis. Corrections, splits and
reference changes can require recalculation from an earlier date.`;

function readEnvironment(workspace, environment) {
  let local = {};
  try { local = parseEnv(readFileSync(resolve(workspace, '.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read the workspace .env file'); }
  return { ...local, ...environment };
}

function connection(workspace, config) {
  const port = Number(config.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  const host = config.HOST || '127.0.0.1';
  const hosts = { '127.0.0.1': '127.0.0.1', '0.0.0.0': '127.0.0.1', localhost: 'localhost', '::1': '[::1]', '::': '[::1]' };
  const loopback = Object.hasOwn(hosts, host) ? hosts[host] : null;
  if (!loopback) throw new Error('Use a loopback or wildcard HOST for the local workspace command');
  return { url: `http://${loopback}:${port}/`, token: config.MARKET_ACCESS_TOKEN,
    filename: resolve(workspace, config.MARKET_DB || 'data/market.sqlite') };
}

function jsonClient({ url, token }, fetcher) {
  return async (path, { body, offline = false } = {}) => {
    const target = new URL(`api/v1/${path}`, url);
    const headers = { Accept: 'application/json', ...(token && { Authorization: `Bearer ${token}` }) };
    let response;
    try {
      response = await fetcher(target, { headers, redirect: 'error', signal: AbortSignal.timeout(offline ? 2500 : 15_000),
        ...(body && { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    } catch (error) {
      if (offline && error.cause?.code === 'ECONNREFUSED') return null;
      throw new Error('The local service did not respond. Check it with npm run app -- status.');
    }
    if (response.status === 401) throw new Error('Workspace authentication failed. Check MARKET_ACCESS_TOKEN in the local environment.');
    if (!response.ok) throw new Error(`Workspace request failed with HTTP ${response.status}`);
    try { return await response.json(); }
    catch { throw new Error('The local service returned an invalid response'); }
  };
}

function managedService(workspace, platform, spawn) {
  return (command) => {
    if (platform !== 'darwin') throw new Error('Managed service commands use launchd on macOS. Start the workspace with npm start on other platforms.');
    const result = spawn(process.execPath, [resolve(workspace, 'scripts/local-service.mjs'), command],
      { cwd: workspace, encoding: 'utf8', timeout: 20_000 });
    if (result.error || result.status !== 0) throw new Error(`Managed service ${command} failed. Inspect npm run service -- status.`);
    try { return JSON.parse(result.stdout); }
    catch { throw new Error('The managed service did not return a status record'); }
  };
}

function openBrowser(url, platform, spawn, workspace) {
  const command = platform === 'darwin' ? '/usr/bin/open' : platform === 'linux' ? 'xdg-open' : null;
  if (!command) throw new Error(`Open ${url} in your browser`);
  const result = spawn(command, [url], { cwd: workspace, stdio: 'ignore', timeout: 10_000 });
  if (result.error || result.status !== 0) throw new Error(`Could not open the browser. Open ${url} directly.`);
}

function readUpdateState(filename, dates, calculationVersion) {
  let db;
  try { db = new DatabaseSync(filename, { readOnly: true }); }
  catch { throw new Error('The local warehouse could not be opened for a read-only update check'); }
  try {
    const version = dataVersion(db);
    const pinned = db.prepare(`
      SELECT id,status FROM jobs WHERE type='optimized-five-year' AND
        ((status IN ('waiting_for_space','building') AND unixepoch(updated_at)>=unixepoch('now')-120)
          OR (status='awaiting_publication' AND json_extract(payload,'$.dataVersion')=?))
      ORDER BY rowid DESC LIMIT 1
    `).get(version);
    const jobs = db.prepare(`
      SELECT id,type,status,json_extract(payload,'$.date') AS date,
        json_extract(payload,'$.from') AS firstDate,json_extract(payload,'$.to') AS lastDate
      FROM jobs WHERE status IN ('queued','running') AND type IN ('provider-bootstrap','provider-import')
    `).all();
    if (pinned) return { pinned };
    const captures = new Map();
    const publication = db.prepare('SELECT 1 FROM daily_publications WHERE date=? AND raw_version=? AND calculation_version=?');
    for (const date of dates) {
      const raw = rawBulkReceipt(db, date);
      const verified = bulkSessionStatus(db, date, { verifiedOnly: true });
      captures.set(date, { raw, verified, published: !!verified && !!publication.get(date, verified.version, calculationVersion) });
    }
    return { jobs, captures };
  } finally {
    db.close();
  }
}

function requestedDates(values, now, after) {
  const latest = latestFinalizableSession(now, after);
  const requested = values.date || [latest];
  if (requested.length > dateLimit) throw new Error(`Choose no more than ${dateLimit} daily sessions per update`);
  for (const date of requested) {
    if (!isoDate(date) || !isMarketSession(date) || date > latest) throw new Error(`Choose a finalized exchange session on or before ${latest}`);
  }
  return [...new Set(requested)].sort();
}

function jobForDate(jobs, date) {
  return jobs.find((job) => captureTypes.has(job.type) && (job.type === 'provider-bootstrap' ||
    (job.firstDate || job.date) <= date && date <= (job.lastDate || job.date)));
}

function printAnalysis(status, print) {
  const proof = status.analysisReadiness;
  const exactProof = proof && proof.date === status.latestDate && proof.dataVersion === status.dataVersion
    && proof.calculationVersion === status.calculationVersion;
  if (exactProof && proof.state === 'ready') print('Full analysis is ready for this revision.');
  else if (exactProof && proof.state === 'preparing' || status.preparation?.running || status.preparation?.queued) print('Full analysis is still preparing.');
  else print('Full analysis is not verified for this revision.');
}

async function waitForDailyJobs(api, tickets, print, sleep, { waitMs = 30 * 60_000, pollMs = 2000 } = {}) {
  const deadline = Date.now() + waitMs;
  let unresolved = 0;
  while (tickets.size && Date.now() < deadline) {
    for (const [id, dates] of tickets) {
      const job = await api(`jobs/${encodeURIComponent(id)}`);
      if (pendingStatuses.has(job.status)) continue;
      for (const date of dates) {
        const published = job.status === 'complete' && [job.result?.published, job.result?.alreadyPublished]
          .some((list) => Array.isArray(list) && list.includes(date));
        if (published) print(`${date}: Daily prices and verified publication complete (job ${id}).`);
        else {
          const reason = job.status === 'complete' ? 'Daily job finished without verified publication' : `Daily job ${job.status}`;
          print(`${date}: ${reason} (job ${id}).`);
          unresolved++;
        }
      }
      tickets.delete(id);
    }
    if (tickets.size) await sleep(pollMs);
  }
  if (tickets.size) print(`Daily jobs still pending: ${[...tickets.keys()].join(', ')}`);
  printAnalysis(await api('data/status'), print);
  return unresolved || tickets.size ? 1 : 0;
}

async function update({ api, filename, values, clock, after, print, readState, sleep, waitOptions }) {
  const now = clock();
  const dates = requestedDates(values, now, after);
  const defer = ({ id, status }) => {
    print(`Update deferred while five-year job ${id} is ${status.replaceAll('_', ' ')}. The pinned source revision is unchanged by this command.`);
    return 2;
  };
  const preflight = readState(filename, []).pinned;
  if (preflight) return defer(preflight);
  const build = await api('build');
  if (!/^2-[a-f0-9]{12}$/.test(build?.calculationVersion ?? '')) throw new Error('The local service calculation version could not be verified');
  const firstFresh = shiftDate(marketDay(now), -currentRosterDays);
  const tickets = new Map();
  let blocked = 0;
  for (const date of dates) {
    const { pinned, jobs, captures } = readState(filename, [date], build.calculationVersion);
    if (pinned) return defer(pinned);
    const { raw, verified, published } = captures.get(date);
    if (published) {
      print(`${date}: Already captured and published.`);
      continue;
    }
    const existing = jobForDate(jobs, date);
    if (existing?.type === 'provider-bootstrap') {
      print(`${date}: Update deferred while historical capture job ${existing.id} is ${existing.status}.`);
      blocked++;
      continue;
    }
    if (raw && !verified && !existing) {
      print(`${date}: Already captured with unverified coverage. Existing prices kept.`);
      blocked++;
      continue;
    }
    if (!verified && !existing && date < firstFresh) {
      print(`${date}: Outside the provider's seven-calendar-day current-roster verification window.`);
      blocked++;
      continue;
    }
    const body = { bulk: true, date, verifiedOnly: true, skipCaptured: true, ...(verified && { localOnly: true }) };
    const job = existing || await api('data/refresh', { body });
    if (typeof job?.id !== 'string' || !job.id) throw new Error('The service did not return a daily job ID');
    print(`${date}: ${existing ? 'Existing daily job' : verified ? 'Local publication queued' : 'Daily capture queued'} ${job.id}.`);
    tickets.set(job.id, [...(tickets.get(job.id) || []), date]);
  }
  if (values.wait && tickets.size) return await waitForDailyJobs(api, tickets, print, sleep, waitOptions) || Number(blocked > 0);
  return Number(blocked > 0);
}

export async function runWorkspace(argv, { workspace = root, environment = process.env, platform = process.platform,
  spawn = spawnSync, fetcher = fetch, print = console.log, clock = () => new Date(), sleep = delay, readState = readUpdateState,
  waitOptions } = {}) {
  const command = argv[0]?.startsWith('-') ? 'start' : argv[0] || 'start';
  if (!commands.includes(command)) throw new Error('Choose start, open, status, stop, update, or help');
  const { values } = parseArgs({ args: argv[0] === command ? argv.slice(1) : argv,
    options: { help: { type: 'boolean', short: 'h' },
      ...(command === 'start' && { 'no-open': { type: 'boolean' }, workspace: { type: 'boolean' } }),
      ...(command === 'update' && { date: { type: 'string', multiple: true }, wait: { type: 'boolean' } }) } });
  if (command === 'help' || values.help) { print(usage); return 0; }
  const manage = managedService(workspace, platform, spawn);
  if (command === 'stop') {
    manage('stop');
    print('Managed workspace stopped.');
    return 0;
  }
  const configuration = readEnvironment(workspace, environment);
  const target = connection(workspace, configuration);
  const api = jsonClient(target, fetcher);
  if (command === 'update') return update({ api, filename: target.filename, values, clock, after: marketSyncAfter(configuration.MARKET_SYNC_AFTER),
    print, readState, sleep, waitOptions });
  let build = await api('build', { offline: true });
  if (command === 'start') {
    const managed = platform === 'darwin' && (!build || values.workspace) ? manage('status') : null;
    if (values.workspace && (managed?.release || build?.releaseId)) throw new Error('The workspace already has an active immutable release');
    if (!build && !managed?.loaded) manage('start');
    for (let attempt = 0; !build && attempt < 6; attempt++) {
      await sleep(350);
      build = await api('build', { offline: true });
    }
  }
  if (!build) {
    if (command === 'status') { print(`Workspace is not responding at ${target.url}`); return 1; }
    throw new Error(`Workspace is not responding at ${target.url}`);
  }
  print(`Market Intelligence ${build.releaseId || 'workspace'} at ${target.url}`);
  if (command === 'status') {
    const status = await api('data/status');
    print(status.latestDate ? `Data through ${status.latestDate}, revision ${status.dataVersion}, calculation ${status.calculationVersion}.` : 'No market sessions are loaded.');
    printAnalysis(status, print);
    const pinned = readState(target.filename, [], build.calculationVersion).pinned;
    if (pinned) print(`Five-year job ${pinned.id} is ${pinned.status.replaceAll('_', ' ')}.`);
  }
  if (command === 'open' || command === 'start' && !values['no-open']) openBrowser(target.url, platform, spawn, workspace);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await runWorkspace(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
