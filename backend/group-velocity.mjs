import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expectedSessions, shiftDate, weekEnd } from './calendar.mjs';
import { CALCULATION_VERSION, dataVersion, isoDate } from './database.mjs';
import { quantile } from './metrics.mjs';
import { readPreparedRankPercentiles } from './preparation.mjs';
import { readPreparedSnapshot, readPreparedSnapshotRankWitnesses } from './prepared-snapshots.mjs';
import { rankBy } from './ranking.mjs';
import { decodeStoredJson, encodeStoredJson } from './storage-codec.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
export const GROUP_VELOCITY_VERSION = `group-membership-1-${digest(readFileSync(new URL(import.meta.url))).slice(0, 12)}`;
export const groupMembershipBasis = 'current-membership';
export const groupVelocityPolicy = Object.freeze({ minimumPairedCoverage: 0.8, minimumMembers: 1, minimumPeers: 2, coverageDenominator: 'current-ranked-members' });
const periods = { '4w': 4, '12w': 12 };
const groupLevels = ['sector', 'industry', 'subindustry', 'theme'];
const finite = Number.isFinite;
const schema = `CREATE TABLE IF NOT EXISTS prepared_current_group_velocity (
  projection_version TEXT NOT NULL, calculation_version TEXT NOT NULL,
  date TEXT NOT NULL, data_version INTEGER NOT NULL, recipe TEXT NOT NULL,
  sha256 TEXT NOT NULL, payload BLOB NOT NULL,
  PRIMARY KEY(projection_version,calculation_version,date,data_version,recipe)
) WITHOUT ROWID;`;

export function isCurrentGroupMembership(config) {
  return config.classification === 'nasdaq' && config.basis === 'reconstructed' && config.referenceMode === 'latest' &&
    isoDate(config.date) && config.date === config.latestDate && isoDate(config.observedReferenceDate);
}

export function groupComparisonDates(date) {
  const week = weekEnd(date);
  return Object.fromEntries(Object.entries(periods).map(([period, weeks]) => {
    const end = shiftDate(week, -7 * weeks);
    return [period, expectedSessions(shiftDate(end, -4), end).at(-1) ?? null];
  }));
}

function pointMetadata(config) {
  return { basis: groupMembershipBasis, anchorDate: config.date, observedReferenceDate: config.observedReferenceDate,
    comparisonDates: groupComparisonDates(config.date), policy: groupVelocityPolicy,
    dataVersion: config.dataVersion, calculationVersion: CALCULATION_VERSION, projectionVersion: GROUP_VELOCITY_VERSION,
    scope: { universe: config.universe.id, universeVersion: config.universe.version, model: config.model.id,
      modelVersion: config.model.version, benchmark: config.benchmark, priceBasis: config.basis, classification: config.classification,
      reference: config.referenceMode },
    historicalInterpretation: 'Uses stock RS for the current ranked cohort at both endpoints. The full traded roster is disclosed separately. Survivorship, selection, IPO and reclassification effects limit historical interpretation.',
  };
}

function keyFor(config) {
  const scope = [config.universe.id, config.universe.version, config.model.id, config.model.version,
    config.benchmark, config.basis, config.classification, config.referenceMode];
  const themes = (config.themes ?? []).map(({ id, version }) => [id, version]).toSorted((a, b) => a[0].localeCompare(b[0]));
  const recipe = digest(JSON.stringify([scope, config.observedReferenceDate, themes]));
  return [GROUP_VELOCITY_VERSION, CALCULATION_VERSION, config.date, config.dataVersion, recipe];
}

const keyWhere = 'projection_version=? AND calculation_version=? AND date=? AND data_version=? AND recipe=?';
const present = (db) => !!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='prepared_current_group_velocity' AND type='table'").get();

function classifiedCaptureDate(db, config) {
  const cutoff = config.observedReferenceDate > config.date ? config.observedReferenceDate : config.date;
  return db.prepare(`SELECT max(json_extract(detail,'$.catalogDate')) AS date FROM ingestion_runs
    WHERE provider='nasdaq' AND dataset LIKE 'stocks-screener:%' AND status='complete' AND version<=? AND json_valid(detail)
    AND json_extract(detail,'$.catalogDate')<=?`).get(config.dataVersion, cutoff)?.date ?? null;
}

