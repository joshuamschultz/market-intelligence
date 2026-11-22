import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, statfsSync, statSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CALCULATION_VERSION, createJob, dataVersion, updateJob } from '../backend/database.mjs';

export const fiveYearJobType = 'optimized-five-year';
const sourceVersion = 18914;
const anchor = '2026-11-20';
const sessions = 1260;
const gib = 2 ** 30;
const availableSpace = (directory) => {
  const { bavail, bsize } = statfsSync(directory);
  return bavail * bsize;
};
const benchmark = fileURLToPath(new URL('./benchmark-pipeline.mjs', import.meta.url));

export function fiveYearArguments(source, output) {
  return [benchmark, '--source', source, '--output', output, '--version', String(sourceVersion), '--to', anchor,
    '--sessions', String(sessions), '--scope', 'all', '--workers', '16', '--chunk-size', '48', '--worker-heap-mib', '4096',
    '--seed-mode', 'local', '--calibration', 'full', '--five-year-gate', '--boundary-oracle', '--full-readback', '--progress',
    '--max-output-gib', '36', '--max-pending-gib', '32'];
}

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = work();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function capacity(dataset, expected) {
  const current = dataVersion(dataset);
  if (current !== expected) throw new Error(`Source revision changed. Expected ${expected}, found ${current}.`);
}

function savedProgress(line) {
  const core = /^(breadth warmup|cold|NYSE breadth warmup) (\d{4}-\d{2}-\d{2}): shard (\d+) (compute|merge), (\d+)\/(\d+) merged sessions/.exec(line);
  if (core) {
    const [, label, date, shard, event, completed, total] = core;
    return { phase: label === 'cold' ? 'core' : label, date, shard: Number(shard), event, completed: Number(completed),
      total: Number(total), unit: 'sessions' };
  }
  const symbols = /^Range, detail and risk source pass: (\d+)\/(\d+) securities, (\d+) bytes/.exec(line);
  if (symbols) return { phase: 'instruments', completed: Number(symbols[1]), total: Number(symbols[2]), unit: 'securities', bytes: Number(symbols[3]) };
  return null;
}

