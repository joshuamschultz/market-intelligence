import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { JSDOM } from 'jsdom';

const anchor = '2026-11-20';
const capture = '2026-11-22';
const dates = { '4w': '2026-10-23', '12w': '2026-08-28' };
const scope = { universe: 'us-core', universeVersion: 1, model: 'composite', modelVersion: 2, priceBasis: 'reconstructed',
  benchmark: 'SPY', classification: 'nasdaq', reference: 'latest' };
const projection = { basis: 'current-membership', state: 'partial', anchorDate: anchor, classificationCaptureDate: capture,
  observedReferenceDate: capture, comparisonDates: dates, dataVersion: 42, calculationVersion: 'rank-v1', projectionVersion: 'groups-v1', scope,
  policy: { minimumPairedCoverage: 0.8, minimumMembers: 1, minimumPeers: 2, coverageDenominator: 'current-ranked-members' } };
const base = { level: 'industry', count: 5, rankedCount: 5, velocity4w: null, velocity12w: null, rankChange4w: null, rankChange12w: null };
const horizon = (window, current, prior, matchedMembers = 4) => ({ state: 'ready', priorDate: dates[window], current, prior,
  matchedMembers, priorFiniteMembers: matchedMembers, currentFiniteMembers: 5, peerCount: 2, pairedCoverage: 0.8 });
const end = (medianRS, rank, percentile) => ({ medianRS, rank, percentile });
const matched4w = horizon('4w', end(70, 2, 35), end(60, 3, 15));
const matched12w = horizon('12w', end(76, 1, 80), end(72, 2, 70));
const unavailable = { state: 'unavailable', reason: 'insufficient_member_coverage', priorDate: dates['4w'], matchedMembers: 0,
  priorFiniteMembers: 0, currentFiniteMembers: 1, pairedCoverage: 0, peerCount: 2, current: null, prior: null };
const groups = [
  { ...base, id: 'alpha', name: 'Alpha', rank: 3, medianRS: 88, percentile: 90,
    currentMembership: { cohortCount: 5, tradedRosterCount: 5, representativeness: 1, velocity4w: 20, velocity12w: 10, rankChange4w: 1, rankChange12w: 1,
      horizons: { '4w': matched4w, '12w': matched12w } } },
  { ...base, id: 'beta', name: 'Beta', rank: 1, medianRS: 93, percentile: 100, count: 2, rankedCount: 1,
    currentMembership: { cohortCount: 1, tradedRosterCount: 2, representativeness: 0.5, velocity4w: 0, velocity12w: null, rankChange4w: 0, rankChange12w: null,
      horizons: { '4w': { ...horizon('4w', end(93, 1, 100), end(94, 1, 100), 1), currentFiniteMembers: 1, pairedCoverage: 1, thinSample: true },
        '12w': { ...unavailable, priorDate: dates['12w'], reason: 'rank_date_unprepared', matchedMembers: null, priorFiniteMembers: null } } } },
  { ...base, id: 'gamma', name: 'Gamma', rank: 2, medianRS: 91, percentile: 50, count: 10, rankedCount: 1,
    currentMembership: { cohortCount: 1, tradedRosterCount: 10, representativeness: 0.1, velocity4w: null, velocity12w: null, rankChange4w: null, rankChange12w: null,
      horizons: { '4w': unavailable, '12w': { ...unavailable, priorDate: dates['12w'] } } } },
];
const collection = { date: anchor, classificationSystem: 'nasdaq', referenceMode: 'latest', referenceDate: capture,
  coverage: { state: 'complete' }, groupMembershipProjection: projection, groups };

function useBrowser(t, { page = 'industries', data = collection, state = {}, params = {} } = {}) {
  const { window } = new JSDOM('<main></main><dialog></dialog>', { url: `http://localhost/#${page}` });
  const { document } = window;
  const main = document.querySelector('main');
  const detail = document.querySelector('dialog');
  const prior = globalThis.document;
  globalThis.document = document;
  t.after(() => { window.close(); if (prior === undefined) delete globalThis.document; else globalThis.document = prior; });
  const context = { ...scope, basis: scope.priceBasis, classification: data.classificationSystem, reference: data.referenceMode };
  const snapshotContext = { ...context, dataVersion: 42 };
  const controller = new AbortController();
  t.after(() => controller.abort());
  const calls = [];
  const seriesCalls = [];
  let actions;
  const env = { main, page, detail, state, params, context, snapshotContext, signal: controller.signal,
    config: { classificationSystems: ['nasdaq', 'sec-sic'] }, isActive: () => !controller.signal.aborted,
    setActions: (registered) => { actions = registered; }, replaceParams: (patch) => Object.assign(params, patch),
    routeUrl: (page, patch) => `#${page}?${new URLSearchParams(patch)}`,
    showDialog(dialog, _title, markup) { dialog.innerHTML = markup; dialog.open = true; return dialog; },
    async publishedSeries(path) { seriesCalls.push(path); return { rows: [] }; },
    async api(path, options) {
      calls.push({ path, options });
      if (path === 'industries') return data;
      if (path === 'themes') return [];
      if (path === 'industries/alpha') return data.groups[0];
      if (path === 'industries/alpha/members') return { rows: [], total: 0 };
      if (path === 'market/overview') return { date: anchor, dataVersion: 42, coverage: { state: 'complete', traded: 16, ranked: 7 },
        breadth: {}, aggregates: {}, model: { name: 'Composite' }, universe: { name: 'US Core' }, movers: { gainers: [], counts: { gainers: 0 } } };
      return { state: 'unprepared' };
    },
  };
  return { window, document, main, detail, env, calls, seriesCalls,
    choose: (action, value, input = null) => actions[action](value, input, { preventDefault() {} }) };
}