function normalizeGroups(groups) {
  const ids = new Set();
  return groups.map((group) => {
    if (typeof group.id !== 'string' || ids.has(group.id) || !groupLevels.includes(group.level) ||
        !Array.isArray(group.memberIds) || group.memberIds.some((id) => typeof id !== 'string' || !id)) {
      throw new Error('Current group header has invalid permanent membership IDs');
    }
    ids.add(group.id);
    const memberIds = [...new Set(group.memberIds)].sort();
    if (memberIds.length !== group.memberIds.length || memberIds.length !== group.count) {
      throw new Error('Current group roster differs from its stored count');
    }
    return { ...group, memberIds };
  });
}

function rosterDigest(groups) {
  return digest(JSON.stringify(groups.map(({ id, level, memberIds }) => [id, level, memberIds])
    .toSorted((left, right) => left[0].localeCompare(right[0], 'en'))));
}

function mediansByLevel(groups, score) {
  const ranks = new Map();
  for (const level of groupLevels) {
    const sameLevel = groups.filter((group) => group.level === level);
    for (const [id, rank] of rankBy(sameLevel, score, (item) => item.id)) ranks.set(id, rank);
  }
  return ranks;
}

function validateAnchor(groups, current) {
  const medians = new Map();
  for (const group of groups) {
    if (group.memberIds.some((id) => !current.has(id))) throw new Error(`Current rank roster is missing a traded member of ${group.id}`);
    const inputs = group.memberIds.map((id) => current.get(id)).filter(finite);
    const median = quantile(inputs, 0.5);
    if (group.medianRS !== median || group.rankedCount !== inputs.length) {
      throw new Error(`Current RS inputs disagree with the stored group median for ${group.id}`);
    }
    medians.set(group.id, median);
  }
  const ranks = mediansByLevel(groups, (group) => medians.get(group.id));
  for (const group of groups) {
    const rank = ranks.get(group.id);
    if (group.rank !== (rank?.rank ?? null) || group.percentile !== (rank?.percentile ?? null)) {
      throw new Error(`Current RS inputs disagree with the stored group rank for ${group.id}`);
    }
  }
}

function horizonComparisons(groups, current, past, priorDate) {
  const rows = groups.map(({ id, level, memberIds }) => {
    const usablePast = past?.state === 'ready';
    let currentFiniteMembers = 0;
    let priorFiniteMembers = 0;
    const currentPairs = [];
    const priorPairs = [];
    for (const security of memberIds) {
      const here = current.get(security);
      const before = past?.percentiles?.get(security);
      if (finite(here)) currentFiniteMembers++;
      if (finite(before)) priorFiniteMembers++;
      if (finite(here) && finite(before)) {
        currentPairs.push(here);
        priorPairs.push(before);
      }
    }
    const matchedMembers = usablePast ? currentPairs.length : null;
    const pairedCoverage = usablePast && memberIds.length ? matchedMembers / memberIds.length : null;
    const reason = !usablePast ? past?.reason ?? 'rank_date_unprepared'
      : matchedMembers < groupVelocityPolicy.minimumMembers || pairedCoverage < groupVelocityPolicy.minimumPairedCoverage ? 'insufficient_member_coverage' : null;
    return { id, level, priorDate, matchedMembers, pairedCoverage, currentFiniteMembers,
      priorFiniteMembers: usablePast ? priorFiniteMembers : null, reason,
      currentMedian: quantile(currentPairs, 0.5), priorMedian: quantile(priorPairs, 0.5) };
  });
  const eligible = rows.filter((row) => !row.reason);
  const counts = new Map(groupLevels.map((level) => [level, eligible.filter((row) => row.level === level).length]));
  const nowRanks = mediansByLevel(eligible, ({ currentMedian }) => currentMedian);
  const pastRanks = mediansByLevel(eligible, ({ priorMedian }) => priorMedian);
  return new Map(rows.map(({ id, level, currentMedian, priorMedian, reason, ...countsAtDates }) => {
    const peerCount = counts.get(level);
    const unavailable = reason ?? (peerCount < groupVelocityPolicy.minimumPeers ? 'insufficient_peers' : null);
    const here = !unavailable ? { medianRS: currentMedian, ...nowRanks.get(id) } : null;
    const before = !unavailable ? { medianRS: priorMedian, ...pastRanks.get(id) } : null;
    return [id, { ...countsAtDates, state: unavailable ? 'unavailable' : 'ready', reason: unavailable,
      peerCount, current: here, prior: before, ...(countsAtDates.matchedMembers === 1 && { thinSample: true }),
      velocity: here ? here.percentile - before.percentile : null,
      rankChange: here ? before.rank - here.rank : null }];
  }));
}

