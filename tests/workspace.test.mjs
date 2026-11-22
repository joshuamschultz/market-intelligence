import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createJob, openDatabase, updateJob } from '../backend/database.mjs';
import { runWorkspace } from '../scripts/workspace.mjs';

const liveCalculation = '2-be44dec1f429';
const build = { releaseId: 'verified-r11', calculationVersion: liveCalculation };
const latest = '2026-11-20';
const clock = () => new Date('2026-11-20T22:00:00Z');
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const refused = () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); };

function fixture(t, withDatabase = false) {
  const workspace = mkdtempSync(join(tmpdir(), 'market workspace '));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const output = [];
  const options = { workspace, environment: {}, platform: 'darwin', print: (line) => output.push(line), clock, sleep: async () => {} };
  let db;
  if (withDatabase) {
    mkdirSync(join(workspace, 'market data'));
    writeFileSync(join(workspace, '.env'), 'PORT=4193\nMARKET_DB="market data/captures.sqlite"\nMARKET_ACCESS_TOKEN="fake-test-token"\n');
    db = openDatabase(join(workspace, 'market data', 'captures.sqlite'));
    db.prepare("INSERT INTO meta(key,value) VALUES ('data_version','7') ON CONFLICT(key) DO UPDATE SET value='7'").run();
    t.after(() => db.close());
  }
  return { options, output, db };
}

function recordCapture(db, date, version, received) {
  const id = `capture-${version}`;
  db.prepare("INSERT INTO ingestion_runs(id,provider,dataset,scope,status,started_at,version) VALUES (?,'eodhd','bulk-eod','full','complete',?,?)")
    .run(id, date, version);
  db.prepare("INSERT INTO session_imports VALUES (?,?,?,'full',100,?,?)").run(date, id, version, received, received);
}

test('start reuses an answering immutable release and opens the local URL', async (t) => {
  const { options, output } = fixture(t);
  const commands = [];
  const spawn = (path, args, { cwd }) => { commands.push([path, args, cwd]); return { status: 0 }; };
  assert.equal(await runWorkspace([], { ...options, spawn, fetcher: async () => json(build) }), 0);
  assert.deepEqual(commands, [['/usr/bin/open', ['http://127.0.0.1:4173/'], options.workspace]]);
  assert.match(output[0], /verified-r11/);
  assert.equal(await runWorkspace(['start', '--no-open'], { ...options, spawn, fetcher: async () => json(build) }), 0);
  assert.equal(commands.length, 1);
});

test('fresh macOS start delegates to launchd, paths with spaces are arguments, and stop is explicit', async (t) => {
  const { options } = fixture(t);
  const commands = [];
  const spawn = (path, args, { cwd }) => {
    commands.push([path, args, cwd]);
    return { status: 0, stdout: JSON.stringify({ loaded: args.at(-1) !== 'status', release: null }) };
  };
  let requests = 0;
  const fetcher = async () => (++requests === 1 ? refused() : json({ ...build, releaseId: null }));
  assert.equal(await runWorkspace(['start', '--no-open', '--workspace'], { ...options, spawn, fetcher }), 0);
  assert.equal(await runWorkspace(['stop'], { ...options, spawn, fetcher: refused }), 0);
  assert.deepEqual(commands, ['status', 'start', 'stop'].map((command) =>
    [process.execPath, [join(options.workspace, 'scripts/local-service.mjs'), command], options.workspace]));
});

test('slow HTTP never causes a duplicate server launch', async (t) => {
  const { options } = fixture(t);
  let spawns = 0;
  await assert.rejects(runWorkspace(['start'], { ...options, fetcher: async () => {
    throw Object.assign(new Error('blocked HTTP'), { name: 'TimeoutError' });
  }, spawn: () => { spawns++; } }), /did not respond/);
  assert.equal(spawns, 0);
});

