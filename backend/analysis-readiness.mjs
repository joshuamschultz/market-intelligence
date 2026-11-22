import { createHash } from 'node:crypto';
import { independentPreparedQueryScreens } from './prepared-query-screen.mjs';
import { expectedSessions, isMarketSession, shiftDate } from './calendar.mjs';
import { isoDate } from './database.mjs';
import { reusableArchiveVersions, usableArchiveRow } from './archive-lineage.mjs';

const manifestFormat = 'market-preparation-publication-1';
const fiveYearSessions = 1260;
const scopeKinds = ['alert-rule', 'health-model', 'ranking-model', 'screen', 'stock-detail-preparation', 'theme', 'universe'];
const partitionProducts = {
  base: ['prepared_snapshot_contexts'],
  velocity: ['prepared_snapshot_contexts'],
  ranks: ['prepared_rank_dates', 'prepared_rank_blocks'],
  breadth: ['market_history'],
  monitor: ['market_history'],
  detail: ['prepared_detail_products', 'prepared_detail_blocks'],
  risk: ['prepared_risk_history_runs', 'prepared_risk_history_blocks'],
  ranges: ['prepared_range_history_runs', 'prepared_range_history_blocks'],
  health: ['prepared_health'],
  nyseSummation: ['prepared_nyse_summation'],
};
const calculationJobs = new Set(['prepare-context', 'prepare-stock-details', 'prepare-range', 'prepare-range-history', 'prepare-risk-history',
  'materialize', 'rank-materialize', 'workspace-precompute', 'production-precompute', 'health-precompute', 'optimized-five-year']);
const active = new Set(['queued', 'running', 'waiting_for_space', 'building']);
const unsuccessful = new Set(['failed', 'interrupted', 'cancelled']);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isPositiveCount = (value) => Number.isSafeInteger(value) && value > 0;
const hasTable = (db, table) => !!db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name=?").get(table);
export const isAnalysisCalculationJob = (type) => calculationJobs.has(type);

// Versions come from the same workspace inputs used to build preparation recipes.
// Books, notes, manual lists and independent prepared-data queries are research records.
export function analysisWorkspaceScopeHash(db) {
  const independentQueries = independentPreparedQueryScreens(db);
  const definitions = hasTable(db, 'workspace') ? db.prepare(`
    SELECT a.kind, a.id, a.version FROM workspace a
    WHERE a.kind IN (SELECT value FROM json_each(?)) AND a.deleted=0
      AND a.version=(SELECT max(b.version) FROM workspace b WHERE b.kind=a.kind AND b.id=a.id)
      AND (a.kind<>'alert-rule' OR (json_extract(a.definition,'$.type') IN ('stocks','screen')
        AND json_extract(a.definition,'$.active') IS NOT 0))
    ORDER BY a.kind, a.id
  `).all(JSON.stringify(scopeKinds)).filter(({ kind, id, version }) => kind !== 'screen' || independentQueries.get(id) !== version)
    .map(({ kind, id, version }) => [kind, id, version]) : [];
  const registered = hasTable(db, 'preparation_definitions')
    ? db.prepare('SELECT id FROM preparation_definitions ORDER BY id').all().map(({ id }) => id) : [];
  return hash(['analysis-scope-1', definitions, registered]);
}

