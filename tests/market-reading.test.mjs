import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMarketReading, renderMarketReading } from '../frontend/market-reading.js';

const sample = (numerator, denominator) => ({ numerator, denominator, value: denominator ? 100 * numerator / denominator : null });
const date = '2026-11-20';

test('uses prepared comparable counts, available leadership, and existing constituent actions', () => {
  const snapshot = {
    date, universe: { name: 'US Core' }, coverage: { state: 'partial', traded: 250 },
    health: { score: null },
    breadth: { above_50d: sample(90, 125), above_200d: sample(65, 100), advancers: sample(110, 200), decliners: sample(83, 200),
      positive_21d: sample(125, 185), positive_63d: sample(100, 160) },
    aggregates: { upDollar: 3_000_000, downDollar: 2_000_000, dollarVolumeObservations: 194 },
    leaders: [{ symbol: 'TWO', rsRank: 2 }, { symbol: 'ONE', securityId: 'equity:1', rsRank: 1, rsPercentile: 100 }],
    groups: [{ level: 'sector', name: 'Energy', medianRS: 99, rankedCount: 4 },
      { level: 'industry', name: 'Semiconductors', medianRS: 76, rankedCount: 12 }],
  };
  const reading = buildMarketReading(snapshot);
  assert.equal(reading.date, date);
  assert.deepEqual(reading.participation.map(({ numerator, denominator, label }) => [numerator, denominator, label]),
    [[90, 125, 'broad'], [65, 100, 'broad']]);
  assert.deepEqual(reading.daily, { key: 'adSpread', advancers: 110, decliners: 83, denominator: 200, value: 13.5, direction: 1 });
  assert.equal(reading.dollars.ratio, 1.5);
  assert.equal(reading.leader.symbol, 'ONE');
  assert.equal(reading.industry.name, 'Semiconductors');
  const html = renderMarketReading(snapshot);
  for (const key of ['above_50d', 'above_200d', 'adSpread', 'positive_21d', 'positive_63d']) {
    assert.ok(html.includes(`data-action="breadth" data-value="${key}"`));
  }
  assert.match(html, /Nov 20, 2026 · US Core · Observed stocks/);
  assert.match(html, /125 of 185 comparable/);
  assert.match(html, /110 advanced · 83 declined/);
  assert.match(html, /\+13\.5 pp/);
  assert.match(html, /1\.50×/);
  assert.match(html, /\$3,000,000\.00 up · \$2,000,000\.00 down/);
  assert.match(html, /data-action="stock" data-value="equity:1"/);
  assert.match(html, /Semiconductors had a median RS percentile of 76\.0 across 12 ranked stocks/);
  assert.doesNotMatch(html, /Energy|TWO|score|withheld/i);
});

test('distinguishes conflicting breadth and dollar volume and describes weak and mixed bands', () => {
  const snapshot = {
    date, coverage: { state: 'complete' },
    breadth: { above_50d: sample(40, 100), above_200d: sample(39, 100), advancers: sample(7, 20), decliners: sample(11, 20) },
    aggregates: { upDollar: 220, downDollar: 150, dollarVolumeObservations: 15 },
  };
  const html = renderMarketReading(snapshot);
  assert.match(html, /Verified coverage/);
  assert.match(html, /Intermediate participation was mixed and long-term participation was weak/);
  assert.match(html, /Decliners outnumbered advancers, while recorded dollar volume favored advancers/);
  assert.match(html, /Broad is 60% or higher, mixed is 40% to under 60%, and weak is below 40%/);
  assert.equal(buildMarketReading({ breadth: { above_50d: sample(3, 5) } }).participation[0].label, 'broad');
  assert.match(renderMarketReading({ ...snapshot, aggregates: { upDollar: 0, downDollar: 150, dollarVolumeObservations: 10 } }),
    /Decliners outnumbered advancers and recorded dollar volume favored decliners/);
});

test('omits unknown metrics and preserves a measured zero', () => {
  const noCoverage = { date, breadth: { above_50d: null, above_200d: sample(0, 0), positive_21d: { ...sample(0, 10), value: null },
    advancers: sample(5, 20), decliners: sample(6, 21) },
  aggregates: { upDollar: 0, downDollar: 0, dollarVolumeObservations: 0 }, leaders: null, groups: null };
  const html = renderMarketReading(noCoverage);
  assert.match(html, /No comparable market readings are available for this session/);
  assert.doesNotMatch(html, /0\.0%|data-action|dollar volume|NaN|undefined/);
  assert.match(renderMarketReading(null), /No comparable market readings/);
  const measuredZero = renderMarketReading({ date, breadth: { positive_21d: sample(0, 10) } });
  assert.match(measuredZero, /0\.0%/);
  assert.match(measuredZero, /0 of 10 comparable/);
  assert.doesNotMatch(measuredZero, /No comparable market readings/);
});

test('escapes snapshot content in labels, leadership text, and stock attributes', () => {
  const html = renderMarketReading({
    date, universe: { name: '<script>universe</script>' },
    leaders: [{ symbol: '<img src=x>', securityId: '" onload="bad', rsRank: 1 }],
    groups: [{ level: 'industry', name: '<svg onload=bad>', medianRS: 50, rankedCount: 1 }],
  });
  assert.match(html, /&lt;script&gt;universe&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(html, /data-value="&quot; onload=&quot;bad"/);
  assert.match(html, /&lt;svg onload=bad&gt;/);
  assert.doesNotMatch(html, /<(script|img|svg)\b|onload="bad/);
});
