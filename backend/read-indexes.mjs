// Run during an explicit maintenance step once a warehouse has prepared history.
export function ensureMarketHistoryReadIndex(db) {
  const history = db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='market_history'").get();
  if (!history) return false;
  db.exec(`
    CREATE INDEX IF NOT EXISTS main.market_history_read_scope
      ON market_history(universe, model, calculation_version, definition_key, data_version, date)
  `);
  return true;
}
