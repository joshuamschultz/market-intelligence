import { setTimeout } from 'node:timers/promises';
import { normalizeSymbol, isoDate, marketDay, today } from './database.mjs';
import { expectedSessions, latestFinalizableSession, shiftDate } from './calendar.mjs';
import { reconcileCurrentCapture } from '../scripts/reconcile-current.mjs';
import { verifiedCorrectionSymbols } from '../scripts/apply-verified-correction.mjs';

const BASE_URL = 'https://eodhd.com/api/';
export const BENCHMARKS = ['SPY', 'QQQ', 'IWM', 'DIA', 'XLB', 'XLC', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLRE', 'XLU', 'XLV', 'XLY'];
const nasdaqComposite = { symbol: 'IXIC', name: 'NASDAQ Composite', exchange: 'INDX', type: 'index', providerSymbol: 'IXIC.INDX' };
const DEFAULT_SAMPLE = [...BENCHMARKS.slice(0, 3), 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'JPM', 'XOM', 'UNH', 'V', 'PG', 'HD', 'AVGO', 'AMD', 'COST', 'LLY', 'TSLA'];
const symbolPattern = /^[A-Z0-9^][A-Z0-9._^=-]{0,32}$/i;

class ProviderError extends Error {
  constructor(message, status = null, retryAfter = null) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function requireArray(value, dataset) {
  if (!Array.isArray(value)) throw new ProviderError(`EODHD returned an unexpected ${dataset} response`);
  return value;
}

function safeSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase();
  if (!symbolPattern.test(symbol)) throw new Error('A provider symbol is invalid');
  return [nasdaqComposite.symbol, `${nasdaqComposite.symbol}.US`].includes(symbol)
    ? nasdaqComposite.providerSymbol : symbol.includes('.') ? symbol : `${symbol}.US`;
}

function canonicalSymbol(symbol) {
  return String(symbol || '').toUpperCase() === nasdaqComposite.providerSymbol ? nasdaqComposite.symbol : normalizeSymbol(symbol);
}

function factorFrom(raw) {
  if (raw == null) return null;
  const [a, b] = String(raw).split('/').map(Number);
  return b > 0 ? a / b : Number.isFinite(a) && a > 0 ? a : null;
}

function quotaDate(value) {
  if (typeof value === 'string') {
    const date = value.trim().slice(0, 10);
    if (isoDate(date)) return date;
  }
  if (typeof value === 'number' || typeof value === 'string' && /^\d{10,13}$/.test(value)) {
    const stamp = Number(value);
    const date = new Date(stamp < 10_000_000_000 ? stamp * 1000 : stamp);
    return Number.isFinite(date.valueOf()) ? date.toISOString().slice(0, 10) : null;
  }
  return null;
}

export function EodhdProvider({
  apiKey = process.env.EODHD_API_KEY, fetcher = fetch, attempts = 3,
  minRequestSpacing = fetcher === fetch ? 75 : 0, clock = Date.now, wait = setTimeout,
} = {}) {
  let spacing = Math.max(0, minRequestSpacing);
  let nextRequest = 0;
  let pauseUntil = 0;

  async function startRequest(send) {
    for (;;) {
      const now = clock();
      const remaining = Math.max(nextRequest, pauseUntil) - now;
      if (remaining > 0) await wait(remaining);
      else {
        nextRequest = now + spacing;
        return send();
      }
    }
  }

  function retryDelay(header, now) {
    if (!header) return null;
    const numeric = Number(header);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric * 1000;
    const timestamp = Date.parse(header);
    return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
  }

  function observeRate(response, now) {
    const limit = Number(response.headers.get('x-ratelimit-limit'));
    const rawRemaining = response.headers.get('x-ratelimit-remaining');
    if (limit > 0) spacing = Math.max(minRequestSpacing, Math.ceil(60_000 / (limit * 0.8)));
    if (rawRemaining != null && Number(rawRemaining) <= 2) {
      pauseUntil = Math.max(pauseUntil, now + 60_000);
    }
  }

  async function request(path, params = {}) {
    if (!apiKey) throw new ProviderError('Set EODHD_API_KEY before contacting the provider');
    const url = new URL(path, BASE_URL);
    url.searchParams.set('api_token', apiKey);
    url.searchParams.set('fmt', 'json');
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== '') url.searchParams.set(key, value);
    }
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await startRequest(() => fetcher(url, { signal: AbortSignal.timeout(45_000), redirect: 'error' }));
        const now = clock();
        if (response.ok) observeRate(response, now);
        if (!response.ok) {
          const retryAfter = retryDelay(response.headers.get('retry-after'), now);
          if (response.status === 429) pauseUntil = Math.max(pauseUntil, now + (retryAfter ?? 60_000));
          throw new ProviderError(`EODHD request failed (HTTP ${response.status})`, response.status, retryAfter);
        }
        try { return await response.json(); }
        catch { throw new ProviderError('EODHD returned a response that is not JSON', 422); }
      } catch (error) {
        lastError = error instanceof ProviderError ? error : new ProviderError('EODHD could not be reached');
        if (lastError.status && lastError.status < 500 && lastError.status !== 429) break;
        if (attempt + 1 < attempts && lastError.status !== 429) await wait(lastError.retryAfter ?? 500 * 2 ** attempt);
      }
    }
    throw lastError;
  }

  async function getSecurities({ delisted = false, symbols, asOf = marketDay() } = {}) {
    const rows = requireArray(await request('exchange-symbol-list/US', {
      delisted: delisted ? 1 : null, symbols: symbols?.map(normalizeSymbol).join(','),
    }), 'symbol list');
    return rows.map((row) => ({
      symbol: row.Code, name: row.Name, exchange: row.Exchange, type: row.Type,
      providerSymbol: `${row.Code}.US`, isin: row.Isin || row.ISIN || null, country: row.Country || null,
      status: delisted ? 'delisted' : 'active',
      listingDate: row.ListingDate || row.listingDate || null,
      delistingDate: row.DelistingDate || row.delistingDate || null,
      knownAt: asOf,
    }));
  }

  async function getListingEvents({ from, to } = {}) {
    const rows = requireArray(await request('symbol-change-history', { from, to, ex: 'US' }), 'symbol changes');
    return rows.filter((row) => row.old_symbol && row.new_symbol && isoDate(row.effective)).map((row) => ({
      exchange: row.exchange || 'US', oldSymbol: normalizeSymbol(row.old_symbol), newSymbol: normalizeSymbol(row.new_symbol),
      effectiveDate: row.effective, companyName: row.company_name || null, knownAt: marketDay(),
    }));
  }

  async function getQuota() {
    const value = await request('user');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderError('EODHD returned an unexpected quota response');
    const count = (field) => value[field] != null && value[field] !== '' && Number.isFinite(Number(value[field])) ? Number(value[field]) : null;
    const requestDate = quotaDate(value.apiRequestsDate);
    const dailyLimit = count('dailyRateLimit');
    const extra = count('extraLimit') || 0;
    const used = requestDate && requestDate < today() ? 0 : count('apiRequests');
    return { requestDate, dailyLimit, extra, used, remaining: dailyLimit == null || used == null ? null : Math.max(0, dailyLimit - used) + extra };
  }

  async function getDailyPrices({ symbol, from, to, date } = {}) {
    if (symbol) {
      return requireArray(await request(`eod/${encodeURIComponent(safeSymbol(symbol))}`, { from, to, period: 'd', order: 'a' }), 'price history')
        .map((row) => ({ ...row, symbol: canonicalSymbol(symbol) }));
    }
    const rows = requireArray(await request('eod-bulk-last-day/US', { date, type: 'eod' }), 'bulk price');
    return rows.map((row) => ({ ...row, symbol: row.code || row.Code || row.symbol, exchange: row.exchange_short_name || row.exchange }));
  }

  async function getCorporateActions({ symbol, from, to, date } = {}) {
    if (symbol && safeSymbol(symbol) === nasdaqComposite.providerSymbol) return [];
    const splitPath = symbol ? `splits/${encodeURIComponent(safeSymbol(symbol))}` : 'eod-bulk-last-day/US';
    const dividendPath = symbol ? `div/${encodeURIComponent(safeSymbol(symbol))}` : 'eod-bulk-last-day/US';
    const [splits, dividends] = await Promise.all([
      request(splitPath, { from, to, date, type: symbol ? null : 'splits' }),
      request(dividendPath, { from, to, date, type: symbol ? null : 'dividends' }),
    ]);
    return [
      ...requireArray(splits, 'split').map((row) => ({ symbol: symbol || row.code, date: row.date, type: 'split', factor: factorFrom(row.split),
        exchange: row.exchange_short_name || row.exchange })),
      ...requireArray(dividends, 'dividend').map((row) => ({ symbol: symbol || row.code, date: row.date, type: 'dividend', amount: row.unadjustedValue ?? row.value,
        exchange: row.exchange_short_name || row.exchange })),
    ];
  }

  function normalizeReference(value, symbol, asOf) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderError('EODHD returned an unexpected fundamentals response');
    const general = value.General || {};
    const stats = value.SharesStats || {};
    const ticker = normalizeSymbol(general.Code || symbol);
    return {
      fundamentals: {
        symbol: ticker, effectiveDate: asOf, knownAt: asOf, float: stats.SharesFloat,
        sharesOutstanding: stats.SharesOutstanding, marketCap: value.Highlights?.MarketCapitalization,
      },
      classifications: {
        symbol: ticker, effectiveFrom: asOf, knownAt: asOf, sector: general.Sector,
        industry: general.Industry, subindustry: general.GicSubIndustry,
      },
      securities: {
        symbol: ticker, name: general.Name, exchange: general.Exchange, isin: general.ISIN || null,
        type: general.Type === 'Common Stock' && /REIT/i.test(general.Industry || '') ? 'REIT'
          : /ADR|depositary/i.test(general.HomeCategory || '') ? 'ADR' : general.Type,
        listingDate: general.IPODate || null, knownAt: asOf,
        status: general.IsDelisted === true || general.IsDelisted === 'true' ? 'delisted' : 'active',
      },
    };
  }

  async function getReference(symbol, asOf = marketDay()) {
    return normalizeReference(await request(`fundamentals/${encodeURIComponent(safeSymbol(symbol))}`), symbol, asOf);
  }

  async function getBulkReference({ exchange, offset = 0, limit = 500 } = {}) {
    if (!['NYSE', 'NASDAQ', 'AMEX'].includes(exchange)) throw new Error('Unknown US fundamentals exchange');
    const value = await request(`bulk-fundamentals/${exchange}`, { offset, limit, version: '1.2' });
    if (!value || typeof value !== 'object') throw new ProviderError('EODHD returned an unexpected bulk fundamentals response');
    return Object.values(value).map((item) => normalizeReference(item, null, marketDay()))
      .filter((item) => item.securities.symbol);
  }

  async function capabilities({ date = latestFinalizableSession() } = {}) {
    const checks = {
      prices: () => getDailyPrices({ symbol: 'AAPL.US', from: shiftDate(date, -10), to: date }),
      catalog: () => getSecurities({ symbols: ['AAPL'] }),
      bulk: () => getDailyPrices({ date }),
      currentReference: () => getReference('AAPL.US'),
      splits: () => request('splits/AAPL.US', { from: '2020-07-01', to: '2020-09-01' }),
      delistedCatalog: () => getSecurities({ delisted: true, symbols: ['TWTR'] }),
      renames: () => getListingEvents({ from: shiftDate(date, -30), to: date }), quota: () => getQuota(),
    };
    const results = {};
    for (const [key, probe] of Object.entries(checks)) {
      try {
        const value = await probe();
        const observations = Array.isArray(value) ? value.length : null;
        results[key] = { available: true, observations, coverageVerified: observations == null ? null : observations > 0,
          ...(key === 'quota' ? { quota: value } : {}) };
      } catch (error) {
        results[key] = { available: false, status: error.status ?? null, reason: error.message };
      }
    }
    return { provider: 'eodhd', checkedAt: new Date().toISOString(), ...results, pointInTimeFloat: false, pointInTimeClassifications: false };
  }

  const getIndexDailyPrices = (date) => getDailyPrices({ symbol: nasdaqComposite.symbol, from: date, to: date });
  return { getSecurities, getDailyPrices, getIndexDailyPrices, getCorporateActions, getReference, getBulkReference, getListingEvents, getQuota, capabilities };
}

