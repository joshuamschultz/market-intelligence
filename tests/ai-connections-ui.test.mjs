import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { mountAiConnections } from '../frontend/ai-connections.js';

const createdAt = '2026-11-22T12:00:00Z';
const revokedAt = '2026-11-23T12:00:00Z';
const token = 'mi_research_fixture.one_time_value';
const existing = { id: 'existing', name: '<img src=x>', scopes: ['research:read'], createdAt, revokedAt: null };
const runtime = { command: '/usr/local/bin/node', scriptPath: '/Workspace Path/scripts/research-mcp.mjs', database: '/Workspace Path/market.sqlite' };
const settings = {
  integrations: [existing], runtime,
  endpoints: { tools: '/research/v1/tools', openapi: '/research/v1/openapi.json', mcp: '/mcp' },
  scopes: [
    { id: 'research:read', label: 'Read market research', required: true },
    { id: 'research:notes', label: 'Read private research notes', required: false },
    { id: 'research:journals', label: 'Read private market journals', required: false },
  ],
};

function fixture(t, api) {
  const { window } = new JSDOM('<main></main>', { url: 'http://localhost:8000/#settings' });
  const { document } = window;
  const main = document.querySelector('main');
  const controller = new AbortController();
  t.after(() => { controller.abort(); window.close(); });
  const calls = [];
  const copied = [];
  Object.defineProperty(window.navigator, 'clipboard', { value: { async writeText(value) { copied.push(value); } } });
  const env = { main, signal: controller.signal, isActive: () => !controller.signal.aborted, api(path, options) {
    calls.push({ path, ...options });
    return api(path, options);
  } };
  const q = (selector) => main.querySelector(selector);
  const submit = (name) => {
    q('[name="name"]').value = name;
    q('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  };
  const escape = (element) => element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  return { window, document, main, env, controller, calls, copied, q, submit, escape };
}

test('AI connections creates a scoped token and exposes it only in the temporary field or explicit clipboard copy', async (t) => {
  const view = fixture(t, async (path, options) => options.method === 'POST'
    ? { integration: { ...existing, id: 'new', ...options.body }, token } : settings);
  const { window, document, main, env, calls, copied, q, submit, escape } = view;
  mountAiConnections(env, main);
  await setImmediate();
  assert.equal(document.head.querySelectorAll('[data-ai-connections-styles]').length, 1);
  assert.equal(q('img'), null);
  assert.equal(q('[data-ai-records] h3').textContent, existing.name);
  const read = q('[value="research:read"]');
  assert.equal(read.disabled && read.checked, true);
  assert.equal(q('[value="research:notes"]').checked, false);
  assert.equal(q('[value="research:journals"]').checked, false);
  q('[value="research:notes"]').checked = true;
  submit(' Claude Desktop ');
  assert.equal(q('[type="submit"]').disabled, true);
  await setImmediate();
  assert.deepEqual(calls.map(({ path, method, plain, body }) => ({ path, method, plain, body })), [
    { path: 'research-access', method: undefined, plain: true, body: undefined },
    { path: 'research-access', method: 'POST', plain: true, body: { name: 'Claude Desktop', scopes: ['research:read', 'research:notes'] } },
  ]);
  const field = q('[data-ai-issued] input');
  assert.equal(q('[data-ai-issued]').hidden, false);
  assert.equal(document.activeElement.id, 'ai-connections-issued-title');
  assert.equal(field.value, token);
  assert.equal(field.type, 'password');
  assert.equal(field.getAttribute('value'), null);
  q('[data-ai-show]').click();
  assert.equal(field.type, 'text');
  assert.equal(q('[data-ai-show]').textContent, 'Hide token');
  assert.equal(main.innerHTML.includes(token), false);
  assert.equal(window.location.href.includes(token), false);
  assert.equal(window.localStorage.length, 0);
  assert.equal(window.sessionStorage.length, 0);
  q('[data-ai-copy-token]').click();
  await setImmediate();
  assert.deepEqual(copied, [token]);
  assert.equal(q('[data-ai-token-status]').textContent, 'Token copied.');
  assert.equal(escape(field), false);
  assert.equal(field.value, '');
  assert.equal(field.type, 'password');
  assert.equal(q('[data-ai-issued]').hidden, true);
  assert.equal(document.activeElement, q('[name="name"]'));
  assert.equal(q('[type="submit"]').disabled, false);
});

test('AI connections links same-origin endpoints and copies provider configurations with placeholders', async (t) => {
  const { main, env, copied, q } = fixture(t, async () => settings);
  mountAiConnections(env, main);
  await setImmediate();
  assert.deepEqual([...main.querySelectorAll('dl a')].map((link) => link.href),
    ['http://localhost:8000/research/v1/tools', 'http://localhost:8000/research/v1/openapi.json', 'http://localhost:8000/mcp']);
  const desktop = q('#ai-connections-desktop').textContent;
  assert.deepEqual(JSON.parse(desktop), { mcpServers: { 'market-intelligence': {
    command: runtime.command, args: [runtime.scriptPath], env: { MARKET_DB: runtime.database, MARKET_RESEARCH_TOKEN: 'PASTE_RESEARCH_TOKEN_HERE' },
  } } });
  q('[data-ai-copy="ai-connections-desktop"]').click();
  await setImmediate();
  assert.deepEqual(copied, [desktop]);
  assert.match(q('#ai-connections-rest').textContent, /Bearer \$MARKET_RESEARCH_TOKEN.*\n.+\/research\/v1\/tools/);
  assert.match(main.textContent, /Claude connects from Anthropic’s cloud.*HTTPS port 443/);
  assert.match(main.textContent, /ChatGPT web custom MCP supports OAuth.*research bearer token cannot authenticate directly/);
  assert.match(main.textContent, /OpenAI Responses API and Grok API accept an MCP tool definition/);
});

test('AI connections handles load, create and revoke errors without losing input or dropping active metadata', async (t) => {
  let getAttempts = 0;
  let postAttempts = 0;
  let revokeAttempts = 0;
  const { document, main, env, calls, q, submit, escape } = fixture(t, async (path, options) => {
    if (path === 'research-access/existing') {
      if (++revokeAttempts === 1) throw new Error('Revoke failed');
      return { integration: { ...existing, revokedAt } };
    }
    if (options.method === 'POST') {
      if (++postAttempts === 1) throw new Error('Create failed');
      return { integration: { ...existing, id: 'new', ...options.body }, token };
    }
    if (++getAttempts === 1) throw new Error('Workspace offline');
    return settings;
  });
  mountAiConnections(env, main);
  await setImmediate();
  assert.match(q('[role="alert"]').textContent, /Workspace offline/);
  q('[data-ai-retry]').click();
  await setImmediate();
  assert.equal(document.activeElement, q('[name="name"]'));
  q('[value="research:journals"]').checked = true;
  submit('Grok API');
  await setImmediate();
  assert.equal(q('[data-ai-create-error]').textContent, 'Create failed');
  assert.equal(q('[name="name"]').value, 'Grok API');
  assert.equal(q('[value="research:journals"]').checked, true);
  submit('Grok API');
  await setImmediate();
  assert.equal(q('[data-ai-create-error]').hidden, true);
  q('[data-ai-dismiss]').click();
  assert.equal(q('[data-ai-issued] input').value, '');
  q('[data-ai-revoke="existing"]').click();
  assert.equal(document.activeElement, q('[data-ai-revoke-cancel]'));
  assert.equal(escape(q('[data-ai-revoke-cancel]')), false);
  assert.equal(document.activeElement, q('[data-ai-revoke="existing"]'));
  assert.equal(revokeAttempts, 0);
  q('[data-ai-revoke="existing"]').click();
  q('[data-ai-revoke-confirm]').click();
  await setImmediate();
  assert.equal(q('[data-ai-revoke-error]').textContent, 'Revoke failed');
  assert.match(q('[data-ai-revoke="existing"]').closest('li').textContent, /Active token/);
  q('[data-ai-revoke-confirm]').click();
  await setImmediate();
  assert.equal(q('[data-ai-revoke="existing"]'), null);
  assert.equal(q('[data-ai-confirm]').hidden, true);
  assert.equal(document.activeElement.id, 'ai-connections-tokens');
  assert.match(q('[data-ai-list-status]').textContent, /Revoked token/);
  assert.equal(q(`time[datetime="${revokedAt}"]`).textContent, 'Nov 23, 2026');
  assert.deepEqual(calls.filter(({ method }) => method === 'DELETE').map(({ path, plain }) => [path, plain]),
    [['research-access/existing', true], ['research-access/existing', true]]);
});

test('switching Settings tabs discards an issued token and prevents late responses from restoring it', async (t) => {
  let late;
  let posts = 0;
  const { window, document, main, env, calls, q, submit } = fixture(t, async (path, options) => {
    if (path === 'jobs') return [];
    if (options.method !== 'POST') return settings;
    if (++posts === 1) return { integration: { ...existing, id: 'issued' }, token };
    return new Promise((resolve) => { late = resolve; });
  });
  const originalDocument = globalThis.document;
  globalThis.document = document;
  t.after(() => { if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument; });
  const { render } = await import('../frontend/library.js');
  let actions;
  Object.assign(env, { page: 'settings', params: { tab: 'ai-connections' }, state: {}, config: { status: {} },
    setActions: (value) => { actions = value; }, replaceParams: (patch) => Object.assign(env.params, patch) });
  await render(env);
  await setImmediate();
  assert.equal(q('[data-value="ai-connections"]').getAttribute('aria-pressed'), 'true');
  submit('Claude Desktop');
  await setImmediate();
  const issuedField = q('[data-ai-issued] input');
  assert.equal(issuedField.value, token);
  actions['settings-tab']('jobs');
  assert.equal(env.params.tab, 'jobs');
  assert.equal(issuedField.value, '');
  assert.equal(q('[data-ai-issued]'), null);
  actions['settings-tab']('ai-connections');
  await setImmediate();
  assert.equal(document.head.querySelectorAll('[data-ai-connections-styles]').length, 1);
  submit('OpenAI API');
  const lateField = q('[data-ai-issued] input');
  actions['settings-tab']('jobs');
  assert.equal(calls.at(-1).signal.aborted, true);
  late({ integration: { ...existing, id: 'late' }, token });
  await setImmediate();
  assert.equal(lateField.value, '');
  assert.equal(q('[data-ai-issued]'), null);
  assert.equal(window.location.href.includes(token), false);
});

test('leaving the browser page clears visible secrets and suppresses an in-flight token result', async (t) => {
  let resolvePost;
  let posts = 0;
  const { window, main, env, q, submit, controller } = fixture(t, async (path, options) => {
    if (options.method !== 'POST') return settings;
    if (++posts === 1) return new Promise((resolve) => { resolvePost = resolve; });
    return { integration: { ...existing, id: 'next' }, token };
  });
  mountAiConnections(env, main);
  await setImmediate();
  submit('In flight');
  window.dispatchEvent(new window.PageTransitionEvent('pagehide', { persisted: true }));
  resolvePost({ integration: { ...existing, id: 'late' }, token });
  await setImmediate();
  assert.equal(q('[data-ai-issued]').hidden, true);
  assert.equal(q('[data-ai-issued] input').value, '');
  assert.ok(q('[data-ai-revoke="late"]'));
  submit('Next credential');
  await setImmediate();
  const field = q('[data-ai-issued] input');
  assert.equal(field.value, token);
  window.dispatchEvent(new window.PageTransitionEvent('pagehide', { persisted: true }));
  assert.equal(field.value, '');
  assert.equal(q('[data-ai-issued]').hidden, true);
  controller.abort();
  assert.equal(main.childNodes.length, 0);
});
