import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const researchScopes = [
  { id: 'research:read', label: 'Read market research', required: true },
  { id: 'research:notes', label: 'Read private research notes', required: false },
  { id: 'research:journals', label: 'Read private market journals', required: false },
];
export const researchEndpoints = {
  tools: '/research/v1/tools', openapi: '/research/v1/openapi.json', mcp: '/mcp',
};
const prefix = 'mi_research_';
const tokenPattern = /^mi_research_([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/;
const idPattern = /^[a-f0-9-]{36}$/;
const allowedScopes = new Set(researchScopes.map(({ id }) => id));
const digest = (token) => createHash('sha256').update(token).digest();
const record = ({ id, name, scopes, created_at, revoked_at }) => ({
  id, name, scopes: JSON.parse(scopes), createdAt: created_at, revokedAt: revoked_at,
});
const error = (message, status = 400) => Object.assign(new Error(message), { status });

export const researchTokenFromHeader = (header) => /^Bearer (\S+)$/i.exec(header || '')?.[1];
export function isResearchAuthorization(header) {
  if (researchTokenFromHeader(header)?.startsWith(prefix)) return true;
  const basic = /^Basic (\S+)$/i.exec(header || '')?.[1];
  return !!basic && Buffer.from(basic, 'base64').toString('utf8').split(':').slice(1).join(':').startsWith(prefix);
}

export function createResearchAccess({ filename, now = () => new Date() } = {}) {
  if (!filename) throw new Error('Research credential storage requires a file');
  let memory = null;
  const schema = `CREATE TABLE IF NOT EXISTS integrations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, scopes TEXT NOT NULL, token_hash BLOB NOT NULL,
    created_at TEXT NOT NULL, revoked_at TEXT
  ) WITHOUT ROWID;`;

  function withStore(write, use) {
    let db;
    if (filename === ':memory:') {
      if (!memory && write) {
        memory = new DatabaseSync(':memory:');
        memory.exec(schema);
      }
      db = memory;
    } else {
      if (write && !existsSync(filename)) {
        try { closeSync(openSync(filename, 'wx', 0o600)); }
        catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
      }
      if (existsSync(filename)) {
        const file = lstatSync(filename);
        if (!file.isFile() || file.mode & 0o077) throw new Error('Research credential storage must be a private regular file');
        db = new DatabaseSync(filename, { readOnly: !write });
      }
    }
    if (!db) return use(null);
    try {
      db.exec('PRAGMA busy_timeout=5000');
      if (write) db.exec(schema);
      const hasTable = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='integrations' AND type='table'").get();
      return use(hasTable ? db : null);
    } finally {
      if (db !== memory) db.close();
    }
  }

  return {
    list() {
      return withStore(false, (db) => ({
        integrations: db ? db.prepare('SELECT id,name,scopes,created_at,revoked_at FROM integrations ORDER BY created_at DESC,id').all().map(record) : [],
        endpoints: researchEndpoints, scopes: researchScopes,
      }));
    },
    create(input) {
      if (!input || Array.isArray(input) || typeof input !== 'object' ||
          Object.keys(input).some((key) => !['name', 'scopes'].includes(key))) throw error('Provide a name and optional research scopes');
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) throw error('Choose an integration name from 1 to 100 characters');
      const scopes = input.scopes ?? [];
      if (!Array.isArray(scopes) || scopes.length > researchScopes.length || scopes.some((scope) => !allowedScopes.has(scope))) {
        throw error('Choose supported research scopes');
      }
      const id = randomUUID();
      const token = `${prefix}${id}.${randomBytes(32).toString('base64url')}`;
      const scopeList = [...new Set(['research:read', ...scopes])];
      return withStore(true, (db) => {
        if (db.prepare('SELECT count(*) AS count FROM integrations WHERE revoked_at IS NULL').get().count >= 100) {
          throw error('Revoke an existing integration before creating another', 409);
        }
        const row = db.prepare('INSERT INTO integrations VALUES (?,?,?,?,?,NULL) RETURNING id,name,scopes,created_at,revoked_at')
          .get(id, name, JSON.stringify(scopeList), digest(token), now().toISOString());
        return { integration: record(row), token };
      });
    },
    revoke(id) {
      if (!idPattern.test(id)) throw error('Integration not found', 404);
      return withStore(true, (db) => {
        const row = db.prepare(`UPDATE integrations SET revoked_at=coalesce(revoked_at,?)
          WHERE id=? RETURNING id,name,scopes,created_at,revoked_at`).get(now().toISOString(), id);
        if (!row) throw error('Integration not found', 404);
        return { integration: record(row) };
      });
    },
    authenticate(token) {
      const match = tokenPattern.exec(token || '');
      if (!match) return null;
      return withStore(false, (db) => {
        const row = db?.prepare('SELECT * FROM integrations WHERE id=? AND revoked_at IS NULL').get(match[1]);
        const received = digest(token);
        const expected = row ? Buffer.from(row.token_hash) : Buffer.alloc(received.length);
        return timingSafeEqual(received, expected) && row ? record(row) : null;
      });
    },
    close() {
      if (memory?.isOpen) memory.close();
    },
  };
}
