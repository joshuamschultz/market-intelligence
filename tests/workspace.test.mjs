import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createJob, importDataset, openDatabase, updateJob } from '../backend/database.mjs';
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
    for (const args of [[], ['--wait-analysis']]) {
      assert.equal(await runWorkspace(['update', ...args], { ...options,
        fetcher: () => assert.fail('pinned build must defer before contacting server') }), 2);
    }
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

function analysisStatus({ latestDate = latest, dataVersion = 9, proof = {}, state = 'ready' } = {}) {
  return { latestDate, dataVersion, calculationVersion: liveCalculation, analysisReadiness: {
    date: latestDate, dataVersion, calculationVersion: liveCalculation, state, ...proof,
  } };
}

test('wait-analysis follows daily publication and waits for the exact latest proof', async (t) => {
  const { options, output } = fixture(t);
  const requests = [];
  let rawPolls = 0;
  let elapsed = 0;
  const statuses = [
    analysisStatus({ latestDate: '2026-11-19', dataVersion: 8 }),
    analysisStatus({ proof: { dataVersion: 8 } }),
    analysisStatus({ proof: { calculationVersion: '2-081799bad3bf' } }),
    { ...analysisStatus({ state: 'preparing' }), currentReadiness: { state: 'ready' } },
    analysisStatus(),
  ];
  const fetcher = async (url, request) => {
    requests.push([url.pathname, request.method ?? 'GET']);
    switch (url.pathname) {
      case '/api/v1/build': return json(build);
      case '/api/v1/data/refresh': return json({ id: 'daily' }, 202);
      case '/api/v1/jobs/daily': return json(++rawPolls === 1 ? { status: 'running' }
        : { status: 'complete', result: { published: [latest] } });
      case '/api/v1/data/status':
        assert.equal(rawPolls, 2, 'analysis polling starts after the daily job publishes');
        return json(statuses.shift());
      default: assert.fail(`Unexpected route ${url.pathname}`);
    }
  };
  const readState = (_filename, dates) => ({ version: 9, jobs: [], captures: new Map(dates.map((date) => [date, {}])) });
  assert.equal(await runWorkspace(['update', '--wait-analysis'], { ...options, fetcher, readState,
    sleep: async (milliseconds) => { elapsed += milliseconds; }, waitOptions: { now: () => elapsed } }), 0);
  assert.equal(statuses.length, 0, 'only the final matching proof can finish the command');
  assert.deepEqual(requests.filter(([, method]) => method === 'POST'), [['/api/v1/data/refresh', 'POST']]);
  assert.ok(output.some((line) => line.includes('verified publication complete')));
  assert.match(output.at(-1), /Full analysis is ready for 2026-11-20, revision 9, calculation 2-be44dec1f429 \(10s elapsed\)/);
});

test('wait-analysis accepts the current verified baseline without a legacy daily publication or new job', async (t) => {
  const { options, output, db } = fixture(t, true);
  const { version } = importDataset(db, { provider: 'fixture', prices: [{ symbol: 'AAA', date: latest, knownAt: latest,
    open: 10, high: 11, low: 9, close: 10, volume: 1_000 }] });
  recordCapture(db, latest, version, 81);
  assert.equal(db.prepare('SELECT count(*) AS count FROM daily_publications').get().count, 0);
  let desiredVersion = version;
  const requests = [];
  const fetcher = async (url, request) => {
    assert.equal(request.method ?? 'GET', 'GET', 'current verified proof should not create a job');
    requests.push(url.pathname);
    if (url.pathname === '/api/v1/build') return json(build);
    assert.equal(url.pathname, '/api/v1/data/status');
    return json(analysisStatus({ dataVersion: desiredVersion }));
  };
  assert.equal(await runWorkspace(['update', '--wait-analysis'], { ...options, fetcher }), 0);
  assert.deepEqual(requests, ['/api/v1/build', '/api/v1/data/status']);
  assert.match(output.at(-1), new RegExp(`Full analysis is ready for ${latest}, revision ${version}`));
  desiredVersion--;
  assert.equal(await runWorkspace(['update', '--wait-analysis'], { ...options, fetcher }), 1);
  assert.match(output.at(-1), /Already captured with unverified coverage/);
});

