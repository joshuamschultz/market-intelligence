import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { mountAiConnections } from '../frontend/ai-connections.js';

const read = 'research:read';
const notes = 'research:notes';
const journals = 'research:journals';
const write = 'research:workspace:create';
const future = 'research:future';
const writeLabel = 'Create watchlists and saved screens';
const createdAt = '2026-11-22T12:00:00Z';
const granted = { id: 'openai/dev', name: 'OpenAI dev', scopes: [read, notes, future], createdAt, revokedAt: null };
const revoked = { id: 'revoked', name: 'Old client', scopes: [read, write], createdAt, revokedAt: createdAt };
const access = {
  endpoints: { tools: '/research/v1/tools', openapi: '/research/v1/openapi.json', mcp: '/mcp' },
  integrations: [granted, revoked],
  scopes: [
    { id: read, label: 'Read market research', required: true },
    { id: notes, label: 'Read private research notes', required: false },
    { id: journals, label: 'Read private market journals', required: false },
    { id: write, label: writeLabel, required: false },
    { id: future, label: 'Other assigned permission', required: false },
  ],
};

function fixture(t, handler, data = access) {
  const { window } = new JSDOM('<main></main>', { url: 'http://localhost/#settings?tab=ai-connections' });
  const { document } = window;
  const main = document.querySelector('main');
  const controller = new AbortController();
  const calls = [];
  const env = { signal: controller.signal, isActive: () => !controller.signal.aborted, async api(path, options) {
    calls.push({ path, ...options });
    if (path === 'research-access' && !options.method) return data;
    return handler(path, options);
  } };
  const abort = mountAiConnections(env, main);
  t.after(() => { controller.abort(); window.close(); });
  const submit = (form) => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const escape = (element) => element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  const query = (selector) => main.querySelector(selector);
  return { window, document, main, abort, calls, query, submit, escape };
}

const scopeInput = (form, id) => form.querySelector(`[name="scopes"][value="${id}"]`);

test('workspace creation permission is advertised by the endpoint and requires an explicit choice on token creation', async (t) => {
  let nextId = 1;
  const { window, main, calls, query, submit } = fixture(t, async (_path, options) => ({
    integration: { ...granted, id: `created-${nextId++}`, ...options.body }, token: 'synthetic-one-time-token',
  }));
  await setImmediate();
  const form = query('[data-ai-create-form]');
  const optional = scopeInput(form, write);
  assert.equal(scopeInput(form, read).disabled && scopeInput(form, read).checked, true);
  assert.equal(optional.checked, false);
  assert.match(optional.closest('label').textContent, /Create watchlists and saved screens/);
  assert.match(main.ownerDocument.getElementById(optional.getAttribute('aria-describedby')).textContent, /create new watchlists and saved screens/);
  form.elements.namedItem('name').value = 'Read only client';
  submit(form);
  await setImmediate();
  query('[data-ai-dismiss]').click();

  form.elements.namedItem('name').value = 'Create lists and screens';
  optional.checked = true;
  submit(form);
  await setImmediate();
  assert.deepEqual(calls.filter(({ method }) => method === 'POST').map(({ body }) => body), [
    { name: 'Read only client', scopes: [read] }, { name: 'Create lists and screens', scopes: [read, write] },
  ]);
  assert.match(query('[data-ai-edit="created-2"]').closest('li').textContent, /Create watchlists and saved screens/);
  assert.equal(optional.checked, false);
  const token = query('[data-ai-issued] input');
  assert.equal(token.value, 'synthetic-one-time-token');
  query('[data-ai-dismiss]').click();
  assert.equal(token.value, '');
  assert.equal(window.localStorage.length + window.sessionStorage.length, 0);
  assert.doesNotMatch(main.innerHTML, /synthetic-one-time-token/);
});

