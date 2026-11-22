import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bulkSessionStatus, CALCULATION_VERSION, dailyPublication, openDatabase } from './database.mjs';
import { expectedSessions, latestFinalizableSession, shiftDate } from './calendar.mjs';
import { journalDueDate } from './journal.mjs';
import { createService, dailyCaptureAvailability, defaultMarketSyncAfter, hasUnprovedDailyGap, marketSyncAfter,
  orderedDailyPoint, orderedDailyTarget, scheduledJournalReadiness, scheduledPrecomputeKey } from './service.mjs';
import { runningRelease } from '../scripts/release.mjs';

const publicDir = fileURLToPath(new URL('../frontend/', import.meta.url));
const backendDir = fileURLToPath(new URL('./', import.meta.url));
const codeRoot = fileURLToPath(new URL('../', import.meta.url));
const packagePath = resolve(codeRoot, 'package.json');
const release = runningRelease(resolve(codeRoot));
const contentTypes = new Map([
  ['html', 'text/html; charset=utf-8'],
  ['css', 'text/css; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'],
  ['svg', 'image/svg+xml'],
  ['json', 'application/json; charset=utf-8'],
  ['png', 'image/png'],
  ['ico', 'image/x-icon'],
]);
const commonHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
};
const loopbackNames = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

async function readBody(request) {
  const maxBytes = 30 * 1024 * 1024;
  if (Number(request.headers['content-length']) > maxBytes) throw Object.assign(new Error('Request exceeds the 30 MB limit'), { status: 413 });
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error('Request exceeds the 30 MB limit'), { status: 413 });
    chunks.push(chunk);
  }
  if (!total) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Request body must be JSON'), { status: 400 }); }
}

function authorized(request, token) {
  if (!token) return true;
  const header = request.headers.authorization || '';
  let provided;
  if (header.startsWith('Bearer ')) provided = header.slice(7);
  else if (header.startsWith('Basic ')) provided = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':');
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

let workspaceBuild;
export async function buildInformation() {
  if (release) {
    const { releaseId, appVersion, buildHash, builtAt, deployment } = release;
    return { appVersion, releaseId, buildHash, calculationVersion: CALCULATION_VERSION, deployment, builtAt,
      version: `${CALCULATION_VERSION}.${buildHash}` };
  }
  const folders = await Promise.all([publicDir, backendDir].map(async (folder) => (await readdir(folder, { withFileTypes: true }))
    .filter((entry) => entry.isFile()).map((entry) => resolve(folder, entry.name))));
  const files = [packagePath, ...folders.flat()].sort();
  const modified = await Promise.all(files.map((file) => stat(file).then(({ mtimeMs, size }) => [mtimeMs, size])));
  const signature = JSON.stringify([files, modified]);
  if (workspaceBuild?.signature === signature) return workspaceBuild.metadata;
  const contents = await Promise.all(files.map((file) => readFile(file)));
  const hash = createHash('sha256');
  for (const [index, file] of files.entries()) {
    hash.update(file.slice(codeRoot.length)).update(':').update(String(contents[index].length)).update(':').update(contents[index]);
  }
  const buildHash = hash.digest('hex');
  const metadata = { appVersion: JSON.parse(contents[files.indexOf(packagePath)]).version, releaseId: null, buildHash,
    calculationVersion: CALCULATION_VERSION, deployment: 'workspace', builtAt: null, version: `${CALCULATION_VERSION}.${buildHash}` };
  workspaceBuild = { signature, metadata };
  return metadata;
}

export function createHandler({ service, token = '', host = '127.0.0.1' }) {
  const isLocal = loopbackNames.has(host);
  return async (req, res) => {
    const send = (status, headers, body) => {
      res.writeHead(status, { ...commonHeaders, ...headers });
      res.end(req.method === 'HEAD' ? null : body);
    };
    const json = (status, body, headers = {}) => send(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }, JSON.stringify(body));
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      const hostname = new URL(`http://${req.headers.host || 'localhost'}`).hostname;
      if (isLocal && !loopbackNames.has(hostname)) return json(403, { error: 'Use the local workspace address' });
      if (!authorized(req, token)) return json(401, { error: 'Workspace authentication required' }, { 'WWW-Authenticate': 'Basic realm="Market Intelligence", charset="UTF-8"' });
      if (pathname.startsWith('/api/v1/')) {
        if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
          const remote = new URL(req.headers.origin).host;
          if (remote !== req.headers.host) return json(403, { error: 'Cross-origin mutation is denied' });
        }
        if (pathname === '/api/v1/build' && ['GET', 'HEAD'].includes(req.method)) return json(200, await buildInformation());
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
        const outcome = await service.dispatch({ method: req.method === 'HEAD' ? 'GET' : req.method, url: req.url, body });
        const result = pathname === '/api/v1/config' && outcome.status === 200
          ? { ...outcome.body, build: await buildInformation() } : outcome.body;
        return send(outcome.status, outcome.headers, typeof result === 'string' || Buffer.isBuffer(result) ? result : JSON.stringify(result));
      }
      if (!['GET', 'HEAD'].includes(req.method)) return json(405, { error: 'Method not allowed' });
      const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (!/^[A-Za-z0-9_-]+\.(?:html|css|js|svg|json|png|ico)$/.test(filename)) return json(404, { error: 'Route not found' });
      const type = contentTypes.get(filename.split('.').at(-1));
      const content = await readFile(resolve(publicDir, filename));
      return send(200, { 'Content-Type': type }, content);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const status = error.status || (error.code === 'ENOENT' ? 404 : 500);
      if (status === 500) console.error('Workspace request failed:', error.message);
      return json(status, { error: status === 404 ? 'Route not found' : status === 500 ? 'Request failed' : error.message });
    }
  };
}

