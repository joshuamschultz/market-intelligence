import { compact, count, dateLabel, direction, money, number, numeric, rate, ratio, safe, signed } from './ui.js';

export const chartbookDefaultRange = 126;
export const chartbookLayers = [
  ['sma20', '20D SMA'], ['sma50', '50D SMA'], ['benchmark', 'SPY'], ['industry', 'Industry'], ['moves', '±4% moves'],
];

const chartWidth = 1080;
const chartHeight = 410;
const plot = { left: 60, right: 1060, top: 18, bottom: 354 };
const windows = [20, 50];
const threshold = .04 - 1e-12;
const positive = (value) => numeric(value) && value > 0;
const validDate = (date) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);

export function chartbookShortcut(event, dialogOpen = false) {
  if (dialogOpen || event.repeat || event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey ||
      event.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], dialog')) return null;
  const key = event.key?.toLowerCase();
  if (key === ' ' || event.code === 'Space') return event.shiftKey ? 'previous' : 'next';
  if (key === 'arrowleft') return 'previous';
  if (event.shiftKey) return null;
  return { b: 'bookmark', v: 'longer', m: 'three-months', n: 'note', escape: 'dismiss' }[key] || null;
}

function stockHistory(bars, date) {
  const sorted = (bars || []).filter((bar) => validDate(bar?.date) && (!date || bar.date <= date)).toSorted((a, b) => a.date.localeCompare(b.date));
  const closes = [];
  const sums = [0, 0];
  let consecutive = 0;
  return sorted.map((bar, index) => {
    const close = positive(bar.close) && bar.traded !== false && !bar.missing && !bar.unverifiedSplit && !bar.priceQuarantined ? bar.close : null;
    const value = { date: bar.date, close, volume: numeric(bar.volume) && !bar.volumeQuarantined ? bar.volume : null };
    closes.push(close);
    if (close == null) {
      consecutive = 0;
      sums.fill(0);
      return value;
    }
    if ([bar.open, bar.high, bar.low].every(positive) && bar.high >= Math.max(bar.open, close) && bar.low <= Math.min(bar.open, close)) {
      Object.assign(value, { open: bar.open, high: bar.high, low: bar.low });
    }
    consecutive++;
    windows.forEach((period, position) => {
      sums[position] += close - (consecutive > period ? closes[index - period] : 0);
      value[`sma${period}`] = consecutive >= period ? sums[position] / period : null;
    });
    const previous = closes[index - 1];
    value.change = positive(previous) ? close / previous - 1 : null;
    return value;
  });
}

export function buildChartbookPlot(bundle, sessions, layers) {
  const visible = stockHistory(bundle.chartBars, bundle.date).slice(-sessions);
  const first = visible.findIndex(({ close }) => positive(close));
  const last = visible.findLastIndex(({ close }) => positive(close));
  const rows = first < 0 ? [] : visible.slice(first, last + 1);
  const comparisons = [['benchmark', bundle.benchmark, 'close'], ['industry', bundle.industry, 'value']].map(([key, source, field]) => {
    const ready = source?.state == null || ['ready', 'partial'].includes(source.state);
    const values = new Map((ready ? source?.rows || [] : []).filter((row) => validDate(row?.date) && positive(row[field])).map((row) => [row.date, row[field]]));
    const usable = rows.filter((row) => positive(row.close) && values.has(row.date));
    return { key, source, values, usable, label: key === 'benchmark' ? source?.symbol || 'SPY' : source?.name || 'Industry' };
  });
  const enabled = comparisons.filter(({ key, usable }) => layers[key] && usable.length >= 2);
  const shared = enabled.length ? rows.find((row) => positive(row.close) && enabled.every(({ values }) => values.has(row.date))) : null;
  const anchor = shared || enabled[0]?.usable[0];
  for (const comparison of comparisons) {
    const { key, values, usable } = comparison;
    const base = anchor && values.get(anchor.date);
    comparison.shown = Boolean(layers[key] && base && usable.filter((row) => row.date >= anchor.date).length >= 2);
    if (!comparison.shown) continue;
    for (const row of rows) {
      if (row.date >= anchor.date && positive(row.close) && values.has(row.date)) row[key] = anchor.close * values.get(row.date) / base;
    }
  }
  return { rows, comparisons, anchor: anchor?.date || null };
}

