import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { analysisWorkspaceScopeHash } from '../backend/analysis-readiness.mjs';
import { dataVersion, importDataset, openDatabase, storeWorkspace } from '../backend/database.mjs';
import { createEngine } from '../backend/engine.mjs';
import { independentPreparedQueryScreens, isPreparedQueryScreen, PREPARED_QUERY_MODE } from '../backend/prepared-query-screen.mjs';
import { rangeWindowsForScreen } from '../backend/range-metrics.mjs';
import { preparationWorkspaceScopes, screenDataNeeds } from '../backend/service.mjs';

const query = () => ({ preparationMode: PREPARED_QUERY_MODE, dateMode: 'latest', context: {},
  filter: { operator: 'and', filters: [{ field: 'rsPercentile', op: 'gte', value: 98 }, { field: 'return_63d', op: 'gt', value: 0 }] },
  sort: [{ field: 'rsRank', direction: 'asc' }], columns: ['symbol', 'rsPercentile', 'velocity4w'], search: '', includeUntraded: false });
const save = (db, definition, id = 'leaders') => storeWorkspace(db, 'screen', { name: 'Leaders', definition }, id);

test('prepared-query eligibility excludes calculation dependencies and rejects marker-only or malformed records', () => {
  assert.equal(isPreparedQueryScreen(query()), true);
  for (const alteration of [
    { preparationMode: undefined }, { context: { universe: 'new-universe' } }, { dateMode: 'fixed' }, { computed: [] },
    { rankingPeriod: '3m' }, { rangeWindows: [73] }, { groupBy: 'industry' }, { unknown: true },
    { filter: { expression: 'previous(close, 1) > close' } },
    ...[{ field: 'rsRank', op: 'between' }, { field: 'rsRank', op: 'between', value: [1, 2, 3] },
      { field: 'rsRank', op: 'in', value: 1 }, { field: 'rsRank', op: 'eq' }, { field: 'range_since_high_20d', op: 'gte', value: 30 },
      { field: 'return_777d', op: 'gt', value: 0 }, { field: 'close', op: 'gt', value: Infinity }]
      .map((rule) => ({ filter: { operator: 'and', filters: [rule] } })),
    ...['return_777d', 'distance_all_time_high', 'distance_loaded_history_high', 'range_distance_high_73d',
      'above_73d', 'rvol_73d', 'slope_sma_73d'].flatMap((text) => [
      { search: text }, { filter: { operator: 'and', filters: [{ field: 'name', op: 'eq', value: text }] } },
    ]),
  ]) assert.equal(isPreparedQueryScreen({ ...query(), ...alteration }), false, JSON.stringify(alteration));
  assert.deepEqual(screenDataNeeds(query()), {});
  assert.deepEqual(rangeWindowsForScreen(query()), []);
});

test('independent saved queries leave the legacy scope hash intact; edits and active alerts retain dependencies', (t) => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const before = analysisWorkspaceScopeHash(db);
  assert.equal(before, createHash('sha256').update(JSON.stringify(['analysis-scope-1', [], []])).digest('hex'));
  const saved = save(db, query());
  assert.equal(independentPreparedQueryScreens(db).get(saved.id), saved.version);
  assert.equal(analysisWorkspaceScopeHash(db), before);
  const revised = save(db, { ...query(), search: 'energy' });
  assert.equal(independentPreparedQueryScreens(db).get(saved.id), revised.version);
  assert.equal(analysisWorkspaceScopeHash(db), before);
  const alert = (active) => storeWorkspace(db, 'alert-rule', { name: 'Alert', definition: { type: 'screen', screenId: saved.id, active } }, 'alert');
  alert(false);
  assert.equal(analysisWorkspaceScopeHash(db), before);
  alert(true);
  assert.equal(independentPreparedQueryScreens(db).has(saved.id), false);
  const alertScope = analysisWorkspaceScopeHash(db);
  save(db, { ...query(), search: 'different' });
  assert.notEqual(analysisWorkspaceScopeHash(db), alertScope);
  alert(false);
  assert.equal(analysisWorkspaceScopeHash(db), before);
  save(db, { ...query(), computed: [{ field: 'custom_lag', expression: 'previous(close, 20)' }] });
  assert.equal(independentPreparedQueryScreens(db).has(saved.id), false);
  assert.notEqual(analysisWorkspaceScopeHash(db), before);
});

test('saved queries preserve exact preparation inputs and raw revision; ordinary custom screens still extend the plan', (t) => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const { version } = importDataset(db, { provider: 'fixture', securities: [{ symbol: 'ALFA', name: 'ALFA', type: 'common', exchange: 'NYSE' }],
    prices: [{ symbol: 'ALFA', date: '2026-11-20', open: 10, high: 11, low: 9, close: 10, volume: 1000 }] });
  const engine = createEngine(db);
  const options = { date: '2026-11-20', version };
  const before = preparationWorkspaceScopes(db, engine, options);
  save(db, query());
  assert.deepEqual(preparationWorkspaceScopes(db, engine, options), before);
  assert.equal(dataVersion(db), version);
  save(db, { ...query(), context: { windows: [73] }, filter: { field: 'return_73d', op: 'gte', value: 0 } });
  assert.notDeepEqual(preparationWorkspaceScopes(db, engine, options).custom, before.custom);
});
