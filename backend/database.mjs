import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const analyticsSources = [
  'calendar', 'database', 'metrics', 'ranking', 'breadth', 'engine', 'screener', 'research',
  'materialization', 'rank-archive', 'archive-lineage', 'precompute',
];
const sourceHash = createHash('sha256');
for (const filename of analyticsSources) sourceHash.update(readFileSync(new URL(`./${filename}.mjs`, import.meta.url)));
import { shiftDate } from './calendar.mjs';

export const CALCULATION_VERSION = `2-${sourceHash.digest('hex').slice(0, 12)}`;
const daysInMonth = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function decimalPair(value, offset) {
  const tens = value.charCodeAt(offset) - 48;
  const ones = value.charCodeAt(offset + 1) - 48;
  return tens >= 0 && tens <= 9 && ones >= 0 && ones <= 9 ? tens * 10 + ones : -1;
}

export function isoDate(value) {
  if (typeof value !== 'string' || value.length !== 10 || value[4] !== '-' || value[7] !== '-') return false;
  const century = decimalPair(value, 0);
  const yearInCentury = decimalPair(value, 2);
  const month = decimalPair(value, 5);
  const day = decimalPair(value, 8);
  if (century < 0 || yearInCentury < 0 || month < 1 || month > 12 || day < 1) return false;
  const leapDay = month === 2 && yearInCentury % 4 === 0 && (yearInCentury !== 0 || century % 4 === 0);
  return day <= daysInMonth[month] + Number(leapDay);
}
export const today = () => new Date().toISOString().slice(0, 10);
const marketDayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
export const marketDay = (timestamp = new Date()) => marketDayFormat.format(new Date(timestamp));
const json = (value) => JSON.stringify(value);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const knownDay = (value, fallback) => {
  if (isoDate(value)) return value;
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
    ? marketDay(value) : fallback;
};
const marketTimestamp = () => new Date().toISOString();
const num = (value) => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const pick = (row, ...keys) => keys.map((key) => row[key]).find((value) => value != null && value !== '');

export function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase().replace(/\.US$/, '');
}

export function normalizeExchange(value) {
  const exchange = String(value || '').toUpperCase().trim();
  if (/NASDAQ|^XNAS$|^NAS(D|DAQ)?$/.test(exchange)) return 'NASDAQ';
  if (/AMEX|NYSE AMER|^XASE$/.test(exchange)) return 'NYSE AMERICAN';
  if (/ARCA|^ARCX$/.test(exchange)) return 'NYSE ARCA';
  if (/^NYSE$|^XNYS$|NEW YORK STOCK/.test(exchange)) return 'NYSE';
  return exchange || 'UNKNOWN';
}

export function normalizeType(value) {
  const type = String(value || '').toLowerCase().trim();
  if (['common', 'common stock', 'common_stock', 'ordinary share', 'ordinary shares', 'equity'].includes(type)) return 'common';
  if (/etf|exchange traded fund/.test(type)) return 'etf';
  if (/reit|real estate investment trust/.test(type)) return 'reit';
  if (/adr|depositary/.test(type)) return 'adr';
  if (/preferred/.test(type)) return 'preferred';
  if (/warrant/.test(type)) return 'warrant';
  if (/^rights?$/.test(type)) return 'right';
  if (/unit/.test(type)) return 'unit';
  if (/fund|etn/.test(type)) return type;
  return type || 'unknown';
}