const layerColor = { sma20: '#8cafac', sma50: '#97a5c7', benchmark: '#8ba8e8', industry: '#cfb78a' };

function lineMarkup(rows, key, x, y) {
  const segments = [];
  let segment = null;
  rows.forEach((row, index) => {
    if (!numeric(row[key])) {
      segment = null;
      return;
    }
    if (!segment) {
      segment = [];
      segments.push(segment);
    }
    segment.push([x(index), y(row[key])]);
  });
  return segments.map((points) => points.length === 1
    ? `<circle cx="${points[0][0]}" cy="${points[0][1]}" r="1.4" fill="${layerColor[key]}"/>`
    : `<path d="${points.map(([px, py], index) => `${index ? 'L' : 'M'}${px} ${py}`).join(' ')}" fill="none" stroke="${layerColor[key]}"
      stroke-width="${key.startsWith('sma') ? 1.15 : 1.45}" opacity=".74"${key === 'industry' ? ' stroke-dasharray="5 2"' : ''} vector-effect="non-scaling-stroke"/>`).join('');
}

export function renderChartbookChart(data, layers, symbol) {
  const { rows, comparisons, anchor } = data;
  const lanes = ['sma20', 'sma50', 'benchmark', 'industry'].filter((key) => layers[key]);
  const prices = rows.flatMap((row) => [row.low, row.high, row.close, ...lanes.map((key) => row[key])]).filter(positive);
  if (!prices.length) return { html: '', rows };
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const padding = Math.max((max - min) * .07, Math.abs(max) * .008, .00001);
  const lower = Math.max(0, min - padding);
  const upper = max + padding;
  const snap = (value) => Number(value.toFixed(2));
  const x = (index) => snap(plot.left + (plot.right - plot.left) * (index + .5) / rows.length);
  const y = (value) => snap(plot.bottom - (plot.bottom - plot.top) * (value - lower) / (upper - lower));
  const body = Math.min(15, Math.max(.55, (plot.right - plot.left) * .58 / rows.length));
  const grid = Array.from({ length: 5 }, (_, index) => lower + (upper - lower) * index / 4).map((value) =>
    `<line x1="${plot.left}" x2="${plot.right}" y1="${y(value)}" y2="${y(value)}"/><text x="${plot.left - 7}" y="${y(value) + 3}" text-anchor="end">${safe(value < .01 ? number(value, 4) : number(value, 2))}</text>`).join('');
  const preparedCandles = rows.map((row, index) => {
    if (!positive(row.open)) return '';
    const px = x(index);
    const open = y(row.open);
    const close = y(row.close);
    return `<g class="chartbook-candle ${row.close >= row.open ? 'rising' : 'falling'}"><line x1="${px}" x2="${px}" y1="${y(row.high)}" y2="${y(row.low)}" vector-effect="non-scaling-stroke"/>
      <rect x="${px - body / 2}" y="${Math.min(open, close)}" width="${body}" height="${Math.max(1, Math.abs(open - close))}"/></g>`;
  }).join('');
  const closes = rows.map((row, index) => positive(row.close) && !positive(row.open)
    ? `<circle class="chartbook-close-mark" cx="${x(index)}" cy="${y(row.close)}" r="1.5"/>` : '').join('');
  const dates = [...new Set([0, .2, .4, .6, .8, 1].map((value) => Math.round(value * (rows.length - 1))))];
  const sameYear = rows[0].date.slice(0, 4) === rows.at(-1).date.slice(0, 4);
  const labels = dates.map((index) => `<text x="${x(index)}" y="396" text-anchor="${index === 0 ? 'start' : index === rows.length - 1 ? 'end' : 'middle'}">${safe(dateLabel(rows[index].date, sameYear))}</text>`).join('');
  const markers = layers.moves ? rows.map((row, index) => numeric(row.change) && Math.abs(row.change) >= threshold
    ? `<circle class="chartbook-move ${row.change > 0 ? 'rising' : 'falling'}" cx="${x(index)}" cy="373" r="2"/>` : '').join('') : '';
  const title = `${symbol} candlestick chart. Use Up and Down Arrow or Home and End to inspect sessions.`;
  return { rows, x, comparisons, anchor, html: `<div class="chartbook-plot" data-chartbook-plot>
    <svg viewBox="0 0 ${chartWidth} ${chartHeight}" preserveAspectRatio="none" role="img" tabindex="0" aria-label="${safe(title)}">
      <g class="chartbook-grid">${grid}<line x1="${plot.left}" x2="${plot.right}" y1="${plot.bottom}" y2="${plot.bottom}"/>${labels}</g>
      ${lanes.map((key) => lineMarkup(rows, key, x, y)).join('')}${preparedCandles}${closes}${markers}
      <line x1="0" x2="0" y1="${plot.top}" y2="${plot.bottom}" class="chartbook-crosshair" hidden/>
    </svg><div class="chartbook-point" data-chartbook-point role="status" aria-live="polite" hidden></div></div>` };
}

