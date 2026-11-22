import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { reusableArchiveVersions } from './archive-lineage.mjs';
import { expectedSessions, shiftDate } from './calendar.mjs';
import { CALCULATION_VERSION, qualityOverrides } from './database.mjs';
import { readMaterializedHistory } from './materialization.mjs';
import { finite, mean, prepareBars, splitFactorBetween } from './metrics.mjs';
import { decodeStoredJson, encodeStoredJson } from './storage-codec.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
export const TIMING_MODEL_VERSION = `timing-1-${digest(Buffer.concat([
  readFileSync(new URL(import.meta.url)), Buffer.from(CALCULATION_VERSION),
])).slice(0, 12)}`;
export const TIMING_BASIS = 'reconstructed';
export const TIMING_INSTRUMENTS = Object.freeze({
  SPY: { id: 'eodhd:SPY', label: 'S&P 500 ETF proxy', type: 'etf', volume: 'ETF share volume' },
  QQQ: { id: 'eodhd:QQQ', label: 'Nasdaq-100 ETF proxy', type: 'etf', volume: 'ETF share volume' },
  IXIC: { id: 'eodhd:IXIC', label: 'Nasdaq Composite index', type: 'index', volume: 'Reported index volume' },
});
export const TIMING_PROFILE = Object.freeze({
  label: 'Session timing rules · 2024 follow-through profile',
  followThrough: { minimumRallyDay: 4, minimumReturn: 0.0125, volume: 'strictly higher than the previous market session' },
  distribution: { maximumReturn: -0.002, sessions: 25, recovery: 0.05, constructiveMinimumComparisons: 20,
    volume: 'strictly higher than the previous market session' },
  trend: { ema: 21, sma: [20, 50, 150, 200], slopeSessions: 5, shortWeakSessions: 2, pressureCount: 4 },
  strongTrend: { lowAboveEmaSessions: 10, emaAboveSmaSessions: 5, closeReturnMinimum: 0 },
  breadth: { universe: 'us-core', model: 'composite', benchmark: 'SPY', reference: 'as-of', minimumObservations: 20, observationShare: 0.8 },
  leadership: { sessions: 5, minimumCohortCoverage: 0.8 },
  posture: { benchmarks: ['SPY', 'IXIC'], personalTradeFeedback: 'unknown' },
  references: [
    { label: 'Follow-through threshold and timing', url: 'https://marketsurge-files.investors.com/2024/02/StockGuide-Q1-2024.pdf#page=18' },
    { label: 'Distribution price and volume conditions', url: 'https://shop.investors.com/Images/promotional/Wizards-QA.pdf' },
    { label: 'Moving-average trend exit', url: 'https://marketsurge-files.investors.com/2024/07/StockGuide-Mid-year-2024.pdf#page=17' },
  ],
});

const { followThrough, distribution, trend, strongTrend, breadth: breadthRules, leadership: leadershipRules, posture } = TIMING_PROFILE;
const symbols = Object.keys(TIMING_INSTRUMENTS);
const epsilon = 1e-12;
const availablePrice = (bar) => bar?.close > 0 && bar?.low > 0 && !bar.priceQuarantined && !bar.unverifiedSplit;
const pctChange = (close, previous) => close > 0 && previous > 0 ? close / previous - 1 : null;
const signedSide = (price, average) => !finite(average) ? null : price >= average ? 'above' : 'below';
const labelForGap = (bar) => bar?.priceQuarantined ? 'price-quarantined' : bar?.unverifiedSplit ? 'unverified-split' : 'missing-price';

function initialState() {
  return { phase: 'unknown', correction: null, rally: null, confirmation: null, strong: false,
    bars: [], averages: {}, slopes: {}, counts: {}, previousClose: null, previousVolume: null, previousSource: null,
    active: [], observations: [] };
}

function rebase(state, factor) {
  if (!(factor > 0) || factor === 1) return;
  const price = (value) => value == null ? value : value / factor;
  state.previousClose = price(state.previousClose);
  if (state.previousVolume != null) state.previousVolume *= factor;
  state.bars = state.bars.map((close) => close / factor);
  state.averages = Object.fromEntries(Object.entries(state.averages).map(([key, value]) => [key, price(value)]));
  for (const history of Object.values(state.slopes)) {
    for (let index = 0; index < history.length; index++) history[index] = price(history[index]);
  }
  if (state.correction) state.correction = { ...state.correction, low: price(state.correction.low) };
  if (state.rally) state.rally = { ...state.rally, low: price(state.rally.low) };
  if (state.confirmation) state.confirmation = { ...state.confirmation, low: price(state.confirmation.low) };
  state.active = state.active.map((event) => ({ ...event, comparisonClose: price(event.comparisonClose) }));
}