test('Industries uses current-member velocities consistently in heatmap, scatter, table, drawer, sorting, and CSV', async (t) => {
  const { window, document, main, detail, env, choose, calls, seriesCalls } = useBrowser(t, { state: { heatmapMetric: 'velocity4w' } });
  const { render } = await import('../frontend/research.js');
  await render(env);
  const selected = () => main.querySelector('[data-action="group-membership"][aria-pressed="true"]').textContent;
  const tile = (id) => main.querySelector(`.group-heatmap-tile[data-value="${id}"]`);
  assert.equal(selected(), 'Current members');
  assert.deepEqual([...main.querySelectorAll('.group-membership-dates time')].map((element) => element.dateTime), [capture, anchor, dates['4w'], dates['12w']]);
  assert.equal(tile('alpha').querySelector('strong').textContent, '+20.0 pts');
  assert.match(tile('alpha').title, /4 of 5 current-ranked members matched · 2 peer groups/);
  assert.match(tile('alpha').title, /Median constituent RS 60.0 → 70.0 · Peer rank 3 → 2/);
  assert.equal(tile('beta').querySelector('strong').textContent, '0.0 pts');
  assert.match(tile('beta').title, /1 of 1 current-ranked members matched.*1 of 2 traded members ranked at anchor \(50%\).*One-member comparison \(n=1\)/);
  assert.equal(tile('gamma').querySelector('strong').textContent, 'Unavailable');
  assert.match(tile('gamma').title, /0 of 1 current-ranked members matched.*1 of 10 traded members ranked at anchor.*Too few current-ranked members/);
  assert.notEqual(tile('alpha').style.getPropertyValue('--group-heatmap-color'), tile('gamma').style.getPropertyValue('--group-heatmap-color'));

  choose('group-view', 'velocity');
  const point = () => main.querySelector('.rotation-chart [data-value="alpha"]');
  assert.match(point().textContent, /4W matched-peer RS percentile 35 · 4W paired RS velocity \(pts\) \+20.0/);
  assert.equal(Number(point().querySelector('circle').getAttribute('cx')), 227.5);
  choose('leadership-window', 'velocity12w');
  assert.match(point().textContent, /12W matched-peer RS percentile 80 · 12W paired RS velocity \(pts\) \+10.0/);
  assert.equal(main.querySelector('.rotation-chart [data-value="beta"]'), null);

  choose('group-view', 'table');
  const grid = main.querySelector('table');
  const tableRows = () => [...main.querySelectorAll('.table-scroll tbody tr')];
  assert.match(grid.tHead.textContent, /Rank \(session\).*Median RS \(session\)/s);
  assert.deepEqual(tableRows().map((row) => row.cells[1].textContent), ['Beta', 'Gamma', 'Alpha']);
  choose('group-sort', 'velocity4w');
  assert.deepEqual(tableRows().map((row) => row.cells[1].textContent), ['Alpha', 'Beta', 'Gamma']);
  assert.deepEqual([...tableRows()[0].cells].slice(3, 9).map((cell) => cell.textContent), ['3', '88.0', '+1', '+1', '+20.0', '+10.0']);
  assert.match(main.querySelector('.rotation-chart [data-value="alpha"]').textContent, /4W matched-peer RS percentile 35/);
  assert.match(main.textContent, /Dated membership history/);

  const exports = [];
  const createObjectURL = URL.createObjectURL;
  const click = window.HTMLAnchorElement.prototype.click;
  URL.createObjectURL = (blob) => { exports.push(blob); return 'blob:http://localhost/test'; };
  window.HTMLAnchorElement.prototype.click = function () { assert.equal(this.download, 'industry-rankings.csv'); };
  t.after(() => { URL.createObjectURL = createObjectURL; window.HTMLAnchorElement.prototype.click = click; });
  const exportRows = async () => {
    choose('export-group-rankings');
    const [headers, ...rows] = (await exports.at(-1).text()).trim().split('\r\n').map((line) => line.slice(1, -1).split('","'));
    return rows.map((cells) => Object.fromEntries(headers.map((key, index) => [key, cells[index]])));
  };
  const [alpha, beta, excluded] = await exportRows();
  assert.deepEqual([alpha.membershipBasis, alpha.rank, alpha.medianRS, alpha.velocity4w, alpha.selectedVelocity4w, alpha.currentMatchedRank4w,
    alpha.currentMatchedPercentile12w, alpha.comparisonDate4w, alpha.projectionVersion, alpha.calculationVersion, alpha.universe, alpha.modelVersion],
  ['current-membership', '3', '88', '', '20', '2', '80', dates['4w'], 'groups-v1', 'rank-v1', 'us-core', '2']);
  assert.equal(beta.selectedVelocity4w, '0');
  assert.equal(beta.currentMembershipTradedRosterCount, '2');
  assert.equal(beta.currentMembershipRepresentativeness, '0.5');
  assert.equal(beta.thinSample4w, 'true');
  assert.equal(excluded.selectedVelocity4w, '');
  assert.equal(excluded.comparisonReason4w, 'insufficient_member_coverage');
  assert.equal(excluded.matchedMembers4w, '0');
  await choose('industry', 'alpha');
  assert.match(detail.textContent, /Median RS\s+88.0\s+Rank 3/);
  assert.match(detail.textContent, /4W RS velocity \+20.0 pts.*Peer rank 3 → 2/s);

  const compare = main.querySelector('[data-change="group-compare"][value="alpha"]');
  compare.checked = true;
  choose('change:group-compare', 'alpha', compare);
  await setImmediate();
  const chart = main.querySelector('#industry-chart');
  choose('group-membership', 'dated');
  assert.equal(main.querySelector('#industry-chart'), chart);
  assert.deepEqual(seriesCalls, ['industries/compare']);
  assert.equal(document.activeElement.textContent, 'Dated membership');
  assert.equal(env.params.membership, 'dated');
  assert.equal(selected(), 'Dated membership');
  assert.match(main.textContent, /Dated Nasdaq ranks are unavailable/);
  assert.equal(main.querySelector('.rotation-chart'), null);
  const [datedAlpha] = await exportRows();
  assert.equal(datedAlpha.membershipBasis, 'dated-membership');
  assert.equal(datedAlpha.selectedVelocity4w, '');
  assert.equal(datedAlpha.currentMembershipVelocity4w, '20');
  choose('group-view', 'heatmap');
  assert.equal(tile('alpha').querySelector('strong').textContent, 'Unavailable');
  assert.deepEqual(calls.map(({ path }) => path), ['industries', 'themes', 'industries/alpha', 'industries/alpha/members']);
  assert.equal(groups[0].velocity4w, null);
});

