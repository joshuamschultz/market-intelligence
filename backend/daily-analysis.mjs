import { createHash } from 'node:crypto';
import { dailyAnalysisParent, verifiedAnalysisPublication, writeDailyAnalysisReceipt } from './analysis-readiness.mjs';
import { prepareBatchedSnapshots } from './batch-preparation.mjs';
import { expectedSessions, shiftDate } from './calendar.mjs';
import { CALCULATION_VERSION, dataVersion, listWorkspace } from './database.mjs';
import { readMaterializedHistory } from './materialization.mjs';
import { batchPreparationSpecs, preparationInput, preparationRecipe, preparationSpecs, requirePreparationSpace, verifyPreparedRankCoverage } from './preparation.mjs';
import { createPreparedDetailWriter, dailyDetailSources } from './prepared-details.mjs';
import { preparedSnapshotDates, readPreparedSnapshot, readPreparedSnapshotRankWitnesses } from './prepared-snapshots.mjs';
import { prepareRangeHistoryBatch, prepareRangeMetrics, readPreparedRangeMetrics, verifyPreparedExactRanges, verifyPreparedRangeHistory } from './range-metrics.mjs';
import { createRiskHistoryWriter, normalizeRiskBenchmarks, normalizeRiskWindows, prepareRiskHistoryBenchmarks, riskHistoryManifest } from './risk-history.mjs';
import { decodeStoredJson } from './storage-codec.mjs';
import { appendSummation, readPreparedSummation } from './summation.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const asOf = (config, date = config.date) => ({ ...config, date, requestedDate: date, referenceMode: 'as-of', currentVersion: false });
const windowBatches = (windows) => Array.from({ length: Math.ceil(windows.length / 16) }, (_, index) => windows.slice(index * 16, index * 16 + 16));

function dailyPlans(db, engine, point, scopes, rangeContext) {
  const specs = preparationSpecs(db, engine, scopes.base, { custom: scopes.custom }).filter(({ phase }) => phase === 'history');
  const contexts = batchPreparationSpecs(engine, specs).flatMap(({ contexts, followLatest }) =>
    contexts.map(({ context, rank }) => ({ config: engine.context(context), rank, followLatest })));
  const ranges = new Map();
  for (const input of scopes.rangeInputs) {
    if (!input.rangeWindows?.length) continue;
    let config;
    try { config = rangeContext(engine, engine.context({ ...scopes.base, ...input })); } catch { continue; }
    if (!config.date) continue;
    const observed = config.referenceMode === 'latest' && config.date === config.latestDate ? config.observedReferenceDate : null;
    const key = JSON.stringify([config.date, config.dataVersion, config.basis, observed]);
    if (!ranges.has(key)) ranges.set(key, { config, windows: new Set() });
    for (const window of input.rangeWindows) ranges.get(key).windows.add(window);
  }
  const rangesByScope = [...ranges.values()].map(({ config, windows }) => ({ config, windows: [...windows].sort((a, b) => a - b) }));
  const rangeWindows = [...new Set(rangesByScope.flatMap(({ windows }) => windows))].sort((a, b) => a - b);
  const registrations = listWorkspace(db, 'stock-detail-preparation').map(({ definition }) => definition);
  const riskWindows = normalizeRiskWindows([...new Set([...normalizeRiskWindows(), ...registrations.map(({ lookback }) => lookback)])]);
  const benchmarks = normalizeRiskBenchmarks(registrations.map(({ benchmark }) => benchmark), point.benchmark);
  const contextIdentity = ({ config, rank }) => {
    const { date, dataVersion, observedReferenceDate, ...recipe } = preparationInput(config);
    return JSON.stringify([rank, recipe]);
  };
  const contextIdentities = contexts.map(contextIdentity).sort();
  const rollingIdentities = contexts.filter(({ followLatest }) => followLatest).map(contextIdentity).sort();
  const recipeHash = (identities) => digest([identities, scopes.custom, rangeWindows, riskWindows, benchmarks]);
  return { contexts, rangesByScope, rangeWindows, riskWindows, benchmarks, registrations,
    recipeHash: recipeHash(contextIdentities), logicalRecipeHash: recipeHash([...new Set(contextIdentities)]),
    rollingRecipeHash: digest([...new Set(rollingIdentities)]) };
}