function updateTrend(state, bar, dayReturn, signals) {
  const { close, low } = bar;
  const previous = state.averages;
  state.bars.push(close);
  if (state.bars.length > Math.max(...trend.sma)) state.bars.shift();
  const averages = Object.fromEntries(trend.sma.map((length) => [`sma${length}`,
    state.bars.length >= length ? mean(state.bars.slice(-length)) : null]));
  averages.ema21 = finite(previous.ema21) ? previous.ema21 + (close - previous.ema21) * 2 / (trend.ema + 1)
    : state.bars.length >= trend.ema ? mean(state.bars.slice(-trend.ema)) : null;
  const slopes = {};
  for (const [key, value] of Object.entries(averages)) {
    const history = state.slopes[key] ??= [];
    const prior = history[0];
    slopes[key] = history.length === trend.slopeSessions && finite(value) && finite(prior) ? pctChange(value, prior) : null;
    history.push(value);
    if (history.length > trend.slopeSessions) history.shift();
  }
  const support = {};
  for (const key of ['sma20', 'sma50', 'ema21']) {
    const side = signedSide(close, averages[key]);
    const priorSide = signedSide(state.previousClose, previous[key]);
    const days = side ? (side === priorSide ? state.counts[key] || 0 : 0) + 1 : 0;
    state.counts[key] = days;
    support[key] = { side, days };
    if (key !== 'ema21' && side && priorSide && side !== priorSide) {
      signals.push({ type: side === 'above' ? 'support-reclaim' : 'support-break', average: key, close, value: averages[key] });
    }
  }
  const lowAbove = finite(averages.ema21) && low > averages.ema21;
  const emaAbove = finite(averages.ema21) && finite(averages.sma50) && averages.ema21 > averages.sma50;
  state.counts.lowAboveEma = lowAbove ? (state.counts.lowAboveEma || 0) + 1 : 0;
  state.counts.emaAboveSma = emaAbove ? (state.counts.emaAboveSma || 0) + 1 : 0;
  const checklist = {
    lowAboveEmaDays: state.counts.lowAboveEma, emaAboveSmaDays: state.counts.emaAboveSma,
    sma50Rising: finite(slopes.sma50) ? slopes.sma50 > 0 : null,
    nonnegativeCloseDay: finite(dayReturn) ? dayReturn >= strongTrend.closeReturnMinimum - epsilon : null,
  };
  if (state.strong && finite(averages.sma50) && averages.ema21 < averages.sma50) {
    state.strong = false;
    signals.push({ type: 'strong-trend-exit', ema21: averages.ema21, sma50: averages.sma50 });
  } else if (!state.strong && checklist.lowAboveEmaDays >= strongTrend.lowAboveEmaSessions &&
      checklist.emaAboveSmaDays >= strongTrend.emaAboveSmaSessions && checklist.sma50Rising && checklist.nonnegativeCloseDay) {
    state.strong = true;
    signals.push({ type: 'strong-trend-entry', ...checklist });
  }
  const trendState = !finite(averages.sma200) || !finite(slopes.sma200) ? 'warming-up'
    : close >= averages.sma50 && averages.sma50 > averages.sma150 && averages.sma150 > averages.sma200 && slopes.sma200 > 0 ? 'rising'
    : close < averages.sma50 && averages.sma50 < averages.sma150 && averages.sma150 < averages.sma200 && slopes.sma200 < 0 ? 'falling' : 'mixed';
  state.averages = averages;
  return { averages, slopes, support, state: trendState, strongTrend: { active: state.strong, ...checklist } };
}

function startCorrection(state, date, low, reason, signals) {
  state.phase = 'correction';
  state.correction = { since: date, low, lowDate: date, reason };
  state.rally = null;
  state.confirmation = null;
  signals.push({ type: 'correction-start', low, reason });
}

