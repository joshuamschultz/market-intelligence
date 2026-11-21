import { createHash } from 'node:crypto';
import { dataVersion, importDataset, isoDate, marketDay, normalizeSymbol } from './database.mjs';
import { normalizeIssuerName } from './sec.mjs';

const ticker = (value) => normalizeSymbol(value).replace(/\.(?=[A-Z]$)/, '-');
const listedVenues = new Set(['NASDAQ', 'NYSE', 'NYSE AMERICAN', 'NYSE ARCA', 'CBOE', 'BATS', 'IEX']);
const types = new Set(['common', 'adr', 'reit']);
const instrumentDescriptors = [
  ['preferred', /\bpreferred stock\b/i],
  ['warrant', /\bwarrants?(?:\s+(?:to purchase|exercisable for)\b.*)?$/i],
  ['right', /\brights?(?:\s+to (?:purchase|subscribe)\b.*)?$/i],
  ['unit', /\bunits?(?:\s*,?\s*each consisting\b.*)?$/i],
  ['etf', /\bexchange[- ]traded fund\b/i],
];
const validLabel = (value) => typeof value === 'string' && value.trim() && !/^(?:n\/?a|--|-)$/i.test(value.trim()) ? value.trim() : null;
const name = (value) => normalizeIssuerName(String(value ?? '')
  .replace(/\s+(?:american depositar[yi] (?:shares|receipts)|depositar[yi] (?:shares|receipts)|ads(?:s)?\b).*$/i, '')
  .replace(/\s+(?:class [a-z]\s+)?(?:common stock|ordinary shares?|ordinary stock|common shares?|capital stock)(?:\b.*|$)/i, '')
  .replace(/^the\s+/i, ''));

export function parseNasdaqScreener(input) {
  const object = Buffer.isBuffer(input) || typeof input === 'string' ? JSON.parse(input) : input;
  if (!Array.isArray(object?.data?.rows)) throw new TypeError('Expected Nasdaq screener data.rows');
  const rows = [];
  let invalid = 0;
  for (const raw of object.data.rows) {
    const symbol = ticker(raw?.symbol);
    const issuerName = validLabel(raw?.name);
    if (!symbol || !issuerName) { invalid++; continue; }
    const sector = validLabel(raw.sector);
    const industry = validLabel(raw.industry);
    const marketCap = /^\$?[\d,]+(?:\.\d+)?$/.test(String(raw.marketCap ?? '').trim())
      ? Number(String(raw.marketCap).replace(/[$,]/g, '')) : null;
    const subtype = /\b(?:american depositar[yi] (?:shares|receipts)|depositar[yi] shares)\b/i.test(issuerName) ? 'adr'
      : /\breal estate investment trusts?\b/i.test(industry ?? '') ? 'reit' : instrumentDescriptors.find(([, pattern]) => pattern.test(issuerName))?.[0] ?? null;
    rows.push({ symbol, issuerName, sector, industry, marketCap: Number.isFinite(marketCap) && marketCap > 0 ? marketCap : null, subtype });
  }
  return { rows, invalid };
}

function groupBySymbol(rows, field) {
  const groups = new Map();
  for (const row of rows) {
    const symbol = ticker(row[field]);
    const values = groups.get(symbol) ?? [];
    values.push(row);
    groups.set(symbol, values);
  }
  return groups;
}