function verifyCore(db, engine, contexts, dates, exactThrough = dates.at(-1)) {
  const products = { base: 0, velocity: 0, ranks: 0, breadth: 0, monitor: 0 };
  const rankCache = new Map();
  const witnessCache = new Map();
  for (const { config, rank } of contexts) {
    for (const date of dates) {
      const configAtDate = date === config.date ? config : asOf(config, date);
      const history = readMaterializedHistory(db, engine, configAtDate, { from: date, to: date, limit: 1 });
      const item = history.rows[0];
      const exact = date === exactThrough;
      if (!history.complete || item?.date !== date || !item?.breadth || !item.aggregates || exact && history.reused) {
        throw new Error(`Missing prepared breadth for ${config.universe.id}/${config.model.id} on ${date}`);
      }
      const baseVersion = preparedSnapshotDates(db, engine, configAtDate, [date]).get(date);
      if (!baseVersion || exact && baseVersion !== config.dataVersion || !readPreparedSnapshot(db, engine, configAtDate, { stockFields: ['securityId'] })) {
        throw new Error(`Missing prepared base snapshot for ${config.universe.id}/${config.model.id} on ${date}`);
      }
      products[rank ? 'breadth' : 'monitor']++;
      if (!rank) continue;
      products.base++;
      const velocityVersion = preparedSnapshotDates(db, engine, configAtDate, [date], { velocity: true }).get(date);
      if (!velocityVersion || exact && velocityVersion !== config.dataVersion ||
          !readPreparedSnapshot(db, engine, configAtDate, { velocity: true, stockFields: ['securityId', 'velocity4w'] })) {
        throw new Error(`Missing prepared velocity for ${config.universe.id}/${config.model.id} on ${date}`);
      }
      products.velocity++;
      products.ranks += verifyPreparedRankCoverage(db, configAtDate, [date],
        readPreparedSnapshotRankWitnesses(db, engine, configAtDate, [date], witnessCache), rankCache).dates;
    }
  }
  return products;
}

function verifyDetails(db, config, roster) {
  const products = db.prepare(`SELECT security_id,blocks FROM prepared_detail_products
    WHERE calculation_version=? AND basis=? AND data_version=? AND anchor_date=? ORDER BY security_id`);
  const block = db.prepare('SELECT 1 FROM prepared_detail_blocks WHERE hash=?');
  const linked = new Set();
  let count = 0;
  for (const { security_id, blocks } of products.iterate(CALCULATION_VERSION, config.basis, config.dataVersion, config.date)) {
    if (security_id !== roster[count++]) throw new Error('Prepared detail roster differs from the pinned price source');
    const manifest = decodeStoredJson(blocks);
    if (!manifest.length || manifest.at(-1).last !== config.date) throw new Error(`Prepared chart does not reach ${config.date} for ${security_id}`);
    for (const { hash } of manifest) {
      if (linked.has(hash)) continue;
      if (!block.get(hash)) throw new Error(`Missing prepared chart block for ${security_id}`);
      linked.add(hash);
    }
  }
  if (count !== roster.length) throw new Error('Prepared detail roster is incomplete');
  return count;
}

function prepareInstruments(db, engine, config, parent, plans, progress) {
  const stats = { reusedSecurities: 0, coldSecurities: 0, retainedChartBlocks: 0, chartBlocksWritten: 0,
    boundedSourceSessions: 0, coldSourceSessions: 0 };
  const roster = db.prepare(`SELECT id FROM securities WHERE EXISTS (SELECT 1 FROM price_revisions
    WHERE security_id=securities.id AND version<=? AND date<=? LIMIT 1) ORDER BY id`).all(config.dataVersion, config.date).map(({ id }) => id);
  const dates = [config.date];
  const options = { dates, windows: plans.riskWindows, benchmarks: plans.benchmarks, batchSize: 32 };
  const risk = createRiskHistoryWriter(db, config, { ...options, ...prepareRiskHistoryBenchmarks(db, engine, config, options) });
  const writer = createPreparedDetailWriter(db, engine, config, { riskWindows: [] });
  const batch = [];
  const flush = () => {
    for (const { blocksWritten } of writer.batch(batch.splice(0))) stats.chartBlocksWritten += blocksWritten;
  };
  const save = (detail) => {
    risk.writeSecurity(detail);
    if (!writer.ready(detail.securityId)) batch.push(detail);
    if (batch.length >= 32) flush();
  };
  const ranges = windowBatches(plans.rangeWindows);
  let rangePairs = 0;
  for (const [index, windows] of ranges.entries()) {
    const previous = readPreparedRangeMetrics(db, asOf(config, parent.date), windows);
    if (!previous.ready) throw new Error('Missing verified range inputs at the parent session');
    const lookback = Math.min(7560, Math.max(windows.at(-1) + 1, ...(index === 0 ? plans.riskWindows : []), 21));
    let result;
    do {
      result = prepareRangeHistoryBatch(db, engine, config, windows, { dates, bucketSize: 32,
        previousRanges: previous.values,
        detailSources: (ids) => dailyDetailSources(db, engine, config, parent, ids, { stats, lookback }),
        onSecurity: index === 0 ? save : undefined,
        progress: (fraction) => progress(0.24 + 0.45 * (index + fraction) / ranges.length) });
      if (result.processedSecurities % 512 === 0) requirePreparationSpace(db);
    } while (!result.done);
    rangePairs += verifyPreparedRangeHistory(db, config, dates, windows).pairs;
  }
  flush();
  risk.flush();
  // An interrupted attempt may have committed a range bucket before its shared products.
  for (let start = 0; start < roster.length; start += 32) {
    const ids = roster.slice(start, start + 32).filter((id) => !writer.ready(id) || !risk.status.done && id > (risk.status.cursor ?? ''));
    if (!ids.length) continue;
    for (const detail of dailyDetailSources(db, engine, config, parent, ids, { lookback: Math.max(21, ...plans.riskWindows), stats })) save(detail);
  }
  flush();
  const report = riskHistoryManifest(db, risk.finish().runId);
  if (!report?.done || report.actualSecurities !== roster.length || report.totalSecurities !== roster.length ||
      report.actualBlocks !== report.expectedBlocks || report.riskKeys + report.basisExclusions !== report.expectedKeys) {
    throw new Error('Prepared risk is missing required security, lookback or benchmark coverage');
  }
  return { detail: verifyDetails(db, config, roster), risk: report.actualBlocks, ranges: rangePairs, stats,
    expected: { detail: roster.length, risk: report.expectedBlocks, ranges: plans.rangeWindows.length } };
}

