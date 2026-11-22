import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { CALCULATION_VERSION, createJob, jobById, openDatabase, updateJob } from '../backend/database.mjs';
import { fiveYearArguments, fiveYearJobType, runFiveYearBuild } from '../scripts/run-fiveyear-build.mjs';

const gib = 2 ** 30;
const nodeChild = (script, options) => spawn(process.execPath, ['-e', script], options);
const testSource = 18914;
const sampleBytes = 'verified archive fixture';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'market-fiveyear-test-'));
  const source = join(directory, 'source.sqlite');
  const db = openDatabase(source);
  db.prepare('INSERT INTO meta VALUES(?,?)').run('data_version', String(testSource));
  db.exec('CREATE TRIGGER unrelated_feature AFTER UPDATE ON jobs BEGIN SELECT 1; END');
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const triggers = () => db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' ORDER BY name").all().map(({ name }) => name);
  return { db, source, triggers, options: { source, outputRoot: directory, freeBytes: () => 42 * gib, pollMs: 10 } };
}

async function until(check) {
  const end = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < end, 'timed out awaiting job state');
    await delay(10);
  }
}

function result(output, overrides = {}) {
  const digest = 'a'.repeat(64);
  return { output, source: 'read-only pinned revisions', sourceVersionBefore: testSource, sourceVersionAfter: testSource,
    calculationVersion: CALCULATION_VERSION, scope: 'all', coverageTarget: 'five-year', calibration: 'full',
    readback: 'all fields on sampled sessions', elapsedMs: 672000, totalElapsedMs: 705000,
    boundaryOracle: [{ phase: 'core', sessions: 54, velocitySnapshots: 54, leaderContexts: 54 }],
    archive: { bytes: sampleBytes.length, sha256: createHash('sha256').update(sampleBytes).digest('hex') },
    stages: [{ from: '2021-11-15', to: '2026-11-20', dataVersion: testSource, sessions: 1260, recipes: 86, availableRecipes: 86,
      sourcePin: { dataVersion: testSource, calculationVersion: CALCULATION_VERSION, sourceHash: digest, contextHash: digest },
      recipeDigest: digest, verified: { detailProducts: 10007, risk: { riskBlocks: 30021 }, ranges: { pairs: 2520 },
        calibration: { breadth: { recipes: 86, readyRecipes: 86, requestedPairs: 86, readyPairs: 86 },
          health: { missing: 0 }, sum: { state: 'prepared', verified: 1260 } } } }], ...overrides };
}

test('five-year runner pins the complete benchmark command and waits below capacity without starting a child', async (t) => {
  assert.deepEqual(fiveYearArguments('/market.sqlite', '/derived.sqlite').slice(1),
    ['--source', '/market.sqlite', '--output', '/derived.sqlite', '--version', '18914', '--to', '2026-11-20', '--sessions', '1260',
      '--scope', 'all', '--workers', '16', '--chunk-size', '48', '--worker-heap-mib', '4096', '--seed-mode', 'local',
      '--calibration', 'full', '--five-year-gate', '--boundary-oracle', '--full-readback', '--progress',
      '--max-output-gib', '36', '--max-pending-gib', '32']);
  const { db, options, triggers } = fixture(t);
  const abort = new AbortController();
  let registered;
  let launched = false;
  const build = runFiveYearBuild({ ...options, freeBytes: () => 39 * gib, signal: abort.signal, onRegistered: (job) => { registered = job; },
    spawnProcess: () => { launched = true; throw new Error('child started before space was ready'); } });
  const rejection = assert.rejects(build, /test stop/);
  await until(() => registered && jobById(db, registered.jobId)?.status === 'waiting_for_space');
  assert.equal(launched, false);
  const waiting = jobById(db, registered.jobId);
  assert.equal(waiting.type, fiveYearJobType);
  assert.equal(waiting.result.availableBytes, 39 * gib);
  assert.equal(waiting.result.requiredBytes, 40 * gib);
  assert.equal(existsSync(registered.output), false);
  assert.deepEqual(triggers(), ['unrelated_feature']);
  abort.abort(new Error('test stop'));
  await rejection;
  assert.equal(jobById(db, registered.jobId).status, 'interrupted');
  assert.deepEqual(triggers(), ['unrelated_feature']);
});