export function createDailyTick(service, db, { after = defaultMarketSyncAfter, providerEnabled = false,
  config = process.env, now = () => new Date() } = {}) {
  after = marketSyncAfter(after);
  const eligible = (date) => bulkSessionStatus(db, date, { verifiedOnly: true });
  const active = db.prepare("SELECT 1 FROM jobs WHERE type=? AND status IN ('queued','running') LIMIT 1");
  const completedNasdaq = db.prepare(`SELECT 1 FROM jobs WHERE type='nasdaq-refresh' AND status='complete'
    AND json_extract(result, '$.captureDate')>=? UNION ALL SELECT 1 FROM ingestion_runs WHERE provider='nasdaq'
    AND dataset LIKE 'stocks-screener:%' AND status='complete' AND json_extract(detail, '$.catalogDate')>=? LIMIT 1`);
  const completedReference = db.prepare("SELECT 1 FROM jobs WHERE type='provider-reference' AND status='complete' AND json_extract(result, '$.referenceDate')>=? LIMIT 1");
  const scheduledBackups = db.prepare(`SELECT status,updated_at FROM jobs WHERE type='backup'
    AND json_extract(payload,'$.scheduledFor')=? ORDER BY rowid`);
  const lastAttempts = new Map();
  const retryInterval = 30 * 60 * 1000;
  const attemptDue = (stage, scope, stamp) => {
    const last = lastAttempts.get(stage);
    return last?.scope !== scope || stamp - last.stamp > retryInterval;
  };
  const attempted = (stage, scope, stamp) => lastAttempts.set(stage, { scope, stamp });
  return () => {
    const clock = now();
    const finalized = latestFinalizableSession(clock, after);
    const stamp = clock.getTime();
    const nasdaqEnabled = config.MARKET_NASDAQ_SYNC === '1';
    const referenceEnabled = providerEnabled && config.MARKET_REFERENCE_SYNC === '1';
    const precomputeEnabled = config.MARKET_PRECOMPUTE === '1';
    const ordered = precomputeEnabled ? orderedDailyPoint(db) : null;
    if (ordered?.date > finalized) return;
    const date = ordered ? orderedDailyTarget(ordered, finalized) : finalized;
    const alreadyReady = ordered?.date === date && ordered.ready;
    const receipt = eligible(date);
    const publication = dailyPublication(db, date, receipt?.version);
    const availability = dailyCaptureAvailability(db, date, clock, after, { ordered: precomputeEnabled });
    const sourcesActive = ['provider-import', 'provider-bootstrap', 'provider-reference', 'nasdaq-refresh'].some((type) => active.get(type));
    // A pin without an adjacent proof cannot be repaired by importing more source facts.
    const backfillRequired = precomputeEnabled && ordered.date === date && !alreadyReady && hasUnprovedDailyGap(db, ordered);
    if (!alreadyReady && !backfillRequired && (precomputeEnabled ? !sourcesActive : !active.get('provider-import'))) {
      if (providerEnabled && availability.due) {
        const captureAttempt = availability.attempts + 1;
        service.enqueue('provider-import', { bulk: true, date, scheduledFor: date, captureAttempt, verifiedOnly: true,
          skipCaptured: true, force: !!availability.receipt, ...(precomputeEnabled && { orderedDaily: true }) },
        `daily-capture:${date}:${captureAttempt}`);
      } else if ((providerEnabled || precomputeEnabled) && attemptDue('publication', date, stamp)) {
        const recovery = precomputeEnabled ? receipt && !publication && date
          : expectedSessions(shiftDate(date, -5), date).slice(-3).find((session) => {
            const receipt = eligible(session);
            return receipt && !dailyPublication(db, session, receipt.version);
          });
        if (recovery) {
          attempted('publication', date, stamp);
          service.enqueue('provider-import', { bulk: true, date: recovery, verifiedOnly: true, skipCaptured: true, localOnly: true,
            ...(precomputeEnabled && { orderedDaily: true }) }, `daily-publication:${recovery}:${eligible(recovery).version}`);
        }
      }
    }
    const referenceRequired = referenceEnabled && !backfillRequired;
    const nasdaqRequired = nasdaqEnabled && !backfillRequired;
    if (publication && !alreadyReady && referenceRequired && !completedReference.get(date) && !active.get('provider-reference')
        && attemptDue('reference', date, stamp)) {
      attempted('reference', date, stamp);
      service.enqueue('provider-reference', { scheduledFor: date, ...(precomputeEnabled && { orderedDaily: true }) });
    }
    if (publication && !alreadyReady && nasdaqRequired && !completedNasdaq.get(date, date) && !active.get('nasdaq-refresh')
        && attemptDue('nasdaq', date, stamp)) {
      attempted('nasdaq', date, stamp);
      service.enqueue('nasdaq-refresh', { scheduledFor: date, ...(precomputeEnabled && { orderedDaily: true }) });
    }
    const readiness = publication || alreadyReady ? scheduledJournalReadiness(db, {
      date, nasdaqEnabled: nasdaqRequired, referenceEnabled: referenceRequired, precomputeEnabled,
    }) : null;
    const preparationKey = readiness?.dataVersion && scheduledPrecomputeKey(date, readiness.dataVersion);
    if (['waiting_for_precompute', 'precompute_failed'].includes(readiness?.state)
        && !['production-precompute', 'workspace-precompute', 'rank-materialize', 'materialize'].some((type) => active.get(type))
        && attemptDue('precompute', preparationKey, stamp)) {
      attempted('precompute', preparationKey, stamp);
      service.enqueue('production-precompute', { scheduledFor: date,
        context: { ...service.workspaceConfiguration(), date, dataVersion: readiness.dataVersion },
      }, preparationKey);
    }
    const scope = readiness?.state === 'ready' ? service.journalConfiguration() : null;
    const journalDate = scope && journalDueDate(db, { publishedDate: date, scope, now: clock });
    if (journalDate && !active.get('journal-generate') && attemptDue('journal', journalDate, stamp)) {
      attempted('journal', journalDate, stamp);
      service.enqueue('journal-generate', { asOfDate: journalDate, context: { dataVersion: readiness.dataVersion,
        universe: scope.universe, universeVersion: scope.universeVersion, basis: scope.basis, benchmark: scope.benchmark,
        model: scope.analysisModel, modelVersion: scope.analysisModelVersion, classification: scope.classification,
        reference: scope.referenceMode }, includeNotes: false });
    }
    const backups = config.MARKET_BACKUP === '1' ? scheduledBackups.all(date) : [];
    const backupAttempt = backups.length + 1;
    const backupDue = !backups.some(({ status }) => ['complete', 'queued', 'running'].includes(status))
      && backupAttempt <= 3 && (backupAttempt === 1 || stamp - Date.parse(backups.at(-1).updated_at) >= retryInterval);
    if (readiness?.state === 'ready' && config.MARKET_BACKUP === '1' && backupDue &&
        !['backup', 'provider-bootstrap', 'provider-import', 'production-precompute', 'workspace-precompute', 'rank-materialize', 'materialize',
          'provider-reference', 'nasdaq-refresh', 'journal-generate'].some((type) => active.get(type))) {
      service.enqueue('backup', { format: 'sqlite', scheduledFor: date, backupAttempt, retain: config.MARKET_BACKUP_RETAIN ?? null },
        backupAttempt === 1 ? `backup:${date}` : `backup:${date}:${backupAttempt}`);
    }
    if (precomputeEnabled && readiness?.state === 'ready') service.prepareStandard?.({ date, version: readiness.dataVersion });
    else if (precomputeEnabled && !publication && (!providerEnabled || availability.state === 'exhausted') &&
      !['provider-import', 'provider-bootstrap', 'provider-reference', 'nasdaq-refresh'].some((type) => active.get(type))) {
      service.prepareStandard?.({ date });
    }
  };
}

