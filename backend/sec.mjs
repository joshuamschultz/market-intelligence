import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { expectedSessions, shiftDate } from './calendar.mjs';
import { dataVersion, importDataset, isoDate, marketDay, normalizeExchange, normalizeSymbol } from './database.mjs';

export const SEC_CLASSIFICATION_SYSTEM = 'sec-sic';
export const SEC_TICKER_URL = 'https://www.sec.gov/files/company_tickers_exchange.json';
export const SEC_SIC_URL = 'https://www.sec.gov/search-filings/standard-industrial-classification-sic-code-list';
const sharesTag = 'EntityCommonStockSharesOutstanding';
const periodicForms = /^(10-K|10-Q|20-F|40-F)(\/A)?$/;
const supportedExchanges = new Set(['NYSE', 'NASDAQ', 'NYSE AMERICAN', 'NYSE ARCA', 'CBOE', 'BATS', 'IEX']);
const supportedTypes = new Set(['common', 'adr', 'reit']);
const cikNumber = (value) => /^\d{1,10}$/.test(String(value)) && Number(value) > 0 ? String(Number(value)).padStart(10, '0') : null;
const sicNumber = (value) => /^\d{3,4}$/.test(String(value).trim()) ? String(value).trim().padStart(4, '0') : null;
const tickerKey = (symbol) => normalizeSymbol(symbol).replace(/\.(?=[A-Z]$)/, '-');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const toObject = (value) => typeof value === 'string' || Buffer.isBuffer(value) ? JSON.parse(value) : value;
const accessionPattern = /^\d{10}-\d{2}-\d{6}$/;
const onOrAfterSession = (date) => expectedSessions(date, shiftDate(date, 10))[0];

function filingMarketDate(filed, accepted) {
  const origin = compactDate(accepted?.slice(0, 10));
  const time = /[ T](\d\d:\d\d:\d\d)/.exec(accepted ?? '')?.[1];
  if (!origin || !time) return onOrAfterSession(shiftDate(filed, 1));
  if (filed > origin) return onOrAfterSession(filed);
  // Before 13:00 ET is safe on ordinary and shortened US equity sessions. Later inputs are usable next session.
  return onOrAfterSession(time < '13:00:00' ? origin : shiftDate(origin, 1));
}

export const secArtifactUrl = (kind, id) => {
  if (kind === 'catalog') return SEC_TICKER_URL;
  if (kind === 'sic') return SEC_SIC_URL;
  if (kind === 'quarter' && /^20\d{2}q[1-4]$/.test(String(id))) {
    return `https://www.sec.gov/files/dera/data/financial-statement-data-sets/${id}.zip`;
  }
  const cik = cikNumber(id);
  if (kind === 'companyfacts' && cik) return `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
  if (kind === 'submissions' && cik) return `https://data.sec.gov/submissions/CIK${cik}.json`;
  throw new TypeError('Select a recognized SEC artifact and a valid quarter or CIK');
};

function compactDate(value) {
  const normalized = /^\d{8}$/.test(value ?? '') ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value;
  return isoDate(normalized) ? normalized : null;
}

function legalName(value) {
  const parts = String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[/\\]\s*(?:[a-z]{2,3}|new)\s*[/\\]?\s*$/, '')
    .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/);
  if (parts.length > 2 && parts.at(-2) === 'class' && /^[a-z]$/.test(parts.at(-1))) parts.splice(-2);
  while (parts.length > 1 && /^(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|llc|lp|sa|nv|ag|se)$/.test(parts.at(-1))) parts.pop();
  return parts.join(' ');
}

export { legalName as normalizeIssuerName };

export function parseSecTickerExchange(input) {
  const { fields, data } = toObject(input) ?? {};
  if (!Array.isArray(fields) || !Array.isArray(data) || !['cik', 'name', 'ticker', 'exchange'].every((field) => fields.includes(field))) {
    throw new TypeError('Expected the SEC ticker and exchange catalog with fields and data');
  }
  const indices = Object.fromEntries(fields.map((field, index) => [field, index]));
  return data.flatMap((item) => {
    if (!Array.isArray(item)) return [];
    const cik = cikNumber(item[indices.cik]);
    const name = String(item[indices.name] ?? '').trim();
    const symbol = tickerKey(item[indices.ticker]);
    if (!cik || !name || !symbol) return [];
    return [{ cik, name, symbol, exchange: normalizeExchange(item[indices.exchange]) }];
  });
}