test('capacity transition waits for an active job, gates other claims, records progress, and awaits publication', async (t) => {
  const { db, options, triggers } = fixture(t);
  const active = createJob(db, 'prepare-context', {});
  updateJob(db, active.id, 'running', 23);
  const legacy = createJob(db, 'prepare-context', {});
  const chartBook = createJob(db, 'chartbook-industry', {});
  let bytes = 30 * gib;
  let registered;
  let launched = false;
  const build = runFiveYearBuild({ ...options, freeBytes: () => bytes, onRegistered: (job) => { registered = job; },
    spawnProcess: (_exec, args, childOptions) => {
      launched = true;
      assert.equal(args[4], registered.output);
      assert.deepEqual(triggers().filter((name) => name.startsWith('fiveyear_claim_')).length, 1);
      assert.equal(db.prepare("UPDATE jobs SET status='running' WHERE id=? RETURNING id").get(legacy.id), undefined);
      assert.equal(db.prepare("UPDATE jobs SET status='running' WHERE id=? RETURNING id").get(chartBook.id).id, chartBook.id);
      updateJob(db, chartBook.id, 'complete', 100);
      return nodeChild(`
        const fs = require('node:fs');
        fs.writeFileSync(${JSON.stringify(registered.output)}, ${JSON.stringify(sampleBytes)});
        console.error('cold 2026-10-02: shard 3 merge, 120/1260 merged sessions, 123 verified shard bytes');
        setTimeout(() => console.log(${JSON.stringify(JSON.stringify(result(registered.output)))}), 200);
      `, childOptions);
    } });
  await until(() => registered && jobById(db, registered.jobId).status === 'waiting_for_space');
  bytes = 42 * gib;
  await until(() => jobById(db, registered.jobId).result.stage === 'waiting_for_existing_job');
  assert.equal(launched, false);
  assert.equal(jobById(db, active.id).status, 'running');
  updateJob(db, active.id, 'complete', 100);
  await until(() => jobById(db, registered.jobId).result.completed === 120);
  assert.equal(jobById(db, registered.jobId).status, 'building');
  const finished = await build;
  assert.equal(finished.status, 'awaiting_publication');
  assert.equal(finished.progress, 97);
  assert.equal(finished.result.targetMet, false);
  assert.equal(finished.result.sessions, 1260);
  assert.ok(readFileSync(registered.log, 'utf8').includes('120/1260'));
  assert.equal(statSync(registered.log).mode & 0o777, 0o600);
  assert.equal(statSync(registered.report).mode & 0o777, 0o600);
  assert.deepEqual(triggers(), ['unrelated_feature']);
  assert.equal(db.prepare("UPDATE jobs SET status='running' WHERE id=? RETURNING id").get(legacy.id).id, legacy.id);
});

test('benchmark failure keeps its partial archive and log and drops only its own trigger', async (t) => {
  const { db, options, triggers } = fixture(t);
  let registered;
  const build = runFiveYearBuild({ ...options, onRegistered: (job) => { registered = job; },
    spawnProcess: (_exec, _args, childOptions) => nodeChild(`
      require('node:fs').writeFileSync(${JSON.stringify(registered.output)}, 'partial');
      console.error('Error: Insufficient pending shard space');
      process.exitCode = 8;
    `, childOptions) });
  await assert.rejects(build, /Insufficient pending shard space/);
  assert.equal(jobById(db, registered.jobId).status, 'failed');
  assert.equal(readFileSync(registered.output, 'utf8'), 'partial');
  assert.match(readFileSync(registered.log, 'utf8'), /Insufficient pending shard space/);
  assert.deepEqual(triggers(), ['unrelated_feature']);
});

test('interrupting a running build ends the child and releases its claim gate', async (t) => {
  const { db, options, triggers } = fixture(t);
  const controller = new AbortController();
  let registered;
  let child;
  const build = runFiveYearBuild({ ...options, signal: controller.signal, onRegistered: (job) => { registered = job; },
    spawnProcess: (_exec, _args, childOptions) => {
      child = nodeChild("console.error('Range, detail and risk source pass: 512/10007 securities, 1234 bytes'); setInterval(() => {}, 1000)", childOptions);
      return child;
    } });
  const rejection = assert.rejects(build, /interrupt build/);
  await until(() => registered && jobById(db, registered.jobId).result.completed === 512);
  controller.abort(new Error('interrupt build'));
  await rejection;
  assert.equal(child.signalCode, 'SIGTERM');
  assert.equal(jobById(db, registered.jobId).status, 'interrupted');
  assert.deepEqual(triggers(), ['unrelated_feature']);
});

test('an exit-zero result missing the boundary oracle remains failed', async (t) => {
  const { db, options, triggers } = fixture(t);
  let registered;
  const build = runFiveYearBuild({ ...options, onRegistered: (job) => { registered = job; },
    spawnProcess: (_exec, _args, childOptions) => nodeChild(`
      require('node:fs').writeFileSync(${JSON.stringify(registered.output)}, ${JSON.stringify(sampleBytes)});
      console.log(${JSON.stringify(JSON.stringify(result(registered.output, { boundaryOracle: null })))});
    `, childOptions) });
  await assert.rejects(build, /did not verify the complete five-year archive/);
  assert.equal(jobById(db, registered.jobId).status, 'failed');
  assert.deepEqual(triggers(), ['unrelated_feature']);
});