function schedule(service, db, after, providerEnabled) {
  const tick = createDailyTick(service, db, { after, providerEnabled });
  const run = () => {
    try { tick(); } catch (error) { console.error('Daily workspace update failed:', error.message); }
  };
  const timer = setInterval(run, 60_000);
  run();
  timer.unref();
  return timer;
}

export function startServer() {
  try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const cutoff = marketSyncAfter(process.env.MARKET_SYNC_AFTER);
  process.env.MARKET_SYNC_AFTER = cutoff;
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 4173);
  const token = process.env.MARKET_ACCESS_TOKEN || '';
  if (!loopbackNames.has(host) && token.length < 20) throw new Error('Set a workspace access token of at least 20 characters before using a non-loopback address');
  const db = openDatabase();
  db.prepare("UPDATE jobs SET status='failed', error='Workspace stopped before job completion' WHERE status='running'").run();
  const service = createService({ db });
  const server = createServer(createHandler({ service, token, host }));
  const timer = schedule(service, db, cutoff,
    process.env.MARKET_SYNC === '1' && Boolean(process.env.EODHD_API_KEY));
  server.on('close', () => { clearInterval(timer); db.close(); });
  server.listen(port, host, () => console.log(`Market Intelligence at http://${host.includes(':') ? `[${host}]` : host}:${port}`));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) startServer();