async function runBenchmark({ source, output, report, log, signal, onProgress, spawnProcess }) {
  signal.throwIfAborted();
  const stdout = openSync(report, 'wx', 0o600);
  let stderr;
  try {
    stderr = openSync(log, 'wx', 0o600);
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = spawnProcess(process.execPath, fiveYearArguments(source, output), { env, stdio: ['ignore', stdout, 'pipe'] });
    let pending = '';
    let lastError;
    let childError;
    let forceStop;
    const stop = () => {
      child.kill('SIGTERM');
      forceStop = setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    try {
      await new Promise((resolve, reject) => {
        child.once('error', (error) => { childError = error; });
        child.stderr.on('data', (bytes) => {
          try {
            writeSync(stderr, bytes);
            const lines = (pending + bytes.toString('utf8')).split('\n');
            pending = lines.pop().slice(-4096);
            for (const line of lines) {
              if (/^\w*Error: /.test(line)) lastError = line.slice(0, 700);
              const progress = savedProgress(line);
              if (progress) onProgress(progress);
            }
          } catch (error) {
            childError ??= error;
            if (!forceStop) stop();
          }
        });
        child.once('close', (code, killedBy) => {
          if (signal.aborted) reject(signal.reason);
          else if (childError) reject(childError);
          else if (code !== 0) {
            if (/^\w*Error: /.test(pending)) lastError = pending.slice(0, 700);
            reject(new Error(lastError || `Benchmark exited with ${killedBy || `code ${code}`}. See ${log}.`));
          } else resolve();
        });
      });
    } finally {
      signal.removeEventListener('abort', stop);
      clearTimeout(forceStop);
    }
  } finally {
    if (stderr !== undefined) closeSync(stderr);
    closeSync(stdout);
  }
}

function verifyBuildReport(reportPath, output) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const stage = report.stages?.[0];
  const verified = stage?.verified;
  const calibration = verified?.calibration;
  const boundary = report.boundaryOracle?.find(({ phase }) => phase === 'core');
  const digest = (value) => /^[0-9a-f]{64}$/u.test(value ?? '');
  if (report.calculationVersion !== CALCULATION_VERSION || report.source !== 'read-only pinned revisions' ||
      report.sourceVersionBefore !== sourceVersion || report.sourceVersionAfter !== sourceVersion || stage?.dataVersion !== sourceVersion ||
      report.output !== output || report.scope !== 'all' || report.coverageTarget !== 'five-year' || report.calibration !== 'full' ||
      report.readback !== 'all fields on sampled sessions' || stage.to !== anchor || stage.sessions < sessions || stage.recipes < 1 ||
      stage.recipes !== stage.availableRecipes || !digest(stage.recipeDigest) || !stage.sourcePin ||
      stage.sourcePin.dataVersion !== sourceVersion || stage.sourcePin.calculationVersion !== CALCULATION_VERSION ||
      !digest(stage.sourcePin.sourceHash) || !digest(stage.sourcePin.contextHash) ||
      !report.archive?.bytes || report.archive.bytes !== statSync(output).size || !digest(report.archive.sha256) ||
      !(report.elapsedMs > 0) || !(boundary?.sessions > 0) || !(boundary.velocitySnapshots > 0) || !(boundary.leaderContexts > 0) ||
      !(verified?.detailProducts > 0) || !(verified.risk?.riskBlocks > 0) || !(verified.ranges?.pairs > 0) ||
      !calibration?.breadth?.recipes || calibration.breadth.readyRecipes !== calibration.breadth.recipes ||
      calibration.breadth.readyPairs !== calibration.breadth.requestedPairs || calibration.health?.missing !== 0 ||
      calibration.sum?.state !== 'prepared' || calibration.sum.verified !== stage.sessions) {
    throw new Error(`Benchmark report did not verify the complete five-year archive. See ${reportPath}.`);
  }
  return { stage: 'awaiting_publication', sessions: stage.sessions, recipes: stage.recipes, recipeDigest: stage.recipeDigest,
    archive: report.archive, elapsedMs: report.elapsedMs, totalElapsedMs: report.totalElapsedMs, targetSeconds: 600,
    targetMet: report.elapsedMs <= 600_000, boundaryOracle: report.boundaryOracle, readback: report.readback };
}