test('editing permissions starts from the existing scopes, supports cancellation and retry, and sends a scope-only PATCH', async (t) => {
  let failSave;
  let requests = 0;
  const { document, window, main, calls, query, submit, escape } = fixture(t, async (path, options) => {
    assert.equal(path, 'research-access/openai%2Fdev');
    if (++requests === 1) return new Promise((_resolve, reject) => { failSave = reject; });
    return { integration: { ...granted, scopes: options.body.scopes }, token: 'ignore-unexpected-token' };
  });
  await setImmediate();
  const edit = query('[data-ai-edit-form]');
  const opener = () => query('[data-ai-edit="openai/dev"]');
  const save = edit.querySelector('[type="submit"]');
  const cancel = edit.querySelector('[data-ai-edit-cancel]');
  assert.match(query('[data-ai-records]').textContent, /Old client.*Revoked/s);
  assert.equal(query('[data-ai-edit="revoked"], [data-ai-revoke="revoked"]'), null);
  opener().click();
  assert.equal(edit.hidden, false);
  assert.equal(opener().getAttribute('aria-expanded'), 'true');
  assert.equal(document.activeElement, edit.querySelector('h3'));
  assert.equal(scopeInput(edit, read).checked && scopeInput(edit, read).disabled, true);
  assert.equal(scopeInput(edit, notes).checked, true);
  assert.equal(scopeInput(edit, journals).checked, false);
  assert.equal(scopeInput(edit, write).checked, false);
  assert.equal(scopeInput(edit, future), null);
  assert.notEqual(scopeInput(edit, write).getAttribute('aria-describedby'),
    scopeInput(query('[data-ai-create-form]'), write).getAttribute('aria-describedby'));

  scopeInput(edit, notes).checked = false;
  scopeInput(edit, write).checked = true;
  cancel.click();
  assert.equal(edit.hidden, true);
  assert.equal(document.activeElement, opener());
  assert.equal(opener().getAttribute('aria-expanded'), 'false');
  assert.equal(requests, 0);
  opener().click();
  assert.equal(scopeInput(edit, notes).checked, true);
  assert.equal(scopeInput(edit, write).checked, false);
  assert.equal(escape(scopeInput(edit, notes)), false);
  assert.equal(edit.hidden, true);
  assert.equal(document.activeElement, opener());

  opener().click();
  scopeInput(edit, notes).checked = false;
  scopeInput(edit, write).checked = true;
  submit(edit);
  assert.equal(save.disabled && cancel.disabled && edit.querySelector('fieldset').disabled, true);
  assert.match(save.textContent, /Saving/);
  query('[data-ai-revoke="openai/dev"]').click();
  assert.equal(query('[data-ai-confirm]').hidden, true);
  submit(edit);
  assert.equal(requests, 1);
  failSave(new Error('Fixture could not save permissions'));
  await setImmediate();
  assert.match(edit.querySelector('[role="alert"]').textContent, /Fixture could not save permissions/);
  assert.equal(edit.hidden, false);
  assert.equal(scopeInput(edit, write).checked, true);
  assert.equal(scopeInput(edit, notes).checked, false);
  assert.equal(save.disabled || cancel.disabled || edit.querySelector('fieldset').disabled, false);
  submit(edit);
  await setImmediate();

  const updates = calls.filter(({ method }) => method === 'PATCH');
  assert.equal(updates.length, 2);
  assert.ok(updates.every(({ plain }) => plain));
  assert.deepEqual(updates.map(({ body }) => body), [{ scopes: [read, future, write] }, { scopes: [read, future, write] }]);
  assert.deepEqual(calls.map(({ method }) => method), [undefined, 'PATCH', 'PATCH']);
  assert.equal(edit.hidden, true);
  assert.equal(document.activeElement, opener());
  assert.match(opener().closest('li').textContent, /Create watchlists and saved screens/);
  assert.match(opener().closest('li').textContent, /Other assigned permission/);
  assert.doesNotMatch(opener().closest('li').textContent, /Read private research notes/);
  assert.match(query('[data-ai-list-status]').textContent, /Permissions saved for OpenAI dev.*Reconnect your MCP client/);
  assert.equal(query('[data-ai-issued]').hidden, true);
  assert.equal(query('[data-ai-issued] input').value, '');
  assert.equal(window.localStorage.length + window.sessionStorage.length, 0);
  assert.doesNotMatch(main.innerHTML, /ignore-unexpected-token/);
});

test('unadvertised permissions stay absent and late saves cannot revive a destroyed Settings panel', async (t) => {
  let finish;
  const { abort, calls, main, query, submit } = fixture(t, async () => new Promise((resolve) => { finish = resolve; }),
    { ...access, scopes: access.scopes.filter(({ id }) => id !== write) });
  await setImmediate();
  query('[data-ai-edit="openai/dev"]').click();
  const edit = query('[data-ai-edit-form]');
  assert.equal(query(`input[value="${write}"]`), null);
  scopeInput(edit, notes).checked = false;
  submit(edit);
  const pending = calls.at(-1);
  assert.equal(pending.method, 'PATCH');
  abort();
  assert.equal(pending.signal.aborted, true);
  finish({ integration: { ...granted, scopes: [read, future] } });
  await setImmediate();
  assert.equal(main.childNodes.length, 0);
});