export function projectGroupMembershipVelocity(inputGroups, evidence, anchorDate, comparisonDates = groupComparisonDates(anchorDate)) {
  const groups = normalizeGroups(inputGroups);
  const current = evidence.get(anchorDate)?.percentiles;
  if (!(current instanceof Map)) throw new Error('Exact current archived RS evidence is required');
  validateAnchor(groups, current);
  const eligibleGroups = groups.map((group) => ({ ...group, memberIds: group.memberIds.filter((id) => finite(current.get(id))) }));
  const comparisons = Object.fromEntries(Object.entries(comparisonDates).map(([period, date]) =>
    [period, horizonComparisons(eligibleGroups, current, evidence.get(date), date)]));
  const entries = groups.map(({ id, memberIds }, index) => {
    const four = comparisons['4w'].get(id);
    const twelve = comparisons['12w'].get(id);
    const cohortCount = eligibleGroups[index].memberIds.length;
    const tradedRosterCount = memberIds.length;
    return { id, basis: groupMembershipBasis, cohortCount, tradedRosterCount,
      representativeness: tradedRosterCount ? cohortCount / tradedRosterCount : null,
      velocity4w: four.velocity, velocity12w: twelve.velocity, rankChange4w: four.rankChange, rankChange12w: twelve.rankChange,
      horizons: { '4w': four, '12w': twelve } };
  });
  return { groups: entries, rosterHash: rosterDigest(groups), eligibleCohortHash: rosterDigest(eligibleGroups) };
}

function unprepared(config, reason = 'projection_not_prepared') {
  return { ...pointMetadata(config), classificationCaptureDate: null, state: 'unprepared', reason, groups: [] };
}

function metadata(projection) {
  const { groups: _groups, ...summary } = projection;
  return summary;
}

export function readGroupMembershipVelocity(db, config) {
  if (!isCurrentGroupMembership(config)) return null;
  if (!present(db)) return unprepared(config);
  const row = db.prepare(`SELECT sha256,payload FROM prepared_current_group_velocity WHERE ${keyWhere}`).get(...keyFor(config));
  if (!row) return unprepared(config);
  try {
    const result = decodeStoredJson(row.payload);
    if (digest(JSON.stringify(result)) !== row.sha256 || !Array.isArray(result.groups) ||
        result.anchorDate !== config.date || result.dataVersion !== config.dataVersion ||
        result.observedReferenceDate !== config.observedReferenceDate || result.projectionVersion !== GROUP_VELOCITY_VERSION) {
      return unprepared(config, 'projection_invalid');
    }
    return result;
  } catch {
    return unprepared(config, 'projection_invalid');
  }
}

export function attachGroupMembershipVelocity(db, config, snapshot) {
  const prepared = readGroupMembershipVelocity(db, config);
  if (!prepared) return snapshot;
  const fallback = !prepared.classificationCaptureDate ? { classificationCaptureDate: classifiedCaptureDate(db, config) } : {};
  if (!prepared.groups.length || !snapshot.groups?.length) {
    return { ...snapshot, groupMembershipProjection: { ...metadata(prepared), ...fallback } };
  }
  // Thin historical archives do not retain member IDs. Their scoped group IDs
  // still have to agree with the stored roster, and available rosters must hash exactly.
  const values = new Map(prepared.groups.map(({ id, ...row }) => [id, row]));
  const mismatch = snapshot.groups.length !== values.size || snapshot.groups.some(({ id, count }) => values.get(id)?.tradedRosterCount !== count) ||
    snapshot.groups.every((group) => Array.isArray(group.memberIds)) && rosterDigest(normalizeGroups(snapshot.groups)) !== prepared.rosterHash;
  if (mismatch) {
    return { ...snapshot, groupMembershipProjection: { ...metadata(unprepared(config, 'roster_mismatch')), ...fallback } };
  }
  return { ...snapshot, groupMembershipProjection: metadata(prepared),
    groups: snapshot.groups.map((group) => ({ ...group, currentMembership: values.get(group.id) })) };
}