async function optional(query, warnings, label) {
  try { return await query(); }
  catch (error) { warnings.push(`${label}: ${error.message}`); return null; }
}

export function providerOptions(input = {}) {
  const date = input.date || latestFinalizableSession();
  const from = input.from || shiftDate(date, -485);
  const to = input.to || date;
  if (![date, from, to].every(isoDate) || from > to) throw new Error('Provide a valid date range in YYYY-MM-DD format');
  const list = Array.isArray(input.symbols) ? input.symbols : input.symbols?.split(',') || DEFAULT_SAMPLE;
  if (list.length > 300) throw new Error('Use bulk import for more than 300 symbols');
  const symbols = [...new Set(list.filter(Boolean).map(safeSymbol))];
  if (!symbols.length) throw new Error('Select at least one symbol');
  return {
    date, from, to, symbols, bulk: !!input.bulk, actions: input.actions !== false,
    reference: !!input.reference, delisted: !!input.delisted,
  };
}

export function providerDates(options, config = providerOptions(options)) {
  if (!config.bulk) return [];
  return options.from || options.to ? expectedSessions(config.from, config.to) : [config.date];
}

export async function importProviderData(options, { provider = EodhdProvider(), db, write, progress = () => {}, hasBulkDate = () => false } = {}) {
  const config = providerOptions(options);
  const catalogDate = marketDay();
  const warnings = [];
  let ingested = 0;
  if (config.bulk) {
    if (!db) throw new Error('Bulk EODHD import requires a warehouse for identity reconciliation');
    const dates = providerDates(options, config);
    if (!dates.length) throw new Error('No exchange sessions in the selected range');
    const catalog = (await provider.getSecurities()).filter((row) => canonicalSymbol(row.symbol || row.Code) !== nasdaqComposite.symbol);
    if (provider.getIndexDailyPrices) catalog.push(nasdaqComposite);
    const identityDate = latestFinalizableSession(new Date(), process.env.MARKET_SYNC_AFTER || '20:30');
    if (config.delisted) warnings.push('Bulk daily capture uses the active catalog. Use the historical bootstrap for delisted issues.');
    const expectsCurrent = (date) => date >= shiftDate(catalogDate, -7);
    const loadedDates = [];
    const captures = [];
    for (const [index, date] of dates.entries()) {
      if (hasBulkDate(date) && !options.force) { progress((index + 1) / dates.length); continue; }
      const prices = (await provider.getDailyPrices({ date })).filter((row) => row.date === date
        && canonicalSymbol(row.symbol || row.code || row.Code) !== nasdaqComposite.symbol);
      if (!prices.length) throw new Error(`No finalized EODHD bars for ${date}`);
      const corporateActions = config.actions ? await provider.getCorporateActions({ date }) : [];
      if (provider.getIndexDailyPrices) {
        const received = await optional(() => provider.getIndexDailyPrices(date), warnings, `Nasdaq Composite for ${date}`);
        const indexPrices = received?.filter((row) => row.date === date) || [];
        if (!indexPrices.length && received) warnings.push(`Nasdaq Composite for ${date}: finalized index observation unavailable`);
        prices.push(...indexPrices.map((row) => ({ ...row, symbol: nasdaqComposite.symbol, exchange: nasdaqComposite.exchange })));
      }
      const result = reconcileCurrentCapture(db, {
        catalog, prices, corporateActions, date, capturedAt: catalogDate, identityDate, useCurrentRoster: expectsCurrent(date),
        includeOtherListings: true, benchmarks: [...BENCHMARKS, nasdaqComposite.symbol], warnings,
      });
      ingested += result.duplicate ? 0 : result.imported;
      captures.push({ date, expected: result.expected, received: result.received, eligibleReceived: result.eligibleReceived,
        benchmarks: result.benchmarksReceived?.filter((symbol) => symbol !== nasdaqComposite.symbol),
        indexReceived: !!result.benchmarksReceived?.includes(nasdaqComposite.symbol), actions: result.corporateActions, identityExclusions: result.reasons });
      loadedDates.push(date);
      progress((index + 1) / dates.length);
    }
    return { provider: 'eodhd', scope: 'full', dates: loadedDates, imported: ingested, captures, warnings };
  }

  const securities = (await optional(() => provider.getSecurities({ symbols: config.symbols }), warnings, 'Symbol catalog') || [])
    .filter((row) => canonicalSymbol(row.symbol) !== nasdaqComposite.symbol);
  const seen = new Set(securities.map(({ symbol }) => normalizeSymbol(symbol)));
  for (const symbol of config.symbols.map(canonicalSymbol).filter((value) => !seen.has(value))) {
    securities.push(symbol === nasdaqComposite.symbol ? nasdaqComposite : { symbol, type: BENCHMARKS.includes(symbol) ? 'ETF' : 'unknown' });
  }
  const batch = { provider: 'eodhd', dataset: 'eod', scope: 'sample', catalogDate, prices: [], corporateActions: [], fundamentals: [], classifications: [], securities, warnings };
  for (const [index, symbol] of config.symbols.entries()) {
    const bars = await optional(() => provider.getDailyPrices({ symbol, from: config.from, to: config.to }), warnings, `Price history for ${symbol}`);
    if (bars?.length) {
      batch.prices.push(...bars);
      if (config.actions && canonicalSymbol(symbol) !== nasdaqComposite.symbol) {
        const actions = await optional(() => provider.getCorporateActions({ symbol, from: config.from, to: config.to }), warnings, `Corporate actions for ${symbol}`);
        if (actions) batch.corporateActions.push(...actions);
      }
      if (config.reference && canonicalSymbol(symbol) !== nasdaqComposite.symbol) {
        const reference = await optional(() => provider.getReference(symbol), warnings, `Current fundamentals for ${symbol}`);
        if (reference) {
          batch.fundamentals.push(reference.fundamentals);
          batch.classifications.push(reference.classifications);
          batch.securities.push(reference.securities);
        }
      }
    }
    progress((index + 1) / config.symbols.length);
  }
  if (!batch.prices.length) throw new Error(warnings[0] || 'No finalized bars returned for the selected symbols');
  return { ...write(batch), provider: 'eodhd', scope: 'sample', warnings };
}