function parseHtmlText(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/<[^>]*>/g, ' ').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (Object.hasOwn(entities, lower)) return entities[lower];
    if (!lower.startsWith('#')) return match;
    const number = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number(lower.slice(1));
    return number >= 0 && number <= 0x10FFFF ? String.fromCodePoint(number) : match;
  }).trim().replace(/\s+/g, ' ');
}

export function parseSecSicList(input) {
  const codes = new Map();
  for (const [, row] of String(input).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(([, value]) => parseHtmlText(value));
    const code = sicNumber(cells[0]);
    if (code && cells[2]) codes.set(code, cells[2]);
  }
  if (!codes.size) throw new TypeError('Expected the official SEC SIC code table');
  return codes;
}

const divisions = [
  [1, 9, 'A Agriculture, forestry and fishing'], [10, 14, 'B Mining'], [15, 17, 'C Construction'],
  [20, 39, 'D Manufacturing'], [40, 49, 'E Transportation, communications and utilities'],
  [50, 51, 'F Wholesale trade'], [52, 59, 'G Retail trade'], [60, 67, 'H Finance, insurance and real estate'],
  [70, 89, 'I Services'], [91, 97, 'J Public administration'],
];

export function secSicIndustry(sic, labels = new Map()) {
  const code = sicNumber(sic);
  if (!code || ['8880', '8888', '9995', '9999'].includes(code)) return null;
  const majorNumber = code.slice(0, 2);
  const division = divisions.find(([min, max]) => Number(majorNumber) >= min && Number(majorNumber) <= max);
  if (!division) return null;
  const majorLabel = labels.get(`${majorNumber}00`);
  const subindustryLabel = labels.get(code);
  return {
    sector: division[2], industry: majorLabel ? `SIC ${majorNumber} · ${majorLabel}` : `SIC ${majorNumber}`,
    subindustry: subindustryLabel ? `SIC ${code} · ${subindustryLabel}` : `SIC ${code}`,
  };
}

export function parseSecSubmissions(input) {
  const lines = String(input).replace(/^\uFEFF/, '').split(/\r?\n/);
  const fields = lines.shift()?.split('\t') ?? [];
  const index = Object.fromEntries(fields.map((field, position) => [field, position]));
  if (!['adsh', 'cik', 'name', 'sic', 'form', 'filed', 'accepted'].every((field) => Object.hasOwn(index, field))) {
    throw new TypeError('Expected the SEC Financial Statement Data Sets sub.txt columns');
  }
  let invalid = 0;
  const rows = [];
  for (const line of lines) {
    if (!line) continue;
    const columns = line.split('\t');
    const get = (field) => columns[index[field]]?.trim() || null;
    const cik = cikNumber(get('cik'));
    const filed = compactDate(get('filed'));
    const acceptedAt = get('accepted');
    const acceptedDate = compactDate(acceptedAt?.slice(0, 10));
    const accession = get('adsh');
    const name = get('name');
    if (!cik || !filed || !acceptedDate || !accessionPattern.test(accession ?? '') || !name) { invalid++; continue; }
    rows.push({ accession, cik, name, sic: sicNumber(get('sic')), form: get('form'), filed, acceptedAt,
      knownAt: filingMarketDate(filed, acceptedAt), formerName: get('former'), nameChanged: compactDate(get('changed')) });
  }
  return { rows, invalid };
}

function activeOn(security, date) {
  return security.valid_from <= date && (!security.valid_to || date <= security.valid_to) &&
    (!security.listing_date || security.listing_date <= date) && (!security.delisting_date || date <= security.delisting_date);
}

function collectGrouped(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const id = key(row);
    const group = groups.get(id) ?? [];
    group.push(row);
    groups.set(id, group);
  }
  return groups;
}