function matchingWork(db, { date, dataVersion, calculationVersion }) {
  if (!hasTable(db, 'jobs')) return {};
  const jobs = db.prepare(`
    SELECT id, type, status, progress, json_extract(payload,'$.jobKey') AS jobKey,
      coalesce(json_extract(payload,'$.context.date'),json_extract(payload,'$.date')) AS date,
      coalesce(json_extract(payload,'$.context.dataVersion'),json_extract(payload,'$.dataVersion'),
        json_extract(payload,'$.analysisGeneration.dataVersion')) AS dataVersion,
      coalesce(json_extract(payload,'$.calculationVersion'),json_extract(payload,'$.analysisGeneration.calculationVersion')) AS calculationVersion,
      json_extract(result,'$.analysisPreparation') AS analysisPreparation
    FROM jobs WHERE type IN (SELECT value FROM json_each(?)) AND json_valid(payload) ORDER BY rowid DESC
  `).iterate(JSON.stringify([...calculationJobs]));
  const work = {};
  const seen = new Set();
  for (const entry of jobs) {
    if (entry.dataVersion != null && Number(entry.dataVersion) !== dataVersion || entry.date && entry.date !== date) continue;
    const external = entry.type === 'optimized-five-year';
    const version = entry.calculationVersion ?? (/^production-precompute:(2-[a-f0-9]{12}):/.exec(entry.jobKey || '')?.[1] ?? null);
    const current = version === calculationVersion;
    const awaitingPublication = entry.status === 'awaiting_publication';
    if (!current && !(active.has(entry.status) && !version) &&
        !(external && Number(entry.dataVersion) === dataVersion && (active.has(entry.status) || awaitingPublication))) continue;
    const key = entry.jobKey || (external ? `optimized-five-year:${version}` : entry.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const info = { id: entry.id, type: entry.type, status: entry.status, progress: entry.progress, calculationVersion: version };
    if (active.has(entry.status)) {
      work.active = info;
      return work;
    }
    if (current && unsuccessful.has(entry.status)) work.failed ??= info;
    if (current && entry.status === 'complete' && entry.analysisPreparation) work.blocked ??= entry.analysisPreparation;
    if (external && awaitingPublication) work.awaiting ??= info;
  }
  return work;
}

function verifiedProducts(proof) {
  return Object.keys(partitionProducts).every((key) => {
    const coverage = proof.products?.[key];
    return isPositiveCount(coverage?.expected) && coverage.verified === coverage.expected;
  }) && proof.products.base.verified === proof.products.breadth.verified
    && proof.products.velocity.verified === proof.products.ranks.verified
    && proof.products.nyseSummation.verified === proof.sessions;
}

function validManifest(manifest, point, scopeHash) {
  const proof = manifest?.verification;
  if (manifest?.format !== manifestFormat || manifest.accepted !== true || manifest.dataVersion !== point.dataVersion ||
      manifest.calculationVersion !== point.calculationVersion || !isHash(manifest.archive?.sha256) || !isPositiveCount(manifest.archive?.bytes) ||
      proof?.scope !== 'all' || proof.coverageTarget !== 'five-year' || proof.calibration !== 'full' ||
      proof.readback !== 'all fields on sampled sessions' || proof.workspaceScopeHash !== scopeHash || !isHash(proof.recipeDigest) ||
      !isPositiveCount(proof.contexts) || proof.availableContexts !== proof.contexts || !isPositiveCount(proof.sessions) ||
      proof.sessions < fiveYearSessions || proof.dateTo !== point.date || !isoDate(proof.dateFrom) || proof.dateFrom >= proof.dateTo ||
      !verifiedProducts(proof)) return false;
  const days = (Date.parse(proof.dateTo) - Date.parse(proof.dateFrom)) / 86_400_000;
  if (days < proof.sessions - 1 || days > proof.sessions * 2) return false;
  try {
    const sessions = expectedSessions(proof.dateFrom, proof.dateTo);
    return sessions.length === proof.sessions && sessions[0] === proof.dateFrom && sessions.at(-1) === proof.dateTo;
  } catch {
    return false;
  }
}

function verifyPublication(db, point, { id, scopeHash } = {}) {
  if (!hasTable(db, 'preparation_publications') || !hasTable(db, 'preparation_publication_partitions')) return null;
  const rows = db.prepare(`
    SELECT id, manifest, plan_hash AS planHash, updated_at AS publishedAt
    FROM preparation_publications WHERE state='verified-awaiting-cutover' AND json_valid(manifest)
      AND json_extract(manifest,'$.dataVersion')=? AND json_extract(manifest,'$.calculationVersion')=? AND (? IS NULL OR id=?)
    ORDER BY updated_at DESC, id
  `).iterate(point.dataVersion, point.calculationVersion, id ?? null, id ?? null);
  const partitions = db.prepare(`
    SELECT table_name AS tableName, sum(count) AS rowCount, sum(state<>'consumed') AS pending
    FROM preparation_publication_partitions WHERE publication=? GROUP BY table_name
  `);
  for (const row of rows) {
    scopeHash ??= analysisWorkspaceScopeHash(db);
    const manifest = JSON.parse(row.manifest);
    if (!isHash(row.planHash) || row.id !== hash(manifest) || !validManifest(manifest, point, scopeHash)) continue;
    const tables = partitions.all(row.id);
    if (tables.some(({ pending, rowCount }) => pending !== 0 || !isPositiveCount(rowCount))) continue;
    const published = new Set(tables.map(({ tableName }) => tableName));
    if (Object.values(partitionProducts).some((names) => names.some((name) => !published.has(name)))) continue;
    const { dateFrom, sessions, contexts } = manifest.verification;
    return { publicationId: row.id, publishedAt: row.publishedAt, dateFrom, sessions, contexts };
  }
  return null;
}

export const verifiedAnalysisPublication = (db, point) => verifyPublication(db, point);

const dailyReceipts = 'analysis_daily_receipts';
const receiptFormat = 'analysis-daily-1';
const completeDailyProducts = (products) => Object.keys(partitionProducts).every((key) =>
  isPositiveCount(products?.[key]?.expected) && products[key].verified === products[key].expected);

function historicalReferenceChanged(db, parentVersion, dataVersion, date) {
  const reference = db.prepare(`SELECT 1 FROM reference_revisions AS revision JOIN reference_revisions AS prior
    ON prior.security_id=revision.security_id AND prior.version=(SELECT max(version) FROM reference_revisions
      WHERE security_id=revision.security_id AND version<=?)
    WHERE revision.version>? AND revision.version<=? AND (
      json_extract(revision.definition,'$.name') IS NOT json_extract(prior.definition,'$.name') OR
      json_extract(revision.definition,'$.isin') IS NOT json_extract(prior.definition,'$.isin')) LIMIT 1`)
    .get(parentVersion, parentVersion, dataVersion);
  return !!reference || !!db.prepare(`SELECT 1 FROM quality_overrides WHERE kind='notice' AND version>? AND version<=?
    AND effective_from<=? LIMIT 1`).get(parentVersion, dataVersion, date);
}

function verifiedDailyReceipt(db, point, scopeHash) {
  if (!hasTable(db, dailyReceipts)) return null;
  const load = db.prepare(`SELECT id,receipt,created_at FROM ${dailyReceipts} WHERE calculation_version=? AND date=? AND data_version=?
    AND json_valid(receipt)`);
  const stored = load.get(point.calculationVersion, point.date, point.dataVersion);
  if (!stored) return null;
  const receipt = JSON.parse(stored.receipt);
  const base = receipt?.base;
  if (!isHash(receipt?.recipeHash) || !isHash(base?.publicationId) || !isoDate(base.date) || !isPositiveCount(base.dataVersion)) return null;
  const root = verifyPublication(db, { date: base.date, dataVersion: base.dataVersion, calculationVersion: point.calculationVersion },
    { id: base.publicationId, scopeHash });
  if (!root || base.date >= point.date || base.dataVersion >= point.dataVersion) return null;
  const descendants = expectedSessions(base.date, point.date);
  if (descendants.length < 2 || descendants.at(-1) !== point.date) return null;
  let candidate = receipt;
  let pin = { ...point, id: stored.id };
  const edges = [];
  for (let index = descendants.length - 1; index > 0; index--) {
    const parent = candidate?.parent;
    if (candidate?.format !== receiptFormat || pin.id !== hash(candidate) || candidate.scopeHash !== scopeHash ||
        candidate.date !== pin.date || candidate.date !== descendants[index] || candidate.dataVersion !== pin.dataVersion ||
        candidate.calculationVersion !== point.calculationVersion || candidate.recipeHash !== receipt.recipeHash ||
        candidate.contexts !== root.contexts || candidate.dateFrom !== root.dateFrom || candidate.sessions !== root.sessions + index ||
        hash(candidate.base) !== hash(base) || !completeDailyProducts(candidate.products) || !isHash(parent?.id) ||
        parent.date !== descendants[index - 1] || !isPositiveCount(parent.dataVersion) || parent.dataVersion >= pin.dataVersion) return null;
    edges.push({ date: parent.date, data_version: parent.dataVersion });
    if (index === 1) {
      if (parent.id !== base.publicationId || parent.dataVersion !== base.dataVersion) return null;
      break;
    }
    const older = load.get(point.calculationVersion, parent.date, parent.dataVersion);
    if (older?.id !== parent.id) return null;
    candidate = JSON.parse(older.receipt);
    pin = parent;
  }
  const bounds = reusableArchiveVersions(db, { ...point, referenceMode: 'as-of' }, edges.map(({ data_version }) => data_version));
  if (edges.some((edge) => !usableArchiveRow(bounds, edge))) return null;
  return { ...root, sessions: receipt.sessions, receiptId: stored.id, publishedAt: stored.created_at, receipt, base };
}

export function dailyAnalysisParent(db, point) {
  if (!isoDate(point.date) || !isMarketSession(point.date) || !isPositiveCount(point.dataVersion)) return null;
  const date = expectedSessions(shiftDate(point.date, -14), point.date).at(-2);
  if (!date) return null;
  const scopeHash = analysisWorkspaceScopeHash(db);
  const versions = [];
  if (hasTable(db, dailyReceipts)) {
    versions.push(...db.prepare(`SELECT data_version AS version FROM ${dailyReceipts}
      WHERE calculation_version=? AND date=? AND data_version<? ORDER BY data_version DESC`)
      .all(point.calculationVersion, date, point.dataVersion).map(({ version }) => version));
  }
  if (hasTable(db, 'preparation_publications')) {
    versions.push(...db.prepare(`SELECT json_extract(manifest,'$.dataVersion') AS version FROM preparation_publications
      WHERE state='verified-awaiting-cutover' AND json_valid(manifest) AND json_extract(manifest,'$.calculationVersion')=?
        AND json_extract(manifest,'$.verification.dateTo')=? AND json_extract(manifest,'$.dataVersion')<?`)
      .all(point.calculationVersion, date, point.dataVersion).map(({ version }) => version));
  }
  const bounds = reusableArchiveVersions(db, { ...point, referenceMode: 'as-of' }, versions);
  for (const version of [...new Set(versions)].sort((a, b) => b - a)) {
    if (!usableArchiveRow(bounds, { data_version: version, date }) || historicalReferenceChanged(db, version, point.dataVersion, date)) continue;
    const pin = { date, dataVersion: version, calculationVersion: point.calculationVersion };
    const priorWork = matchingWork(db, pin);
    if (priorWork.active || priorWork.failed) continue;
    const publication = verifyPublication(db, pin, { scopeHash });
    if (publication) return { ...pin, ...publication, id: publication.publicationId, scopeHash,
      base: { publicationId: publication.publicationId, date, dataVersion: version } };
    const daily = verifiedDailyReceipt(db, pin, scopeHash);
    if (daily) return { ...pin, ...daily, id: daily.receiptId, scopeHash };
  }
  return null;
}

export function writeDailyAnalysisReceipt(db, point, parent, { recipeHash, contexts, products }) {
  const currentParent = dailyAnalysisParent(db, point);
  if (currentParent?.id !== parent.id || contexts !== parent.contexts ||
      parent.receipt && parent.receipt.recipeHash !== recipeHash || !isHash(recipeHash) ||
      !completeDailyProducts(products)) {
    throw new Error('Daily analysis proof no longer matches the verified parent, recipe scope or required products');
  }
  const receipt = { format: receiptFormat, ...point, dateFrom: parent.dateFrom, sessions: parent.sessions + 1, contexts,
    scopeHash: parent.scopeHash, recipeHash, products, base: parent.base,
    parent: { id: parent.id, date: parent.date, dataVersion: parent.dataVersion } };
  const id = hash(receipt);
  db.exec(`CREATE TABLE IF NOT EXISTS ${dailyReceipts} (
    calculation_version TEXT NOT NULL, date TEXT NOT NULL, data_version INTEGER NOT NULL,
    id TEXT NOT NULL, receipt TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(calculation_version,date,data_version)
  ) WITHOUT ROWID`);
  db.prepare(`INSERT OR IGNORE INTO ${dailyReceipts} VALUES (?,?,?,?,?,?)`)
    .run(point.calculationVersion, point.date, point.dataVersion, id, JSON.stringify(receipt), new Date().toISOString());
  if (db.prepare(`SELECT id FROM ${dailyReceipts} WHERE calculation_version=? AND date=? AND data_version=?`)
    .get(point.calculationVersion, point.date, point.dataVersion).id !== id) throw new Error('Daily analysis receipt conflicts with an existing verified pin');
  return id;
}

export function readAnalysisReadiness(db, { date = null, dataVersion, calculationVersion }) {
  const point = { date, dataVersion, calculationVersion };
  if (!isoDate(date) || !isPositiveCount(dataVersion)) return { ...point, state: 'incomplete', reason: 'no_source_data' };
  const { active: pending, failed, awaiting, blocked } = matchingWork(db, point);
  if (pending) return { ...point, state: 'preparing', reason: 'background_calculation', job: pending };
  if (failed) return { ...point, state: 'incomplete', reason: 'calculation_failed', job: failed };
  const publication = verifyPublication(db, point);
  if (publication) return { ...point, state: 'ready', ...publication };
  const daily = hasTable(db, dailyReceipts) && verifiedDailyReceipt(db, point, analysisWorkspaceScopeHash(db));
  if (daily) {
    const { publicationId, receiptId, publishedAt, dateFrom, sessions, contexts } = daily;
    return { ...point, state: 'ready', publicationId, receiptId, publishedAt, dateFrom, sessions, contexts };
  }
  return awaiting ? { ...point, state: 'preparing', reason: 'awaiting_publication', job: awaiting }
    : { ...point, state: 'incomplete', reason: blocked ?? 'no_matching_verified_publication' };
}
