import assert from 'node:assert/strict';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createResearchAccess, isResearchAuthorization, workspaceCreateScope } from '../backend/ai-access.mjs';

test('dedicated integration credentials store only a digest, preserve private scopes and can be revoked', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'market research access '));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'credentials.sqlite');
  const access = createResearchAccess({ filename, now: () => new Date('2025-03-28T20:00:00Z') });
  assert.deepEqual(access.list().integrations, []);
  assert.throws(() => statSync(filename), { code: 'ENOENT' });
  assert.throws(() => access.create({ name: 'all scopes', scopes: ['admin'] }), /supported research scopes/);
  const { integration, token } = access.create({ name: 'Claude research', scopes: ['research:notes'] });
  assert.equal(statSync(filename).mode & 0o777, 0o600);
  assert.deepEqual(integration.scopes, ['research:read', 'research:notes']);
  assert.equal(integration.revokedAt, null);
  assert.deepEqual(access.authenticate(token), integration);
  assert.equal(access.authenticate(token.replace(/\.[\w-]+$/, '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')), null);
  assert.equal(access.authenticate('workspace password'), null);
  assert.equal(isResearchAuthorization(`Bearer ${token}`), true);
  assert.equal(isResearchAuthorization('Basic ' + Buffer.from(`operator:${token}`).toString('base64')), true);
  assert.deepEqual(access.list().integrations, [integration]);
  const db = new DatabaseSync(filename, { readOnly: true });
  assert.equal(db.prepare('SELECT length(token_hash) AS bytes FROM integrations').get().bytes, 32);
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM integrations').all()), new RegExp(token));
  db.close();
  const second = createResearchAccess({ filename });
  assert.equal(second.authenticate(token).id, integration.id);
  assert.ok(second.revoke(integration.id).integration.revokedAt);
  assert.equal(access.authenticate(token), null);
  assert.equal(access.list().integrations.length, 1);
});

test('scope edits preserve the integration ID, digest and timestamps, and cannot reenable a revoked token', (t) => {
  const access = createResearchAccess({ filename: ':memory:' });
  t.after(() => access.close());
  const { integration, token } = access.create({ name: 'Scope edit', scopes: ['research:notes'] });
  const other = access.create({ name: 'Existing read-only' });
  for (const invalid of [{}, { scopes: null }, { scopes: ['admin'] }, { scopes: [], name: 'Changed' }, { name: 'Changed' }]) {
    assert.throws(() => access.update(integration.id, invalid), { status: 400 });
  }
  const scopes = ['research:notes', workspaceCreateScope];
  assert.deepEqual(access.update(integration.id, { scopes }), { integration: { ...integration, scopes: ['research:read', ...scopes] } });
  assert.deepEqual(access.authenticate(token).scopes, ['research:read', ...scopes]);
  assert.deepEqual(access.authenticate(other.token), other.integration);
  assert.deepEqual(access.update(integration.id, { scopes: ['research:notes'] }), { integration });
  assert.deepEqual(access.authenticate(token), integration);
  access.revoke(integration.id);
  assert.throws(() => access.update(integration.id, { scopes }), { status: 404 });
  assert.equal(access.authenticate(token), null);
});