export function bindChartbookChart(container, chart) {
  if (!chart.html) return () => false;
  const svg = container.querySelector('[data-chartbook-plot] svg');
  const tooltip = container.querySelector('[data-chartbook-point]');
  const crosshair = svg.querySelector('.chartbook-crosshair');
  let index = -1;
  const hide = () => {
    if (index < 0) return false;
    index = -1;
    tooltip.hidden = true;
    crosshair.toggleAttribute('hidden', true);
    return true;
  };
  const show = (position) => {
    index = Math.max(0, Math.min(chart.rows.length - 1, position));
    const row = chart.rows[index];
    const px = chart.x(index);
    crosshair.setAttribute('x1', px);
    crosshair.setAttribute('x2', px);
    crosshair.removeAttribute('hidden');
    tooltip.hidden = false;
    tooltip.classList.toggle('chartbook-point-left', px > chartWidth / 2);
    tooltip.style.setProperty('--point-x', `${100 * px / chartWidth}%`);
    tooltip.innerHTML = `<strong>${safe(dateLabel(row.date))}</strong>${positive(row.close) ? `<span>Close ${money(row.close)}${numeric(row.change) ? ` · ${rate(row.change)}` : ''}</span>
      ${positive(row.open) ? `<span>Open ${money(row.open)} · High ${money(row.high)} · Low ${money(row.low)}</span>` : ''}
      ${numeric(row.volume) ? `<span>Volume ${compact(row.volume)}</span>` : ''}
      ${chart.comparisons.filter(({ key, shown }) => shown && positive(row[key])).map(({ key, label }) => `<span>${safe(label)} ${money(row[key])} rebased</span>`).join('')}`
      : '<span>No usable price for this session</span>'}`;
  };
  svg.addEventListener('pointermove', (event) => {
    const bounds = svg.getBoundingClientRect();
    if (!bounds.width) return;
    const position = (chartWidth * (event.clientX - bounds.left) / bounds.width - plot.left) / (plot.right - plot.left);
    show(Math.floor(position * chart.rows.length));
  });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (event) => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') show(0);
    else if (event.key === 'End' || index < 0) show(chart.rows.length - 1);
    else show(index + (event.key === 'ArrowUp' ? 1 : -1));
  });
  return hide;
}

export function chartbookStats(row) {
  const stats = [
    ['Close', money(row.close)], ['1D move', rate(row.return_1d), direction(row.return_1d)], ['1M return', rate(row.return_21d), direction(row.return_21d)],
    ['RS rank', count(row.rsRank)], ['RS percentile', number(row.rsPercentile)], ['4W RS velocity', signed(row.velocity4w), direction(row.velocity4w)],
    ['12W RS velocity', signed(row.velocity12w), direction(row.velocity12w)], ['20D relative volume', ratio(row.rvol_20d)],
    ['50D up/down volume', ratio(row.udv_50d, row.udv_state_50d)], ['20D accumulation', signed(row.accumulation_20d, 0), direction(row.accumulation_20d)],
    ['20D OBV change', compact(row.obv_slope_20d), direction(row.obv_slope_20d)],
  ];
  return `<dl class="chartbook-stats" aria-label="Ticker metrics">${stats.map(([label, value, style]) =>
    `<div><dt>${label}</dt><dd${style ? ` class="${style}"` : ''}>${safe(value)}</dd></div>`).join('')}</dl>`;
}