function updateRally(state, date, position, bar, evidence, trendResult, signals) {
  const { low, close } = bar;
  const { dayReturn, higherVolume } = evidence;
  const existingRally = state.rally;
  const existingConfirmation = state.confirmation;
  if (existingRally && low < existingRally.low) {
    signals.push({ type: 'rally-low-break', low, rallyLow: existingRally.low, rallyDate: existingRally.start, failedAttempt: true });
  }
  if (existingConfirmation && low < existingConfirmation.low) {
    signals.push({ type: 'follow-through-low-break', low, followThroughLow: existingConfirmation.low,
      followThroughDate: existingConfirmation.date, failedAttempt: true });
  }
  if ((existingRally && low < existingRally.low) || (existingConfirmation && low < existingConfirmation.low)) {
    startCorrection(state, date, low, existingRally && low < existingRally.low ? 'rally-low-break' : 'follow-through-low-break', signals);
    return null;
  }
  const { averages, support } = trendResult;
  const freshWeakness = support.sma20.days === trend.shortWeakSessions || support.sma50.days === 1;
  if ((['unknown', 'baseline'].includes(state.phase) || state.phase === 'confirmed' && freshWeakness) && support.sma20.side === 'below' &&
      support.sma20.days >= trend.shortWeakSessions && support.sma50.side === 'below') {
    startCorrection(state, date, low, 'below-20-and-50-session-support', signals);
    return null;
  }
  if (state.phase === 'unknown' && close > averages.sma50 && finite(averages.sma50) && averages.sma20 >= averages.sma50) {
    state.phase = 'baseline';
  }
  if (state.phase === 'correction') {
    if (low < state.correction.low) state.correction = { ...state.correction, low, lowDate: date };
    if (dayReturn > epsilon) {
      state.phase = 'rally';
      state.rally = { start: date, position, low: state.correction.low, lowDate: state.correction.lowDate };
      signals.push({ type: 'rally-start', low: state.rally.low, lowDate: state.rally.lowDate, return: dayReturn });
    }
  }
  if (!state.rally) return null;
  const day = position - state.rally.position + 1;
  const priceQualified = day >= followThrough.minimumRallyDay && dayReturn != null && dayReturn >= followThrough.minimumReturn - epsilon;
  const qualification = { day, priceQualified, rallyLowIntact: true, ...evidence };
  if (!priceQualified) return qualification;
  if (higherVolume !== true) {
    signals.push({ type: 'follow-through-candidate', ...qualification, reason: higherVolume == null ? 'volume-unavailable' : 'volume-not-higher' });
    return qualification;
  }
  const subsequent = state.phase === 'confirmed';
  if (!subsequent) state.confirmation = { date, low, close };
  state.phase = 'confirmed';
  signals.push({ type: subsequent ? 'subsequent-follow-through' : 'follow-through', ...qualification, low, close });
  return qualification;
}

function updateDistribution(state, date, position, close, evidence, signals) {
  const expired = [];
  state.active = state.active.filter((entry) => {
    const age = position - entry.position;
    const reason = age >= distribution.sessions ? 'session-window'
      : close > 0 && close >= entry.comparisonClose * (1 + distribution.recovery) * (1 - epsilon) ? 'price-recovery' : null;
    if (reason) expired.push({ ...entry, age, expiredOn: date, expiryReason: reason, expiryClose: close });
    return !reason;
  });
  if (evidence.higherVolume === true && evidence.dayReturn != null && evidence.dayReturn <= distribution.maximumReturn + epsilon) {
    const event = { date, position, close, comparisonClose: close, return: evidence.dayReturn, volume: evidence.volume,
      previousVolume: evidence.previousVolume, previousClose: evidence.previousClose };
    state.active.push(event);
    signals.push({ type: 'distribution', ...event });
  }
  return { active: state.active.map((entry) => ({ ...entry, age: position - entry.position })), expired,
    count: state.active.length, comparableSessions: state.observations.filter(Boolean).length, expectedSessions: distribution.sessions };
}

