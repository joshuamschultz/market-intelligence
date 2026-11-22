import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLeadershipMap, groupHeatmapMetrics, renderGroupHeatmap } from '../frontend/group-visuals.js';

const sector = (id, values) => ({ id, name: id, level: 'sector', ...values });
const industry = (id, values) => ({ id, name: id, level: 'industry', ...values });

test('heatmap renders pinned links, scales, dates, observed counts, and comparable breadth', () => {
  const rows = [sector('Technology', { above50: 75, count: 100, rankedCount: 85, counts: { above50: { numerator: 60, denominator: 80 } } }),
    sector('Materials', { above50: 0, count: 8, rankedCount: 0 }), industry('Other level', { above50: 100 })];
  const options = { level: 'sector', metric: 'above50', date: '2026-11-20', contextLabel: 'US Core · Nasdaq',
    routeUrl: ({ id, level }) => `#industries?level=${level}&date=2026-11-20&dataVersion=42&group=${encodeURIComponent(id)}`, action: 'industry' };
  assert.deepEqual(groupHeatmapMetrics.map(([key]) => key), ['medianRS', 'equalWeight', 'velocity4w', 'above50']);
  const html = renderGroupHeatmap(rows, options);
  assert.match(html, /Sectors by above 50d sma/i);
  assert.match(html, /Nov 20, 2026 · US Core · Nasdaq · 2 of 2 groups with a value/);
  assert.match(html, /#industries\?level=sector&amp;date=2026-11-20&amp;dataVersion=42&amp;group=Technology/);
  assert.match(html, /Technology · Above 50D SMA 75\.0% · 100 traded · 85 ranked · 60 of 80 comparable/);
  assert.match(html, /Materials · Above 50D SMA 0\.0% · 8 traded · 0 ranked/);
  assert.match(html, /0\.0%<\/span>.*50\.0%<\/span>.*100\.0%<\/span>/);
  assert.doesNotMatch(html, /Other level|data-action="industry"/);
});

test('signed colors use actual units, preserve extremes, and mark invalid or absent data as unavailable', () => {
  const rows = [industry('Largest drawdown', { equalWeight: -0.2, velocity4w: -100 }),
    industry('Surge', { equalWeight: 4.2, velocity4w: 100 }), industry('Flat', { equalWeight: 0, velocity4w: 0 }),
    industry('Missing', { equalWeight: null, velocity4w: 101 })];
  const result = renderGroupHeatmap(rows, { metric: 'equalWeight' });
  assert.match(result, /3 of 4 groups with a value/);
  assert.match(result, /-420\.00%<\/span>.*0\.00%<\/span>.*\+420\.00%<\/span>/);
  assert.match(result, /Largest drawdown<\/span><strong>-20\.00%<\/strong>/);
  assert.match(result, /Surge<\/span><strong>\+420\.00%<\/strong>/);
  assert.match(result, /--group-heatmap-color:rgb\(30, 39, 45\)"><span class="group-heatmap-name">Missing<\/span><strong>Unavailable<\/strong>/);
  const velocities = renderGroupHeatmap(rows, { metric: 'velocity4w', action: 'industry' });
  assert.match(velocities, /3 of 4 groups with a value/);
  assert.match(velocities, /-100\.0 pts<\/span>.*0\.0 pts<\/span>.*\+100\.0 pts<\/span>/);
  assert.match(velocities, /<button type="button"[^>]+data-action="industry" data-value="Missing" aria-label="Missing · 4W RS velocity Unavailable"/);
  assert.doesNotMatch(velocities, /101\.0 pts/);
  const withReason = renderGroupHeatmap([rows.at(-1)], { metric: 'velocity4w',
    unavailableReason: 'Historical Nasdaq classifications are unavailable for this lookback.' });
  assert.match(withReason, /0 of 1 groups with a value/);
  assert.match(withReason, /Historical Nasdaq classifications are unavailable/);
  assert.match(renderGroupHeatmap([], { metric: 'velocity4w' }), /No prepared groups for the selected context/);
});

test('heatmap escapes labels and accepts only local link targets', () => {
  const rows = [industry('" onclick="bad', { name: '<img src=x>', medianRS: 67 })];
  for (const target of ['javascript:alert(1)', '//example.com/', '/\\example.com/', ' /index.html']) {
    const html = renderGroupHeatmap(rows, { routeUrl: () => target, action: 'industry', contextLabel: '<script>context</script>' });
    assert.match(html, /&lt;script&gt;context&lt;\/script&gt;/);
    assert.match(html, /data-value="&quot; onclick=&quot;bad"/);
    assert.match(html, /&lt;img src=x&gt;/);
    assert.doesNotMatch(html, / href=|<script|<img|onclick="bad/);
  }
  const escapedRoute = renderGroupHeatmap(rows, { routeUrl: () => '#industries?group="x"', action: 'bad action' });
  assert.match(escapedRoute, /href="#industries\?group=&quot;x&quot;"/);
  assert.doesNotMatch(escapedRoute, /data-action/);
});

test('RS map uses group percentile and separates flat velocity from missing history', () => {
  const rows = [sector('Rising high', { percentile: 50, velocity4w: 10, velocity12w: null }),
    sector('Falling high', { percentile: 80, velocity4w: -12, velocity12w: 1 }),
    sector('Rising low', { percentile: 20, velocity4w: 3, velocity12w: -1 }),
    sector('Falling low', { percentile: 0, velocity4w: -100, velocity12w: -4 }),
    sector('Flat', { percentile: 100, velocity4w: 0, velocity12w: 0 }), sector('Unknown velocity', { percentile: 41, velocity4w: null }),
    sector('Unknown group rank', { medianRS: 91, velocity4w: 7 }), industry('Other level', { percentile: 99, velocity4w: 5 })];
  const map = buildLeadershipMap(rows, { level: 'sector' });
  assert.deepEqual(map.points, rows.slice(0, 5));
  assert.equal(map.total, 7);
  assert.equal(map.plotted, 5);
  assert.equal(map.omitted, 2);
  assert.deepEqual(map.quadrants, { higherRSRising: 1, higherRSFalling: 1, lowerRSRising: 1, lowerRSFalling: 1, flat: 1 });
  const twelveWeeks = buildLeadershipMap(rows, { level: 'sector', velocity: 'velocity12w' });
  assert.equal(twelveWeeks.velocity, 'velocity12w');
  assert.equal(twelveWeeks.plotted, 4);
  assert.equal(twelveWeeks.omitted, 3);
  assert.equal(twelveWeeks.quadrants.lowerRSFalling, 2);
});
