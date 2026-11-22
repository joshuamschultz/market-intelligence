import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { workspaceCreateScope } from './ai-access.mjs';
import { stockColumns } from './ai-tools.mjs';
import { getWorkspace, marketDay, normalizeSymbol, storeWorkspace } from './database.mjs';
import { isPreparedQueryScreen, PREPARED_QUERY_MODE } from './prepared-query-screen.mjs';
import { workspaceDefinition } from './service.mjs';

const error = (message, status = 400) => Object.assign(new Error(message), { status });
const receiptSchema = `CREATE TABLE IF NOT EXISTS research_workspace_creations (
  integration_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  workspace_kind TEXT NOT NULL, workspace_id TEXT NOT NULL, workspace_version INTEGER NOT NULL,
  PRIMARY KEY (integration_id, idempotency_key),
  FOREIGN KEY (workspace_kind, workspace_id, workspace_version) REFERENCES workspace (kind, id, version)
) WITHOUT ROWID`;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function resolveMembers(db, members, date) {
  const exact = db.prepare('SELECT id FROM securities WHERE id=?');
  const ticker = db.prepare(`SELECT DISTINCT i.security_id AS id FROM identifiers i JOIN securities s ON s.id=i.security_id
    WHERE i.symbol=? AND i.valid_from<=? AND (i.valid_to IS NULL OR i.valid_to>=?)
      AND (s.listing_date IS NULL OR s.listing_date<=?) AND (s.delisting_date IS NULL OR s.delisting_date>=?) LIMIT 2`);
  const resolved = [];
  const unavailable = [];
  for (const member of members) {
    const direct = exact.get(member);
    const matches = direct ? [direct] : ticker.all(normalizeSymbol(member), date, date, date, date);
    if (matches.length === 1) resolved.push(matches[0].id);
    else unavailable.push(member);
  }
  if (unavailable.length) {
    const shown = unavailable.slice(0, 10).map((member) => JSON.stringify(member)).join(', ');
    const remaining = unavailable.length - 10;
    throw error(`Unknown or ambiguous watchlist members: ${shown}${remaining > 0 ? ` and ${remaining} more` : ''}`);
  }
  return resolved;
}

function screenDefinition({ filters = [], combine = 'and', sort = [{ field: 'rsRank', direction: 'asc' }],
  fields = stockColumns, q = '', includeUntraded = false }) {
  const definition = workspaceDefinition('screen', { definition: {
    preparationMode: PREPARED_QUERY_MODE, dateMode: 'latest', context: {},
    filter: filters.length ? { operator: combine, filters } : null, sort, columns: fields, search: q, includeUntraded,
  } });
  if (!isPreparedQueryScreen(definition)) throw error('Use only same-session fields and values supported by prepared screens.');
  return definition;
}

export function createResearchWorkspaceWriter(filename, { now = () => new Date() } = {}) {
  function create(kind, input, principal, payload, define) {
    if (!principal?.id || !principal.scopes?.includes(workspaceCreateScope)) {
      throw error('This integration lacks the required research scope', 403);
    }
    if (!filename || filename === ':memory:' || !existsSync(filename)) throw error('Workspace creation is unavailable.', 503);
    const { name, idempotencyKey } = input;
    const fingerprint = createHash('sha256').update(canonicalJson({ kind, name, ...payload })).digest('hex');
    const db = new DatabaseSync(filename);
    try {
      db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
      db.exec(receiptSchema);
      const receipt = db.prepare(`SELECT request_hash,workspace_kind,workspace_id,workspace_version
        FROM research_workspace_creations WHERE integration_id=? AND idempotency_key=?`).get(principal.id, idempotencyKey);
      if (receipt && receipt.request_hash !== fingerprint) throw error('Idempotency key was used with a different creation request', 409);
      const saved = receipt ? getWorkspace(db, receipt.workspace_kind, receipt.workspace_id, receipt.workspace_version)
        : storeWorkspace(db, kind, { name, definition: define(db) });
      if (!saved) throw new Error('Workspace creation receipt has no saved item');
      if (!receipt) db.prepare('INSERT INTO research_workspace_creations VALUES (?,?,?,?,?,?)')
        .run(principal.id, idempotencyKey, fingerprint, kind, saved.id, saved.version);
      db.exec('COMMIT');
      return saved;
    } finally {
      if (db.isTransaction) db.exec('ROLLBACK');
      db.close();
    }
  }

  return {
    createWatchlist(input, principal) {
      return create('watchlist', input, principal, { members: input.members }, (db) => workspaceDefinition('watchlist', {
        definition: { members: resolveMembers(db, input.members, marketDay(now())) },
      }));
    },
    createScreen(input, principal) {
      const definition = screenDefinition(input);
      return create('screen', input, principal, { definition }, () => definition);
    },
  };
}
