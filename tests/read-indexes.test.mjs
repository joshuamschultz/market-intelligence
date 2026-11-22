import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ensureMarketHistoryReadIndex } from '../backend/read-indexes.mjs';

test('optional market-history index is idempotent and covers R11 archive revision lookups', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  assert.equal(ensureMarketHistoryReadIndex(db), false);
  db.exec(`
    CREATE TABLE market_history (
      universe TEXT NOT NULL, model TEXT NOT NULL, data_version INTEGER NOT NULL,
      calculation_version TEXT NOT NULL, definition_key TEXT NOT NULL, date TEXT NOT NULL,
      value TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (universe, model, data_version, calculation_version, definition_key, date)
    ) WITHOUT ROWID;
    INSERT INTO market_history VALUES
      ('us-core','composite',1,'be44','scope','2026-11-19','old','2026-11-20'),
      ('us-core','composite',1,'be44','scope','2026-11-20','old','2026-11-20'),
      ('us-core','composite',2,'be44','scope','2026-11-20','new','2026-11-21'),
      ('us-core','composite',2,'be44','other','2026-11-20','other','2026-11-21'),
      ('us-core','composite',3,'be44','scope','2026-11-20','future','2026-11-22');
  `);
  const query = `SELECT DISTINCT data_version FROM market_history WHERE
    universe=? AND model=? AND calculation_version=? AND definition_key=? AND data_version<=?`;
  const params = ['us-core', 'composite', 'be44', 'scope', 2];
  const revisions = () => db.prepare(query).all(...params).map(({ data_version }) => data_version).sort();
  assert.deepEqual(revisions(), [1, 2]);
  assert.equal(ensureMarketHistoryReadIndex(db), true);
  assert.equal(ensureMarketHistoryReadIndex(db), true);
  assert.deepEqual(revisions(), [1, 2]);

  const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...params).map(({ detail }) => detail).join('\n');
  assert.match(plan, /USING COVERING INDEX market_history_read_scope/);
  assert.match(plan, /universe=\? AND model=\? AND calculation_version=\? AND definition_key=\?/);
});