export async function runFiveYearBuild({
  source = 'data/market.sqlite', outputRoot = 'data/performance-wave-1', signal = new AbortController().signal,
  freeBytes = availableSpace, pollMs = 15_000, drainTimeoutMs = 300_000, spawnProcess = spawn, onRegistered = () => {},
} = {}) {
  const required = 40 * gib;
  source = resolve(source);
  outputRoot = resolve(outputRoot);
  if (!existsSync(source)) throw new Error(`Source warehouse is missing: ${source}`);
  const db = new DatabaseSync(source);
  const ownerTtl = Math.max(120, Math.ceil(4 * pollMs / 1000));
  const ownerAlive = `unixepoch(updated_at) >= unixepoch('now') - ${ownerTtl}`;
  let job;
  let trigger;
  let heartbeat;
  let info;
  let lastProgress;
  let began;
  const setStatus = (status, progress, extra, error = null) =>
    updateJob(db, job.id, status, progress, { ...info, heartbeatAt: new Date().toISOString(), ...extra }, error);
  try {
    db.exec('PRAGMA busy_timeout=5000');
    transaction(db, () => {
      capacity(db, sourceVersion);
      const prior = db.prepare(`SELECT id FROM jobs WHERE type=? AND
        ((status IN ('waiting_for_space','building') AND ${ownerAlive}) OR
          (status='awaiting_publication' AND json_extract(payload,'$.calculationVersion')=? AND json_extract(payload,'$.dataVersion')=?))
        LIMIT 1`).get(fiveYearJobType, CALCULATION_VERSION, sourceVersion);
      if (prior) throw new Error(`Five-year preparation already has an active or verified job: ${prior.id}`);
      mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
      const directory = mkdtempSync(join(outputRoot, 'fiveyear-'));
      info = { directory, output: join(directory, 'derived.sqlite'), report: join(directory, 'benchmark.json'), log: join(directory, 'progress.log'),
        requiredBytes: required, dataVersion: sourceVersion, calculationVersion: CALCULATION_VERSION, sessions };
      job = createJob(db, fiveYearJobType, { label: 'Prepare five years of market analytics', ...info });
      setStatus('waiting_for_space', 0, { stage: 'waiting_for_space', availableBytes: freeBytes(directory) });
    });
    onRegistered({ jobId: job.id, ...info });
    let drainStarted;
    while (true) {
      signal.throwIfAborted();
      capacity(db, sourceVersion);
      const availableBytes = freeBytes(info.directory);
      if (availableBytes >= required) {
        const acquired = transaction(db, () => {
          capacity(db, sourceVersion);
          if (db.prepare("SELECT 1 FROM jobs WHERE status='running' LIMIT 1").get()) return false;
          const name = `fiveyear_claim_${job.id.replaceAll('-', '')}`;
          db.exec(`CREATE TRIGGER ${name} BEFORE UPDATE OF status ON jobs
            WHEN OLD.status='queued' AND NEW.status='running' AND NEW.type<>'chartbook-industry'
              AND EXISTS(SELECT 1 FROM jobs WHERE id='${job.id}' AND status='building' AND ${ownerAlive})
            BEGIN SELECT RAISE(IGNORE); END`);
          setStatus('building', 1, { stage: 'starting', availableBytes });
          trigger = name;
          return true;
        });
        if (acquired) break;
        drainStarted ??= Date.now();
        if (Date.now() - drainStarted >= drainTimeoutMs) throw new Error('An existing background job did not reach a checkpoint before the claim timeout.');
      } else drainStarted = undefined;
      setStatus('waiting_for_space', 0, { stage: availableBytes >= required ? 'waiting_for_existing_job' : 'waiting_for_space', availableBytes });
      await delay(pollMs, undefined, { signal });
    }

    const monitor = new AbortController();
    began = Date.now();
    heartbeat = setInterval(() => {
      try {
        capacity(db, sourceVersion);
        setStatus('building', 1, { stage: lastProgress?.phase ?? 'starting', ...lastProgress,
          availableBytes: freeBytes(info.directory), wallElapsedMs: Date.now() - began });
      } catch (error) { monitor.abort(error); }
    }, pollMs);
    await runBenchmark({ source, ...info, spawnProcess, signal: AbortSignal.any([signal, monitor.signal]),
      onProgress: (progress) => { lastProgress = progress; } });
    capacity(db, sourceVersion);
    const verified = verifyBuildReport(info.report, info.output);
    return setStatus('awaiting_publication', 97, verified);
  } catch (error) {
    const failure = signal.aborted ? signal.reason : error;
    if (job) setStatus(signal.aborted ? 'interrupted' : 'failed', 0, {
      stage: signal.aborted ? 'interrupted' : 'failed', lastProgress, wallElapsedMs: began ? Date.now() - began : 0,
    }, failure?.message ?? String(failure));
    throw failure;
  } finally {
    clearInterval(heartbeat);
    try { if (trigger) db.exec(`DROP TRIGGER IF EXISTS ${trigger}`); }
    finally { db.close(); }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { source: { type: 'string' }, 'output-root': { type: 'string' } } });
  const controller = new AbortController();
  for (const name of ['SIGTERM', 'SIGINT']) process.on(name, () => controller.abort(new Error(`Interrupted by ${name}.`)));
  try {
    const result = await runFiveYearBuild({ source: values.source, outputRoot: values['output-root'], signal: controller.signal,
      onRegistered: (job) => console.log(JSON.stringify(job)) });
    console.log(JSON.stringify({ id: result.id, status: result.status, ...result.result }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = controller.signal.aborted ? 130 : 1;
  }
}