function matchCatalog(db, catalog, asOf) {
  const candidates = db.prepare(`SELECT s.id,s.name,s.type,s.status,s.provider,s.listing_date,s.delisting_date,s.first_seen,
    i.symbol,i.exchange,i.valid_from,i.valid_to FROM securities s JOIN identifiers i ON i.security_id=s.id`).all();
  const byTicker = collectGrouped(candidates, (row) => tickerKey(row.symbol));
  const byIssue = collectGrouped(candidates, (row) => row.id);
  const activeCatalog = catalog.filter((row) => supportedExchanges.has(row.exchange));
  const byCatalogTicker = collectGrouped(activeCatalog, (row) => row.symbol);
  const matches = [];
  const quarantine = { ambiguousCatalog: 0, ambiguousWarehouse: 0, nameMismatch: 0, inactiveOrUnclassified: 0, warehouseMissing: 0 };
  const seen = new Set();
  for (const entry of activeCatalog) {
    const aliases = byTicker.get(entry.symbol) ?? [];
    if (!aliases.length) { quarantine.warehouseMissing++; continue; }
    if (new Set(byCatalogTicker.get(entry.symbol).map((row) => row.cik)).size > 1) { quarantine.ambiguousCatalog++; continue; }
    const eligible = aliases.filter((row) => row.exchange === entry.exchange && activeOn(row, asOf) && row.status !== 'delisted');
    if (new Set(eligible.map((row) => row.id)).size > 1) { quarantine.ambiguousWarehouse++; continue; }
    const issue = eligible[0];
    if (!issue || !supportedTypes.has(issue.type)) { quarantine.inactiveOrUnclassified++; continue; }
    const normalizedName = legalName(issue.name);
    if (normalizedName.length < 3 || normalizedName !== legalName(entry.name)) { quarantine.nameMismatch++; continue; }
    const key = `${entry.cik}:${issue.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A historical fact needs an explicit listing bound or actual observed trading for this stable ID.
    const earliest = issue.listing_date ?? issue.first_seen ?? null;
    const historical = (date) => Boolean(earliest && date >= earliest && byIssue.get(issue.id).some((alias) =>
      activeOn(alias, date) && new Set((byTicker.get(tickerKey(alias.symbol)) ?? [])
        .filter((other) => activeOn(other, date)).map((other) => other.id)).size === 1));
    matches.push({ ...entry, issueId: issue.id, issueType: issue.type, earliest, normalizedName, historical });
  }
  const byCik = collectGrouped(catalog, (row) => row.cik);
  return { matches, quarantine, byCik, activeCatalog: activeCatalog.length };
}

function shareFacts(document) {
  const value = toObject(document.data);
  const cik = cikNumber(value?.cik);
  if (!cik) throw new TypeError('Expected a SEC companyfacts document with a CIK');
  const entries = value.facts?.dei?.[sharesTag]?.units?.shares ?? [];
  if (!Array.isArray(entries)) throw new TypeError('SEC companyfacts shares must be an array');
  return { cik, name: value.entityName, entries, provenance: value.provenance ?? value._provenance };
}

function documentEvidence(document, defaultCapture) {
  return {
    source: document.source ?? document.id ?? 'SEC EDGAR', sha256: document.sha256 ?? null,
    capturedAt: document.capturedAt ?? defaultCapture,
  };
}

function initializeEvidence(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS sec_enrichment_runs (
    run_key TEXT PRIMARY KEY, warehouse_version INTEGER NOT NULL, recorded_at TEXT NOT NULL, summary TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sec_enrichment_evidence (
    run_key TEXT NOT NULL REFERENCES sec_enrichment_runs(run_key), security_id TEXT NOT NULL REFERENCES securities(id),
    kind TEXT NOT NULL, effective_date TEXT NOT NULL, known_at TEXT NOT NULL, accession TEXT NOT NULL, evidence TEXT NOT NULL,
    PRIMARY KEY (run_key, security_id, kind, effective_date, known_at, accession)
  ) WITHOUT ROWID;`);
}