function instrumentSession(state, date, position, bar) {
  rebase(state, bar?.splitFactor);
  const signals = [];
  const usablePrice = availablePrice(bar);
  const previousClose = state.previousClose;
  const previousVolume = state.previousVolume;
  const dayReturn = usablePrice ? pctChange(bar.close, previousClose) : null;
  const volume = usablePrice && bar.volume > 0 && !bar.volumeQuarantined ? bar.volume : null;
  const source = usablePrice ? bar.source ?? null : null;
  const higherVolume = dayReturn == null || volume == null || previousVolume == null || source !== state.previousSource
    ? null : volume > previousVolume;
  const evidence = { dayReturn, volume, previousClose, previousVolume, higherVolume, source,
    volumeBasis: volume == null ? null : bar.volumeBasis ?? null };
  state.observations.push(higherVolume != null);
  if (state.observations.length > distribution.sessions) state.observations.shift();
  const supply = updateDistribution(state, date, position, usablePrice ? bar.close : null, evidence, signals);
  if (!usablePrice) {
    if (state.rally) signals.push({ type: 'rally-continuity-unknown', start: state.rally.start });
    const { active, observations } = state;
    Object.assign(state, initialState(), { active, observations });
    return { state: 'unavailable', reason: labelForGap(bar), phase: 'unknown', evidence, distribution: supply, signals };
  }
  const technical = updateTrend(state, bar, dayReturn, signals);
  const candidate = updateRally(state, date, position, bar, evidence, technical, signals);
  const pressure = [
    ...(supply.count >= trend.pressureCount ? ['elevated-distribution'] : []),
    ...(technical.support.ema21.side === 'below' && technical.support.ema21.days >= trend.shortWeakSessions &&
      ['baseline', 'confirmed'].includes(state.phase) ? ['below-ema21'] : []),
    ...(signals.some(({ failedAttempt }) => failedAttempt) ? ['failed-rally'] : []),
  ];
  state.previousClose = bar.close;
  state.previousVolume = volume;
  state.previousSource = source;
  return { state: 'observed', phase: state.phase, warmup: technical.state === 'warming-up' || state.phase === 'unknown',
    close: bar.close, low: bar.low, evidence, trend: technical, correction: state.correction, pressure,
    rally: state.rally && { start: state.rally.start, low: state.rally.low, lowDate: state.rally.lowDate, day: candidate.day },
    candidate, confirmation: state.confirmation, distribution: supply, signals };
}

const breadthKeys = ['above_20d', 'above_50d', 'above_200d', 'new_high_20d', 'new_low_20d', 'new_high_252d', 'new_low_252d',
  'high_volume_up', 'high_volume_down', 'breakout_20d'];
const validMetric = (metric, traded) => finite(metric?.value) && metric.denominator >= breadthRules.minimumObservations &&
  metric.denominator >= traded * breadthRules.observationShare;

function breadthEvidence(row) {
  if (!row) return { state: 'unavailable', reason: 'no-prepared-dated-breadth' };
  const traded = row.coverage?.traded ?? 0;
  const metrics = Object.fromEntries(breadthKeys.map((key) => [key, row.breadth?.[key] ?? null]));
  const comparability = Object.fromEntries(Object.entries(metrics).map(([key, metric]) => [key, {
    usable: validMetric(metric, traded), observations: metric?.denominator ?? 0,
    share: traded ? (metric?.denominator ?? 0) / traded : null,
  }]));
  const { above_20d: m20, above_50d: m50, above_200d: m200, new_high_20d: highs, new_low_20d: lows } = metrics;
  const shortKeys = ['above_20d', 'above_50d', 'new_high_20d', 'new_low_20d'];
  const shortComparable = shortKeys.every((key) => comparability[key].usable);
  const observations = row.aggregates?.volumeObservations ?? 0;
  const up = row.aggregates?.upVolume ?? null;
  const down = row.aggregates?.downVolume ?? null;
  const volumeBalance = observations >= breadthRules.minimumObservations && observations >= traded * breadthRules.observationShare && finite(up) && finite(down) && up + down > 0
    ? up > down ? 'up' : up < down ? 'down' : 'even' : 'unavailable';
  const supportive = shortComparable && comparability.above_200d.usable && [m20, m50, m200].every(({ value }) => value >= 50) &&
    highs.numerator > lows.numerator && ['up', 'even'].includes(volumeBalance);
  const weak = shortComparable && m20.value < 50 && m50.value < 50 && highs.numerator < lows.numerator;
  const state = supportive ? 'supportive' : weak ? 'weak' : shortComparable ? 'mixed' : 'insufficient';
  return { state, date: row.date, coverage: row.coverage?.state ?? null, traded, sourceDataVersion: row.sourceDataVersion ?? row.dataVersion,
    universe: row.universe?.id ?? breadthRules.universe, model: row.model?.id ?? breadthRules.model, classification: row.classificationSystem ?? null,
    referenceMode: row.referenceMode ?? 'as-of', metrics, comparability, volume: { observations, up, down, balance: volumeBalance } };
}

