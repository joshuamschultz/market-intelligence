import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createResearchAccess, workspaceCreateScope } from '../backend/ai-access.mjs';
import { createResearchEngine } from '../backend/ai-research.mjs';
import { createResearchWorkspaceWriter } from '../backend/ai-workspace-writes.mjs';
import { CALCULATION_VERSION, dataVersion, getWorkspace, importDataset, listWorkspace, openDatabase, storeWorkspace } from '../backend/database.mjs';
import { analysisWorkspaceScopeHash } from '../backend/analysis-readiness.mjs';
import { createHandler } from '../backend/server.mjs';

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const sendJson = (token) => ({ ...bearer(token), 'Content-Type': 'application/json' });
const adminToken = 'workspace-test-password';
const clientInfo = { name: 'workspace-write-test', version: '1.0.0' };
const currentDate = '2026-11-20';
const pendingScreen = { name: 'Liquid leaders', idempotencyKey: 'screen-1', fields: ['symbol', 'close'],
  filters: [{ field: 'close', op: 'between', value: [10, 100] }, { field: 'traded', op: 'true' }],
  sort: [{ field: 'close', direction: 'desc' }] };

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'market research writes '));
  const filename = join(directory, 'warehouse.sqlite');
  const db = openDatabase(filename);
  const { version } = importDataset(db, { provider: 'fixture', securities: [
    { symbol: 'ALFA', securityId: 'fixture:ALFA' }, { symbol: 'BETA', securityId: 'fixture:BETA' },
    { symbol: 'DUPE', securityId: 'fixture:duplicate-one' }, { symbol: 'DUPE', securityId: 'fixture:duplicate-two' },
    { symbol: 'OLD', securityId: 'fixture:OLD', listingDate: '2022-01-01', delistingDate: '2024-01-01' },
  ].map((item) => ({ ...item, exchange: 'NYSE', type: 'common' })), prices: [{ symbol: 'ALFA', date: currentDate,
    open: 10, high: 11, low: 9, close: 10, volume: 1000 }] });
  const readOnly = new DatabaseSync(filename, { readOnly: true });
  const access = createResearchAccess({ filename: `${filename}.research-access.sqlite` });
  const workspaceWriter = createResearchWorkspaceWriter(filename, { now: () => new Date(`${currentDate}T21:00:00Z`) });
  const research = createResearchEngine(readOnly, { workspaceWriter });
  const service = { dispatch: () => assert.fail('Research tools must not dispatch through the workspace API') };
  const server = createServer(createHandler({ service, token: adminToken, access, research }));
  t.after(() => {
    server.close(); server.closeAllConnections();
    access.close(); readOnly.close(); db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = new URL(`http://127.0.0.1:${server.address().port}`);
  const url = (path) => new URL(path, base);
  const post = (token, name, input) => fetch(url(`/research/v1/tools/${name}`), {
    method: 'POST', headers: sendJson(token), body: JSON.stringify(input),
  });
  const permissions = (id, scopes, token = adminToken) => fetch(url(`/api/v1/research-access/${id}`), {
    method: 'PATCH', headers: sendJson(token), body: JSON.stringify({ scopes }),
  });
  const hasReceipts = () => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='research_workspace_creations'").get());
  return { filename, db, access, version, url, post, permissions, hasReceipts };
}

test('REST workspace writes require explicit permission and atomically bind scoped retries to the original version', async (t) => {
  const { db, version, access, url, post, permissions, hasReceipts } = await fixture(t);
  const { integration, token } = access.create({ name: 'Existing integration', scopes: ['research:notes'] });
  const other = access.create({ name: 'Other integration', scopes: [workspaceCreateScope] });
  const watch = { name: 'Research watchlist', idempotencyKey: 'watch-1', members: ['alfa.us', 'fixture:BETA', 'ALFA', 'fixture:OLD'] };
  const toolNames = async () => (await (await fetch(url('/research/v1/tools'), { headers: bearer(token) })).json()).tools;
  const openApi = async () => (await (await fetch(url('/research/v1/openapi.json'), { headers: bearer(token) })).json()).paths;
  assert.ok(!(await toolNames()).some(({ name }) => name.startsWith('create_')));
  assert.equal((await openApi())['/research/v1/tools/create_screen'], undefined);
  assert.equal((await post(token, 'create_watchlist', watch)).status, 403);
  assert.equal((await permissions(integration.id, [workspaceCreateScope], token)).status, 401);
  assert.equal(hasReceipts(), false);

  const patched = await permissions(integration.id, ['research:notes', workspaceCreateScope]);
  assert.equal(patched.status, 200);
  assert.deepEqual(await patched.json(), { integration: { ...integration, scopes: ['research:read', 'research:notes', workspaceCreateScope] } });
  const writes = (await toolNames()).filter(({ name }) => name.startsWith('create_'));
  assert.deepEqual(writes.map(({ name }) => name), ['create_watchlist', 'create_screen']);
  assert.ok(writes.every(({ annotations }) => !annotations.readOnlyHint && !annotations.destructiveHint && annotations.idempotentHint));
  assert.ok((await openApi())['/research/v1/tools/create_screen'].post.responses[409]);

  for (const member of ['UNKNOWN', 'DUPE', 'OLD']) {
    const invalid = await post(token, 'create_watchlist', { ...watch, members: ['ALFA', member] });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /Unknown or ambiguous watchlist members/);
  }
  for (const invalid of [
    { ...pendingScreen, context: { asOf: currentDate } },
    { ...pendingScreen, filters: [{ expression: 'close > 10' }] },
    { ...pendingScreen, filters: [{ field: 'close', op: 'between', value: [4, 1] }] },
    { ...pendingScreen, q: 'range_distance_high_73d' },
    { ...pendingScreen, fields: ['raw_sql'] },
  ]) assert.equal((await post(token, 'create_screen', invalid)).status, 400, JSON.stringify(invalid));
  assert.equal(hasReceipts(), false, 'invalid first writes also roll back receipt table creation');
  assert.deepEqual(listWorkspace(db, 'watchlist'), []);
  assert.deepEqual(listWorkspace(db, 'screen'), []);

  const scopeHash = analysisWorkspaceScopeHash(db);
  const calls = await Promise.all([post(token, 'create_watchlist', watch), post(token, 'create_watchlist', watch)]);
  assert.ok(calls.every(({ status }) => status === 200));
  const [created, repeated] = await Promise.all(calls.map((response) => response.json()));
  const watchlist = created.data.saved;
  assert.deepEqual(created, repeated);
  assert.equal(created.context, null, 'workspace creation is independent of a prepared pin');
  assert.deepEqual(watchlist.definition, { mode: 'manual', screenId: null, members: ['fixture:ALFA', 'fixture:BETA', 'fixture:OLD'] });
  assert.deepEqual(getWorkspace(db, 'watchlist', watchlist.id), watchlist);
  assert.equal((await post(token, 'create_watchlist', { ...watch, members: ['ALFA'] })).status, 409);
  assert.equal((await post(token, 'create_screen', { ...pendingScreen, idempotencyKey: watch.idempotencyKey })).status, 409);
  const otherResult = await post(other.token, 'create_watchlist', watch);
  assert.equal(otherResult.status, 200);
  assert.notEqual((await otherResult.json()).data.saved.id, watchlist.id, 'another principal is free to use the same key and name');

  const savedScreen = await post(token, 'create_screen', pendingScreen);
  assert.equal(savedScreen.status, 200);
  const createdScreen = await savedScreen.json();
  assert.deepEqual(createdScreen.data.saved.definition, {
    preparationMode: 'prepared-query-v1', context: {}, dateMode: 'latest',
    filter: { operator: 'and', filters: pendingScreen.filters }, columns: pendingScreen.fields,
    sort: pendingScreen.sort, search: '', includeUntraded: false,
  });
  const equivalent = { q: '', includeUntraded: false, ...pendingScreen, combine: 'and', filters: [
    { value: [10, 100], op: 'between', field: 'close' }, { op: 'true', field: 'traded' },
  ] };
  assert.deepEqual(await (await post(token, 'create_screen', equivalent)).json(), createdScreen);
  assert.equal(analysisWorkspaceScopeHash(db), scopeHash);
  storeWorkspace(db, 'watchlist', { ...watchlist, definition: { members: [] } }, watchlist.id);
  db.prepare("UPDATE identifiers SET valid_to='2024-01-01' WHERE symbol='ALFA'").run();
  assert.deepEqual(await (await post(token, 'create_watchlist', watch)).json(), created, 'retry survives later edits and ticker changes');
  assert.equal(getWorkspace(db, 'watchlist', watchlist.id).version, 2);

  db.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON research_workspace_creations WHEN new.idempotency_key='rollback'
    BEGIN SELECT RAISE(ABORT,'forced receipt failure'); END;`);
  const rollback = { ...pendingScreen, idempotencyKey: 'rollback' };
  assert.equal((await post(token, 'create_screen', rollback)).status, 500);
  assert.equal(listWorkspace(db, 'screen').length, 1);
  db.exec('DROP TRIGGER reject_receipt');
  assert.equal((await post(token, 'create_screen', rollback)).status, 200);
  assert.equal(listWorkspace(db, 'screen').length, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM research_workspace_creations').get().n, 4);
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
  assert.equal(dataVersion(db), version);
  assert.equal(CALCULATION_VERSION, '2-081799bad3bf');
});

test('REST reevaluates permission and revocation after a slow request body arrives', async (t) => {
  const { db, access, url, permissions, hasReceipts } = await fixture(t);
  const authenticate = access.authenticate.bind(access);
  async function sendWhileChangingAccess(change) {
    const { integration, token } = access.create({ name: 'Slow upload', scopes: [workspaceCreateScope] });
    const authenticated = Promise.withResolvers();
    const observed = t.mock.method(access, 'authenticate', (value) => {
      const principal = authenticate(value);
      if (value === token) authenticated.resolve();
      return principal;
    });
    try {
      const result = Promise.withResolvers();
      const upload = request(url('/research/v1/tools/create_watchlist'), { method: 'POST', headers: sendJson(token) }, (res) => {
        res.resume(); result.resolve(res.statusCode);
      });
      upload.on('error', result.reject);
      upload.write('{"idempotencyKey":"slow",');
      await authenticated.promise;
      await change(integration.id);
      upload.end('"name":"Must not exist","members":["ALFA"]}');
      return await result.promise;
    } finally { observed.mock.restore(); }
  }
  assert.equal(await sendWhileChangingAccess(async (id) => assert.equal((await permissions(id, [])).status, 200)), 403);
  assert.equal(await sendWhileChangingAccess((id) => access.revoke(id)), 401);
  assert.equal(hasReceipts(), false);
  assert.deepEqual(listWorkspace(db, 'watchlist'), []);
});

test('HTTP MCP and stdio can share a creation receipt; scope removal takes effect on a connected client', async (t) => {
  const { access, filename, db, url, post } = await fixture(t);
  const { integration, token } = access.create({ name: 'Transport checks', scopes: [workspaceCreateScope] });
  const http = new Client(clientInfo);
  const stdio = new Client(clientInfo, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  const child = new StdioClientTransport({ command: process.execPath, args: ['scripts/research-mcp.mjs'],
    env: { MARKET_DB: filename, MARKET_RESEARCH_TOKEN: token }, stderr: 'pipe' });
  try {
    await http.connect(new StreamableHTTPClientTransport(url('/mcp'), { requestInit: { headers: bearer(token) } }));
    await stdio.connect(child);
    const writeNames = (listing) => listing.tools.filter(({ annotations }) => annotations?.readOnlyHint === false).map(({ name }) => name);
    assert.deepEqual(writeNames(await http.listTools()), ['create_watchlist', 'create_screen']);
    assert.deepEqual(writeNames(await stdio.listTools()), ['create_watchlist', 'create_screen']);
    const screenCall = { name: 'create_screen', arguments: pendingScreen };
    const outcomes = await Promise.all([stdio.callTool(screenCall), http.callTool(screenCall)]);
    assert.ok(outcomes.every((value) => !value.isError), JSON.stringify(outcomes));
    assert.deepEqual(outcomes[0].structuredContent, outcomes[1].structuredContent);
    const restReplay = await post(token, 'create_screen', pendingScreen);
    assert.equal(restReplay.status, 200);
    assert.deepEqual(await restReplay.json(), outcomes[0].structuredContent);
    assert.equal(listWorkspace(db, 'screen').length, 1);
    const watchCall = { name: 'create_watchlist', arguments: { name: 'SDK watchlist', idempotencyKey: 'sdk-watch', members: ['ALFA'] } };
    const watch = await stdio.callTool(watchCall);
    assert.equal(watch.isError, undefined, JSON.stringify(watch));
    assert.deepEqual(watch.structuredContent.data.saved.definition.members, ['fixture:ALFA']);
    const conflict = await stdio.callTool({ ...watchCall, arguments: { ...watchCall.arguments, name: 'Changed' } });
    assert.equal(conflict.isError, true);
    assert.match(conflict.content[0].text, /Idempotency key/);

    access.update(integration.id, { scopes: [] });
    assert.deepEqual(writeNames(await http.listTools()), []);
    assert.equal((await stdio.callTool(watchCall)).isError, true);
    assert.equal((await post(token, 'create_watchlist', watchCall.arguments)).status, 403);
    access.revoke(integration.id);
    assert.equal((await stdio.callTool(watchCall)).isError, true);
    assert.equal(listWorkspace(db, 'watchlist').length, 1);
  } finally { await Promise.all([http.close(), stdio.close()]); }
});