test('An unprepared projection displays the missing archive reason and does not automatically change the basis', async (t) => {
  const { groups: _ignored, ...data } = collection;
  const { main, env, choose } = useBrowser(t, { data: { ...data, groupMembershipProjection: { ...projection, state: 'unprepared', reason: 'rank_witness_unprepared' },
    groups: groups.map(({ currentMembership: _comparison, ...group }) => group) }, state: { heatmapMetric: 'velocity4w' } });
  const { render } = await import('../frontend/research.js');
  await render(env);
  assert.equal(main.querySelector('[data-action="group-membership"][aria-pressed="true"]').textContent, 'Dated membership');
  choose('group-membership', 'current');
  assert.match(main.textContent, /The rank archive could not be verified/);
  assert.equal(main.querySelector('.group-heatmap-tile strong').textContent, 'Unavailable');
});

test('Overview heatmap selects the same basis and carries that choice into Industries routes', async (t) => {
  const { main, env, choose, calls, document } = useBrowser(t, { page: 'overview', state: { heatmapMetric: 'velocity4w', heatmapLevel: 'industry' } });
  const { render } = await import('../frontend/overview.js');
  await render(env);
  await setImmediate();
  const tile = () => main.querySelector('.group-heatmap-tile[href*="group=alpha"]');
  const membership = () => main.querySelector('[data-action="overview-group-membership"][aria-pressed="true"]');
  assert.equal(membership().textContent, 'Current members');
  assert.equal(tile().querySelector('strong').textContent, '+20.0 pts');
  assert.match(tile().getAttribute('href'), /date=2026-11-20.*membership=current/);
  assert.match(main.querySelector('[data-overview-group-view="velocity"]').href, /groupView=velocity&membership=current/);
  await choose('overview-group-membership', 'dated');
  assert.equal(membership().textContent, 'Dated membership');
  assert.equal(document.activeElement, membership());
  assert.equal(tile().querySelector('strong').textContent, 'Unavailable');
  assert.match(main.querySelector('[data-overview-group-view="table"]').href, /groupView=table&membership=dated/);
  assert.equal(calls.filter(({ path }) => path === 'industries').length, 1);
});
