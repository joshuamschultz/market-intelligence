// Saved queries use already prepared same-session fields. They do not register
// calculation requirements. Keep eligibility structural and fail closed: the
// marker alone never exempts a definition from preparation or readiness checks.
import { AVERAGES, DEFAULT_WINDOWS } from './metrics.mjs';

export const PREPARED_QUERY_MODE = 'prepared-query-v1';
export const PREPARED_QUERY_FIELDS = [
  'securityId', 'symbol', 'name', 'exchange', 'type', 'sector', 'industry', 'industryId', 'subindustry', 'traded', 'close', 'open', 'high', 'low',
  'volume', 'dollarVolume', 'market_cap', 'float', 'shares', 'floatDate', 'floatKnownAt', 'sharesDate', 'sharesKnownAt', 'return_1d', 'return_5d', 'return_10d', 'return_20d', 'return_21d',
  'return_42d', 'return_63d', 'return_126d', 'return_252d', 'relative_return_21d', 'distance_high_252d', 'adv_20d', 'rvol_20d', 'udv_50d',
  'udv_state_50d', 'rsScore', 'rsRank', 'rsPercentile', 'velocity4w', 'velocity12w', 'rankChange4w', 'rankChange12w', 'industryRS',
  'industryBreadth', 'industryVelocity', 'above_20d', 'above_50d', 'above_100d', 'above_200d', 'new_high_20d', 'new_low_20d', 'new_high_252d',
  'new_low_252d', 'ma_50_above_200', 'ma_rising_50', 'ma_rising_200', 'ma_aligned', 'obv_slope', 'marketCapBucket',
];
const fields = new Set(PREPARED_QUERY_FIELDS);
const keys = ['preparationMode', 'dateMode', 'context', 'filter', 'sort', 'columns', 'search', 'includeUntraded'];
const object = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, allowed, required = allowed) => object(value)
  && Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
const scalar = (value) => value === null || typeof value === 'boolean'
  || typeof value === 'string' && value.length <= 180 || typeof value === 'number' && Number.isFinite(value);
const ops = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'between', 'missing', 'present', 'true', 'false'];
const rule = (value) => {
  if (!exact(value, ['field', 'op', 'value'], ['field', 'op']) || !fields.has(value.field) || !ops.includes(value.op)) return false;
  const operand = value.value;
  if (['missing', 'present', 'true', 'false'].includes(value.op)) return operand == null;
  if (!Object.hasOwn(value, 'value')) return false;
  if (value.op === 'in') return Array.isArray(operand) && operand.length > 0 && operand.length <= 30 && operand.every(scalar);
  if (value.op === 'between') return Array.isArray(operand) && operand.length === 2 && operand.every(scalar);
  if (value.op === 'contains') return typeof operand === 'string' && operand.length > 0 && operand.length <= 180;
  return scalar(operand);
};

export function isPreparedQueryScreen(definition) {
  if (!exact(definition, keys) || definition.preparationMode !== PREPARED_QUERY_MODE || definition.dateMode !== 'latest'
      || !exact(definition.context, []) || typeof definition.includeUntraded !== 'boolean'
      || typeof definition.search !== 'string' || definition.search.length > 100
      || !Array.isArray(definition.columns) || definition.columns.length > 20 || !definition.columns.every((key) => fields.has(key))
      || !Array.isArray(definition.sort) || definition.sort.length > 4 || !definition.sort.every((sort) =>
        exact(sort, ['field', 'direction']) && fields.has(sort.field) && ['asc', 'desc'].includes(sort.direction))) return false;
  const filter = definition.filter;
  if (filter !== null && (!exact(filter, ['operator', 'filters']) || !['and', 'or'].includes(filter.operator)
      || !Array.isArray(filter.filters) || filter.filters.length > 12 || !filter.filters.every(rule))) return false;
  // Legacy dependency scanners examine serialized values as well as field keys.
  // Reject values that would request extra history, even when supplied as text.
  const source = JSON.stringify(definition);
  if (/\bdistance_(?:all_time|loaded_history)_high\b|\brange_(?:distance|since|age)_(?:high|low)_\d+d\b/.test(source)) return false;
  for (const [pattern, builtIn] of [
    [/\breturn_(\d+)d\b/g, DEFAULT_WINDOWS],
    [/\b(?:ema|sma|vs_(?:ema|sma)|slope_(?:ema|sma)|above)_(\d+)d\b/g, AVERAGES],
    [/\b(?:obv_slope|udv|rvol|adv|avg_volume|float_turnover|up_volume)_(\d+)d\b/g, [1, 10, 20, 50, 100]],
  ]) if ([...source.matchAll(pattern)].some(([, period]) => !builtIn.includes(Number(period)))) return false;
  return true;
}

// An active alert depends on its screen's current definition. Such screens must
// remain calculation inputs, including changes after an alert was published.
export function independentPreparedQueryScreens(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='workspace'").get()) return new Map();
  const rows = db.prepare(`SELECT a.kind,a.id,a.version,a.definition FROM workspace a
    WHERE a.kind IN ('screen','alert-rule') AND a.deleted=0
      AND a.version=(SELECT max(b.version) FROM workspace b WHERE b.kind=a.kind AND b.id=a.id)` ).all();
  const references = new Set();
  const screens = [];
  for (const row of rows) {
    let definition;
    try { definition = JSON.parse(row.definition); } catch { return new Map(); }
    if (row.kind === 'screen') screens.push({ id: row.id, version: row.version, definition });
    else if (definition?.type === 'screen' && definition.active !== false) references.add(definition.screenId);
  }
  return new Map(screens.filter(({ id, definition }) => !references.has(id) && isPreparedQueryScreen(definition)).map(({ id, version }) => [id, version]));
}