test('wait-analysis still captures explicitly requested older sessions', async (t) => {
  const { options } = fixture(t);
  const older = '2026-11-19';
  const requests = [];
  let proofPolls = 0;
  const fetcher = async (url, request) => {
    requests.push(url.pathname);
    if (url.pathname === '/api/v1/build') return json(build);
    if (url.pathname === '/api/v1/data/refresh') {
      assert.equal(JSON.parse(request.body).date, older);
      return json({ id: 'older' }, 202);
    }
    if (url.pathname === '/api/v1/jobs/older') return json({ status: 'complete', result: { published: [older] } });
    assert.equal(url.pathname, '/api/v1/data/status');
    return json(++proofPolls === 1 ? analysisStatus({ latestDate: older }) : analysisStatus());
  };
  const readState = (_filename, dates) => ({ version: 9, latestDate: latest, jobs: [], captures: new Map(dates.map((date) => [date, {}])) });
  assert.equal(await runWorkspace(['update', '--date', older, '--wait-analysis'], { ...options, readState, fetcher }), 0);
  assert.deepEqual(requests, ['/api/v1/build', '/api/v1/data/refresh', '/api/v1/jobs/older', '/api/v1/data/status', '/api/v1/data/status']);
});

test('wait-analysis does not fall back to a date or revision older than one already observed', async (t) => {
  const { options, output } = fixture(t);
  const next = '2026-11-23';
  const statuses = [
    analysisStatus({ latestDate: next, dataVersion: 10, state: 'preparing' }),
    analysisStatus({ latestDate: next, dataVersion: 9 }),
    analysisStatus({ latestDate: latest, dataVersion: 10 }),
    analysisStatus({ latestDate: next, dataVersion: 10 }),
  ];
  const fetcher = async (url, request) => {
    assert.equal(request.method ?? 'GET', 'GET');
    if (url.pathname === '/api/v1/build') return json(build);
    assert.equal(url.pathname, '/api/v1/data/status');
    return json(statuses.shift());
  };
  const readState = (_filename, dates) => ({ version: 9, latestDate: latest, jobs: [],
    captures: new Map(dates.map((date) => [date, { published: true }])) });
  assert.equal(await runWorkspace(['update', '--wait-analysis'], { ...options, readState, fetcher }), 0);
  assert.equal(statuses.length, 0);
  assert.match(output.at(-1), /Full analysis is ready for 2026-11-23, revision 10/);
});

test('wait-analysis bounds refresh submission by the shared deadline after checking existing proof', async (t) => {
  const { options, output } = fixture(t);
  let elapsed = 0;
  let timeout;
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    timeout = milliseconds;
    return new AbortController().signal;
  });
  const readState = (_filename, dates) => ({ version: 9, latestDate: latest, jobs: [],
    captures: new Map(dates.map((date) => [date, { verified: { version: 9 } }])) });

  for (const spent of [2500, 3000]) {
    elapsed = 0;
    let submitted = 0;
    const fetcher = async (url) => {
      if (url.pathname === '/api/v1/build') return json(build);
      if (url.pathname === '/api/v1/data/refresh') {
        submitted++;
        assert.equal(timeout, 500);
        return json({ id: 'daily' }, 202);
      }
      if (url.pathname === '/api/v1/jobs/daily') return json({ status: 'complete', result: { published: [latest] } });
      assert.equal(url.pathname, '/api/v1/data/status');
      if (submitted) return json(analysisStatus());
      elapsed = spent;
      return json(analysisStatus({ state: 'preparing' }));
    };
    const result = await runWorkspace(['update', '--wait-analysis'], { ...options, readState, fetcher,
      waitOptions: { now: () => elapsed, waitMs: 3000 } });
    assert.equal(result, spent === 3000 ? 1 : 0);
    assert.equal(submitted, spent === 3000 ? 0 : 1);
  }
  assert.match(output.at(-1), /Timed out submitting the daily update/);
});

