import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { expectedSessions, latestFinalizableSession, shiftDate } from '../backend/calendar.mjs';
import { BENCHMARKS, EodhdProvider } from '../backend/provider.mjs';
import { dataVersion, importDataset, isoDate, normalizeExchange, normalizeSymbol, normalizeType, openDatabase } from '../backend/database.mjs';

const SOURCE = 'eodhd';
const DEFAULT_DAILY_BUDGET = 10_000;
const COST = { quota: 1, catalog: 1, delistedCatalog: 1, prices: 1, actions: 2, reference: 10, listingEvents: 1 };
const CORE_COVERAGE_THRESHOLD = 0.98;
const coreExchanges = new Set(['NYSE', 'NASDAQ']);
const localHost = hostname();
const marketDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const encode = JSON.stringify;
const hash = (value) => createHash('sha256').update(encode(value)).digest('hex');
const redact = (value) => String(value ?? '').replace(/((?:[?&]|--)(?:api[_-]?token|token|api[_-]?key)=)[^\s&'"]+/gi, '$1[redacted]');

function initialize(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bootstrap_plans (
      id TEXT PRIMARY KEY, requested_from TEXT NOT NULL, requested_to TEXT NOT NULL,
      active_catalog TEXT, delisted_catalog TEXT, listing_events TEXT, catalog_version INTEGER,
      published_version INTEGER, owner_pid INTEGER, owner_host TEXT, lease_until INTEGER
    );
    CREATE TABLE IF NOT EXISTS bootstrap_tasks (
      plan_id TEXT NOT NULL REFERENCES bootstrap_plans(id), task_id TEXT NOT NULL, stage TEXT NOT NULL,
      state TEXT NOT NULL, version INTEGER, detail TEXT NOT NULL,
      PRIMARY KEY (plan_id, task_id, stage)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS bootstrap_usage (
      source TEXT NOT NULL, date TEXT NOT NULL, reserved INTEGER NOT NULL,
      PRIMARY KEY (source, date)
    ) WITHOUT ROWID;
  `);
}

function symbolsOf(value) {
  const symbols = Array.isArray(value) ? value : String(value ?? '').split(',');
  const list = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))].sort();
  if (list.some((symbol) => !/^[A-Z0-9^][A-Z0-9._^=-]{0,32}$/.test(symbol))) throw new Error('An invalid symbol was supplied');
  return list;
}

function integer(value, label, minimum, maximum) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < minimum || count > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  return count;
}

function bootstrapOptions(input, now) {
  const latest = latestFinalizableSession(now);
  const to = input.to ?? latest;
  const from = input.from ?? shiftDate(to, -3653);
  if (![from, to].every(isoDate) || from < '1900-01-01' || from > to || to > latest || !expectedSessions(from, to).length) {
    throw new Error('Select a valid date range through the latest finalized US market session');
  }
  const selection = {
    from: input.from ?? null, to: input.to ?? null, symbols: symbolsOf(input.symbols),
    benchmarks: symbolsOf(input.benchmarks ?? BENCHMARKS), actions: input.actions !== false, reference: input.reference === true,
    includeDelisted: input.includeDelisted !== false, includeAmex: input.includeAmex === true,
    includeAdrs: input.includeAdrs === true, includeReits: input.includeReits === true,
  };
  return {
    ...selection, from, to, latest, id: hash([SOURCE, 1, selection]), force: input.force === true,
    concurrency: integer(input.concurrency ?? 3, 'Concurrency', 1, 10),
    maxCalls: integer(input.maxCalls ?? DEFAULT_DAILY_BUDGET, 'Daily call budget', 1, 1_000_000),
  };
}

function pidExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function claimPlan(db, config) {
  const query = db.prepare('SELECT * FROM bootstrap_plans WHERE id=?');
  db.exec('BEGIN IMMEDIATE');
  try {
    let plan = query.get(config.id);
    if (plan?.owner_pid && (plan.owner_host === localHost ? pidExists(plan.owner_pid) : plan.lease_until > Date.now())) {
      throw new Error('This bootstrap plan is already running');
    }
    if (!plan) db.prepare('INSERT INTO bootstrap_plans(id,requested_from,requested_to) VALUES (?,?,?)').run(config.id, config.from, config.to);
    else if (config.force) {
      db.prepare('DELETE FROM bootstrap_tasks WHERE plan_id=?').run(config.id);
      db.prepare(`UPDATE bootstrap_plans SET requested_from=?, requested_to=?, active_catalog=NULL,
        delisted_catalog=NULL, listing_events=NULL, catalog_version=NULL, published_version=NULL WHERE id=?`)
        .run(config.from, config.to, config.id);
    }
    db.prepare('UPDATE bootstrap_plans SET owner_pid=?,owner_host=?,lease_until=? WHERE id=?')
      .run(process.pid, localHost, Date.now() + 900_000, config.id);
    plan = query.get(config.id);
    db.exec('COMMIT');
    return plan;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function credits(db, day, maxCalls, stop) {
  db.prepare('INSERT OR IGNORE INTO bootstrap_usage VALUES (?,?,0)').run(SOURCE, day);
  const select = db.prepare('SELECT reserved FROM bootstrap_usage WHERE source=? AND date=?');
  const reserve = db.prepare('UPDATE bootstrap_usage SET reserved=reserved+? WHERE source=? AND date=? AND reserved+?<=?');
  const baseline = select.get(SOURCE, day).reserved;
  let cap = maxCalls;
  let verified = false;
  let used = 0;
  return {
    reserve(stage) {
      const units = COST[stage];
      if (stop.reason || !reserve.run(units, SOURCE, day, units, cap).changes) {
        stop.reason ??= 'daily_call_budget';
        return false;
      }
      used += units;
      return true;
    },
    account(quota) {
      if (!finiteNonnegative(quota?.remaining)) return;
      verified = true;
      cap = Math.min(maxCalls, select.get(SOURCE, day).reserved + Math.floor(quota.remaining));
    },
    summary() { return { verified, estimatedReserved: used, reservedBeforeRun: baseline, day, cap }; },
  };
}

const finiteNonnegative = (value) => Number.isFinite(value) && value >= 0;
const checkpointState = (raw) => raw ? JSON.parse(raw) : null;

function providerRecord(raw, status, captureDate) {
  const symbol = normalizeSymbol(raw.symbol);
  if (!symbol || !/^[A-Z0-9^][A-Z0-9._^=-]{0,32}$/.test(symbol)) return null;
  return {
    symbol, providerSymbol: raw.providerSymbol || `${symbol}.US`, status, name: raw.name || symbol,
    exchange: normalizeExchange(raw.exchange), type: normalizeType(raw.type), country: raw.country ?? null,
    isin: typeof raw.isin === 'string' && /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/i.test(raw.isin) ? raw.isin.toUpperCase() : null,
    listingDate: isoDate(raw.listingDate) ? raw.listingDate : null,
    delistingDate: isoDate(raw.delistingDate) ? raw.delistingDate : null,
    knownAt: captureDate,
  };
}

const isCore = (record) => coreExchanges.has(record.exchange) && record.type === 'common';

function qualifies(record, config) {
  const exchange = coreExchanges.has(record.exchange) || (config.includeAmex && record.exchange === 'NYSE AMERICAN');
  const type = record.type === 'common' || (config.includeAdrs && record.type === 'adr') || (config.includeReits && record.type === 'reit');
  return exchange && type && (!config.symbols.length || config.symbols.includes(record.symbol));
}

function catalogSelection(active, delisted, events, config, captureDate) {
  const activeBySymbol = new Map(active.map((record) => [record.symbol, record]));
  const benchmarks = new Set(config.benchmarks.filter((symbol) => !isCore(activeBySymbol.get(symbol) ?? {})));
  const current = active.filter((record) => !benchmarks.has(record.symbol) && qualifies(record, config));
  const core = current.filter(isCore);
  const unknownCurrent = active.filter((record) => coreExchanges.has(record.exchange) && record.type === 'unknown' && !benchmarks.has(record.symbol)).length;
  const historical = delisted.filter((record) => qualifies(record, config) && !benchmarks.has(record.symbol));
  const selected = [];
  const quarantined = [];
  const identities = new Map();
  for (const record of [...current, ...historical]) {
    const list = identities.get(record.symbol) ?? [];
    const signature = encode([record.status, record.listingDate, record.delistingDate, record.exchange, record.isin]);
    if (!list.some((item) => item.signature === signature)) list.push({ record, signature });
    identities.set(record.symbol, list);
  }
  for (const candidates of identities.values()) {
    const records = candidates.map(({ record }) => record);
    const ordered = [...records].sort((a, b) => (a.listingDate ?? '').localeCompare(b.listingDate ?? ''));
    const ambiguous = ordered.some((record, index) => index > 0 && (!record.listingDate || !ordered[index - 1].delistingDate ||
      ordered[index - 1].delistingDate >= record.listingDate));
    if (ambiguous) quarantined.push(...records);
    else {
      for (const record of records) {
        // A delisted ticker without a terminal date could include a different issuer or a reused ticker.
        if (record.status === 'delisted' && !record.delistingDate && !record.isin) quarantined.push(record);
        else selected.push(record);
      }
    }
  }
  for (const symbol of benchmarks) {
    const match = activeBySymbol.get(symbol);
    selected.push({ ...match, symbol, providerSymbol: match?.providerSymbol ?? `${symbol}.US`, status: 'active',
      name: match?.name ?? symbol, type: match?.type && match.type !== 'unknown' ? match.type : 'etf',
      exchange: match?.exchange ?? 'NYSE ARCA', knownAt: match?.knownAt ?? captureDate, benchmark: true });
  }
  const uniqueCore = new Set(core.map((record) => record.symbol));
  const grouped = new Map();
  for (const record of selected) {
    const key = record.isin ?? record;
    const values = grouped.get(key) ?? [];
    values.push(record);
    grouped.set(key, values);
  }
  const securities = [];
  const aliases = [];
  let linkedAliases = 0;
  for (const records of grouped.values()) {
    const next = confirmedAliasIntervals(records, events);
    if (!next) { quarantined.push(...records); continue; }
    aliases.push(...next);
    if (next.length === 1) securities.push(next[0]);
    else {
      const last = next.at(-1);
      securities.push({ ...last, listingDate: next[0].listingDate, identifiers: next.map((record) => ({
        symbol: record.symbol, providerSymbol: record.providerSymbol, exchange: record.exchange,
        validFrom: record.listingDate, validTo: record.delistingDate,
      })) });
      linkedAliases += next.length - 1;
    }
  }
  return { selected: aliases, securities, quarantined, linkedAliases, expectedCore: uniqueCore.size, unknownCurrent };
}

function confirmedAliasIntervals(records, events) {
  if (records.length === 1) {
    const [record] = records;
    return record.status !== 'delisted' || record.delistingDate || record.isin ? records : null;
  }
  if (records.filter((record) => record.status === 'active').length > 1 || records.some((record) => record.benchmark)) return null;
  const bySymbol = new Set(records.map((record) => record.symbol));
  const relevant = events.filter(({ oldSymbol, newSymbol, effectiveDate }) => isoDate(effectiveDate) &&
    oldSymbol !== newSymbol && bySymbol.has(oldSymbol) && bySymbol.has(newSymbol));
  const timelines = records.map((record) => {
    const starts = [...new Set(relevant.filter(({ newSymbol }) => newSymbol === record.symbol).map(({ effectiveDate }) => effectiveDate))];
    const ends = [...new Set(relevant.filter(({ oldSymbol }) => oldSymbol === record.symbol).map(({ effectiveDate }) => shiftDate(effectiveDate, -1)))];
    if (starts.length > 1 || ends.length > 1 || (ends.length && record.status === 'active')) return null;
    const listingDate = starts[0] && (!record.listingDate || starts[0] > record.listingDate) ? starts[0] : record.listingDate;
    const delistingDate = ends[0] && (!record.delistingDate || ends[0] < record.delistingDate) ? ends[0] : record.delistingDate;
    if (record.status === 'delisted' && (!delistingDate || (listingDate && listingDate > delistingDate))) return null;
    return { ...record, listingDate, delistingDate };
  });
  if (timelines.includes(null)) return null;
  timelines.sort((left, right) => (left.listingDate ?? '').localeCompare(right.listingDate ?? ''));
  if (timelines.some((record, index) => index > 0 && (!record.listingDate || !timelines[index - 1].delistingDate ||
      record.listingDate <= timelines[index - 1].delistingDate))) return null;
  return timelines;
}

function resolvedTasks(db, selection, plan) {
  const hasIsin = db.prepare('PRAGMA table_info(securities)').all().some((column) => column.name === 'isin');
  const findSecurity = db.prepare(`
    SELECT DISTINCT s.id, i.exchange, ${hasIsin ? 's.isin' : 'NULL AS isin'} FROM securities s
    JOIN identifiers i ON i.security_id=s.id WHERE s.provider=? AND i.symbol=?
      AND i.valid_from<=? AND (i.valid_to IS NULL OR i.valid_to>=?)
  `);
  const tasks = [];
  const unresolved = [];
  for (const record of selection.selected) {
    const from = record.listingDate && record.listingDate > plan.requested_from ? record.listingDate : plan.requested_from;
    const to = record.delistingDate && record.delistingDate < plan.requested_to ? record.delistingDate : plan.requested_to;
    if (from > to || !expectedSessions(from, to).length) continue;
    const candidates = findSecurity.all(SOURCE, record.symbol, to, to).filter((security) =>
      (record.exchange === 'UNKNOWN' || security.exchange === record.exchange) &&
      (!record.isin || !security.isin || record.isin === security.isin));
    if (candidates.length !== 1) { unresolved.push(record); continue; }
    const securityId = candidates[0].id;
    tasks.push({ ...record, securityId, from, to, id: hash([securityId, record.providerSymbol, from, to]) });
  }
  return { tasks, unresolved };
}

function knownDate(record, captureDate) {
  const stamp = record.knownAt ?? record.known_at;
  return typeof stamp === 'string' && isoDate(stamp.slice(0, 10)) && stamp.slice(0, 10) <= captureDate ? stamp : captureDate;
}

function importedPriceCount(db, task, version = dataVersion(db)) {
  return db.prepare(`SELECT count(DISTINCT date) AS observations,min(date) AS first,max(date) AS last FROM price_revisions
    WHERE security_id=? AND date BETWEEN ? AND ? AND source=? AND version<=? AND volume>0`)
    .get(task.securityId, task.from, task.to, SOURCE, version);
}

function taskDetails(task, observations, batchResult) {
  const historicalStart = task.listingDate ? task.from : observations.first;
  const unknownDelisting = task.status === 'delisted' && !task.delistingDate;
  const historicalEnd = unknownDelisting ? observations.last : task.to;
  const expected = historicalStart && historicalEnd ? expectedSessions(historicalStart, historicalEnd).length : 0;
  return {
    observations: observations.observations, first: observations.first, last: observations.last,
    listingDateUnknown: !task.listingDate, delistingDateUnknown: unknownDelisting, expected, missingSessions: Math.max(0, expected - observations.observations),
    invalid: batchResult?.invalid ?? 0, unresolved: batchResult?.unresolved ?? 0,
  };
}

function stopFor(error, stage, stop) {
  if (error.status === 429) stop.reason ??= 'provider_rate_limit';
  if (['catalog', 'prices'].includes(stage) && [401, 402, 403].includes(error.status)) stop.reason ??= 'provider_access';
}

function sourceMessage(error) {
  const key = process.env.EODHD_API_KEY;
  const message = redact(error?.message);
  return (key ? message.replaceAll(key, '[redacted]') : message).slice(0, 200);
}

function publishCore(db, config, plan, selection, resolved, target, captureDate) {
  const candidates = resolved.tasks.filter((task) => task.status === 'active' && !task.benchmark && isCore(task));
  const { expectedCore } = selection;
  const coreIds = [...new Set(candidates.map((task) => task.securityId))];
  const rows = db.prepare(`
    SELECT p.* FROM daily_prices p JOIN securities s ON s.id=p.security_id
    WHERE p.date=? AND p.source=? AND p.volume>0 AND s.type='common' AND s.exchange IN ('NYSE','NASDAQ')
      AND p.security_id IN (SELECT value FROM json_each(?)) ORDER BY p.security_id
  `).all(target, SOURCE, encode(coreIds));
  const ready = !config.symbols.length && target === plan?.anchorSession && expectedCore > 0 &&
    selection.unknownCurrent === 0 && coreIds.length === expectedCore &&
    rows.length >= Math.ceil(expectedCore * CORE_COVERAGE_THRESHOLD);
  if (!ready) return { expected: expectedCore, received: rows.length, published: false, version: null };
  const prices = rows.map((row) => ({
    securityId: row.security_id, date: row.date, open: row.open, high: row.high, low: row.low, close: row.close,
    adjustedClose: row.adjusted_close, splitClose: row.split_close, volume: row.volume,
    volumeAdjusted: !!row.volume_adjusted, volumeBasis: row.volume_basis, knownAt: row.known_at,
  }));
  const result = importDataset(db, {
    provider: SOURCE, dataset: `bootstrap-current-coverage:${config.id}`, scope: 'full',
    catalogDate: plan?.capturedOn ?? captureDate, expected: expectedCore, sessions: [target], prices,
    warnings: ['Latest-session coverage was checked against the source active catalog. Historical universe completeness is unverified.',
      ...(rows.length === expectedCore ? [] : [`The source reported positive volume for ${rows.length} of ${expectedCore} eligible catalog entries.`])],
  });
  db.prepare('UPDATE bootstrap_plans SET published_version=? WHERE id=?').run(result.version, config.id);
  return { expected: expectedCore, received: rows.length, published: true, version: result.version };
}

export async function runBootstrap({ db, provider = EodhdProvider(), options = {}, onProgress, signal, now = () => new Date() }) {
  const initialTime = now();
  const quotaDay = initialTime.toISOString().slice(0, 10);
  const captureDate = marketDay.format(initialTime);
  const config = bootstrapOptions(options, initialTime);
  initialize(db);
  const plan = claimPlan(db, config);
  const stop = { reason: null };
  const budget = credits(db, quotaDay, config.maxCalls, stop);
  const heartbeat = db.prepare('UPDATE bootstrap_plans SET lease_until=? WHERE id=?');
  const setTask = db.prepare(`INSERT INTO bootstrap_tasks VALUES (?,?,?,?,?,?)
    ON CONFLICT(plan_id,task_id,stage) DO UPDATE SET state=excluded.state,version=excluded.version,detail=excluded.detail`);
  const existing = new Map(db.prepare('SELECT * FROM bootstrap_tasks WHERE plan_id=?').all(config.id)
    .map((row) => [`${row.stage}:${row.task_id}`, row]));
  const warnings = [];
  const emit = (phase, data = {}) => onProgress?.({ phase, planId: config.id, ...data });
  function active() {
    if (signal?.aborted) stop.reason ??= 'cancelled';
    if (now().toISOString().slice(0, 10) !== quotaDay) stop.reason ??= 'day_boundary';
    return !stop.reason;
  }
  async function request(stage, action) {
    if (!active() || !budget.reserve(stage)) return { paused: true };
    heartbeat.run(Date.now() + 900_000, config.id);
    try { return { value: await action() }; }
    catch (error) { stopFor(error, stage, stop); return { error }; }
  }
  async function saveCatalog(column, stage, action, category) {
    const prior = checkpointState(plan[column]);
    if (prior?.available) return prior;
    const result = await request(stage, action);
    if (result.paused) return null;
    if (result.error) {
      warnings.push({ stage: category, reason: sourceMessage(result.error) });
      if (stop.reason || category === 'activeCatalog') return null;
    }
    if (!result.error && !Array.isArray(result.value)) throw new Error(`The ${category} response was not a catalog list`);
    const rows = result.error ? [] : category === 'listingEvents' ? result.value.slice(0, 100_000).map((row) => ({
      exchange: normalizeExchange(row.exchange), oldSymbol: normalizeSymbol(row.oldSymbol), newSymbol: normalizeSymbol(row.newSymbol),
      effectiveDate: isoDate(row.effectiveDate) ? row.effectiveDate : null, knownAt: knownDate(row, captureDate),
    })) :
      result.value.map((row) => providerRecord(row, category === 'activeCatalog' ? 'active' : 'delisted', captureDate)).filter(Boolean);
    const saved = { capturedOn: captureDate, anchorSession: config.latest, available: !result.error, rows };
    db.prepare(`UPDATE bootstrap_plans SET ${column}=? WHERE id=?`).run(encode(saved), config.id);
    return saved;
  }
  function finish(state, extra = {}) {
    const report = {
      planId: config.id, state, reason: stop.reason, from: plan.requested_from, to: plan.requested_to,
      dataVersion: dataVersion(db), quota: budget.summary(), warnings, historicalPointInTimeCoverage: 'unverified', ...extra,
    };
    emit('finish', { state, reason: stop.reason });
    return report;
  }
  try {
    let quotaCheck;
    function verifyQuota() {
      if (typeof provider.getQuota !== 'function') return undefined;
      quotaCheck ??= (async () => {
        const result = await request('quota', () => provider.getQuota());
        if (result.error) warnings.push({ stage: 'quota', reason: sourceMessage(result.error) });
        else if (!result.paused) budget.account(result.value);
      })();
      return quotaCheck;
    }
    if (!plan.active_catalog) await verifyQuota();
    const activeCatalog = await saveCatalog('active_catalog', 'catalog', () => provider.getSecurities({ asOf: captureDate,
      symbols: config.symbols.length ? [...new Set([...config.symbols, ...config.benchmarks])] : undefined }), 'activeCatalog');
    if (!activeCatalog?.rows.length) return finish(stop.reason ? 'paused' : 'partial', { reason: stop.reason ?? 'catalog_unavailable' });
    const priorDelistedAvailable = checkpointState(plan.delisted_catalog)?.available;
    if (config.includeDelisted && !priorDelistedAvailable) await verifyQuota();
    const delistedCatalog = config.includeDelisted ? await saveCatalog('delisted_catalog', 'delistedCatalog', () => provider.getSecurities({
      delisted: true, asOf: captureDate, symbols: config.symbols.length ? config.symbols : undefined,
    }), 'delistedCatalog') : null;
    const priorEventsAvailable = checkpointState(plan.listing_events)?.available;
    if (config.includeDelisted && !priorEventsAvailable && typeof provider.getListingEvents === 'function' && active()) await verifyQuota();
    const events = config.includeDelisted && typeof provider.getListingEvents === 'function' && active()
      ? await saveCatalog('listing_events', 'listingEvents', () => provider.getListingEvents({ from: plan.requested_from, to: plan.requested_to }), 'listingEvents') : null;
    const selection = catalogSelection(activeCatalog.rows, delistedCatalog?.rows ?? [], events?.rows ?? [], config, activeCatalog.capturedOn);
    if (!plan.catalog_version || (!priorDelistedAvailable && delistedCatalog?.available) || (!priorEventsAvailable && events?.available)) {
      const { version } = importDataset(db, {
        provider: SOURCE, dataset: `bootstrap-catalog:${config.id}`, scope: 'sample', catalogDate: activeCatalog.capturedOn,
        securities: selection.securities,
      });
      db.prepare('UPDATE bootstrap_plans SET catalog_version=? WHERE id=?').run(version, config.id);
    }
    const resolved = resolvedTasks(db, selection, plan);
    const count = { prices: 0, actions: 0, reference: 0 };
    const statuses = { prices: { failed: 0, skipped: 0 }, actions: { failed: 0, skipped: 0 }, reference: { failed: 0, skipped: 0 } };
    const priceDetails = [];
    const saveTask = (task, stage, state, version, detail) => {
      setTask.run(config.id, task.id, stage, state, version, encode(detail));
      existing.set(`${stage}:${task.id}`, { state, version, detail: encode(detail) });
    };

    async function pull(task, stage) {
      const previous = existing.get(`${stage}:${task.id}`);
      const priceCount = stage === 'prices' && previous?.state === 'complete' ? importedPriceCount(db, task, previous.version).observations : null;
      const priorDetail = previous && checkpointState(previous.detail);
      if (previous?.state === 'complete' && (stage !== 'prices' || (priceCount > 0 && priceCount >= priorDetail.observations))) {
        count[stage]++;
        statuses[stage].skipped++;
        if (stage === 'prices') priceDetails.push(priorDetail);
        return;
      }
      const dataset = `bootstrap-${stage}:${config.id}:${task.id}`;
      if (!config.force && !previous) {
        const committed = db.prepare("SELECT version FROM ingestion_runs WHERE provider=? AND dataset=? AND status='complete' ORDER BY version DESC LIMIT 1").get(SOURCE, dataset);
        if (committed) {
          const observations = stage === 'prices' ? importedPriceCount(db, task, committed.version) : null;
          if (stage !== 'prices' || observations.observations) {
            const details = observations ? taskDetails(task, observations) : {};
            saveTask(task, stage, 'complete', committed.version, details);
            if (stage === 'prices') priceDetails.push(details);
            count[stage]++;
            statuses[stage].skipped++;
            return;
          }
        }
      }
      await verifyQuota();
      const params = { symbol: task.providerSymbol, from: task.from, to: task.to };
      const result = await request(stage, () => {
        if (stage === 'prices') return provider.getDailyPrices(params);
        if (stage === 'actions') return provider.getCorporateActions(params);
        return provider.getReference(task.providerSymbol, captureDate);
      });
      if (result.paused) return;
      try {
        if (result.error) throw result.error;
        const batch = { provider: SOURCE, dataset, scope: 'sample', catalogDate: captureDate };
        if (stage !== 'reference') {
          if (!Array.isArray(result.value)) throw new Error('Provider returned an invalid observations list');
          const rows = result.value.filter((row) => isoDate(row.date) && row.date >= task.from && row.date <= task.to)
            .map((row) => ({ ...row, securityId: task.securityId, knownAt: knownDate(row, captureDate) }));
          if (stage === 'prices' && !rows.length) throw new Error('No history in the security identity interval');
          batch[stage === 'prices' ? 'prices' : 'corporateActions'] = rows;
        } else {
          if (!result.value?.fundamentals && !result.value?.classifications) throw new Error('Current reference data is unavailable');
          if (result.value.fundamentals) batch.fundamentals = [{ ...result.value.fundamentals, securityId: task.securityId,
            effectiveDate: captureDate, knownAt: captureDate }];
          if (result.value.classifications) batch.classifications = [{ ...result.value.classifications, securityId: task.securityId,
            effectiveFrom: captureDate, knownAt: captureDate }];
        }
        const loaded = importDataset(db, batch);
        let detail = {};
        if (stage === 'prices') {
          const history = importedPriceCount(db, task, loaded.version);
          if (!history.observations) throw new Error('No valid trading prices committed for the security');
          detail = taskDetails(task, history, loaded);
          priceDetails.push(detail);
        }
        saveTask(task, stage, 'complete', loaded.version, detail);
        count[stage]++;
      } catch (error) {
        statuses[stage].failed++;
        const reason = sourceMessage(error);
        saveTask(task, stage, 'retry', null, { reason, status: error.status ?? null });
        if (warnings.length < 100) warnings.push({ stage, symbol: task.symbol, reason });
      }
    }

    async function runPhase(stage, tasks) {
      let cursor = 0;
      let processed = 0;
      emit(stage, { completed: 0, total: tasks.length, percent: 0 });
      const workers = await Promise.allSettled(Array.from({ length: Math.min(config.concurrency, tasks.length) }, async () => {
        while (active() && cursor < tasks.length) {
          const task = tasks[cursor++];
          await pull(task, stage);
          processed++;
          emit(stage, { completed: processed, total: tasks.length, percent: Math.floor(100 * processed / tasks.length), symbol: task.symbol });
        }
      }));
      const failed = workers.find((worker) => worker.status === 'rejected');
      if (failed) throw failed.reason;
    }

    await runPhase('prices', resolved.tasks);
    const withPrices = resolved.tasks.filter((task) => existing.get(`prices:${task.id}`)?.state === 'complete');
    if (config.actions && withPrices.length && typeof provider.getCorporateActions === 'function') await runPhase('actions', withPrices);
    const referenceTasks = withPrices.filter((task) => task.status === 'active' && !task.benchmark);
    if (config.reference && referenceTasks.length && typeof provider.getReference === 'function') await runPhase('reference', referenceTasks);
    const publication = plan.published_version && db.prepare('SELECT expected, eligible_received FROM session_imports WHERE version=? AND date=?')
      .get(plan.published_version, plan.requested_to);
    const coverage = publication ? { expected: publication.expected, received: publication.eligible_received,
      published: true, version: plan.published_version } : publishCore(db, config, activeCatalog, selection, resolved, plan.requested_to, captureDate);
    const taskSymbols = new Set(resolved.tasks.map((task) => task.symbol));
    const missingRequestedSymbols = config.symbols.filter((symbol) => !taskSymbols.has(symbol));
    const publicationExpected = !config.symbols.length && plan.requested_to === activeCatalog.anchorSession;
    const unfinished = count.prices < resolved.tasks.length || selection.quarantined.length > 0 || resolved.unresolved.length > 0 ||
      (config.actions && count.actions < withPrices.length) || (config.reference && count.reference < referenceTasks.length) ||
      (config.includeDelisted && !delistedCatalog?.available) || (publicationExpected && !coverage.published) ||
      missingRequestedSymbols.length > 0 || !resolved.tasks.length;
    return finish(stop.reason ? 'paused' : unfinished ? 'partial' : 'complete', {
      catalog: { capturedOn: activeCatalog.capturedOn, anchorSession: activeCatalog.anchorSession, active: activeCatalog.rows.length, historical: delistedCatalog?.rows.length ?? 0,
        delistedCatalogAvailable: delistedCatalog?.available ?? false, listingEvents: events?.rows.length ?? 0,
        listingEventsAvailable: events?.available ?? false, unclassifiedCoreCandidates: selection.unknownCurrent,
        quarantined: selection.quarantined.length + resolved.unresolved.length, linkedAliases: selection.linkedAliases, missingRequestedSymbols },
      tasks: { planned: resolved.tasks.length, ...statuses, completed: count }, coverage,
      prices: { observations: priceDetails.reduce((sum, item) => sum + item.observations, 0),
        missingWithinObservedIntervals: priceDetails.reduce((sum, item) => sum + item.missingSessions, 0),
        unknownListingDates: priceDetails.filter((item) => item.listingDateUnknown).length,
        unknownDelistingDates: priceDetails.filter((item) => item.delistingDateUnknown).length },
      benchmarks: { expected: config.benchmarks.length, loaded: new Set(withPrices.filter((task) =>
        config.benchmarks.includes(task.symbol)).map((task) => task.symbol)).size },
    });
  } finally {
    db.prepare('UPDATE bootstrap_plans SET owner_pid=NULL,owner_host=NULL,lease_until=NULL WHERE id=?').run(config.id);
  }
}

const help = `Usage: node scripts/bootstrap.mjs [options]

  --from YYYY-MM-DD        First date (default at least ten years before --to)
  --to YYYY-MM-DD          Last date (default latest finalized US market session)
  --symbols SYMBOLS        Comma-separated research subset. Default loads the eligible US catalog.
  --benchmarks SYMBOLS     Comma-separated benchmarks. Default adds SPY, QQQ, IWM and sector ETFs.
  --db FILE                SQLite warehouse (default data/market.sqlite or MARKET_DB)
  --concurrency N          Simultaneous security requests (default 3)
  --max-calls N            Daily estimated provider units for this warehouse (default 10000)
  --include-amex           Include NYSE American common stocks
  --include-adrs           Include ADRs
  --include-reits          Include REITs
  --reference              Capture current fundamentals and industry data when available
  --no-actions             Skip split and dividend collection
  --no-delisted            Skip the separate delisted catalog and listing event feed
  --force                  Restart this plan and refresh its source catalog
  --quiet                  Omit JSON progress from stderr
  --help                   Show usage`;

async function main() {
  try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { values } = parseArgs({ options: {
    from: { type: 'string' }, to: { type: 'string' }, symbols: { type: 'string' }, benchmarks: { type: 'string' }, db: { type: 'string' },
    concurrency: { type: 'string' }, 'max-calls': { type: 'string' }, 'include-amex': { type: 'boolean' }, 'include-adrs': { type: 'boolean' },
    'include-reits': { type: 'boolean' }, reference: { type: 'boolean' }, 'no-actions': { type: 'boolean' },
    'no-delisted': { type: 'boolean' }, force: { type: 'boolean' }, quiet: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(help); return; }
  if (!process.env.EODHD_API_KEY) throw new Error('Set EODHD_API_KEY before starting a source bootstrap');
  const db = openDatabase(values.db);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await runBootstrap({ db, signal: controller.signal, options: {
      from: values.from, to: values.to, symbols: values.symbols, benchmarks: values.benchmarks,
      concurrency: values.concurrency, maxCalls: values['max-calls'], includeAmex: values['include-amex'],
      includeAdrs: values['include-adrs'], includeReits: values['include-reits'], reference: values.reference,
      actions: !values['no-actions'], includeDelisted: !values['no-delisted'], force: values.force,
    }, onProgress: values.quiet ? undefined : (event) => console.error(encode(event)) });
    console.log(JSON.stringify(result, null, 2));
    if (result.state !== 'complete') process.exitCode = 2;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); }
  catch (error) { console.error(sourceMessage(error)); process.exitCode = 1; }
}
