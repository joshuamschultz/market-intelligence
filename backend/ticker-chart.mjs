import { CALCULATION_VERSION } from './database.mjs';
import { readPreparedChart } from './prepared-details.mjs';

function chartBar({ date, open, high, low, close, missing, traded, priceQuarantined, unverifiedSplit }) {
  if (priceQuarantined) return { date, gap: 'price-quarantined' };
  if (unverifiedSplit) return { date, gap: 'unverified-split' };
  if (missing) return { date, gap: 'missing' };
  if (traded === false) return { date, gap: 'untraded' };
  if (![open, high, low, close].every((price) => Number.isFinite(price) && price > 0) ||
      high < Math.max(open, close) || low > Math.min(open, close)) return { date, gap: 'incomplete-ohlc' };
  return { date, open, high, low, close };
}

export function tickerChart(db, config, security, lookback) {
  const { date, requestedDate, dataVersion, basis } = config;
  const alias = date && security.identifiers?.filter(({ valid_from, valid_to }) => valid_from <= date && (!valid_to || valid_to >= date))
    .sort((a, b) => b.valid_from.localeCompare(a.valid_from) || a.symbol.localeCompare(b.symbol))[0];
  const context = { securityId: security.id, symbol: alias?.symbol ?? null, date, requestedDate, dataVersion,
    calculationVersion: CALCULATION_VERSION, basis, lookback };
  const empty = { sourceDataVersion: null, bars: [], span: { from: null, through: null, observations: 0, sessionCount: 0, gaps: 0 } };
  if (!date) return { ...context, ...empty, state: 'not-prepared' };
  if (!alias || security.listing_date > date || security.delisting_date && security.delisting_date < date) {
    return { ...context, symbol: null, ...empty, state: 'outside-listing' };
  }
  const prepared = readPreparedChart(db, config, security.id, lookback);
  const bars = prepared.bars.map(chartBar);
  const observations = bars.filter((bar) => !bar.gap);
  return { ...context, state: prepared.state === 'ready' && !observations.length ? 'no-observations' : prepared.state,
    sourceDataVersion: prepared.sourceDataVersion, bars, span: { from: observations[0]?.date ?? null,
      through: observations.at(-1)?.date ?? null, observations: observations.length, sessionCount: bars.length,
      gaps: bars.length - observations.length } };
}