test('wait-analysis stops before submitting a refresh if preflight sees a new calculation version', async (t) => {
  const { options, output } = fixture(t);
  const requests = [];
  const readState = (_filename, dates) => ({ version: 9, latestDate: latest, jobs: [],
    captures: new Map(dates.map((date) => [date, { verified: { version: 9 } }])) });
  const fetcher = async (url, request) => {
    assert.equal(request.method ?? 'GET', 'GET');
    requests.push(url.pathname);
    if (url.pathname === '/api/v1/build') return json(build);
    assert.equal(url.pathname, '/api/v1/data/status');
    const calculationVersion = '2-081799bad3bf';
    return json({ ...analysisStatus({ state: 'preparing', proof: { calculationVersion } }), calculationVersion });
  };
  assert.equal(await runWorkspace(['update', '--wait-analysis'], { ...options, readState, fetcher }), 1);
  assert.deepEqual(requests, ['/api/v1/build', '/api/v1/data/status']);
  assert.match(output.at(-1), /calculation version changed.*--wait-analysis/);
});

test('wait-analysis times out on an unpublished proof even when daily capture is already complete', async (t) => {
  const { options, output } = fixture(t);
  let elapsed = 0;
  let polls = 0;
  const readState = (_filename, dates) => ({ version: 9, jobs: [], captures: new Map(dates.map((date) => [date, { published: true }])) });
  const fetcher = async (url) => {
    if (url.pathname === '/api/v1/build') return json(build);
    assert.equal(url.pathname, '/api/v1/data/status');
    polls++;
    return json(analysisStatus({ state: 'preparing' }));
  };
  assert.equal(await runWorkspace(['update', '--wait-analysis'], { ...options, readState, fetcher,
    sleep: async (milliseconds) => { elapsed += milliseconds; }, waitOptions: { now: () => elapsed, waitMs: 3000 } }), 1);
  assert.equal(polls, 2);
  assert.match(output.at(-1), /Timed out waiting for verified full analysis \(3s elapsed\).*npm run app -- status/);
});

test('wait-analysis reports a missing baseline or failed calculation without exposing job details', async (t) => {
  const { options, output } = fixture(t);
  const readState = (_filename, dates) => ({ version: 9, jobs: [], captures: new Map(dates.map((date) => [date, { published: true }])) });
  for (const [reason, message] of [
    ['verified_baseline_required', /Verify and publish a baseline/], ['calculation_failed', /Inspect the failed preparation job/],
  ]) {
    const fetcher = async (url) => {
      if (url.pathname === '/api/v1/build') return json(build);
      assert.equal(url.pathname, '/api/v1/data/status');
      return json(analysisStatus({ state: 'incomplete', proof: { reason, job: { error: 'private provider details' } } }));
    };
    assert.equal(await runWorkspace(['update', '--wait-analysis'], { ...options, readState, fetcher,
      sleep: () => assert.fail('terminal proof failures should return immediately') }), 1);
    assert.match(output.at(-1), message);
    assert.doesNotMatch(output.join('\n'), /private provider details/);
  }
});

test('wait-analysis fills the missing prerequisite and proves it before submitting the next date', async (t) => {
  const { options, output } = fixture(t);
  const monday = '2026-11-23';
  const tuesday = '2026-11-24';
  const mutations = [];
  const proofs = [];
  let date = latest;
  let version = 7;
  let pending = false;
  let elapsed = 0;
  const readState = (_filename, dates) => ({ version, latestDate: date, jobs: [],
    captures: new Map(dates.map((requested) => [requested, { published: requested > latest && requested <= date }])) });
  const fetcher = async (url, request) => {
    if (url.pathname === '/api/v1/build') return json(build);
    if (url.pathname === '/api/v1/data/refresh') {
      const body = JSON.parse(request.body);
      assert.equal(body.orderedDaily, true);
      assert.equal(body.calculationVersion, liveCalculation);
      if (body.date === tuesday) assert.deepEqual(proofs, [latest, monday]);
      mutations.push(body.date);
      return json({ id: body.date }, 202);
    }
    if (url.pathname.startsWith('/api/v1/jobs/')) {
      date = url.pathname.split('/').at(-1);
      version++;
      pending = true;
      return json({ status: 'complete', result: { published: [date] } });
    }
    assert.equal(url.pathname, '/api/v1/data/status');
    if (pending) {
      pending = false;
      return json(analysisStatus({ latestDate: date, dataVersion: version, state: 'preparing' }));
    }
    proofs.push(date);
    return json(analysisStatus({ latestDate: date, dataVersion: version }));
  };
  assert.equal(await runWorkspace(['update', '--date', tuesday, '--wait-analysis'], { ...options, fetcher, readState,
    clock: () => new Date('2026-11-24T22:00:00Z'), sleep: async (ms) => { elapsed += ms; },
    waitOptions: { now: () => elapsed } }), 0);
  assert.deepEqual(mutations, [monday, tuesday]);
  assert.deepEqual(proofs, [latest, monday, tuesday]);
  assert.match(output.at(-1), /Full analysis is ready for 2026-11-24, revision 9/);
});