function leaderEvidence(rolling, previousDate, row) {
  const source = row?.aggregates;
  const expected = source?.leaderReturnExpected ?? null;
  const observations = source?.leaderReturnObservations ?? 0;
  const value = previousDate && source?.previousLeaderDate === previousDate && expected > 0 &&
    observations / expected >= leadershipRules.minimumCohortCoverage && finite(source.leaderReturn) ? source.leaderReturn : null;
  const day = { date: row?.date ?? null, cohortDate: source?.previousLeaderDate ?? null, return: value, expected, observations,
    persistence: source?.leadershipPersistence ?? null };
  rolling.push(day);
  if (rolling.length > leadershipRules.sessions) rolling.shift();
  const comparable = rolling.filter((entry) => finite(entry.return)).length;
  return { state: comparable === leadershipRules.sessions ? 'available' : 'insufficient',
    method: 'Compounded daily response of each prior session’s top-decile cohort',
    return5d: comparable === leadershipRules.sessions ? rolling.reduce((gross, entry) => gross * (1 + entry.return), 1) - 1 : null,
    comparable, required: leadershipRules.sessions, day };
}

function riskEvidence(instruments, breadth, leadership) {
  const readings = posture.benchmarks.map((symbol) => [symbol, instruments[symbol]]);
  const known = readings.filter(([, row]) => row.state === 'observed' && row.phase !== 'unknown');
  const pressure = known.filter(([, row]) => row.pressure.length || row.phase === 'correction');
  const confirmed = known.filter(([, row]) => row.phase === 'confirmed');
  const trendSupport = confirmed.every(([, row]) => row.trend.support.sma50.side === 'above');
  const volumeSupport = readings.every(([, row]) => row.evidence.higherVolume != null &&
    row.distribution.comparableSessions >= distribution.constructiveMinimumComparisons);
  const leadersPositive = leadership.return5d == null ? null : leadership.return5d > 0;
  const evidence = { benchmarks: Object.fromEntries(readings.map(([symbol, row]) => [symbol,
    { phase: row.phase, pressure: row.pressure ?? [], observed: row.state === 'observed',
      currentVolumeComparable: row.evidence.higherVolume != null,
      distributionComparisons: row.distribution.comparableSessions }])), breadth: breadth.state, leadersPositive };
  const stage = !known.length ? 'unknown'
    : pressure.length ? known.length === readings.length && known.every(([, row]) => row.phase === 'correction') ? 'conservative' : 'pressure'
    : known.length === readings.length && confirmed.length === readings.length && trendSupport && volumeSupport &&
      breadth.state === 'supportive' && leadersPositive === true ? 'constructive'
    : known.some(([, row]) => ['rally', 'confirmed', 'baseline'].includes(row.phase)) ? 'test' : 'unknown';
  return { stage, evidence, personalTradeFeedback: 'unknown', conditions: {
    constructive: 'Both benchmarks confirmed and above the 50-session average with usable current volume and at least 20 volume comparisons in 25 sessions, supportive observed breadth and positive lagged leader response.',
    increaseRisk: 'Assess actual pilot outcomes before considering greater risk. Personal trade feedback is unavailable.',
    failure: 'Review a rally or follow-through low break, sustained short-term weakness, or elevated active distribution.',
  } };
}

export function replayMarketTiming(dates, barsByInstrument, breadthRows = new Map()) {
  const states = Object.fromEntries(symbols.map((symbol) => [symbol, initialState()]));
  const rollingLeaders = [];
  return dates.map((date, index) => {
    const instruments = Object.fromEntries(symbols.map((symbol) => [symbol,
      instrumentSession(states[symbol], date, index, barsByInstrument[symbol]?.get(date))]));
    const source = breadthRows.get(date);
    const breadth = breadthEvidence(source);
    const leadership = leaderEvidence(rollingLeaders, dates[index - 1], source);
    return { date, instruments, breadth, leadership, risk: riskEvidence(instruments, breadth, leadership) };
  });
}

