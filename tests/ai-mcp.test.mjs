import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createResearchAccess } from '../backend/ai-access.mjs';
import { createResearchEngine } from '../backend/ai-research.mjs';
import { openDatabase } from '../backend/database.mjs';
import { createHandler } from '../backend/server.mjs';

async function httpFixture(t, token = 'workspace-password') {
  const db = openDatabase(':memory:');
  const access = createResearchAccess({ filename: ':memory:' });
  const service = { dispatch() { assert.fail('Dedicated research traffic must never dispatch to the workspace API.'); } };
  const runtime = { command: '/runtime/node', scriptPath: '/private/research-mcp.mjs', database: '/private/warehouse.sqlite' };
  const server = createServer(createHandler({ service, token, access, research: createResearchEngine(db), researchRuntime: runtime }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); access.close(); db.close(); });
  return { base: new URL(`http://127.0.0.1:${server.address().port}`), db, access };
}

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const clientInfo = { name: 'research-test', version: '1.0.0' };
const json = { 'Content-Type': 'application/json' };

test('REST, discovery and workspace credential administration enforce separate bearer scopes', async (t) => {
  const { base, db } = await httpFixture(t);
  const url = (route) => new URL(route, base);
  const changes = () => db.prepare('SELECT total_changes() AS n').get().n;
  const before = changes();
  const admin = url('/api/v1/research-access');
  assert.equal((await fetch(admin)).status, 401);
  const posted = await fetch(admin, { method: 'POST', headers: { ...json, ...bearer('workspace-password') },
    body: JSON.stringify({ name: 'REST test', scopes: [] }) });
  assert.equal(posted.status, 201);
  const { integration, token } = await posted.json();
  for (const route of ['/api/v1/data/import', '/api/v1/journal/settings', '/api/v1/research-access']) {
    assert.equal((await fetch(url(route), { method: 'POST', headers: { ...json, ...bearer(token) }, body: '{}' })).status, 401);
  }
  const tools = url('/research/v1/tools');
  assert.equal((await fetch(tools)).status, 401);
  assert.equal((await fetch(tools, { headers: bearer('workspace-password') })).status, 401);
  assert.equal((await fetch(tools, { headers: { ...bearer(token), Origin: 'https://outside.example' } })).status, 403);
  const manifest = await (await fetch(tools, { headers: bearer(token) })).json();
  assert.ok(manifest.tools.some(({ name }) => name === 'benchmark_event_study'));
  assert.ok(manifest.tools.every(({ annotations }) => annotations.readOnlyHint && !annotations.openWorldHint));
  assert.ok(!manifest.tools.some(({ name }) => name === 'read_journals'));
  const spec = await (await fetch(url('/research/v1/openapi.json'), { headers: bearer(token) })).json();
  assert.equal(spec.components.securitySchemes.researchBearer.scheme, 'bearer');
  assert.ok(spec.paths['/research/v1/tools/screen_stocks']);
  assert.doesNotMatch(JSON.stringify(spec), /private\/warehouse/);
  const postTool = (name, args) => fetch(url(`/research/v1/tools/${name}`),
    { method: 'POST', headers: { ...bearer(token), ...json }, body: JSON.stringify(args) });
  assert.equal((await postTool('read_journals', {})).status, 403);
  assert.equal((await postTool('screen_stocks', { sql: 'SELECT * FROM meta' })).status, 400);
  const available = await postTool('describe_research', { q: 'down_25pct_63d' });
  assert.equal(available.status, 200);
  assert.equal((await available.json()).rows[0].key, 'down_25pct_63d');
  const list = await (await fetch(admin, { headers: bearer('workspace-password') })).json();
  assert.equal(list.integrations[0].id, integration.id);
  assert.equal(list.runtime.database, '/private/warehouse.sqlite');
  assert.doesNotMatch(JSON.stringify(list), new RegExp(token));
  assert.equal((await fetch(url(`/api/v1/research-access/${integration.id}`),
    { method: 'DELETE', headers: bearer('workspace-password') })).status, 200);
  assert.equal((await fetch(tools, { headers: bearer(token) })).status, 401);
  assert.equal(changes(), before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
});

test('official SDK lists and calls structured tools over modern and legacy Streamable HTTP', async (t) => {
  const { base, access } = await httpFixture(t, '');
  const { token } = access.create({ name: 'MCP SDK', scopes: ['research:journals'] });
  assert.equal((await fetch(new URL('/api/v1/config', base), { headers: bearer(token) })).status, 401);
  for (const modern of [true, false]) {
    const client = new Client(clientInfo, modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit: { headers: bearer(token) } });
    try {
      await client.connect(transport);
      assert.equal(client.getNegotiatedProtocolVersion(), modern ? '2026-07-28' : '2025-11-25');
      const listing = await client.listTools();
      assert.ok(listing.tools.some(({ name }) => name === 'read_journals'));
      assert.ok(!listing.tools.some(({ name }) => name === 'read_research_notes'));
      const answer = await client.callTool({ name: 'describe_research', arguments: { q: 'down_25pct_63d' } });
      assert.equal(answer.isError, undefined, JSON.stringify(answer));
      assert.equal(answer.structuredContent.rows[0].key, 'down_25pct_63d');
      const malformed = await client.callTool({ name: 'screen_stocks', arguments: { sort: [{ field: 'sql', direction: 'asc' }] } });
      assert.equal(malformed.isError, true);
    } finally {
      await client.close();
    }
  }
});

test('official SDK calls the same catalog over protocol-only stdio with a dedicated token', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'market stdio '));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'warehouse.sqlite');
  openDatabase(filename).close();
  const access = createResearchAccess({ filename: `${filename}.research-access.sqlite` });
  const { integration, token } = access.create({ name: 'Stdio SDK' });
  const client = new Client(clientInfo, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['scripts/research-mcp.mjs'],
    env: { MARKET_DB: filename, MARKET_RESEARCH_TOKEN: token }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
    const listing = await client.listTools();
    assert.ok(listing.tools.some(({ name, annotations }) => name === 'industry_strength' && annotations.readOnlyHint));
    const query = () => client.callTool({ name: 'describe_research', arguments: { q: 'down_25pct_63d' } });
    assert.equal((await query()).structuredContent.rows[0].key, 'down_25pct_63d');
    access.revoke(integration.id);
    assert.equal((await query()).isError, true);
  } finally {
    await client.close();
  }
});