test('update sends only missing dates and local publication recovery, preserving partial captures', async (t) => {
  const { options, output, db } = fixture(t, true);
  recordCapture(db, '2026-11-18', 4, 55);
  recordCapture(db, '2026-11-19', 5, 98);
  recordCapture(db, latest, 6, 100);
  db.prepare("INSERT INTO daily_publications VALUES (?,6,?,7,'[]',?)").run(latest, liveCalculation, latest);
  const { id: existing } = createJob(db, 'provider-import', { date: '2026-11-16', bulk: true });
  const messages = [];
  const fetcher = async (url, request) => {
    assert.equal(url.origin, 'http://127.0.0.1:4193');
    assert.equal(request.headers.Authorization, 'Bearer fake-test-token');
    if (url.pathname === '/api/v1/build') return json(build);
    assert.equal(url.pathname, '/api/v1/data/refresh');
    assert.equal(request.method, 'POST');
    messages.push(JSON.parse(request.body));
    return json({ id: `job-${messages.length}` }, 202);
  };
  const dates = ['20', '17', '19', '16', '18'].flatMap((day) => ['--date', `2026-11-${day}`]);
  assert.equal(await runWorkspace(['update', ...dates], { ...options, fetcher }), 1);
  assert.deepEqual(messages, [
    { bulk: true, date: '2026-11-17', verifiedOnly: true, skipCaptured: true },
    { bulk: true, date: '2026-11-19', verifiedOnly: true, skipCaptured: true, localOnly: true },
  ]);
  assert.ok(output.some((line) => line.includes(existing) && line.includes('Existing daily job')));
  assert.ok(output.some((line) => line.includes('Existing prices kept')));
  assert.ok(output.some((line) => line.includes('Already captured and published')));
  assert.doesNotMatch(output.join('\n'), /fake-test-token/);
});

test('latest finalized daily date uses Eastern cutoff and no historical range', async (t) => {
  const { options } = fixture(t);
  const bodies = [];
  const fetcher = async (url, { body }) => {
    if (!body) return json(build);
    bodies.push(JSON.parse(body));
    return json({ id: 'queued' }, 202);
  };
  const run = (timestamp) => runWorkspace(['update'], { ...options, fetcher, clock: () => new Date(timestamp),
    readState: (_filename, dates) => ({ jobs: [], captures: new Map(dates.map((date) => [date, {}])) }) });
  assert.equal(await run('2026-11-20T21:29:00Z'), 0);
  assert.equal(await run('2026-11-20T21:30:00Z'), 0);
  assert.deepEqual(bodies.map(({ date }) => date), ['2026-11-19', latest]);
  assert.ok(bodies.every(({ bulk, from, to }) => bulk && !from && !to));
  await assert.rejects(runWorkspace(['update', '--date', '2026-11-21'], { ...options, fetcher }), /finalized exchange session/);
});

test('live pinned build and awaiting cutover block submissions before any API requests', async (t) => {
  const { options, db } = fixture(t, true);
  const { id } = createJob(db, 'optimized-five-year', { dataVersion: 7 });
  for (const state of ['waiting_for_space', 'building', 'awaiting_publication']) {
    updateJob(db, id, state, 40);
    assert.equal(await runWorkspace(['update'], { ...options, fetcher: () => assert.fail('pinned build must defer before contacting server') }), 2);
  }
});

test('wait confirms date-specific publication and reports whole analysis separately', async (t) => {
  const { options, output } = fixture(t);
  let polls = 0;
  const fetcher = async (url) => {
    switch (url.pathname) {
      case '/api/v1/build': return json(build);
      case '/api/v1/data/refresh': return json({ id: 'daily' }, 202);
      case '/api/v1/jobs/daily': return json(++polls < 2 ? { status: 'running' } : { status: 'complete', result: { published: [latest] } });
      case '/api/v1/data/status': return json({ latestDate: latest, dataVersion: 9, calculationVersion: liveCalculation });
      default: assert.fail(`Unexpected route ${url.pathname}`);
    }
  };
  const scoped = { ...options, fetcher, readState: (_filename, dates) => ({ jobs: [], captures: new Map(dates.map((date) => [date, {}])) }) };
  assert.equal(await runWorkspace(['update', '--wait'], scoped), 0);
  assert.equal(polls, 2);
  assert.ok(output.some((line) => line.includes('verified publication complete')));
  assert.equal(output.at(-1), 'Full analysis is not verified for this revision.');
});