export function prepareDailyAnalysis(db, engine, config, {
  workspaceScopes, rangeContext, summationContext, prepareStandardHealth, prepareProxies, prepareTiming = () => undefined, finalizeAlerts, progress,
}) {
  const point = { date: config.date, dataVersion: config.dataVersion, calculationVersion: CALCULATION_VERSION };
  const exact = verifiedAnalysisPublication(db, point);
  if (exact) return { ...point, ...exact, chartBook: prepareProxies(config), sessionReview: prepareTiming(config) };
  const parent = dailyAnalysisParent(db, point);
  if (!parent) return { ...point, analysisPreparation: 'verified_baseline_required' };
  const scopes = workspaceScopes(db, engine, { date: point.date, version: point.dataVersion });
  const plan = dailyPlans(db, engine, scopes.basePoint, scopes, rangeContext);
  const { date: rootDate, dataVersion: rootVersion } = parent.base;
  const rootScopes = workspaceScopes(db, engine, { date: rootDate, version: rootVersion, pinnedDefaults: true });
  const rootPlan = dailyPlans(db, engine, rootScopes.basePoint, rootScopes, rangeContext);
  // A fixed context can share a key with a rolling context at the root and
  // need its own readback after the rolling context advances.
  if (rootPlan.contexts.length !== parent.contexts || rootPlan.logicalRecipeHash !== plan.logicalRecipeHash ||
      rootPlan.rollingRecipeHash !== plan.rollingRecipeHash ||
      parent.receipt && parent.receipt.recipeHash !== rootPlan.recipeHash) {
    return { ...point, analysisPreparation: 'verified_baseline_required' };
  }
  const dated = plan.contexts.filter(({ config: scope }) => scope.date === point.date && scope.dataVersion === point.dataVersion);
  const fixed = plan.contexts.filter(({ config: scope }) => scope.date !== point.date || scope.dataVersion !== point.dataVersion);
  const prior = expectedSessions(shiftDate(parent.date, -14), parent.date).at(-2);
  if (!dated.length || !prior || dated.some(({ config: scope, rank }) => !preparedSnapshotDates(db, engine, asOf(scope, prior), [prior]).has(prior) ||
      rank && !preparedSnapshotDates(db, engine, asOf(scope, prior), [prior], { velocity: true }).has(prior)) ||
      fixed.some(({ config: scope, rank }) => scope.date < parent.dateFrom || !preparedSnapshotDates(db, engine, scope, [scope.date]).has(scope.date) ||
        rank && !preparedSnapshotDates(db, engine, scope, [scope.date], { velocity: true }).has(scope.date))) {
    return { ...point, analysisPreparation: 'verified_baseline_required' };
  }
  const dates = [parent.date, point.date];
  // A current latest-reference session becomes dated history on the next append.
  // Store both views together so later appends don't need to produce the old anchor again.
  const current = new Map(dated.map((entry) => [preparationRecipe(engine, entry.config), entry]));
  for (const { config: scope, rank } of dated) {
    const historical = asOf(scope);
    const key = preparationRecipe(engine, historical);
    if (!current.has(key) || rank && !current.get(key).rank) current.set(key, { config: historical, rank });
  }
  const appendScopes = [...current.values()];
  requirePreparationSpace(db, dates.length);
  const core = prepareBatchedSnapshots(db, engine, appendScopes, { dates, requireDependencySeeds: true, requireCompactRanks: true,
    onProgress: ({ fraction }) => progress(fraction * 0.24) });
  const products = verifyCore(db, engine, appendScopes, dates);
  const instruments = prepareInstruments(db, engine, asOf(scopes.basePoint), parent, plan, progress);
  const { stats, expected, ...instrumentProducts } = instruments;
  Object.assign(products, instrumentProducts);
  const ranked = appendScopes.filter(({ rank }) => rank);
  Object.assign(expected, { base: ranked.length * dates.length, breadth: ranked.length * dates.length,
    velocity: ranked.length * dates.length, ranks: ranked.length * dates.length,
    monitor: (appendScopes.length - ranked.length) * dates.length, nyseSummation: 1,
    health: ranked.length * dates.length * 2 * (1 + listWorkspace(db, 'health-model').length) });

  for (const { config: scope, windows } of plan.rangesByScope) {
    if (scope.basis === 'reconstructed' && scope.dataVersion === point.dataVersion && scope.date >= parent.date) continue;
    for (const batch of windowBatches(windows)) {
      const prepared = readPreparedRangeMetrics(db, scope, batch);
      if (!prepared.ready) {
        if (scope.date < parent.dateFrom || scope.dataVersion !== point.dataVersion) throw new Error('A pinned historical range needs explicit preparation');
        prepareRangeMetrics(db, engine, scope, prepared.missingWindows);
        verifyPreparedExactRanges(db, scope, prepared.missingWindows);
      }
      products.ranges += batch.length;
      expected.ranges += batch.length;
    }
  }

  for (const { securityId, benchmark, basis, lookback } of plan.registrations.filter(({ basis }) => basis === 'known')) {
    const registered = rangeContext(engine, engine.context({ ...scopes.base, basis, benchmark }));
    const writer = createPreparedDetailWriter(db, engine, registered, { benchmarks: [benchmark], riskWindows: [lookback] });
    if (!writer.ready(securityId)) {
      for (const detail of dailyDetailSources(db, engine, registered, null, [securityId])) writer(detail);
    }
    if (!writer.ready(securityId)) throw new Error(`Missing prepared known-at-the-time detail and risk for ${securityId}`);
  }

  products.health = 0;
  for (const scope of fixed) {
    verifyCore(db, engine, [scope], [scope.config.date], null);
    if (scope.rank && prepareStandardHealth(db, engine, scope.config, { from: scope.config.date, limit: 1, verifyOnly: true })
      .some((run) => run.prepared !== 1)) throw new Error(`A pinned historical health recipe is missing for ${scope.config.date}`);
  }
  for (const [index, { config: scope }] of ranked.entries()) {
    const health = prepareStandardHealth(db, engine, scope, { from: parent.date, limit: 2, carryRegime: true });
    for (const run of health) {
      if (run.prepared !== 2 || run.latestPrepared !== point.date || run.missingDates?.length) {
        throw new Error(`Missing calibrated health for ${scope.universe.id}/${scope.model.id}`);
      }
      products.health += run.prepared;
    }
    progress(0.7 + 0.25 * (index + 1) / ranked.length);
  }
  const nyse = summationContext(db, engine, scopes.basePoint);
  const observed = [...engine.batchAdvanceDecline(nyse, { dates: [point.date] })];
  appendSummation(db, nyse, parent, observed[0]);
  const sum = readPreparedSummation(db, nyse, { from: parent.date, limit: 2 });
  if (sum.rows.length !== 2 || sum.rows.some((row, index) => row.date !== dates[index])) throw new Error('Missing prepared NYSE summation');
  products.nyseSummation = 1;
  const chartBook = prepareProxies(config);
  const sessionReview = prepareTiming(scopes.basePoint);
  const alerts = finalizeAlerts(point);
  if (alerts.deferred.length) throw new Error('A saved alert is missing required range or dated screen products');
  if (dataVersion(db) !== point.dataVersion) throw new Error('Warehouse revision changed during daily analysis preparation');
  const proof = Object.fromEntries(Object.entries(products).map(([key, verified]) => [key, { expected: expected[key], verified }]));
  if (sessionReview?.verified) proof.sessionReview = { expected: 1, verified: 1, modelVersion: sessionReview.modelVersion };
  const receiptId = writeDailyAnalysisReceipt(db, point, parent, { recipeHash: rootPlan.recipeHash, contexts: parent.contexts, products: proof });
  progress(1);
  return { ...point, receiptId, parentDate: parent.date, parentDataVersion: parent.dataVersion, dates, products, core,
    physicalContexts: plan.contexts.length, fixedContexts: fixed.length, instruments: stats, chartBook, sessionReview, alerts };
}