test('a plain update selects only the next session and refuses dates beyond the verification window', async (t) => {
  const { options, output } = fixture(t);
  const submitted = [];
  let date = latest;
  let ready = true;
  const readState = (_filename, dates) => ({ version: 7, latestDate: date, jobs: [],
    captures: new Map(dates.map((requested) => [requested, requested === date ? { verified: { version: 7 } } : {}])) });
  const fetcher = async (url, request) => {
    if (url.pathname === '/api/v1/build') return json(build);
    if (url.pathname === '/api/v1/data/status') return json(analysisStatus({
      latestDate: date, dataVersion: 7, state: ready ? 'ready' : 'preparing',
    }));
    assert.equal(url.pathname, '/api/v1/data/refresh');
    submitted.push(JSON.parse(request.body));
    return json({ id: 'daily' }, 202);
  };
  const run = (flags) => runWorkspace(['update', ...flags], { ...options, fetcher, readState,
    clock: () => new Date('2026-11-24T22:00:00Z') });
  assert.equal(await run([]), 0);
  assert.equal(submitted[0].date, '2026-11-23');
  assert.equal(submitted[0].orderedDaily, true);
  date = '2026-11-23';
  ready = false;
  assert.equal(await run([]), 0);
  assert.equal(submitted[1].date, date);
  assert.equal(submitted[1].localOnly, true, 'an unfinished current date can recover its local publication');
  date = '2026-11-10';
  assert.equal(await run(['--wait-analysis']), 1);
  assert.equal(submitted.length, 2);
  assert.match(output.at(-1), /outside the provider verification window.*verified backfill/);
});

test('wait-analysis verifies an intermediate proof after the scheduler has proved a later date', async (t) => {
  const { options, output } = fixture(t);
  const monday = '2026-11-23';
  const tuesday = '2026-11-24';
  let date = monday;
  let version = 8;
  let polls = 0;
  const readState = (_filename, dates) => ({ version, latestDate: date, jobs: [],
    captures: new Map(dates.map((requested) => [requested, { published: true }])) });
  const fetcher = async (url, request) => {
    assert.equal(request.method ?? 'GET', 'GET', 'the CLI must not repull a staged session');
    if (url.pathname === '/api/v1/build') return json(build);
    if (url.pathname === '/api/v1/data/analysis-proof') {
      assert.equal(url.searchParams.get('date'), monday);
      return json({ proof: { date: monday, dataVersion: 8, calculationVersion: liveCalculation, stage: 'daily-analysis-receipt' } });
    }
    assert.equal(url.pathname, '/api/v1/data/status');
    switch (++polls) {
      case 1: return json(analysisStatus({ latestDate: monday, dataVersion: 8, state: 'preparing' }));
      case 2:
        date = tuesday;
        version = 9;
        return json({ ...analysisStatus({ latestDate: date, dataVersion: version }),
          latestAnalysis: { date, dataVersion: version, calculationVersion: liveCalculation, stage: 'daily-analysis-receipt' } });
      case 3:
        return json(analysisStatus({ latestDate: date, dataVersion: version }));
      default: assert.fail('Unexpected poll');
    }
  };
  assert.equal(await runWorkspace(['update', '--wait-analysis'], { ...options, fetcher, readState,
    clock: () => new Date('2026-11-24T22:00:00Z') }), 0);
  assert.equal(polls, 3);
  assert.ok(output.some((line) => line.includes('Full analysis is ready for 2026-11-23, revision 8')));
  assert.ok(output.at(-1).includes('Full analysis is ready for 2026-11-24, revision 9'));
});