export async function importProviderReference(input = {}, { provider = EodhdProvider(), db, write, progress = () => {}, finishedPage = () => null } = {}) {
  const date = marketDay();
  const warnings = ['Provider reference fields are dated to this capture. Historical reference coverage requires dated source facts.'];
  const rawSymbols = Array.isArray(input.symbols) ? input.symbols : String(input.symbols || '').split(',').filter(Boolean);
  const symbols = [...new Set(rawSymbols.map(safeSymbol))];
  if (symbols.length > 300) throw new Error('Use exchange pages to refresh more than 300 securities');
  const protectedSymbols = db ? verifiedCorrectionSymbols(db) : new Set();
  let records = 0;
  function store(references, dataset) {
    if (!references.length) return;
    const trusted = references.filter((item) => !protectedSymbols.has(normalizeSymbol(item.securities.symbol)));
    const skipped = references.length - trusted.length;
    if (skipped) warnings.push(`Skipped ${skipped} provider reference records with independently verified listing corrections.`);
    records += references.length;
    if (!trusted.length) return;
    const securities = trusted.map((item) => item.securities);
    const fundamentals = trusted.map((item) => item.fundamentals).filter((item) => item.float > 0 || item.sharesOutstanding > 0 || item.marketCap > 0);
    const classifications = trusted.map((item) => item.classifications).filter((item) => item.sector || item.industry || item.subindustry);
    write({ provider: 'eodhd', dataset, scope: 'sample', catalogDate: date, securities, fundamentals, classifications, warnings });
  }
  if (symbols.length) {
    for (const [index, symbol] of symbols.entries()) {
      const item = await optional(() => provider.getReference(symbol), warnings, `Reference for ${symbol}`);
      if (item) store([item], `reference-${normalizeSymbol(symbol)}`);
      progress((index + 1) / symbols.length);
    }
  } else {
    const exchanges = input.exchanges == null ? ['NYSE', 'NASDAQ'] : input.exchanges;
    if (!Array.isArray(exchanges) || !exchanges.length || exchanges.some((item) => !['NYSE', 'NASDAQ', 'AMEX'].includes(item))) {
      throw new Error('Select NYSE, NASDAQ or AMEX');
    }
    const maxPages = Math.max(1, Math.min(50, Math.floor(Number(input.maxPages) || 20)));
    const resolved = [...new Set(exchanges)];
    for (const [index, exchange] of resolved.entries()) {
      for (let page = 0; page < maxPages; page++) {
        const dataset = `reference-${exchange}-${page}`;
        const prior = input.force ? null : finishedPage(dataset, date);
        if (prior) {
          records += prior;
          if (prior < 500) break;
          continue;
        }
        const rows = await provider.getBulkReference({ exchange, offset: page * 500 });
        store(rows, dataset);
        progress((index + (page + 1) / maxPages) / resolved.length);
        if (rows.length < 500) break;
        if (page + 1 === maxPages) warnings.push(`Reference refresh stopped after ${maxPages} pages for ${exchange}`);
      }
    }
  }
  if (!records) throw new Error(warnings[1] || 'No current reference observations returned');
  progress(1);
  return { provider: 'eodhd', records, referenceDate: date, warnings };
}
