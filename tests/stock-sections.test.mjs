import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { renderStockMovingAverages, renderStockVolumeWindows, stockMetricValue, stockSectionTabs } from '../frontend/stock-sections.js';

const text = (fragment, selector) => fragment.querySelector(selector)?.textContent.trim();

test('rolling volume compares supported windows with distinct values, scales, and U/D states', () => {
  const html = renderStockVolumeWindows({ avg_volume_10d: 1200, adv_10d: 62_000, rvol_10d: 1.25, udv_10d: 0,
    udv_obs_10d: 10, udv_state_20d: 'infinity', udv_obs_20d: 20, up_volume_10d: 0, up_volume_20d: 0.625,
    udv_obs_50d: 37, udv_state_50d: 'insufficient', float_turnover_10d: 0, float_turnover_20d: 0.51 });
  const view = JSDOM.fragment(html);
  assert.deepEqual([...view.querySelectorAll('thead th')].map((cell) => cell.textContent),
    ['Sessions', 'Avg share volume', 'Avg dollar volume', 'Relative volume', 'U/D share volume', 'Up-volume share', 'Float turnover']);
  assert.deepEqual([...view.querySelectorAll('th[scope="row"]')].map((cell) => cell.textContent), ['10D', '20D', '50D', '100D']);
  assert.equal(text(view, '[data-metric="avg_volume_10d"] strong'), '1.2K');
  assert.equal(text(view, '[data-metric="adv_10d"] strong'), '$62K');
  assert.equal(text(view, '[data-metric="rvol_10d"] strong'), '1.25×');
  assert.equal(text(view, '[data-metric="udv_10d"] strong'), '0.00×');
  assert.equal(text(view, '[data-metric="udv_20d"] strong'), '∞');
  assert.equal(text(view, '[data-metric="udv_50d"] strong'), '—');
  assert.equal(text(view, '[data-metric="udv_50d"] .muted'), '37 comparable');
  assert.equal(text(view, '[data-metric="up_volume_10d"] strong'), '0.00%');
  assert.equal(text(view, '[data-metric="up_volume_20d"] strong'), '62.50%');
  assert.equal(text(view, '[data-metric="float_turnover_10d"] strong'), '0.00%');
  assert.equal(text(view, '[data-metric="float_turnover_20d"] strong'), '51.00%');
  assert.equal(text(view, '[data-metric="float_turnover_50d"] strong'), '—');
});

test('omits unavailable float columns, keeps signed changes, and escapes metric text', () => {
  const html = renderStockVolumeWindows({ float_turnover_10d: null, float_turnover_20d: null });
  assert.doesNotMatch(html, /data-metric="float_turnover|<th[^>]*>Float turnover/);
  assert.equal((html.match(/No comparable window is available/g) || []).length, 1);
  assert.equal(stockMetricValue('up_frequency_20d', { up_frequency_20d: 0.65 }), '65.00%');
  assert.match(stockMetricValue('upVolumeShareChange4w', { upVolumeShareChange4w: 0.075 }), /\+7\.50%/);
  assert.equal(stockMetricValue('marketCapBucket', { marketCapBucket: '<img src=x onerror=bad()>' }), '&lt;img src=x onerror=bad()&gt;');
  assert.match(stockMetricValue('up_frequency_20d', { up_frequency_20d: null }), /—/);
});

test('price trends keep SMA and EMA in distinct columns and tabs retain an explicit active state', () => {
  const view = JSDOM.fragment(renderStockMovingAverages({ sma_20d: 18, ema_20d: 19, above_20d: false, vs_sma_20d: 0,
    slope_ema_20d: 0.044 }));
  assert.deepEqual([...view.querySelectorAll('th[scope="row"]')].map((cell) => cell.textContent), ['10D', '20D', '50D', '100D', '150D', '200D']);
  assert.equal(text(view, '[data-metric="sma_20d"] strong'), '$18.00');
  assert.equal(text(view, '[data-metric="ema_20d"] strong'), '$19.00');
  assert.equal(text(view, '[data-metric="above_20d"] strong'), 'No');
  assert.equal(text(view, '[data-metric="vs_sma_20d"] strong'), '0.00%');
  assert.equal(text(view, '[data-metric="vs_ema_20d"] strong'), '—');
  assert.equal(text(view, '[data-metric="slope_ema_20d"] strong'), '+4.40%');
  const tabs = JSDOM.fragment(stockSectionTabs('volume'));
  assert.deepEqual([...tabs.querySelectorAll('button')].map((button) => button.textContent),
    ['Last session', 'Price & trend', 'Volume & participation', 'Liquidity & fundamentals', 'All metrics']);
  assert.deepEqual([...tabs.querySelectorAll('[aria-pressed="true"]')].map((button) => button.dataset.value), ['volume']);
});