function hasTimingStore(db) {
  return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='market_timing_manifests'").get();
}

function createTimingStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS market_timing_manifests (
    model_version TEXT NOT NULL, basis TEXT NOT NULL, data_version INTEGER NOT NULL, from_date TEXT NOT NULL,
    through_date TEXT NOT NULL, breadth_scope TEXT NOT NULL,
    PRIMARY KEY (model_version,basis,data_version)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS market_timing_values (
    hash TEXT PRIMARY KEY, value BLOB NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS market_timing_sessions (
    model_version TEXT NOT NULL, basis TEXT NOT NULL, data_version INTEGER NOT NULL, date TEXT NOT NULL, hash TEXT NOT NULL,
    PRIMARY KEY (model_version,basis,data_version,date), FOREIGN KEY (hash) REFERENCES market_timing_values(hash)
  ) WITHOUT ROWID`);
}

function canonicalInputs(db, config) {
  const bars = db.prepare(`SELECT * FROM price_revisions WHERE security_id=? AND version<=? AND date<=?
    ORDER BY date,version DESC`);
  const splits = db.prepare(`SELECT * FROM corporate_actions WHERE security_id=? AND version<=? AND type='split' ORDER BY date,version DESC`);
  const quality = qualityOverrides(db, { version: config.dataVersion });
  return Object.fromEntries(symbols.map((symbol) => {
    const { id } = TIMING_INSTRUMENTS[symbol];
    const raw = new Map();
    for (const row of bars.iterate(id, config.dataVersion, config.date)) {
      if (!raw.has(row.date)) raw.set(row.date, row);
    }
    const overrides = quality.filter((row) => row.security_id === id);
    const actions = new Map();
    for (const row of splits.iterate(id, config.dataVersion)) {
      if (!actions.has(row.date)) actions.set(row.date, row);
    }
    const splitQuarantined = (date) => overrides.some((row) => row.kind === 'split' && row.effective_from <= date && date <= row.effective_to);
    const verified = [...actions.values()].filter(({ date }) => !splitQuarantined(date));
    return [symbol, { raw, verified, overrides, splitQuarantined }];
  }));
}

function canonicalBars(input, dates) {
  return Object.fromEntries(symbols.map((symbol) => {
    const { raw, verified, overrides, splitQuarantined } = input[symbol];
    const map = new Map();
    let previous = null;
    for (const date of dates) {
      const row = raw.get(date);
      const pair = previous && row ? [previous, row] : row ? [row] : [];
      // A same-session anchor matches the warehouse's split basis without
      // rewriting an earlier output when a later split becomes effective.
      const bar = prepareBars(pair, verified, date, { overrides }).at(-1);
      const splitFactor = splitFactorBetween(verified, shiftDate(date, -1), date);
      if (bar || splitFactor !== 1) map.set(date, { ...bar, splitFactor, unverifiedSplit: bar?.unverifiedSplit || splitQuarantined(date) });
      previous = row;
    }
    return [symbol, map];
  }));
}

function breadthConfig(db, engine, config) {
  const availableSec = db.prepare(`SELECT 1 FROM classifications WHERE system='sec-sic' AND industry IS NOT NULL
    AND version<=? LIMIT 1`).get(config.dataVersion);
  return engine.context({ ...breadthRules, date: config.date, dataVersion: config.dataVersion,
    basis: TIMING_BASIS, classification: availableSec ? 'sec-sic' : 'provider' });
}

function timingManifest(db, config, earlier = false) {
  if (!hasTimingStore(db)) return null;
  return db.prepare(`SELECT * FROM market_timing_manifests WHERE model_version=? AND basis=? AND data_version${earlier ? '<' : '='}?
    ORDER BY data_version DESC LIMIT 1`).get(TIMING_MODEL_VERSION, config.basis, config.dataVersion);
}

function presentTimingSession(db, config) {
  return db.prepare(`SELECT 1 FROM market_timing_sessions s JOIN market_timing_values v ON v.hash=s.hash
    WHERE s.model_version=? AND s.basis=? AND s.data_version=? AND s.date=?`)
    .get(TIMING_MODEL_VERSION, config.basis, config.dataVersion, config.date);
}

function reuseThrough(db, config, previous, first, scope) {
  if (!previous || previous.from_date !== first || previous.breadth_scope !== scope) return null;
  const lineage = reusableArchiveVersions(db, { ...config, referenceMode: 'as-of' }, [previous.data_version]);
  if (!lineage.has(previous.data_version)) return null;
  const impact = lineage.get(previous.data_version);
  return (!impact || impact > previous.through_date) && previous.through_date <= config.date ? previous.through_date : null;
}

export function prepareMarketTiming(db, engine, config, { force = false } = {}) {
  const point = { date: config.date, dataVersion: config.dataVersion, basis: config.basis, modelVersion: TIMING_MODEL_VERSION };
  if (!config.date || config.basis !== TIMING_BASIS) return { ...point, state: 'unavailable', written: 0 };
  const existing = timingManifest(db, config);
  const covered = existing?.through_date >= config.date;
  const repair = covered && config.date >= existing.from_date && !presentTimingSession(db, config);
  if (covered && !force && !repair) return config.date >= existing.from_date ? { ...point, state: 'ready', written: 0, reused: true }
    : { ...point, state: 'unavailable', written: 0 };
  if (repair && existing.through_date > config.date) throw new Error(`Rebuild session review with --force through ${existing.through_date} to repair the missing session`);
  if (force && existing?.through_date > config.date) throw new RangeError('Refresh through the latest prepared session to preserve the full review history');
  // Rebuild the three small benchmark tapes when no compatible checkpoint is
  // available. Prepared participation is read from the existing archive only.
  const inputs = canonicalInputs(db, config);
  const first = Object.values(inputs).map(({ raw }) => raw.keys().next().value).filter(Boolean).sort()[0];
  if (!first) return { ...point, state: 'unavailable', written: 0 };
  const dates = expectedSessions(first, config.date);
  const source = breadthConfig(db, engine, config);
  const scope = digest(JSON.stringify([source.universe.id, source.universe.version, source.model.id, source.model.version, engine.definitionKey(source)]));
  const prior = existing ?? timingManifest(db, config, true);
  const reuse = force || repair ? null : existing?.breadth_scope === scope && existing.from_date === first ? existing.through_date
    : reuseThrough(db, config, prior, first, scope);
  const firstWrite = reuse ? dates.findIndex((date) => date > reuse) : 0;
  // A previous warehouse version can cover the exact same ending date.
  const offset = firstWrite < 0 ? dates.length : firstWrite;
  const from = dates[Math.max(0, offset - leadershipRules.sessions)];
  const lens = offset === dates.length ? [] : readMaterializedHistory(db, engine, source, { from, limit: 7560 }).rows;
  const rows = replayMarketTiming(dates, canonicalBars(inputs, dates), new Map(lens.map((row) => [row.date, row]))).slice(offset);
  createTimingStore(db);
  const keys = [TIMING_MODEL_VERSION, config.basis, config.dataVersion];
  const nested = db.isTransaction;
  db.exec(nested ? 'SAVEPOINT prepare_market_timing' : 'BEGIN IMMEDIATE');
  try {
    if (!force && timingManifest(db, config)?.through_date >= config.date && presentTimingSession(db, config)) {
      db.exec(nested ? 'RELEASE prepare_market_timing' : 'COMMIT');
      return { ...point, state: 'ready', written: 0, reused: true };
    }
    if (reuse && prior.data_version !== config.dataVersion) db.prepare(`INSERT OR IGNORE INTO market_timing_sessions
      SELECT model_version,basis,?,date,hash FROM market_timing_sessions WHERE model_version=? AND basis=? AND data_version=? AND date<=?`)
      .run(config.dataVersion, TIMING_MODEL_VERSION, config.basis, prior.data_version, reuse);
    const putValue = db.prepare('INSERT OR IGNORE INTO market_timing_values VALUES (?,?)');
    const putSession = db.prepare(`INSERT INTO market_timing_sessions VALUES (?,?,?,?,?)
      ON CONFLICT(model_version,basis,data_version,date) DO UPDATE SET hash=excluded.hash`);
    for (const row of rows) {
      const json = JSON.stringify(row);
      const hash = digest(json);
      putValue.run(hash, encodeStoredJson(row));
      putSession.run(...keys, row.date, hash);
    }
    db.prepare(`INSERT INTO market_timing_manifests VALUES (?,?,?,?,?,?)
      ON CONFLICT(model_version,basis,data_version) DO UPDATE SET from_date=excluded.from_date,
        through_date=max(through_date,excluded.through_date),breadth_scope=excluded.breadth_scope`)
      .run(...keys, first, dates.at(-1), scope);
    db.exec(nested ? 'RELEASE prepare_market_timing' : 'COMMIT');
  } catch (error) {
    db.exec(nested ? 'ROLLBACK TO prepare_market_timing; RELEASE prepare_market_timing' : 'ROLLBACK');
    throw error;
  }
  return { ...point, state: 'ready', from: first, through: dates.at(-1), written: rows.length,
    reusedSessions: offset, breadthSessions: lens.length, breadthClassification: source.classification };
}

export function prepareDailyMarketTiming(db, engine, config) {
  const prepared = prepareMarketTiming(db, engine, config);
  if (prepared.state === 'unavailable') {
    const registered = db.prepare(`SELECT 1 FROM securities WHERE id IN (?,?,?) LIMIT 1`)
      .get(...symbols.map((symbol) => TIMING_INSTRUMENTS[symbol].id));
    if (!registered) return prepared;
  }
  const readback = readPreparedMarketTiming(db, config, { limit: 0 });
  if (readback.state !== 'ready' || readback.session?.date !== config.date || readback.dataVersion !== config.dataVersion ||
      readback.modelVersion !== TIMING_MODEL_VERSION) throw new Error('Missing exact prepared session review for daily publication');
  return { ...prepared, verified: true };
}

function historyRow(session) {
  return { date: session.date, risk: { stage: session.risk.stage }, instruments: Object.fromEntries(symbols.map((symbol) => {
    const { close, state, phase, trend: technical, evidence, signals, distribution: supply } = session.instruments[symbol];
    return [symbol, { close: close ?? null, state, phase, averages: technical?.averages ?? null, return: evidence.dayReturn,
      distribution: { count: supply.count, expired: supply.expired },
      signals: signals.filter(({ type }) => /^(follow-through|subsequent-follow-through|distribution|rally-low-break|follow-through-low-break)$/.test(type)) }];
  })) };
}

export function readPreparedMarketTiming(db, config, { limit = 252 } = {}) {
  const result = { date: config.date, requestedDate: config.requestedDate ?? config.date, dataVersion: config.dataVersion,
    basis: config.basis, modelVersion: TIMING_MODEL_VERSION, calculationVersion: CALCULATION_VERSION, profile: TIMING_PROFILE, instruments: TIMING_INSTRUMENTS,
    session: null, history: [] };
  if (!config.date || config.basis !== TIMING_BASIS) return { ...result, state: 'unavailable',
    reason: !config.date ? 'no-market-session' : 'unsupported-basis' };
  const manifest = timingManifest(db, config);
  if (!manifest || config.date > manifest.through_date) return { ...result, state: 'unprepared',
    reason: 'session-review-not-prepared', action: 'Run node scripts/market-timing.mjs prepare for the selected warehouse revision.' };
  if (config.date < manifest.from_date) return { ...result, state: 'unavailable', reason: 'before-benchmark-history' };
  const rows = db.prepare(`SELECT v.value FROM market_timing_sessions s JOIN market_timing_values v ON v.hash=s.hash
    WHERE s.model_version=? AND s.basis=? AND s.data_version=? AND s.date${limit ? '<=' : '='}? ORDER BY s.date DESC LIMIT ?`)
    .all(TIMING_MODEL_VERSION, config.basis, config.dataVersion, config.date, Math.max(1, limit)).map(({ value }) => decodeStoredJson(value));
  if (rows[0]?.date !== config.date) return { ...result, state: 'unprepared', reason: 'prepared-session-missing',
    action: 'Run node scripts/market-timing.mjs prepare --force for the selected warehouse revision.' };
  return { ...result, state: 'ready', session: rows[0], history: limit ? rows.reverse().map(historyRow) : [] };
}

export function marketTimingJournalContext(db, config) {
  const { session, history, profile, requestedDate, action, ...selection } = readPreparedMarketTiming(db, config, { limit: 0 });
  const { references, ...rules } = profile;
  return { ...selection, rules, session };
}
