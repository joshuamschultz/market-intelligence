import { createHash } from 'node:crypto';
import { expectedSessions } from './calendar.mjs';
import { isoDate } from './database.mjs';

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
// Books, notes, manual lists and frozen cohort content are research records.
export function analysisWorkspaceScopeHash(db) {
  const definitions = hasTable(db, 'workspace') ? db.prepare(`
    SELECT a.kind, a.id, a.version FROM workspace a
    WHERE a.kind IN (SELECT value FROM json_each(?)) AND a.deleted=0
      AND a.version=(SELECT max(b.version) FROM workspace b WHERE b.kind=a.kind AND b.id=a.id)
      AND (a.kind<>'alert-rule' OR (json_extract(a.definition,'$.type') IN ('stocks','screen')
        AND json_extract(a.definition,'$.active') IS NOT 0))
    ORDER BY a.kind, a.id
  `).all(JSON.stringify(scopeKinds)).map(({ kind, id, version }) => [kind, id, version]) : [];
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
      coalesce(json_extract(payload,'$.calculationVersion'),json_extract(payload,'$.analysisGeneration.calculationVersion')) AS calculationVersion
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

function verifyPublication(db, point) {
  if (!hasTable(db, 'preparation_publications') || !hasTable(db, 'preparation_publication_partitions')) return null;
  const rows = db.prepare(`
    SELECT id, manifest, plan_hash AS planHash, updated_at AS publishedAt
    FROM preparation_publications WHERE state='verified-awaiting-cutover' AND json_valid(manifest)
      AND json_extract(manifest,'$.dataVersion')=? AND json_extract(manifest,'$.calculationVersion')=?
    ORDER BY updated_at DESC, id
  `).iterate(point.dataVersion, point.calculationVersion);
  const partitions = db.prepare(`
    SELECT table_name AS tableName, sum(count) AS rowCount, sum(state<>'consumed') AS pending
    FROM preparation_publication_partitions WHERE publication=? GROUP BY table_name
  `);
  let scopeHash;
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

export function readAnalysisReadiness(db, { date = null, dataVersion, calculationVersion }) {
  const point = { date, dataVersion, calculationVersion };
  if (!isoDate(date) || !isPositiveCount(dataVersion)) return { ...point, state: 'incomplete', reason: 'no_source_data' };
  const { active: pending, failed, awaiting } = matchingWork(db, point);
  if (pending) return { ...point, state: 'preparing', reason: 'background_calculation', job: pending };
  if (failed) return { ...point, state: 'incomplete', reason: 'calculation_failed', job: failed };
  const publication = verifyPublication(db, point);
  if (publication) return { ...point, state: 'ready', ...publication };
  return awaiting ? { ...point, state: 'preparing', reason: 'awaiting_publication', job: awaiting }
    : { ...point, state: 'incomplete', reason: 'no_matching_verified_publication' };
}
