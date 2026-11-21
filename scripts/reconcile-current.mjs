import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { dataVersion, importDataset, isoDate, marketDay, normalizeExchange, normalizeSymbol, normalizeType, openDatabase } from '../backend/database.mjs';
import { isMarketSession } from '../backend/calendar.mjs';
import { normalizeIssuerName } from '../backend/sec.mjs';
import { verifiedCorrectionSymbols } from './apply-verified-correction.mjs';

const coreVenues = new Set(['NYSE', 'NASDAQ']);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const identityName = (value) => normalizeIssuerName(String(value || '').replace(/\s+common stock\b.*$/i, ''));
const knownIsin = (value) => /^[A-Z]{2}[A-Z0-9]{9}\d$/i.test(value ?? '') ? value.toUpperCase() : null;
const field = (row, lower, upper) => row[lower] ?? row[upper];
const rowsFor = (map, symbol, row) => map.set(symbol, [...(map.get(symbol) || []), row]);

export function reconcileCurrentCapture(db, {
  catalog, prices, date, capturedAt, catalogHash, pricesHash, dryRun = false, corporateActions = [],
  identityDate = date, useCurrentRoster = true, includeOtherListings = false, benchmarks = [], warnings = [],
}) {
  if (!isoDate(date) || !isMarketSession(date)) throw new Error('Choose a finalized US equity session');
  const knownAt = isoDate(capturedAt) ? capturedAt : marketDay(capturedAt);
  if (!isoDate(knownAt) || knownAt < date || !isoDate(identityDate) || identityDate < date || identityDate > knownAt
      || !Array.isArray(catalog) || !Array.isArray(prices) || !Array.isArray(corporateActions)) {
    throw new Error('Capture metadata or data rows are invalid');
  }
  catalogHash ??= hash(JSON.stringify(catalog));
  pricesHash ??= hash(JSON.stringify(prices));
  const recipe = [date, catalogHash, pricesHash];
  if (includeOtherListings || !useCurrentRoster || benchmarks.length || corporateActions.length) {
    recipe.push(includeOtherListings, useCurrentRoster, benchmarks, hash(JSON.stringify(corporateActions)));
  }
  const capturedKey = `Verified current EODHD capture ${hash(JSON.stringify(recipe))}`;
  const duplicates = db.prepare(`SELECT r.id,r.version,r.detail,s.expected,s.received,s.eligible_received FROM ingestion_runs r
    JOIN session_imports s ON s.run_id=r.id WHERE r.provider='eodhd' AND r.dataset='bulk-eod' AND r.status='complete'
    AND s.date=? AND EXISTS (SELECT 1 FROM json_each(r.detail, '$.warnings') WHERE value=?)
    AND (s.expected IS NULL OR (SELECT count(*) FROM session_capture_expected m WHERE m.run_id=r.id AND m.date=s.date)=s.expected)
    LIMIT 1`).get(date, capturedKey);
  if (!dryRun && duplicates) {
    const receipt = JSON.parse(duplicates.detail).warnings.find((warning) => warning.startsWith('Verified benchmark receipts '));
    const recorded = receipt ? JSON.parse(receipt.slice('Verified benchmark receipts '.length)) : {};
    return { id: duplicates.id, version: duplicates.version, expected: duplicates.expected,
      received: duplicates.received, eligibleReceived: duplicates.eligible_received, date, duplicate: true, ...recorded };
  }

  const source = new Map();
  const coreSymbols = new Set();
  const benchmarkSymbols = new Set(benchmarks);
  const catalogIsins = new Map();
  for (const raw of catalog) {
    const symbol = normalizeSymbol(field(raw, 'symbol', 'Code'));
    const exchange = normalizeExchange(field(raw, 'exchange', 'Exchange'));
    const type = normalizeType(field(raw, 'type', 'Type'));
    const isin = knownIsin(raw.isin || raw.Isin || raw.ISIN);
    if (!symbol || raw.status === 'delisted') continue;
    if (type === 'common' && coreVenues.has(exchange)) coreSymbols.add(symbol);
    rowsFor(source, symbol, { symbol, name: field(raw, 'name', 'Name'), symbolProvider: raw.providerSymbol || `${symbol}.US`,
      isin, exchange, type, listingDate: raw.listingDate || raw.ListingDate });
    if (isin) {
      if (!catalogIsins.has(isin)) catalogIsins.set(isin, new Set());
      catalogIsins.get(isin).add(symbol);
    }
  }
  const bars = new Map();
  for (const raw of prices) {
    const symbol = normalizeSymbol(raw.symbol || raw.code || raw.Code);
    if (raw.date === date && source.has(symbol)) rowsFor(bars, symbol, raw);
  }
  const candidates = db.prepare(`SELECT s.id,s.name,s.isin,s.type,i.symbol,i.exchange FROM securities s JOIN identifiers i ON i.security_id=s.id
    WHERE s.provider='eodhd' AND i.valid_from<=? AND (i.valid_to IS NULL OR i.valid_to>=?)
      AND (s.listing_date IS NULL OR s.listing_date<=?)
      AND (s.delisting_date IS NULL OR s.delisting_date>=?)
      AND (s.status<>'delisted' OR s.delisting_date IS NOT NULL AND ?<? AND s.delisting_date>=?)`)
    .all(date, date, date, date, date, identityDate, date);
  const bySymbol = new Map();
  const byIsin = new Map();
  for (const row of candidates) {
    rowsFor(bySymbol, row.symbol, row);
    if (row.isin) rowsFor(byIsin, row.isin, row);
  }
  const existingIdentity = db.prepare("SELECT id FROM securities WHERE provider='eodhd' AND isin=? LIMIT 2");
  const occupiedId = db.prepare('SELECT 1 FROM securities WHERE id=?');
  const protectedSymbols = verifiedCorrectionSymbols(db);
  const resolved = new Map();
  const reasons = { ambiguousCatalog: 0, missingBar: 0, ambiguousBar: 0, ambiguousIdentity: 0, noStableIdentity: 0,
    zeroVolume: 0, unresolvedAction: 0, ambiguousAction: 0 };
  const examples = {};
  const count = (reason, symbol) => {
    reasons[reason]++;
    const known = examples[reason] ??= [];
    if (known.length < 12) known.push(symbol);
  };
  const unique = (items, key) => [...new Map(items.map((row) => [key(row), row])).values()];
  const quotesFrom = (rows, exchange) => {
    const sameVenue = rows.filter((row) => normalizeExchange(row.exchange || row.exchange_short_name) === exchange);
    return sameVenue.length ? sameVenue : rows.filter((row) => ['US', 'UNKNOWN'].includes(normalizeExchange(row.exchange || row.exchange_short_name)));
  };
  for (const [symbol, catalogRows] of source) {
    const core = coreSymbols.has(symbol);
    const benchmark = benchmarkSymbols.has(symbol);
    if (!core && !benchmark && !(includeOtherListings && bySymbol.has(symbol))) continue;
    const choices = unique(catalogRows, (row) => JSON.stringify([identityName(row.name), row.exchange, row.isin, row.type]));
    if (choices.length !== 1) { count('ambiguousCatalog', symbol); continue; }
    const issuer = choices[0];
    if (benchmark && !['etf', 'index'].includes(issuer.type)) { count('ambiguousCatalog', symbol); continue; }
    const venueRecords = (bySymbol.get(symbol) || []).filter((row) => row.exchange === issuer.exchange);
    const symbolRecords = unique(venueRecords, (row) => row.id);
    const matched = symbolRecords.filter((row) => issuer.isin && row.isin ? issuer.isin === row.isin
      : identityName(issuer.name)?.length >= 3 && identityName(row.name) === identityName(issuer.name));
    if (protectedSymbols.has(symbol) && !matched.length) { count('ambiguousIdentity', symbol); continue; }
    if (symbolRecords.length > 1 || symbolRecords.length && !matched.length) { count('ambiguousIdentity', symbol); continue; }
    if (matched[0] && matched[0].type !== issuer.type) {
      count('ambiguousIdentity', symbol);
      continue;
    }
    const equivalentSymbols = catalogIsins.get(issuer.isin);
    if (equivalentSymbols?.size > 1) {
      // Only a previously verified primary listing may beat an out-of-scope quote for the same issue.
      const primary = core || benchmark;
      const competingPrimary = [...equivalentSymbols].some((other) => other !== symbol && (coreSymbols.has(other) || benchmarkSymbols.has(other)));
      if (!primary || competingPrimary || matched[0]?.isin !== issuer.isin) { count('ambiguousCatalog', symbol); continue; }
    }
    const captureRows = bars.get(symbol) || [];
    const quotes = unique(quotesFrom(captureRows, issuer.exchange),
      (row) => JSON.stringify([row.open, row.high, row.low, row.close, row.adjusted_close, row.volume]));
    if (quotes.length > 1 || captureRows.length && !quotes.length) {
      count('ambiguousBar', symbol);
      continue;
    }
    const quote = quotes[0];
    if (!quote) count('missingBar', symbol);
    else if (!(quote.volume > 0)) count('zeroVolume', symbol);
    let id = matched[0]?.id;
    let declaration;
    if (!id) {
      if (!core && !benchmark || !quote || date !== identityDate) { count('noStableIdentity', symbol); continue; }
      if (!issuer.isin && !(benchmark || isoDate(issuer.listingDate) && issuer.listingDate <= date)) {
        count('noStableIdentity', symbol);
        continue;
      }
      const exact = unique(byIsin.get(issuer.isin) || [], (row) => row.id);
      const known = issuer.isin ? existingIdentity.all(issuer.isin) : [];
      if (exact.length > 1 || known.length > 1 || known.length === 1 && !exact.length
          || exact[0] && exact[0].type !== issuer.type) {
        count('ambiguousIdentity', symbol);
        continue;
      }
      id = exact[0]?.id || (issuer.isin ? `eodhd:isin:${issuer.isin}` : `eodhd:${symbol}:${issuer.listingDate || date}`);
      if (!exact.length && occupiedId.get(id)) { count('ambiguousIdentity', symbol); continue; }
      declaration = { securityId: id, symbol, ...(exact.length ? {} : {
        name: issuer.name, exchange: issuer.exchange, type: issuer.type, isin: issuer.isin, status: 'active',
      }), knownAt, identifiers: [{ symbol, providerSymbol: issuer.symbolProvider, exchange: issuer.exchange, validFrom: date }] };
    }
    resolved.set(symbol, { id, declaration, quote, exchange: issuer.exchange, type: issuer.type });
  }
  // A current capture has at most one confirmed symbol per permanent issue.
  const byId = new Map();
  for (const [symbol, record] of resolved) rowsFor(byId, record.id, symbol);
  for (const symbols of byId.values()) if (symbols.length > 1) for (const symbol of symbols) {
    count('ambiguousIdentity', symbol);
    resolved.delete(symbol);
  }
  const actions = new Map();
  for (const action of corporateActions) {
    if (action.date !== date || !['split', 'dividend'].includes(action.type)) continue;
    const symbol = normalizeSymbol(action.symbol || action.code || action.Code);
    const record = resolved.get(symbol);
    const field = action.type === 'split' ? 'factor' : 'amount';
    const value = action[field] == null || action[field] === '' ? NaN : Number(action[field]);
    if (!record || !quotesFrom([action], record.exchange).length || !Number.isFinite(value) || !(value > 0)) {
      count('unresolvedAction', symbol);
      continue;
    }
    rowsFor(actions, `${record.id}:${action.type}`, { securityId: record.id, date, type: action.type, [field]: value, knownAt });
  }
  const verifiedActions = [];
  for (const [key, records] of actions) {
    const values = unique(records, (row) => row.factor ?? row.amount);
    if (values.length > 1) count('ambiguousAction', key);
    else verifiedActions.push(values[0]);
  }
  const declarations = [];
  const observed = [];
  for (const { id, declaration, quote } of resolved.values()) {
    if (declaration) declarations.push(declaration);
    if (quote) observed.push({ securityId: id, date, open: quote.open, high: quote.high, low: quote.low, close: quote.close,
      adjusted_close: quote.adjusted_close, volume: quote.volume, knownAt });
  }
  const expected = useCurrentRoster ? coreSymbols.size : null;
  const corePositiveVolume = [...coreSymbols].filter((symbol) => resolved.get(symbol)?.quote?.volume > 0).length;
  const benchmarksReceived = [...benchmarkSymbols].filter((symbol) => {
    const record = resolved.get(symbol);
    if (!record?.quote) return false;
    const { open, high, low, close, volume } = record.quote;
    return [open, high, low, close, volume].every((value) => value != null && value !== '' && Number.isFinite(Number(value)))
      && Number(low) > 0 && Number(open) >= Number(low) && Number(open) <= Number(high)
      && Number(close) >= Number(low) && Number(close) <= Number(high)
      && (record.type === 'index' ? Number(volume) >= 0 : Number(volume) > 0);
  });
  const result = { date, knownAt, expected, captureMatchingBars: [...bars.values()].flat().length,
    reconcilableBars: observed.length, positiveVolume: observed.filter((row) => row.volume > 0).length,
    corePositiveVolume, benchmarksReceived, currentOnlyIdentifiers: declarations.length, corporateActions: verifiedActions.length,
    reasons, examples, catalogHash, pricesHash, dataVersion: dataVersion(db), dryRun };
  if (dryRun) return result;
  if (!observed.length || useCurrentRoster && !expected) throw new Error('No verified security identities and matching bars were found');
  const imported = importDataset(db, {
    provider: 'eodhd', dataset: 'bulk-eod', scope: 'full', catalogDate: knownAt, expected, sessions: [date],
    securities: declarations, prices: observed, corporateActions: verifiedActions,
    expectedRoster: useCurrentRoster ? [...coreSymbols].map((symbol) => ({ symbol, securityId: resolved.get(symbol)?.id ?? null })) : [],
    warnings: [capturedKey, `Source catalog SHA256 ${catalogHash}`, `Bulk price SHA256 ${pricesHash}`,
      `Verified benchmark receipts ${JSON.stringify({ benchmarksReceived, corporateActions: verifiedActions.length, reasons })}`, ...warnings,
      'Unknown ticker and listing histories remain unknown.',
      'The source Common Stock category can still contain ADRs, REITs and other instrument subtypes.',
      ...Object.entries(reasons).filter(([, n]) => n).map(([reason, n]) => `${reason}: ${n}`)],
  });
  const ledger = db.prepare('SELECT received,eligible_received FROM session_imports WHERE date=? AND version=?').get(date, imported.version);
  return { ...result, ...imported, received: ledger?.received ?? null, eligibleReceived: ledger?.eligible_received ?? null };
}