export function ingestNasdaqScreener(db, { input, capturedAt, sha256, source, dryRun = false }) {
  const effectiveDate = isoDate(capturedAt) ? capturedAt : marketDay(capturedAt);
  if (!capturedAt || !isoDate(effectiveDate)) throw new TypeError('Nasdaq capture date is required');
  const { rows, invalid } = parseNasdaqScreener(input);
  const bySource = groupBySymbol(rows, 'symbol');
  const candidates = db.prepare(`SELECT s.id,s.name,s.status,s.type,i.symbol,i.exchange FROM securities s JOIN identifiers i ON i.security_id=s.id
    WHERE i.valid_from<=? AND (i.valid_to IS NULL OR i.valid_to>=?) AND (s.listing_date IS NULL OR s.listing_date<=?)
    AND (s.delisting_date IS NULL OR s.delisting_date>=?) AND s.status<>'delisted'`).all(effectiveDate, effectiveDate, effectiveDate, effectiveDate);
  const byWarehouse = groupBySymbol(candidates.filter((row) => listedVenues.has(row.exchange)), 'symbol');
  const quarantine = { conflictingScreener: 0, missingWarehouse: 0, ambiguousWarehouse: 0, issuerMismatch: 0, unsupportedType: 0 };
  const evidence = [];
  for (const [symbol, raw] of bySource) {
    if (new Set(raw.map((row) => JSON.stringify(row))).size > 1) { quarantine.conflictingScreener++; continue; }
    const issue = [...new Map((byWarehouse.get(symbol) ?? []).map((row) => [row.id, row])).values()];
    if (!issue.length) { quarantine.missingWarehouse++; continue; }
    if (issue.length > 1) { quarantine.ambiguousWarehouse++; continue; }
    if (!types.has(issue[0].type)) { quarantine.unsupportedType++; continue; }
    const row = raw[0];
    const legal = name(row.issuerName);
    if (legal.length < 3 || legal !== name(issue[0].name)) { quarantine.issuerMismatch++; continue; }
    evidence.push({ securityId: issue[0].id, ...row });
  }
  evidence.sort((a, b) => a.securityId.localeCompare(b.securityId));
  const classifications = evidence.filter((row) => row.sector && row.industry).map((row) => ({ securityId: row.securityId,
    system: 'nasdaq', effectiveFrom: effectiveDate, knownAt: effectiveDate, sector: row.sector, industry: row.industry }));
  const fundamentals = evidence.filter((row) => row.marketCap != null).map((row) => ({ securityId: row.securityId,
    effectiveDate, knownAt: effectiveDate, marketCap: row.marketCap }));
  const summary = { dryRun, capturedAt, effectiveDate, source, sha256, system: 'nasdaq', sourceRows: rows.length, invalid,
    matched: evidence.length, classifications: classifications.length, marketCaps: fundamentals.length,
    subtypeEvidence: { adr: evidence.filter((row) => row.subtype === 'adr').length, reit: evidence.filter((row) => row.subtype === 'reit').length },
    quarantine, warehouseVersion: dataVersion(db) };
  if (dryRun || !evidence.length) return summary;
  const id = createHash('sha256').update(JSON.stringify([effectiveDate, source, sha256, evidence])).digest('hex');
  const instrumentTypes = evidence.map(({ securityId, subtype }) => ({
    securityId, subtype, effectiveDate, knownAt: effectiveDate, capturedAt,
  }));
  const result = importDataset(db, { provider: 'nasdaq', dataset: `stocks-screener:${id}`, scope: 'sample', catalogDate: effectiveDate,
    classifications, fundamentals, instrumentTypes });
  db.exec(`CREATE TABLE IF NOT EXISTS nasdaq_reference_evidence (
    capture_id TEXT NOT NULL, security_id TEXT NOT NULL REFERENCES securities(id), effective_date TEXT NOT NULL,
    captured_at TEXT NOT NULL, source TEXT, sha256 TEXT, warehouse_version INTEGER NOT NULL, evidence TEXT NOT NULL,
    PRIMARY KEY(capture_id,security_id)
  ) WITHOUT ROWID`);
  const insert = db.prepare('INSERT OR IGNORE INTO nasdaq_reference_evidence VALUES(?,?,?,?,?,?,?,?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of new Map(evidence.map((item) => [item.securityId, item])).values()) {
      insert.run(id, row.securityId, effectiveDate, capturedAt, source ?? null, sha256 ?? null, result.version, JSON.stringify(row));
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { ...summary, warehouseVersion: result.version, duplicate: Boolean(result.duplicate) };
}