const schema = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS securities (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, exchange TEXT NOT NULL,
    listing_date TEXT, delisting_date TEXT, first_seen TEXT, last_seen TEXT, provider TEXT NOT NULL,
    listing_inferred INTEGER NOT NULL DEFAULT 0, reference_known TEXT,
    reference_inferred INTEGER NOT NULL DEFAULT 0, isin TEXT, status TEXT NOT NULL DEFAULT 'unknown'
  );
  CREATE TABLE IF NOT EXISTS identifiers (
    security_id TEXT NOT NULL REFERENCES securities(id), symbol TEXT NOT NULL, provider_symbol TEXT NOT NULL,
    exchange TEXT NOT NULL, valid_from TEXT NOT NULL, valid_to TEXT, source TEXT NOT NULL,
    PRIMARY KEY (security_id, symbol, valid_from)
  );
  CREATE INDEX IF NOT EXISTS identifiers_symbol ON identifiers(symbol, valid_from, valid_to);
  CREATE TABLE IF NOT EXISTS reference_revisions (
    security_id TEXT NOT NULL, version INTEGER NOT NULL, source TEXT NOT NULL,
    known_at TEXT, definition TEXT NOT NULL, PRIMARY KEY (security_id, version)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS quality_overrides (
    id TEXT NOT NULL, version INTEGER NOT NULL, security_id TEXT NOT NULL REFERENCES securities(id),
    kind TEXT NOT NULL, effective_from TEXT NOT NULL, effective_to TEXT NOT NULL, known_at TEXT NOT NULL,
    active INTEGER NOT NULL, reason TEXT NOT NULL, evidence_url TEXT NOT NULL, source TEXT NOT NULL,
    PRIMARY KEY (id, version)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS session_imports (
    date TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES ingestion_runs(id), version INTEGER NOT NULL,
    scope TEXT NOT NULL, expected INTEGER, received INTEGER NOT NULL, eligible_received INTEGER,
    PRIMARY KEY (date, run_id)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS session_capture_expected (
    run_id TEXT NOT NULL, date TEXT NOT NULL, symbol TEXT NOT NULL, security_id TEXT REFERENCES securities(id),
    PRIMARY KEY (run_id, date, symbol), FOREIGN KEY (date, run_id) REFERENCES session_imports(date, run_id)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS session_capture_received (
    run_id TEXT NOT NULL, date TEXT NOT NULL, security_id TEXT NOT NULL REFERENCES securities(id),
    PRIMARY KEY (run_id, date, security_id), FOREIGN KEY (date, run_id) REFERENCES session_imports(date, run_id)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS instrument_type_observations (
    security_id TEXT NOT NULL REFERENCES securities(id), effective_date TEXT NOT NULL, known_at TEXT NOT NULL,
    captured_at TEXT NOT NULL, subtype TEXT, source TEXT NOT NULL, version INTEGER NOT NULL,
    PRIMARY KEY (security_id, source, effective_date, captured_at, version)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS instrument_type_revision ON instrument_type_observations(version, effective_date);
  CREATE INDEX IF NOT EXISTS sessions_by_version ON session_imports(date, version);
  CREATE TABLE IF NOT EXISTS daily_prices (
    security_id TEXT NOT NULL REFERENCES securities(id), date TEXT NOT NULL,
    open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
    adjusted_close REAL, split_close REAL, volume REAL NOT NULL, source TEXT NOT NULL,
    known_at TEXT NOT NULL, ingested_at TEXT NOT NULL, version INTEGER NOT NULL,
    volume_adjusted INTEGER NOT NULL DEFAULT 0, volume_basis TEXT, PRIMARY KEY (security_id, date)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS prices_date ON daily_prices(date, security_id);
  CREATE TABLE IF NOT EXISTS price_revisions (
    security_id TEXT NOT NULL, date TEXT NOT NULL, open REAL NOT NULL, high REAL NOT NULL,
    low REAL NOT NULL, close REAL NOT NULL, adjusted_close REAL, split_close REAL,
    volume REAL NOT NULL, source TEXT NOT NULL, known_at TEXT NOT NULL, ingested_at TEXT NOT NULL,
    version INTEGER NOT NULL, volume_adjusted INTEGER NOT NULL, volume_basis TEXT,
    PRIMARY KEY (security_id, date, version)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS price_revisions_date ON price_revisions(date, security_id, version);
  CREATE TABLE IF NOT EXISTS corporate_actions (
    security_id TEXT NOT NULL REFERENCES securities(id), date TEXT NOT NULL, type TEXT NOT NULL,
    factor REAL, amount REAL, known_at TEXT NOT NULL, source TEXT NOT NULL, version INTEGER NOT NULL,
    PRIMARY KEY (security_id, date, type, version)
  );
  CREATE INDEX IF NOT EXISTS corporate_actions_lookup ON corporate_actions(security_id, date, type, version);
  CREATE TABLE IF NOT EXISTS fundamentals (
    security_id TEXT NOT NULL REFERENCES securities(id), effective_date TEXT NOT NULL, known_at TEXT NOT NULL,
    float REAL, shares REAL, market_cap REAL, source TEXT NOT NULL, version INTEGER NOT NULL,
    PRIMARY KEY (security_id, effective_date, known_at, version)
  );
  CREATE TABLE IF NOT EXISTS classifications (
    security_id TEXT NOT NULL REFERENCES securities(id), effective_from TEXT NOT NULL,
    effective_to TEXT, known_at TEXT NOT NULL, sector TEXT, industry TEXT, subindustry TEXT,
    system TEXT NOT NULL DEFAULT 'provider', source TEXT NOT NULL, version INTEGER NOT NULL,
    PRIMARY KEY (security_id, system, effective_from, known_at, version)
  );
  CREATE TABLE IF NOT EXISTS ingestion_runs (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL, dataset TEXT NOT NULL, scope TEXT NOT NULL,
    status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, dates TEXT, rows INTEGER NOT NULL DEFAULT 0,
    expected INTEGER, imported INTEGER NOT NULL DEFAULT 0, detail TEXT, fingerprint TEXT, version INTEGER
  );
  CREATE INDEX IF NOT EXISTS ingestion_runs_status ON ingestion_runs(status, started_at);
  CREATE TABLE IF NOT EXISTS workspace (
    kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL,
    definition TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (kind, id, version)
  );
  CREATE TABLE IF NOT EXISTS snapshots (
    kind TEXT NOT NULL, date TEXT NOT NULL, universe TEXT NOT NULL, model TEXT NOT NULL, 
    data_version INTEGER NOT NULL, calculation_version TEXT NOT NULL, definition_key TEXT NOT NULL,
    value TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (kind, date, universe, model, data_version, calculation_version, definition_key)
  );
  CREATE TABLE IF NOT EXISTS alert_events (
    rule_id TEXT NOT NULL, date TEXT NOT NULL, subject TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY (rule_id, date, subject)
  );
  CREATE TABLE IF NOT EXISTS daily_publications (
    date TEXT NOT NULL, raw_version INTEGER NOT NULL, calculation_version TEXT NOT NULL,
    data_version INTEGER NOT NULL, model_versions TEXT NOT NULL, published_at TEXT NOT NULL,
    PRIMARY KEY (date, raw_version, calculation_version)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, progress INTEGER NOT NULL, payload TEXT NOT NULL, result TEXT, error TEXT
  );
`;

const upsertPrice = `
  INSERT INTO daily_prices VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(security_id, date) DO UPDATE SET
    open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
    adjusted_close=excluded.adjusted_close, split_close=coalesce(excluded.split_close, daily_prices.split_close),
    volume=excluded.volume, source=excluded.source, known_at=excluded.known_at, ingested_at=excluded.ingested_at,
    version=excluded.version, volume_adjusted=excluded.volume_adjusted, volume_basis=excluded.volume_basis
  WHERE daily_prices.open IS NOT excluded.open OR daily_prices.high IS NOT excluded.high
    OR daily_prices.low IS NOT excluded.low OR daily_prices.close IS NOT excluded.close
    OR daily_prices.adjusted_close IS NOT excluded.adjusted_close
    OR (excluded.split_close IS NOT NULL AND daily_prices.split_close IS NOT excluded.split_close)
    OR daily_prices.volume IS NOT excluded.volume OR daily_prices.volume_adjusted IS NOT excluded.volume_adjusted
    OR excluded.known_at < daily_prices.known_at
    OR (daily_prices.volume_basis IS NULL AND excluded.volume_basis IS NOT NULL)
`;

function normalizedPrice(raw, provider, version, ingestedAt) {
  const date = pick(raw, 'date', 'Date');
  const open = num(pick(raw, 'open', 'Open'));
  const high = num(pick(raw, 'high', 'High'));
  const low = num(pick(raw, 'low', 'Low'));
  const close = num(pick(raw, 'close', 'Close'));
  const adjusted = num(pick(raw, 'adjusted_close', 'adjustedClose', 'Adjusted_close', 'Adjusted Close'));
  const split = num(pick(raw, 'split_close', 'splitClose'));
  const volume = num(pick(raw, 'volume', 'Volume'));
  if (!isoDate(date) || !(low > 0) || !(open > 0) || !(close > 0) || !((open >= low && open <= high) && (close >= low && close <= high)) || volume == null || volume < 0) return null;
  const volumeAdjusted = raw.volumeAdjusted ?? raw.volume_adjusted ?? (provider === 'eodhd');
  const known = knownDay(raw.knownAt || raw.known_at, marketDay(ingestedAt));
  const volumeBasis = volumeAdjusted ? knownDay(raw.volumeBasis || raw.volume_basis, known) : null;
  return [date, open, high, low, close, adjusted > 0 ? adjusted : null, split > 0 ? split : null,
    volume, provider, known, ingestedAt, version, Number(Boolean(volumeAdjusted)), volumeBasis];
}

function fromStored(row) {
  if (!row) return null;
  return { ...row, definition: JSON.parse(row.definition) };
}

export function openDatabase(filename = process.env.MARKET_DB || 'data/market.sqlite') {
  if (filename !== ':memory:') {
    filename = resolve(filename);
    mkdirSync(dirname(filename), { recursive: true });
  }
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL');
  db.exec(schema);
  for (const [table, column, type] of [
    ['daily_prices', 'volume_basis', 'TEXT'], ['price_revisions', 'volume_basis', 'TEXT'],
    ['securities', 'isin', 'TEXT'], ['securities', 'status', "TEXT NOT NULL DEFAULT 'unknown'"], ['session_imports', 'eligible_received', 'INTEGER'],
  ]) {
    const available = () => db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
    if (!available()) {
      try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`); }
      catch (error) { if (!available()) throw error; }
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS securities_isin ON securities(isin, provider) WHERE isin IS NOT NULL');
  return db;
}

export function dataVersion(db) {
  return Number(db.prepare("SELECT value FROM meta WHERE key = 'data_version'").get()?.value || 0);
}

export function qualityOverrides(db, { version = dataVersion(db), knownThrough = '9999-12-31', includeCleared = false } = {}) {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='quality_overrides'").get()) return [];
  const rows = db.prepare(`SELECT * FROM quality_overrides WHERE version<=? AND known_at<=?
    ORDER BY id,version DESC`).all(version, knownThrough);
  const seen = new Set();
  return rows.filter((row) => !seen.has(row.id) && seen.add(row.id) && (includeCleared || row.active));
}

export function importDataset(db, batch) {
  if (!batch || typeof batch !== 'object') throw new Error('Import must be a dataset object');
  const provider = String(batch.provider || 'file').toLowerCase();
  const dataset = String(batch.dataset || 'eod');
  const scope = batch.scope === 'full' ? 'full' : 'sample';
  const startTime = marketTimestamp();
  const fingerprint = digest(json({
    provider, dataset, scope, expected: batch.expected ?? null, catalogDate: batch.catalogDate ?? null,
    securities: batch.securities || [], prices: batch.prices || [], corporateActions: batch.corporateActions || [],
    fundamentals: batch.fundamentals || [], classifications: batch.classifications || [], sessions: batch.sessions || [],
    ...(batch.instrumentTypes?.length ? { instrumentTypes: batch.instrumentTypes } : {}),
    ...(batch.expectedRoster?.length ? { expectedRoster: batch.expectedRoster } : {}),
    ...(batch.qualityOverrides?.length ? { qualityOverrides: batch.qualityOverrides } : {}),
  }));
  const runId = randomUUID();
  const checkDuplicate = db.prepare("SELECT id, version, rows, imported FROM ingestion_runs WHERE fingerprint=? AND status='complete'");
  const check = checkDuplicate.get(fingerprint);
  if (check) return { ...check, duplicate: true };
  db.prepare("INSERT INTO ingestion_runs (id, provider, dataset, scope, status, started_at, expected, fingerprint) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)")
    .run(runId, provider, dataset, scope, startTime, num(batch.expected), fingerprint);
  const rows = batch.prices || [];
  let imported = 0;
  let invalid = 0;
  let unresolved = 0;
  let inferred = 0;
  let version;
  let earliest = null;
  let latest = null;
  let archiveImpactFrom = null;
  const affect = (date) => {
    const impact = isoDate(date) ? date : '1900-01-01';
    if (archiveImpactFrom == null || impact < archiveImpactFrom) archiveImpactFrom = impact;
  };
  try {
    db.exec('BEGIN IMMEDIATE');
    const duplicate = checkDuplicate.get(fingerprint);
    if (duplicate) {
      db.exec('ROLLBACK');
      db.prepare("UPDATE ingestion_runs SET status='duplicate', finished_at=?, version=? WHERE id=?")
        .run(marketTimestamp(), duplicate.version, runId);
      return { ...duplicate, duplicate: true };
    }
    version = dataVersion(db) + 1;
    const security = db.prepare(`
      INSERT INTO securities (id, name, type, exchange, listing_date, delisting_date, provider, listing_inferred, reference_known, reference_inferred, isin, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
        name=CASE WHEN excluded.name = excluded.id THEN securities.name ELSE excluded.name END,
        type=coalesce(nullif(excluded.type,'unknown'), securities.type),
        exchange=coalesce(nullif(excluded.exchange,'UNKNOWN'), securities.exchange),
        listing_date=coalesce(excluded.listing_date, securities.listing_date),
        delisting_date=coalesce(excluded.delisting_date, securities.delisting_date),
        listing_inferred=CASE WHEN excluded.listing_date IS NOT NULL THEN excluded.listing_inferred ELSE securities.listing_inferred END,
        reference_known=CASE WHEN securities.reference_known IS NULL OR excluded.reference_known < securities.reference_known
          OR (excluded.name <> excluded.id AND excluded.name IS NOT securities.name)
          OR (excluded.type <> 'unknown' AND excluded.type IS NOT securities.type)
          OR (excluded.exchange <> 'UNKNOWN' AND excluded.exchange IS NOT securities.exchange)
          OR (excluded.listing_date IS NOT NULL AND excluded.listing_date IS NOT securities.listing_date)
          OR (excluded.delisting_date IS NOT NULL AND excluded.delisting_date IS NOT securities.delisting_date)
          OR (excluded.status <> 'unknown' AND excluded.status IS NOT securities.status)
          THEN excluded.reference_known ELSE securities.reference_known END,
        reference_inferred=min(securities.reference_inferred, excluded.reference_inferred),
        isin=coalesce(excluded.isin, securities.isin), status=coalesce(nullif(excluded.status, 'unknown'), securities.status)
    `);
    const identifier = db.prepare(`
      INSERT INTO identifiers VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(security_id, symbol, valid_from) DO UPDATE SET valid_to=coalesce(excluded.valid_to, identifiers.valid_to),
        exchange=coalesce(nullif(excluded.exchange,'UNKNOWN'), identifiers.exchange)
    `);
    const currentAlias = db.prepare('SELECT valid_from,valid_to FROM identifiers WHERE security_id=? AND symbol=? ORDER BY valid_from');
    const identifierLookup = db.prepare(`
      SELECT security_id, max(valid_from) valid_from FROM identifiers WHERE symbol=? AND valid_from<=? AND (valid_to IS NULL OR valid_to>=?)
      GROUP BY security_id ORDER BY valid_from DESC LIMIT 2
    `);
    const securityLookup = db.prepare('SELECT * FROM securities WHERE id=?');
    const previousIdentity = db.prepare(`
      SELECT DISTINCT s.id, s.listing_date, s.delisting_date, s.isin FROM identifiers i
      JOIN securities s ON s.id=i.security_id WHERE i.symbol=? AND s.provider=?
    `);
    const exactIdentity = db.prepare('SELECT id FROM securities WHERE isin=? AND provider=? ORDER BY id LIMIT 2');
    const remember = new Map();
    const ranges = new Map();
    const observedSessions = new Map();
    const eligibleSessions = new Map();
    const captureExpected = scope === 'full' && num(batch.expected) > 0;
    const coreIdentifier = db.prepare(`SELECT 1 FROM identifiers i JOIN securities s ON s.id=i.security_id
      WHERE s.id=? AND s.type='common' AND i.exchange IN ('NYSE','NASDAQ')
      AND i.valid_from<=? AND (i.valid_to IS NULL OR i.valid_to>=?) LIMIT 1`);
    const referenceUpdates = new Set();
    const splits = new Map();
    const declare = (row, assumed = false) => {
      const rawSymbol = String(pick(row, 'providerSymbol', 'provider_symbol', 'symbol', 'ticker', 'code', 'Code') || '');
      const symbol = normalizeSymbol(rawSymbol);
      if (!symbol) { invalid += 1; return null; }
      const start = pick(row, 'listingDate', 'listing_date', 'validFrom', 'valid_from');
      const end = pick(row, 'delistingDate', 'delisting_date', 'validTo', 'valid_to');
      const known = knownDay(row.knownAt || row.known_at, knownDay(batch.catalogDate, marketDay()));
      const suppliedIsin = String(pick(row, 'isin', 'ISIN', 'Isin') || '').trim().toUpperCase();
      const isin = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(suppliedIsin) ? suppliedIsin : null;
      const explicit = pick(row, 'securityId', 'security_id', 'id');
      const existing = previousIdentity.all(symbol, provider);
      const exact = isin ? exactIdentity.all(isin, provider) : [];
      const compatible = existing.filter((item) => (!isin || !item.isin || item.isin === isin)
        && (!isoDate(start) || !item.delisting_date || start <= item.delisting_date)
        && (!isoDate(end) || !item.listing_date || end >= item.listing_date));
      if (!explicit && !row.identitySuffix && (exact.length > 1 || !exact.length && compatible.length > 1)) { unresolved++; return null; }
      const fallbackId = existing.length && !compatible.length
        ? `${provider}:${symbol}:${isin || start || end}` : `${provider}:${symbol}`;
      const id = String(explicit || (row.identitySuffix ? `${provider}:${symbol}:${row.identitySuffix}` : exact[0]?.id || compatible[0]?.id || fallbackId));
      if (isoDate(start) && isoDate(end) && start > end) throw new Error(`Listing has an invalid interval for ${symbol}`);
      if (!explicit && compatible.length === 1 && start && compatible[0].listing_date
          && start !== compatible[0].listing_date && end && compatible[0].delisting_date && end !== compatible[0].delisting_date) {
        unresolved++;
        return null;
      }
      if (!/^[a-zA-Z0-9._:@/-]{1,180}$/.test(id)) { invalid += 1; return null; }
      const exchange = normalizeExchange(pick(row, 'exchange', 'Exchange', 'primaryExchange'));
      const type = normalizeType(pick(row, 'type', 'Type', 'securityType'));
      const suppliedStatus = String(row.status || '').toLowerCase();
      const state = ['active', 'halted', 'suspended', 'delisted'].includes(suppliedStatus)
        ? suppliedStatus : isoDate(end) ? 'delisted' : 'unknown';
      security.run(id, String(pick(row, 'name', 'Name') || id), type, exchange,
        isoDate(start) ? start : null, isoDate(end) ? end : null, provider, Number(assumed), known,
        Number(!row.knownAt && !row.known_at), isin, state);
      const identifiers = Array.isArray(row.identifiers) && row.identifiers.length ? row.identifiers : [row];
      for (const entry of identifiers) {
        const alias = normalizeSymbol(pick(entry, 'symbol', 'ticker', 'Code', 'providerSymbol') || rawSymbol);
        if (!alias) continue;
        const from = pick(entry, 'validFrom', 'valid_from', 'listingDate', 'listing_date') || start;
        const to = pick(entry, 'validTo', 'valid_to', 'delistingDate', 'delisting_date') || end;
        const existingAliases = !isoDate(from) ? currentAlias.all(id, alias) : [];
        const validTo = isoDate(to) ? to : null;
        if (!remember.has(alias)) remember.set(alias, new Map());
        const mappings = remember.get(alias);
        if (!mappings.has(id)) mappings.set(id, []);
        if (existingAliases.length && (!validTo || existingAliases.length > 1)) {
          for (const prior of existingAliases) mappings.get(id).push([prior.valid_from, prior.valid_to]);
          continue;
        }
        const validFrom = isoDate(from) ? from : existingAliases[0]?.valid_from || '0001-01-01';
        if (validTo && validTo < validFrom) throw new Error(`Identifier has an invalid interval for ${alias}`);
        identifier.run(id, alias, String(pick(entry, 'providerSymbol', 'provider_symbol', 'symbol', 'ticker', 'Code') || rawSymbol),
          entry.exchange ? normalizeExchange(entry.exchange) : exchange, validFrom, validTo, provider);
        mappings.get(id).push([validFrom, validTo]);
      }
      referenceUpdates.add(id);
      if (assumed) inferred++;
      return id;
    };
    for (const row of batch.securities || []) declare(row);
    const identity = (row, date, infer = false) => {
      const explicit = pick(row, 'securityId', 'security_id');
      if (explicit) return securityLookup.get(explicit)?.id || null;
      const symbol = normalizeSymbol(pick(row, 'symbol', 'ticker', 'code', 'Code', 'providerSymbol'));
      if (!symbol) return null;
      const inBatch = remember.get(symbol);
      if (inBatch?.size === 1) {
        const [[id, intervals]] = inBatch;
        const tableMatches = identifierLookup.all(symbol, date, date);
        if (tableMatches.length <= 1 && intervals.some(([from, to]) => from <= date && (!to || to >= date))) return id;
      }
      const existing = identifierLookup.all(symbol, date, date);
      if (existing.length) return existing.length === 1 ? existing[0].security_id : null;
      if (!infer || inBatch?.size) return null;
      return declare({ symbol, exchange: pick(row, 'exchange', 'Exchange'), type: pick(row, 'type', 'Type') }, true);
    };
    const insertPrice = db.prepare(upsertPrice);
    const revisePrice = db.prepare('INSERT INTO price_revisions SELECT * FROM daily_prices WHERE security_id=? AND date=? AND version=? ON CONFLICT DO NOTHING');
    for (const row of rows) {
      const price = normalizedPrice(row, provider, version, startTime);
      if (!price) { invalid++; continue; }
      const date = price[0];
      const id = identity(row, date, true);
      if (!id) { unresolved++; continue; }
      const result = insertPrice.run(id, ...price);
      if (!observedSessions.has(date)) observedSessions.set(date, new Set());
      observedSessions.get(date).add(id);
      if (captureExpected && price[7] > 0 && coreIdentifier.get(id, date, date)) {
        if (!eligibleSessions.has(date)) eligibleSessions.set(date, new Set());
        eligibleSessions.get(date).add(id);
      }
      if (result.changes) {
        revisePrice.run(id, date, version);
        affect(date);
        imported++;
      }
      const range = ranges.get(id);
      if (!range) ranges.set(id, [date, date]);
      else {
        if (date < range[0]) range[0] = date;
        if (date > range[1]) range[1] = date;
      }
      if (!earliest || date < earliest) earliest = date;
      if (!latest || date > latest) latest = date;
    }
    const observe = db.prepare(`
      UPDATE securities SET first_seen=min(coalesce(first_seen, ?), ?), last_seen=max(coalesce(last_seen, ?), ?)
      WHERE id=?
    `);
    for (const [id, [first, last]] of ranges) {
      const old = securityLookup.get(id);
      if (old?.last_seen && last > old.last_seen) affect(shiftDate(old.last_seen, 1));
      observe.run(first, first, last, last, id);
    }
    const getIdentifiers = db.prepare('SELECT * FROM identifiers WHERE security_id=? ORDER BY valid_from, symbol');
    const priorReference = db.prepare('SELECT definition FROM reference_revisions WHERE security_id=? ORDER BY version DESC LIMIT 1');
    const writeReference = db.prepare('INSERT INTO reference_revisions VALUES (?, ?, ?, ?, ?)');
    const eligibility = (fact) => json([
      fact.type, fact.exchange, fact.listing_date, fact.delisting_date, fact.status,
      fact.reference_inferred, fact.listing_inferred,
      fact.identifiers.map(({ symbol, exchange, valid_from, valid_to }) => [symbol, exchange, valid_from, valid_to]),
    ]);
    for (const id of referenceUpdates) {
      const { first_seen, last_seen, ...reference } = securityLookup.get(id);
      const record = { ...reference, identifiers: getIdentifiers.all(id) };
      const definition = json(record);
      const prior = priorReference.get(id)?.definition;
      if (prior !== definition) {
        if (!prior) affect(reference.listing_date || first_seen || reference.reference_known);
        else {
          const before = JSON.parse(prior);
          if (eligibility(before) !== eligibility(record)) affect('1900-01-01');
          else if (before.reference_known !== record.reference_known) affect([before.reference_known, record.reference_known].filter(Boolean).sort()[0]);
        }
        writeReference.run(id, version, provider, reference.reference_known, definition);
      }
    }
    const addSession = db.prepare('INSERT INTO session_imports VALUES (?, ?, ?, ?, ?, ?, ?)');
    const sessions = new Set((batch.sessions || []).filter(isoDate));
    if (scope === 'full') for (const date of observedSessions.keys()) sessions.add(date);
    const addExpected = db.prepare('INSERT INTO session_capture_expected VALUES (?,?,?,?)');
    const addReceived = db.prepare('INSERT INTO session_capture_received VALUES (?,?,?)');
    for (const date of sessions) {
      const received = eligibleSessions.get(date) || new Set();
      addSession.run(date, runId, version, scope, num(batch.expected), observedSessions.get(date)?.size || 0, captureExpected ? received.size : null);
      if (scope === 'full') affect(date);
      if (!captureExpected) continue;
      for (const id of received) addReceived.run(runId, date, id);
      const roster = new Map();
      for (const row of batch.expectedRoster || []) {
        const symbol = normalizeSymbol(row.symbol);
        if (!symbol || row.date && row.date !== date) continue;
        const candidate = Object.hasOwn(row, 'securityId') && row.securityId == null ? null : identity(row, date);
        const id = candidate && coreIdentifier.get(candidate, date, date) ? candidate : null;
        if (roster.has(symbol) && roster.get(symbol) !== id) roster.set(symbol, null);
        else roster.set(symbol, id);
      }
      const occurrences = new Map();
      for (const id of roster.values()) if (id) occurrences.set(id, (occurrences.get(id) || 0) + 1);
      for (const [symbol, id] of roster) addExpected.run(runId, date, symbol, occurrences.get(id) === 1 ? id : null);
    }
    const previousAction = db.prepare('SELECT factor,amount,known_at FROM corporate_actions WHERE security_id=? AND date=? AND type=? ORDER BY version DESC LIMIT 1');
    const splitAffectsPreviousVolume = db.prepare(`SELECT date FROM daily_prices WHERE security_id=? AND date<?
      AND (volume_adjusted=1 OR split_close IS NOT NULL) AND coalesce(volume_basis,known_at)>=? ORDER BY date LIMIT 1`);
    const insertAction = db.prepare('INSERT OR REPLACE INTO corporate_actions VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const row of batch.corporateActions || []) {
      const date = pick(row, 'date', 'effectiveDate');
      if (!isoDate(date)) { invalid++; continue; }
      const id = identity(row, date);
      if (!id) { unresolved++; continue; }
      const type = String(row.type || '').toLowerCase();
      const factor = num(row.factor);
      const amount = num(row.amount);
      if (!type || (type === 'split' && !(factor > 0))) { invalid++; continue; }
      const known = knownDay(row.knownAt || row.known_at, marketDay(startTime));
      const prior = previousAction.get(id, date, type);
      if (!prior || prior.factor !== factor || prior.amount !== amount || known < prior.known_at) {
        const earlier = type === 'split' ? splitAffectsPreviousVolume.get(id, date, date)?.date : null;
        affect(earlier || date);
      }
      insertAction.run(id, date, type, factor, amount, known, provider, version);
      if (type === 'split') splits.set(id, true);
    }
    const insertFundamentals = db.prepare('INSERT OR REPLACE INTO fundamentals VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const row of batch.fundamentals || []) {
      const date = pick(row, 'effectiveDate', 'effective_date', 'date');
      const known = knownDay(row.knownAt || row.known_at, marketDay());
      if (!isoDate(date)) { invalid++; continue; }
      const id = identity(row, date);
      if (!id) { unresolved++; continue; }
      const float = num(pick(row, 'float', 'sharesFloat', 'floatShares'));
      const shares = num(pick(row, 'shares', 'sharesOutstanding'));
      const cap = num(pick(row, 'marketCap', 'market_cap'));
      insertFundamentals.run(id, date, known, float > 0 ? float : null, shares > 0 ? shares : null, cap > 0 ? cap : null, provider, version);
      affect(date > known ? date : known);
    }
    const insertClassification = db.prepare('INSERT OR REPLACE INTO classifications VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const row of batch.classifications || []) {
      const from = pick(row, 'effectiveFrom', 'effective_from', 'date');
      if (!isoDate(from)) { invalid++; continue; }
      const known = knownDay(row.knownAt || row.known_at, marketDay());
      const id = identity(row, from);
      if (!id) { unresolved++; continue; }
      const to = pick(row, 'effectiveTo', 'effective_to');
      if (to && (!isoDate(to) || to < from)) { invalid++; continue; }
      insertClassification.run(id, from, to || null, known, row.sector || null, row.industry || null,
        row.subindustry || null, row.system || 'provider', provider, version);
      affect(from > known ? from : known);
    }
    const insertType = db.prepare('INSERT OR REPLACE INTO instrument_type_observations VALUES (?,?,?,?,?,?,?)');
    const supportedTypes = new Set(['adr', 'reit', 'preferred', 'warrant', 'right', 'unit', 'etf']);
    for (const row of batch.instrumentTypes || []) {
      const effective = row.effectiveDate;
      const known = knownDay(row.knownAt || row.capturedAt, marketDay(startTime));
      const subtype = row.subtype ?? null;
      if (!isoDate(effective) || subtype != null && !supportedTypes.has(subtype)) { invalid++; continue; }
      const id = identity(row, effective);
      if (!id) { unresolved++; continue; }
      insertType.run(id, effective, known, String(row.capturedAt || known), subtype, provider, version);
      affect(effective > known ? effective : known);
    }
    const putOverride = db.prepare('INSERT INTO quality_overrides VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const previousOverride = db.prepare('SELECT * FROM quality_overrides WHERE id=? ORDER BY version DESC LIMIT 1');
    const overrideKinds = new Set(['price', 'volume', 'adjusted-close', 'split', 'notice']);
    for (const row of batch.qualityOverrides || []) {
      const { id, securityId, kind, from, to = from, knownAt, reason, evidenceUrl, active = true } = row;
      let evidence;
      try { evidence = new URL(evidenceUrl); } catch {}
      if (!/^[A-Za-z0-9:_-]{1,100}$/.test(id || '') || !securityLookup.get(securityId) || !overrideKinds.has(kind)
          || ![from, to, knownAt].every(isoDate) || from > to || typeof active !== 'boolean'
          || typeof reason !== 'string' || !reason.trim() || reason.length > 1000
          || evidence?.protocol !== 'https:' || evidence.username || evidence.password || evidence.href.length > 1000) {
        throw new Error('A quality override requires a security, valid date range, reason, and HTTPS evidence');
      }
      const prior = previousOverride.get(id);
      if (prior && (prior.security_id !== securityId || prior.kind !== kind || prior.effective_from !== from
          || prior.effective_to !== to || prior.known_at > knownAt) || !prior && !active) {
        throw new Error('Quality override identity, scope and knowledge history are immutable. Use a new ID for a different scope.');
      }
      putOverride.run(id, version, securityId, kind, from, to, knownAt, Number(active), reason.trim(), evidence.href, provider);
      if (kind === 'split') {
        const revised = db.prepare(`SELECT date FROM daily_prices WHERE security_id=? AND date<? AND
          (volume_adjusted=1 OR split_close IS NOT NULL) AND coalesce(volume_basis,known_at)>=? ORDER BY date LIMIT 1`)
          .get(securityId, from, from);
        affect(revised?.date || from);
      } else if (kind !== 'notice') affect(from);
    }
    if (rows.length && !earliest) throw new Error('Import contains no valid, resolvable price observations');
    db.prepare("INSERT INTO meta VALUES ('data_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(version));
    const detail = { archiveImpactTracked: true, archiveImpactFrom, invalid, unresolved, inferredIdentifiers: inferred, adjustedWithSplits: splits.size, catalogDate: knownDay(batch.catalogDate, null), catalogRecords: (batch.securities || []).length,
      calendarSessions: Array.isArray(batch.sessions) ? batch.sessions.length : null,
      warnings: Array.isArray(batch.warnings) ? batch.warnings.map(String).slice(0, 100) : [] };
    db.prepare(`UPDATE ingestion_runs SET status='complete', finished_at=?, dates=?, rows=?, imported=?, detail=?, version=? WHERE id=?`)
      .run(marketTimestamp(), json([earliest, latest]), rows.length, imported, json(detail), version, runId);
    db.exec('COMMIT');
    return { id: runId, version, rows: rows.length, imported, dates: [earliest, latest], ...detail };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.prepare("UPDATE ingestion_runs SET status='failed', finished_at=?, detail=? WHERE id=?")
      .run(marketTimestamp(), json({ error: error.message }), runId);
    throw error;
  }
}

export function listWorkspace(db, kind) {
  return db.prepare(`
    SELECT a.* FROM workspace a
    WHERE kind=? AND deleted=0 AND version=(SELECT max(b.version) FROM workspace b WHERE b.kind=a.kind AND b.id=a.id)
    ORDER BY name COLLATE NOCASE, id
  `).all(kind).map(fromStored);
}

export function getWorkspace(db, kind, id, version = null) {
  const item = version
    ? db.prepare('SELECT * FROM workspace WHERE kind=? AND id=? AND version=? AND deleted=0').get(kind, id, version)
    : db.prepare('SELECT * FROM workspace WHERE kind=? AND id=? ORDER BY version DESC LIMIT 1').get(kind, id);
  return item?.deleted ? null : fromStored(item);
}

export function storeWorkspace(db, kind, input, id = randomUUID(), deleted = false) {
  const name = String(input?.name || '').trim();
  if (!name || name.length > 100) throw new Error('Name must contain 1–100 characters');
  const old = getWorkspace(db, kind, id);
  if (deleted && !old) return null;
  const definition = input.definition || {};
  const timestamp = marketTimestamp();
  db.prepare(`
    INSERT INTO workspace (kind, id, version, name, definition, created_at, updated_at, deleted)
    SELECT ?, ?, coalesce(max(version), 0)+1, ?, ?, coalesce(min(created_at), ?), ?, ?
    FROM workspace WHERE kind=? AND id=?
  `).run(kind, id, name, json(definition), timestamp, timestamp, Number(deleted), kind, id);
  return deleted ? { id, deleted: true } : getWorkspace(db, kind, id);
}

export function createJob(db, type, payload) {
  const id = randomUUID();
  const timestamp = marketTimestamp();
  db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, type, 'queued', timestamp, timestamp, 0, json(payload), null, null);
  return jobById(db, id);
}

export function updateJob(db, id, status, progress, result = null, error = null) {
  db.prepare('UPDATE jobs SET status=?, updated_at=?, progress=?, result=?, error=? WHERE id=?')
    .run(status, marketTimestamp(), progress, result == null ? null : json(result), error, id);
  return jobById(db, id);
}

export function jobById(db, id) {
  const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  if (!row) return null;
  return { ...row, payload: JSON.parse(row.payload), result: row.result == null ? null : JSON.parse(row.result) };
}

export function bulkSessionStatus(db, date, { verifiedOnly = false, threshold = 0.98 } = {}) {
  const ledger = db.prepare(`
    SELECT s.*, r.dataset, r.provider FROM session_imports s JOIN ingestion_runs r ON r.id=s.run_id
    WHERE s.date=? AND s.scope='full' AND s.received>0 AND r.provider='eodhd' AND r.status='complete'
      AND (r.dataset='bulk-eod' OR r.dataset LIKE 'bootstrap-current-coverage:%')
    ORDER BY s.version DESC
  `).all(date);
  const classified = ledger.find((row) => row.expected > 0 && row.eligible_received != null
    && row.eligible_received / row.expected >= threshold && row.eligible_received <= row.expected);
  return classified ?? (!verifiedOnly ? ledger.find((row) => row.expected == null) ?? null : null);
}

export function dailyPublication(db, date, rawVersion) {
  if (rawVersion == null) return null;
  return db.prepare('SELECT * FROM daily_publications WHERE date=? AND raw_version=? AND calculation_version=?')
    .get(date, rawVersion, CALCULATION_VERSION) || null;
}

export function recordDailyPublication(db, { date, rawVersion, dataRevision, models }) {
  db.prepare('INSERT OR IGNORE INTO daily_publications VALUES (?,?,?,?,?,?)')
    .run(date, rawVersion, CALCULATION_VERSION, dataRevision, json(models), marketTimestamp());
  return dailyPublication(db, date, rawVersion);
}

export function warehouseStatus(db) {
  const earliest = db.prepare('SELECT date FROM daily_prices ORDER BY date LIMIT 1').get()?.date || null;
  const latest = db.prepare('SELECT date FROM daily_prices ORDER BY date DESC LIMIT 1').get()?.date || null;
  const prices = db.prepare('SELECT count(*) AS count FROM daily_prices').get().count;
  const securities = db.prepare('SELECT count(*) AS count FROM securities').get().count;
  const runs = db.prepare('SELECT * FROM ingestion_runs ORDER BY started_at DESC LIMIT 20').all().map((row) => ({
    id: row.id, provider: row.provider, dataset: row.dataset, scope: row.scope, status: row.status,
    startedAt: row.started_at, finishedAt: row.finished_at, dates: row.dates ? JSON.parse(row.dates) : null,
    rows: row.rows, imported: row.imported, expected: row.expected,
    detail: row.detail ? JSON.parse(row.detail) : null, version: row.version,
  }));
  const lastRun = runs.find((run) => run.status === 'complete');
  const latestSession = latest ? db.prepare("SELECT date, expected, received, eligible_received AS eligibleReceived, version FROM session_imports WHERE date=? AND scope='full' ORDER BY version DESC LIMIT 1").get(latest) : null;
  const latestPublication = latestSession ? dailyPublication(db, latestSession.date, latestSession.version) : null;
  const observed = db.prepare(`
    SELECT (SELECT count(*) FROM corporate_actions) AS corporateActions,
      (SELECT count(*) FROM fundamentals WHERE float IS NOT NULL) AS datedFloat,
      (SELECT count(*) FROM fundamentals WHERE shares IS NOT NULL) AS datedShares,
      (SELECT count(*) FROM classifications WHERE industry IS NOT NULL) AS datedClassifications,
      (SELECT count(*) FROM securities WHERE status='delisted') AS delistedSecurities,
      (SELECT count(*) FROM securities WHERE delisting_date IS NOT NULL) AS knownDelistingDates,
      (SELECT count(*) FROM securities WHERE type IN ('etf','index') AND first_seen IS NOT NULL) AS benchmarks
  `).get();
  return {
    state: !latest ? 'empty' : latestSession?.expected && latestSession.eligibleReceived === latestSession.expected ? 'available' : 'partial',
    earliestDate: earliest, latestDate: latest, prices, securities, dataVersion: dataVersion(db),
    calculationVersion: CALCULATION_VERSION, lastSuccess: lastRun?.finishedAt || null,
    provider: lastRun?.provider || null, runs, latestSession: latestSession || null, latestPublication,
    capabilities: {
      supported: { prices: true, benchmarks: true, corporateActions: true, datedFundamentals: true, datedClassifications: true },
      observed: { prices, ...observed },
      providerEntitlements: null, historicalProviderVintages: false, automaticTickerReuseResolution: false,
    },
  };
}