function recordEvidence(db, key, version, capturedAt, summary, rows) {
  const insert = db.prepare('INSERT OR IGNORE INTO sec_enrichment_evidence VALUES (?,?,?,?,?,?,?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT OR IGNORE INTO sec_enrichment_runs VALUES (?,?,?,?)').run(key, version, capturedAt, JSON.stringify(summary));
    for (const row of rows) insert.run(key, row.securityId, row.kind, row.effectiveDate, row.knownAt, row.accession, JSON.stringify(row));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function usableEvidence(groups, counter) {
  const rows = [];
  for (const records of groups.values()) {
    if (new Set(records.map((row) => row.identityValue)).size !== 1) { counter.conflict++; continue; }
    rows.push(...records);
  }
  return rows;
}

export function ingestSecEnrichment(db, {
  catalog, submissions = [], companyFacts = [], labels = new Map(), capturedAt = new Date().toISOString(),
  catalogCapturedAt = capturedAt, catalogSha256 = null, dryRun = false,
} = {}) {
  const captureDay = isoDate(capturedAt) ? capturedAt : marketDay(capturedAt);
  const catalogDay = isoDate(catalogCapturedAt) ? catalogCapturedAt : marketDay(catalogCapturedAt);
  if (!captureDay || !catalogDay || catalogDay > captureDay) throw new RangeError('SEC capture dates are invalid');
  const catalogRows = parseSecTickerExchange(catalog);
  const { matches, quarantine, byCik, activeCatalog } = matchCatalog(db, catalogRows, catalogDay);
  const matchesByCik = collectGrouped(matches, (row) => row.cik);
  const counters = { invalidSubmissions: 0, unmatchedSubmissions: 0, oldOrAmbiguousIdentity: 0, nameMismatch: 0,
    missingSic: 0, conflict: 0, sharesRestricted: 0, invalidShares: 0 };
  const filingRows = [];
  for (const document of submissions) {
    const parsed = parseSecSubmissions(document.data);
    counters.invalidSubmissions += parsed.invalid;
    const source = documentEvidence(document, capturedAt);
    for (const row of parsed.rows) filingRows.push({ ...row, source });
  }
  const nameEvidence = new Map();
  for (const row of filingRows) {
    if (!row.formerName || !row.nameChanged || row.knownAt > captureDay || row.nameChanged > row.knownAt ||
        !matchesByCik.get(row.cik)?.some((link) => link.normalizedName === legalName(row.name))) continue;
    const key = `${row.cik}:${legalName(row.formerName)}`;
    const changes = nameEvidence.get(key) ?? [];
    changes.push({ date: row.nameChanged, accession: row.accession });
    nameEvidence.set(key, changes);
  }

  const evidence = [];
  const filingsByAccession = new Map(filingRows.map((row) => [row.accession, row]));
  function namedForFiling(row, link) {
    return legalName(row.name) === link.normalizedName || nameEvidence.get(`${row.cik}:${legalName(row.name)}`)
      ?.some((change) => row.knownAt < change.date);
  }
  for (const row of filingRows) {
    const links = matchesByCik.get(row.cik);
    if (!links) { counters.unmatchedSubmissions++; continue; }
    if (row.knownAt > captureDay) { counters.invalidSubmissions++; continue; }
    const industry = secSicIndustry(row.sic, labels);
    if (!industry) { counters.missingSic++; continue; }
    for (const link of links) {
      if (!link.historical(row.knownAt)) { counters.oldOrAmbiguousIdentity++; continue; }
      if (!namedForFiling(row, link)) { counters.nameMismatch++; continue; }
      evidence.push({ kind: 'classification', securityId: link.issueId, cik: row.cik, issuerName: row.name,
        effectiveDate: row.knownAt, knownAt: row.knownAt, filed: row.filed, acceptedAt: row.acceptedAt, accession: row.accession,
        source: row.source, identityValue: row.sic, ...industry });
    }
  }

  for (const document of companyFacts) {
    const { cik, name, entries, provenance } = shareFacts(document);
    const links = matchesByCik.get(cik) ?? [];
    const catalogSymbols = new Set((byCik.get(cik) ?? []).map((row) => row.symbol));
    if (links.length !== 1 || catalogSymbols.size !== 1 || links[0].issueType !== 'common' || legalName(name) !== links[0].normalizedName) {
      counters.sharesRestricted += entries.length;
      continue;
    }
    const [link] = links;
    const source = documentEvidence(document, capturedAt);
    if (typeof provenance?.source === 'string' && provenance.source === secArtifactUrl('companyfacts', cik)) source.source = provenance.source;
    if (typeof provenance?.capturedAt === 'string' && Number.isFinite(Date.parse(provenance.capturedAt))) source.capturedAt = provenance.capturedAt;
    const originalSha256 = provenance?.responseSha256 ?? provenance?.fullResponseSha256 ?? provenance?.fullSha256;
    if (typeof originalSha256 === 'string' && /^[0-9a-f]{64}$/.test(originalSha256)) source.originalSha256 = originalSha256;
    for (const item of entries) {
      if (!isoDate(item.end) || !isoDate(item.filed) || item.end > item.filed || item.filed > captureDay || !accessionPattern.test(item.accn ?? '') ||
          !periodicForms.test(item.form ?? '') || !Number.isSafeInteger(item.val) || item.val <= 0 || !link.historical(item.end) ||
          !link.historical(item.filed)) { counters.invalidShares++; continue; }
      const filedRow = filingsByAccession.get(item.accn);
      const acceptedAt = filedRow?.cik === cik ? filedRow.acceptedAt : null;
      const knownAt = filingMarketDate(item.filed, acceptedAt);
      if (knownAt > captureDay) { counters.invalidShares++; continue; }
      evidence.push({ kind: 'shares', securityId: link.issueId, cik, issuerName: name, effectiveDate: item.end, knownAt,
        filed: item.filed, acceptedAt, accession: item.accn, source, tag: sharesTag, identityValue: item.val });
    }
  }

  const groups = collectGrouped(evidence, (row) => [row.kind, row.securityId, row.effectiveDate, row.knownAt].join('|'));
  const accepted = usableEvidence(groups, counters);
  const unique = [...collectGrouped(accepted, (row) => [row.kind, row.securityId, row.effectiveDate, row.knownAt].join('|')).values()]
    .map((rows) => rows[0]).sort((a, b) => a.securityId.localeCompare(b.securityId) || a.knownAt.localeCompare(b.knownAt) ||
      a.effectiveDate.localeCompare(b.effectiveDate));
  const reports = unique.filter((row) => row.kind === 'classification');
  const fundamentals = unique.filter((row) => row.kind === 'shares');
  const classifiedIds = new Set(reports.map((row) => row.securityId));
  const latestSic = new Map(reports.map((row) => [row.securityId, row.identityValue]));
  const summary = {
    classificationSystem: SEC_CLASSIFICATION_SYSTEM, dryRun, csvSubmissions: filingRows.length,
    secCatalog: { records: catalogRows.length, activeSupportedVenues: activeCatalog, capturedOn: catalogDay, sha256: catalogSha256 },
    identity: { matches: matches.length, classified: classifiedIds.size, quarantine, historicalIdentity: 'reconstructed_from_issuer_and_security_intervals' },
    historicalUniverseCoverage: 'current_catalog_identity_bridge', marketAvailability: 'early_session_safe',
    records: { classifications: reports.length, shares: fundamentals.length, float: 0, filingEvidence: accepted.length },
    currentReitCandidates: matches.filter((link) => link.issueType === 'common' && latestSic.get(link.issueId) === '6798').length,
    sources: { subFiles: submissions.length, companyFactsFiles: companyFacts.length, sicLabels: labels.size },
    quality: counters, dataVersion: dataVersion(db),
  };
  if (dryRun || !unique.length) return summary;
  const classifications = reports.map((row) => ({ securityId: row.securityId, system: SEC_CLASSIFICATION_SYSTEM,
    effectiveFrom: row.effectiveDate, knownAt: row.knownAt, sector: row.sector, industry: row.industry, subindustry: row.subindustry }));
  const shares = fundamentals.map((row) => ({ securityId: row.securityId, effectiveDate: row.effectiveDate,
    knownAt: row.knownAt, sharesOutstanding: row.identityValue }));
  const runKey = sha256(JSON.stringify([catalogDay, catalogSha256, classifications, shares, accepted.map((row) => [row.accession, row.source])]));
  initializeEvidence(db);
  // The importer deduplicates this deterministic batch even if a previous process stopped before the audit transaction.
  const result = importDataset(db, { provider: 'sec', dataset: `edgar-enrichment:${runKey}`, scope: 'sample',
    catalogDate: catalogDay, classifications, fundamentals: shares });
  const imported = { ...summary, dataVersion: result.version, runKey, duplicate: Boolean(result.duplicate) };
  recordEvidence(db, runKey, result.version, capturedAt, imported, accepted);
  return imported;
}

const officialPaths = [
  SEC_TICKER_URL, SEC_SIC_URL,
  /^https:\/\/www\.sec\.gov\/files\/dera\/data\/financial-statement-data-sets\/20\d{2}q[1-4]\.zip$/,
  /^https:\/\/data\.sec\.gov\/(?:submissions|api\/xbrl\/companyfacts)\/CIK\d{10}\.json$/,
];

export function createSecDownloader({ userAgent, fetcher = fetch, sleep = delay, clock = Date.now, attempts = 3 } = {}) {
  if (typeof userAgent !== 'string' || !/\S+\s+[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userAgent.trim()) || /[\r\n]/.test(userAgent)) {
    throw new TypeError('SEC_USER_AGENT must identify your application and include a contact email');
  }
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) throw new RangeError('SEC download attempts must be an integer from 1 to 5');
  let nextStart = -Infinity;
  let halted = false;
  async function request(url, signal) {
    // Reserve a slot synchronously so concurrently requested files are also limited to at most six starts per second.
    const now = clock();
    const slot = Math.max(now, nextStart);
    nextStart = slot + 167;
    if (slot > now) await sleep(slot - now, undefined, { signal });
    if (halted) throw Object.assign(new Error('SEC downloads stopped after HTTP 403'), { status: 403 });
    signal?.throwIfAborted();
    return fetcher(url, { headers: { 'User-Agent': userAgent }, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000) });
  }
  return async function download(url, destination, { force = false, signal } = {}) {
    if (!officialPaths.some((candidate) => typeof candidate === 'string' ? candidate === url : candidate.test(url))) {
      throw new TypeError('Only recognized official SEC artifacts can be downloaded');
    }
    if (!force) {
      const existing = await stat(destination).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
      if (existing?.isFile() && existing.size > 0) return { source: url, destination, bytes: existing.size, skipped: true };
    }
    await mkdir(dirname(destination), { recursive: true });
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const temporary = `${destination}.part-${randomUUID()}`;
      try {
        const response = await request(url, signal);
        if (!response.ok) {
          if (response.status === 403) halted = true;
          await response.body?.cancel();
          const header = response.headers.get('retry-after');
          const wait = header && /^\d+$/.test(header) ? Number(header) * 1000 : header ? Date.parse(header) - clock() : null;
          throw Object.assign(new Error(`SEC returned HTTP ${response.status}`), { status: response.status, wait });
        }
        if (!response.body) throw new Error('SEC returned an empty response');
        let bytes = 0;
        const digest = createHash('sha256');
        const bound = new Transform({ transform(chunk, _encoding, done) {
          bytes += chunk.length;
          if (bytes > 512 * 1024 * 1024) return done(new Error('SEC artifact exceeded the 512 MiB limit'));
          digest.update(chunk);
          return done(null, chunk);
        } });
        await pipeline(Readable.fromWeb(response.body), bound, createWriteStream(temporary, { flags: 'wx' }), { signal });
        if (!bytes) throw new Error('SEC returned an empty file');
        await rename(temporary, destination);
        return { source: url, destination, bytes, sha256: digest.digest('hex'), capturedAt: new Date(clock()).toISOString(), skipped: false };
      } catch (error) {
        await rm(temporary, { force: true });
        lastError = error;
        if (signal?.aborted || error.status && error.status < 500 && ![408, 429].includes(error.status)) break;
        if (attempt + 1 < attempts) await sleep(Math.min(60_000, Math.max(500 * 2 ** attempt, error.wait || 0)), undefined, { signal });
      }
    }
    throw lastError;
  };
}