async function verified(path, manifestPath) {
  const [raw, serialized] = await Promise.all([readFile(path), readFile(manifestPath, 'utf8')]);
  const manifest = JSON.parse(serialized);
  const digest = hash(raw);
  if (manifest.sha256 !== digest) throw new Error(`SHA256 mismatch for ${path}`);
  const data = JSON.parse(raw);
  if (!Array.isArray(data) || manifest.rows != null && manifest.rows !== data.length) throw new Error(`Row count mismatch for ${path}`);
  return { data, manifest, digest };
}

async function main() {
  try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { values } = parseArgs({ options: {
    catalog: { type: 'string' }, bulk: { type: 'string' }, 'catalog-manifest': { type: 'string' }, 'bulk-manifest': { type: 'string' },
    db: { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/reconcile-current.mjs --catalog FILE --bulk FILE [--catalog-manifest FILE --bulk-manifest FILE --dry-run]');
    return;
  }
  if (!values.catalog || !values.bulk) throw new Error('Supply the active catalog and finalized daily bulk capture');
  const sidecar = (path) => path.replace(/\.json$/, '') + '.manifest.json';
  const [catalog, bulk] = await Promise.all([
    verified(values.catalog, values['catalog-manifest'] || sidecar(values.catalog)),
    verified(values.bulk, values['bulk-manifest'] || sidecar(values.bulk)),
  ]);
  const db = openDatabase(values.db);
  try {
    const output = reconcileCurrentCapture(db, { catalog: catalog.data, prices: bulk.data, date: bulk.manifest.date,
      capturedAt: bulk.manifest.captureDate || bulk.manifest.capturedAt, catalogHash: catalog.digest, pricesHash: bulk.digest, dryRun: values['dry-run'] });
    console.log(JSON.stringify(output, null, 2));
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
