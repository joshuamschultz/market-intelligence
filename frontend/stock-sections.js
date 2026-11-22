import { cellValue, count, numeric, panelHead, rate, safe, segment } from './ui.js';

export const stockSections = [
  ['session', 'Last session'], ['price', 'Price & trend'], ['volume', 'Volume & participation'],
  ['liquidity', 'Liquidity & fundamentals'], ['all', 'All metrics'],
];
export const stockVolumePeriods = [10, 20, 50, 100];
const averagePeriods = [10, 20, 50, 100, 150, 200];

export function stockSectionTabs(selected) {
  return `<div role="group" aria-label="Ticker analysis sections">${segment('stock-section', stockSections, selected, 'tabs stock-section-tabs')}</div>`;
}

export function stockMetricValue(id, row, computed = []) {
  if (id === 'up_frequency_20d' || /^(?:up_volume|float_turnover)_\d+d$/.test(id)) {
    return numeric(row[id]) ? rate(row[id], 2, false) : '<span class="quiet">—</span>';
  }
  return cellValue(id, row, computed);
}

const volumeColumns = [
  ['Avg share volume', 'avg_volume', 'compact'], ['Avg dollar volume', 'adv', 'compactMoney'], ['Relative volume', 'rvol', 'ratio'],
  ['U/D share volume', 'udv', 'ratio'], ['Up-volume share', 'up_volume', 'rate'],
];
const volumeFields = stockVolumePeriods.flatMap((period) => volumeColumns.map(([label, field, format]) =>
  ({ field: `${field}_${period}d`, label, format })));
const averageColumns = [
  ['SMA', 'sma'], ['Price vs SMA', 'vs_sma'], ['SMA 5D change', 'slope_sma'], ['Above SMA', 'above'],
  ['EMA', 'ema'], ['Price vs EMA', 'vs_ema'], ['EMA 5D change', 'slope_ema'],
];

function periodTable(label, row, periods, columns, computed) {
  return `<div class="table-scroll stock-period-table" role="region" aria-label="${safe(label)}" tabindex="0"><table aria-label="${safe(label)}">
    <thead><tr><th scope="col">Sessions</th>${columns.map(([title]) => `<th scope="col">${safe(title)}</th>`).join('')}</tr></thead>
    <tbody>${periods.map((period) => `<tr><th scope="row">${period}D</th>${columns.map(([, field]) => {
      const id = `${field}_${period}d`;
      const observed = field === 'udv' ? row[`udv_obs_${period}d`] : null;
      return `<td class="numeric" data-metric="${id}"><strong>${stockMetricValue(id, row, computed)}</strong>${numeric(observed)
        ? `<div class="muted">${count(observed)} comparable</div>` : ''}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div>`;
}

export function renderStockVolumeWindows(row) {
  const hasTurnover = stockVolumePeriods.some((period) => numeric(row[`float_turnover_${period}d`]));
  const columns = hasTurnover ? [...volumeColumns, ['Float turnover', 'float_turnover']] : volumeColumns;
  const floatNote = hasTurnover ? '' : '<p class="muted section-space">Rolling float turnover requires dated public float and volume throughout each window. No comparable window is available.</p>';
  return `<section class="panel panel-body">
    ${panelHead('Rolling volume', 'Average volume includes the selected session. Relative volume compares that session with the preceding window.')}
    ${periodTable('Rolling volume by session window', row, stockVolumePeriods, columns, volumeFields)}
    <details class="section-space"><summary>Volume definitions</summary>
      <p class="muted">U/D divides advancing share volume by declining share volume. Up-volume share divides advancing share volume by the sum of advancing and declining share volume. Float turnover sums daily share volume divided by dated public float.</p></details>
    ${floatNote}
  </section>`;
}

export function renderStockMovingAverages(row) {
  return `<section class="panel panel-body">
    ${panelHead('Moving averages', 'Split-adjusted prices. Each change compares the average with its value five market sessions earlier.')}
    ${periodTable('Moving averages by session window', row, averagePeriods, averageColumns, [])}
  </section>`;
}
