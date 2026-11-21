import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { expectedSessions, shiftDate } from '../backend/calendar.mjs';
import { qualityOverrides } from '../backend/database.mjs';
import { createEngine } from '../backend/engine.mjs';

export function auditPriceJumps(db, { asOf, sessions = 252, multiple = 10 } = {}) {
  if (!Number.isInteger(sessions) || sessions < 1 || sessions > 1000 || !Number.isFinite(multiple) || multiple <= 1) {
    throw new Error('Choose 1–1000 trading sessions and a price multiple above 1');
  }
  const engine = createEngine(db);
  const config = engine.context({ date: asOf, classification: 'nasdaq', reference: 'latest' });
  if (!config.date) throw new Error('Load valid market data before auditing jumps');
  const calendar = expectedSessions(shiftDate(config.date, -(sessions * 2 + 20)), config.date).slice(-(sessions + 1));
  const ordinals = new Map(calendar.map((date, index) => [date, index]));
  const snapshot = engine.snapshot(config, { persist: false, cache: false });
  const prices = db.prepare(`SELECT date,close,adjusted_close,volume
    FROM daily_prices WHERE security_id=? AND date BETWEEN ? AND ? ORDER BY date`);
  const actions = db.prepare(`SELECT date,factor,amount,type FROM corporate_actions WHERE security_id=?
    AND date BETWEEN ? AND ? ORDER BY date,version DESC`);
  const candidates = [];
  let checkedPairs = 0;
  let quarantinedPairs = 0;
  const bySecurity = new Map();
  for (const row of qualityOverrides(db, { version: config.dataVersion })) {
    if (!bySecurity.has(row.security_id)) bySecurity.set(row.security_id, []);
    bySecurity.get(row.security_id).push(row);
  }
  const active = snapshot.stocks.filter((row) => row.traded);
  for (const stock of active) {
    const quality = bySecurity.get(stock.securityId) || [];
    const masked = (kind, date) => quality.some((row) => row.kind === kind && row.effective_from <= date && date <= row.effective_to);
    const daily = prices.all(stock.securityId, calendar[0], config.date);
    const knownActions = new Map();
    for (const action of actions.all(stock.securityId, calendar[0], config.date)) {
      if (action.type === 'split' && masked('split', action.date)) continue;
      const dates = knownActions.get(action.date) ?? new Map();
      if (!dates.has(action.type)) dates.set(action.type, action);
      knownActions.set(action.date, dates);
    }
    for (let index = 1; index < daily.length; index++) {
      const prior = daily[index - 1];
      const current = daily[index];
      if (ordinals.get(prior.date) + 1 !== ordinals.get(current.date) || !prior.volume || !current.volume) continue;
      if (masked('price', prior.date) || masked('price', current.date)) { quarantinedPairs++; continue; }
      checkedPairs++;
      const split = knownActions.get(current.date)?.get('split');
      const dividend = knownActions.get(current.date)?.get('dividend');
      const rawGross = current.close / prior.close;
      const economicGross = (current.close + (dividend?.amount || 0)) / prior.close * (split?.factor || 1);
      if (economicGross < multiple && economicGross > 1 / multiple) continue;
      candidates.push({ securityId: stock.securityId, symbol: stock.symbol, rank: stock.rsRank ?? null, date: current.date,
        priorDate: prior.date, close: current.close, priorClose: prior.close, rawGross, economicGross,
        vendorAdjustedGross: prior.adjusted_close > 0 && current.adjusted_close > 0 ? current.adjusted_close / prior.adjusted_close : null,
        splitFactor: split?.factor ?? null, cashDividend: dividend?.amount ?? null });
    }
  }
  return { asOf: config.date, dataVersion: config.dataVersion, universe: config.universe.id, sessions, multiple,
    tradedSecurities: active.length, rankedSecurities: active.filter((row) => row.rsRank != null).length, checkedPairs, quarantinedPairs,
    candidates: candidates.sort((a, b) => Math.abs(Math.log(b.economicGross)) - Math.abs(Math.log(a.economicGross))) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { db: { type: 'string' }, date: { type: 'string' },
      sessions: { type: 'string' }, multiple: { type: 'string' } } });
    const db = new DatabaseSync(values.db || process.env.MARKET_DB || 'data/market.sqlite', { readOnly: true, timeout: 5000 });
    try { console.log(JSON.stringify(auditPriceJumps(db, { asOf: values.date,
      sessions: Number(values.sessions || 252), multiple: Number(values.multiple || 10) }), null, 2)); }
    finally { db.close(); }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