export function prepareGroupMembershipVelocity(db, engine, config, { force = false, rankCache = new Map(), witnessCache = new Map() } = {}) {
  if (!isCurrentGroupMembership(config)) return null;
  const prior = !force && readGroupMembershipVelocity(db, config);
  if (prior?.state === 'ready') return { ...metadata(prior), reused: true };
  const snapshot = readPreparedSnapshot(db, engine, config, { securityIds: [] });
  const captureDate = classifiedCaptureDate(db, config);
  if (!snapshot?.groups?.length) return { ...metadata(unprepared(config, 'anchor_snapshot_unprepared')), classificationCaptureDate: captureDate };
  const point = pointMetadata(config);
  const dates = [config.date, ...Object.values(point.comparisonDates).filter(Boolean)];
  const witnesses = readPreparedSnapshotRankWitnesses(db, engine, config, dates, witnessCache);
  const evidence = readPreparedRankPercentiles(db, config, dates, witnesses, rankCache);
  if (evidence.get(config.date)?.state !== 'ready') {
    return { ...metadata(unprepared(config, evidence.get(config.date)?.reason)), classificationCaptureDate: captureDate };
  }
  const projection = projectGroupMembershipVelocity(snapshot.groups, evidence, config.date, point.comparisonDates);
  const rankSources = Object.fromEntries([...evidence].map(([date, { percentiles: _values, ...source }]) => [date, source]));
  const comparable = Object.fromEntries(Object.keys(periods).map((period) =>
    [period, projection.groups.filter((group) => group.horizons[period].state === 'ready').length]));
  const state = dates.length === 3 && dates.every((date) => evidence.get(date)?.state === 'ready') ? 'ready' : 'partial';
  const result = { ...point, classificationCaptureDate: captureDate, state, reason: null, rankSources,
    groupCount: projection.groups.length, comparable, ...projection };

  // Only the exact current source revision may publish an anchor projection.
  const nested = db.isTransaction;
  db.exec(nested ? 'SAVEPOINT store_group_membership_velocity' : 'BEGIN IMMEDIATE');
  try {
    if (dataVersion(db) !== config.dataVersion) throw new Error('Warehouse revision changed during group membership preparation');
    db.exec(schema);
    const json = JSON.stringify(result);
    db.prepare(`INSERT INTO prepared_current_group_velocity VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(projection_version,calculation_version,date,data_version,recipe)
      DO UPDATE SET sha256=excluded.sha256,payload=excluded.payload`)
      .run(...keyFor(config), digest(json), encodeStoredJson(result));
    const verified = readGroupMembershipVelocity(db, config);
    if (verified.state !== result.state || verified.rosterHash !== result.rosterHash ||
        verified.eligibleCohortHash !== result.eligibleCohortHash || verified.groups.length !== result.groupCount) {
      throw new Error('Stored group membership projection did not verify at its exact pin');
    }
    db.exec(nested ? 'RELEASE store_group_membership_velocity' : 'COMMIT');
    return { ...metadata(verified), reused: false };
  } catch (error) {
    db.exec(nested ? 'ROLLBACK TO store_group_membership_velocity; RELEASE store_group_membership_velocity' : 'ROLLBACK');
    throw error;
  }
}

export function prepareGroupMemberships(db, engine, contexts, options = {}) {
  const unique = new Map();
  const revision = dataVersion(db);
  for (const entry of contexts) {
    const config = entry.config ?? entry;
    if (entry.rank === false || config.dataVersion !== revision || !isCurrentGroupMembership(config)) continue;
    const key = JSON.stringify(keyFor(config));
    if (!unique.has(key)) unique.set(key, []);
    unique.get(key).push(config);
  }
  const shared = { ...options, rankCache: new Map(), witnessCache: new Map() };
  const details = [...unique.values()].map((alternatives) => {
    let best;
    for (const config of alternatives) {
      const result = prepareGroupMembershipVelocity(db, engine, config, shared);
      if (result.state === 'ready') return result;
      if (result.state === 'partial' || !best) best = result;
    }
    return best;
  });
  const ready = details.filter(({ state }) => state === 'ready').length;
  const partial = details.filter(({ state }) => state === 'partial').length;
  return { state: ready && ready === details.length ? 'ready' : ready || partial ? 'partial' : 'unprepared',
    prepared: ready + partial, scopes: details.length, ready, partial, results: details };
}
