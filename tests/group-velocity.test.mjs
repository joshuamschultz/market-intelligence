import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateGroups } from '../backend/breadth.mjs';
import { groupComparisonDates, projectGroupMembershipVelocity } from '../backend/group-velocity.mjs';

const anchor = '2025-05-14';
const dates = groupComparisonDates(anchor);
function inputs() {
  const values = [0, 10, 20, 30, 100, 50, 75, 90];
  const stock = values.map((rsPercentile, i) => ({ securityId: String.fromCharCode(97 + i), rsPercentile,
    sector: i < 5 ? 'Sector 1' : 'Sector 2', industry: i < 5 ? 'Alpha' : ['Beta', 'Gamma', 'Delta'][i - 5] }));
  const groups = calculateGroups(stock, [], anchor, 0);
  const ranked = (values) => ({ state: 'ready', percentiles: new Map(values.flatMap((x, i) =>
    x == null ? [] : [[stock[i].securityId, x]])) });
  return { groups, evidence: new Map([
    [anchor, ranked(values)], [dates['4w'], ranked([90, 80, 70, 60, null, 40, 10, null])],
    [dates['12w'], ranked([80, 80, 0, null, null, 50, 50, 0])],
  ]) };
}

test('the four and twelve week anchors use exchange week endings, including a holiday Friday', () => {
  assert.deepEqual(dates, { '4w': '2025-04-17', '12w': '2025-02-21' });
});

test('uses the identical member intersection and peer panels for each horizon independently', () => {
  const { groups, evidence } = inputs();
  const initial = JSON.stringify(groups);
  const projection = projectGroupMembershipVelocity(groups, evidence, anchor);
  const by = (name) => projection.groups.find(({ id }) => id.endsWith('/' + name));
  const alpha = by('Alpha');
  assert.equal(JSON.stringify(groups), initial);
  assert.equal(alpha.cohortCount, 5);
  assert.equal(alpha.velocity4w, -100);
  assert.equal(alpha.rankChange4w, -2);
  assert.deepEqual(alpha.horizons['4w'], { state: 'ready', reason: null, priorDate: dates['4w'],
    currentFiniteMembers: 5, priorFiniteMembers: 4, matchedMembers: 4, pairedCoverage: 0.8, peerCount: 3,
    current: { medianRS: 15, rank: 3, percentile: 0 }, prior: { medianRS: 75, rank: 1, percentile: 100 },
    velocity: -100, rankChange: -2 });
  assert.equal(alpha.velocity12w, null);
  assert.equal(alpha.horizons['12w'].matchedMembers, 3);
  assert.equal(alpha.horizons['12w'].reason, 'insufficient_member_coverage');
  assert.equal(by('Gamma').horizons['4w'].current.rank, 1);
  assert.equal(by('Gamma').horizons['12w'].current.rank, 2);
  assert.equal(by('Delta').horizons['4w'].reason, 'insufficient_member_coverage');
  assert.equal(by('Delta').horizons['12w'].prior.medianRS, 0, 'zero is a finite observation');
  assert.equal(by('Beta').horizons['12w'].prior.percentile, by('Gamma').horizons['12w'].prior.percentile, 'tied percentile');
  assert.notEqual(by('Beta').horizons['12w'].prior.rank, by('Gamma').horizons['12w'].prior.rank, 'stable ID breaks ordinal tie');
  const sector = projection.groups.find(({ id }) => id === 'sector:Sector 1');
  assert.equal(sector.horizons['4w'].reason, 'insufficient_peers');
});

test('rejects an inconsistent canonical median, rank or header roster; missing date stays missing', () => {
  const { groups, evidence } = inputs();
  const change = (fields) => [{ ...groups[0], ...fields }, ...groups.slice(1)];
  assert.throws(() => projectGroupMembershipVelocity(change({ rankedCount: -1 }), evidence, anchor), /median/);
  assert.throws(() => projectGroupMembershipVelocity(change({ rank: -1 }), evidence, anchor), /rank/);
  assert.throws(() => projectGroupMembershipVelocity(change({ memberIds: [] }), evidence, anchor), /roster/);
  evidence.set(dates['4w'], { state: 'unprepared', reason: 'rank_date_unprepared' });
  const result = projectGroupMembershipVelocity(groups, evidence, anchor);
  assert.ok(result.groups.every((group) => group.horizons['4w'].reason === 'rank_date_unprepared' && group.velocity4w === null));
  assert.ok(result.groups.some((group) => group.horizons['12w'].state === 'ready'));
});

test('current unranked members reduce representativeness but do not enter the frozen RS cohort', () => {
  const stocks = [
    { securityId: 'ranked-member', rsPercentile: 75, sector: 'Initial', industry: 'A' },
    { securityId: 'current-unranked', rsPercentile: null, sector: 'Initial', industry: 'A' },
    { securityId: 'peer', rsPercentile: 25, sector: 'Initial', industry: 'B' },
  ];
  const evidence = new Map([
    [anchor, { state: 'ready', percentiles: new Map(stocks.map(({ securityId, rsPercentile }) => [securityId, rsPercentile])) }],
    [dates['4w'], { state: 'ready', percentiles: new Map([['ranked-member', 25], ['current-unranked', 95], ['peer', 75]]) }],
    [dates['12w'], { state: 'ready', percentiles: new Map([['current-unranked', 99], ['peer', 75]]) }],
  ]);
  const result = projectGroupMembershipVelocity(calculateGroups(stocks, [], anchor, 0), evidence, anchor);
  const industry = result.groups.find(({ id }) => id.endsWith('/A'));
  assert.equal(industry.tradedRosterCount, 2);
  assert.equal(industry.cohortCount, 1);
  assert.equal(industry.representativeness, 0.5);
  assert.equal(industry.horizons['4w'].matchedMembers, 1);
  assert.equal(industry.horizons['4w'].priorFiniteMembers, 1);
  assert.equal(industry.horizons['4w'].pairedCoverage, 1);
  assert.equal(industry.horizons['4w'].thinSample, true);
  assert.equal(industry.horizons['4w'].prior.medianRS, 25);
  assert.equal(industry.velocity4w, 100);
  assert.equal(industry.horizons['12w'].reason, 'insufficient_member_coverage');
  assert.notEqual(result.eligibleCohortHash, result.rosterHash);
});
