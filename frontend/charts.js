import { csvDownload, dateLabel, empty, number, numeric, safe } from './ui.js';

export const chartColors = ['#58e2c3', '#bae489', '#84a9fa', '#f4c681', '#eaa9e1', '#ff8c94', '#b5b1ef', '#9bdce7'];
const plots = new Map();
let chartId = 0;

function valuesFor(series, rows) {
  return rows.map((row) => typeof series.value === 'function' ? series.value(row) : row[series.key]);
}
function extent(values) {
  return values.reduce(([low, high], value) => numeric(value) ? [Math.min(low, value), Math.max(high, value)] : [low, high], [Infinity, -Infinity]);
}
function axisDomain(values, bound) {
  if (bound) return bound;
  const [low, high] = extent(values);
  if (!Number.isFinite(low)) return [0, 1];
  const margin = high === low ? Math.max(Math.abs(low) * 0.05, 1) : (high - low) * 0.12;
  return [low - margin, high + margin];
}
function lineSegments(values, x, y) {
  const segments = [];
  let line = [];
  values.forEach((value, index) => {
    if (numeric(value)) line.push([x(index), y(value)]);
    else if (line.length) {
      segments.push(line);
      line = [];
    }
  });
  if (line.length) segments.push(line);
  return segments;
}
const path = (points) => points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
const xLabel = (date, showYear) => showYear
  ? new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', year: 'numeric' }).format(new Date(date))
  : dateLabel(date, true);
const yLabel = (value) => Math.abs(value) > 100 || Number.isInteger(value) ? number(value, 0) : number(value, 1);

export function chart(rows, input, options = {}) {
  if (!rows.length) return empty('No observations', 'Choose an available session or a longer date range.', 'chart');
  const id = `plot-${++chartId}`;
  const series = input.map((item, index) => ({ color: chartColors[index % chartColors.length], format: (value) => number(value, 2), ...item }));
  const content = series.map((item) => valuesFor(item, rows));
  if (!content.some((values) => values.some(numeric))) return empty('No comparable observations', 'This selection has no values in the loaded range.', 'chart');

  const width = options.width || 650;
  const height = options.height || 218;
  const left = 43;
  const right = series.some((item) => item.axis === 'right') ? width - 47 : width - 13;
  const top = 12;
  const bottom = height - (options.volume ? 55 : 27);
  const x = (i) => rows.length === 1 ? (left + right) / 2 : left + i * (right - left) / (rows.length - 1);
  const domain = {
    left: axisDomain([...content.flatMap((values, index) => series[index].axis === 'right' ? [] : values),
      ...(options.candles ? rows.flatMap((row) => [row.high, row.low]) : [])], options.domain),
    right: axisDomain(content.flatMap((values, index) => series[index].axis === 'right' ? values : []), options.rightDomain),
  };
  const y = (value, side = 'left') => bottom - (value - domain[side][0]) * (bottom - top) / (domain[side][1] - domain[side][0]);
  const marks = Array.from({ length: 5 }, (_, index) => index / 4);
  const ticks = [...new Set(marks.map((fraction) => Math.round(fraction * (rows.length - 1))))];
  const grid = marks.map((fraction) => {
    const py = bottom - fraction * (bottom - top);
    const value = (side) => domain[side][0] + fraction * (domain[side][1] - domain[side][0]);
    return `<line x1="${left}" y1="${py}" x2="${right}" y2="${py}" stroke="#29383f" stroke-dasharray="3 4"/>
      <text x="${left - 8}" y="${py + 3}" text-anchor="end">${safe((options.axisFormat || yLabel)(value('left')))}</text>
      ${right === width - 47 ? `<text x="${right + 8}" y="${py + 3}">${safe((options.rightAxisFormat || yLabel)(value('right')))}</text>` : ''}`;
  }).join('');
  const candles = options.candles ? rows.map((row, index) => {
    if (![row.open, row.high, row.low, row.close].every(numeric)) return '';
    const color = row.close >= row.open ? '#76e2a7' : '#ff8c94';
    const center = x(index);
    const w = Math.max(1, Math.min(10, (right - left) / rows.length * .66));
    const open = y(row.open);
    const close = y(row.close);
    return `<line x1="${center}" x2="${center}" y1="${y(row.high)}" y2="${y(row.low)}" stroke="${color}" vector-effect="non-scaling-stroke"/>
      <rect x="${center - w/2}" y="${Math.min(open, close)}" width="${w}" height="${Math.max(1, Math.abs(close-open))}" fill="${color}"/>`;
  }).join('') : '';
  const lines = series.map((item, index) => options.candles && index === 0 ? '' : lineSegments(content[index], x, (value) => y(value, item.axis)).map((points) => {
    const line = path(points);
    const fill = index === 0 && options.fill && points.length > 1
      ? `<path d="${line} L${points.at(-1)[0]} ${bottom} H${points[0][0]} Z" fill="url(#${id}-gradient)"/>` : '';
    return `${fill}${points.length === 1
      ? `<circle cx="${points[0][0]}" cy="${points[0][1]}" r="3" fill="${item.color}"/>`
      : `<path class="chart-line" d="${line}" fill="none" stroke="${item.color}" stroke-width="${index ? 1.65 : 2.25}" vector-effect="non-scaling-stroke"${item.dash ? ' stroke-dasharray="4 4"' : ''}/>`}`;
  }).join('')).join('');
  const volumeMax = options.volume ? extent(rows.map(({ volume }) => volume))[1] : 0;
  const volume = numeric(volumeMax) && volumeMax > 0 ? rows.map((row, index) => {
    if (!numeric(row.volume) || row.volume <= 0) return '';
    const h = 23 * row.volume / volumeMax;
    const w = Math.max(1, Math.min(9, (right - left) / rows.length * .7));
    return `<rect x="${x(index) - w / 2}" y="${bottom + 28 - h}" width="${w}" height="${h}" fill="${row.close >= (rows[index - 1]?.close ?? row.close) ? '#447c6b' : '#89515a'}"/>`;
  }).join('') : '';
  const showYear = Date.parse(rows.at(-1).date) - Date.parse(rows[0].date) >= 31536000000;
  const axisLabels = ticks.map((index) => `<text x="${x(index)}" y="${height - 6}" text-anchor="${index === 0 ? 'start' : index === rows.length - 1 ? 'end' : 'middle'}">${safe(xLabel(rows[index].date, showYear))}</text>`).join('');
  plots.set(id, { rows, series, content, width, left, right, top, bottom, x, y, active: -1, candles: options.candles, onPick: options.onPick, describePoint: options.describePoint });
  if (plots.size > 100) {
    for (const key of plots.keys()) if (!document.getElementById(key) && key !== id) plots.delete(key);
  }
  const legend = series.map((item) => `<span class="legend-item"><i class="legend-mark" style="--series-color:${item.color}"></i>${safe(item.label)}</span>`).join('');
  return `<div class="chart-frame" id="${id}" data-chart>
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" tabindex="0" role="img" aria-label="${safe(options.label || series.map(({ label }) => label).join(' and '))}. Use arrow keys to inspect sessions." data-plot="${id}">
      <defs><linearGradient id="${id}-gradient" x2="0" y2="1" gradientUnits="objectBoundingBox"><stop stop-color="${series[0].color}" stop-opacity=".18"/><stop offset="1" stop-color="${series[0].color}" stop-opacity=".015"/></linearGradient></defs>
      <g fill="#98aab3" font-size="10.5" font-family="monospace">${grid}${axisLabels}</g>${candles}${lines}${volume}
      <g class="chart-crosshair" hidden></g>
    </svg>
    <div class="chart-tooltip" hidden></div><div class="legend chart-legend">${legend}${options.volume ? '<span class="legend-item"><i class="legend-mark" style="--series-color:#5d8278"></i>Share volume</span>' : ''}</div>
  </div>`;
}

function showPoint(node, plot, index) {
  const point = Math.min(plot.rows.length - 1, Math.max(0, index));
  const frame = node.parentElement;
  const tooltip = frame.querySelector('.chart-tooltip');
  if (plot.active === point && !tooltip.hidden) return;
  plot.active = point;
  const crosshair = node.querySelector('.chart-crosshair');
  const x = plot.x(point);
  const signals = plot.series.map((item, group) => [item, plot.content[group][point]]);
  tooltip.innerHTML = `<strong>${safe(dateLabel(plot.rows[point].date))}</strong>` + signals.map(([item, value]) =>
    `<span><i class="legend-mark" style="--series-color:${item.color}"></i> ${safe(item.label)} <strong>${safe(item.format(value))}</strong></span>`).join('');
  const descriptions = plot.describePoint?.(plot.rows[point]) || [];
  tooltip.innerHTML += descriptions.map((item)=>`<span>${safe(item)}</span>`).join('');
  if (plot.candles) {
    const row = plot.rows[point];
    const format = plot.series[0].format;
    tooltip.innerHTML += `<span>Open <strong>${safe(format(row.open))}</strong></span><span>High <strong>${safe(format(row.high))}</strong></span><span>Low <strong>${safe(format(row.low))}</strong></span>`;
  }
  tooltip.hidden = false;
  const px = x / plot.width * node.clientWidth;
  tooltip.style.left = `${px + tooltip.offsetWidth + 15 > node.clientWidth ? Math.max(4, px - tooltip.offsetWidth - 10) : px + 10}px`;
  crosshair.innerHTML = `<line x1="${x}" x2="${x}" y1="${plot.top}" y2="${plot.bottom}" stroke="#768a92" stroke-dasharray="3 4"/>` +
    signals.filter(([, value]) => numeric(value)).map(([item, value]) =>
      `<circle cx="${x}" cy="${plot.y(value, item.axis)}" r="3.25" fill="${item.color}" stroke="#11191e" stroke-width="1.2"/>`).join('');
  crosshair.removeAttribute('hidden');
}

function hidePoint(node) {
  node.parentElement.querySelector('.chart-tooltip').hidden = true;
  node.querySelector('.chart-crosshair').setAttribute('hidden', '');
}

document.addEventListener('pointermove', (event) => {
  const node = event.target.closest('[data-plot]');
  const plot = plots.get(node?.dataset.plot);
  if (!plot) {
    const previous = document.querySelector('[data-chart] .chart-tooltip:not([hidden])');
    if (previous && !previous.parentElement.contains(document.activeElement)) hidePoint(previous.parentElement.querySelector('[data-plot]'));
    return;
  }
  const { left, width } = node.getBoundingClientRect();
  const x = (event.clientX - left) * plot.width / width;
  const index = Math.round((x - plot.left) / (plot.right - plot.left) * (plot.rows.length - 1));
  showPoint(node, plot, index);
});
document.addEventListener('focusout', (event) => {
  if (event.target.matches('[data-plot]')) hidePoint(event.target);
});
document.addEventListener('keydown', (event) => {
  const node = event.target.closest('[data-plot]');
  const plot = plots.get(node?.dataset.plot);
  if (!plot) return;
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? plot.rows.length - 1
      : plot.active + (event.key === 'ArrowLeft' ? -1 : 1);
    showPoint(node, plot, index);
  }
  if (event.key === 'Enter' && plot.active >= 0 && plot.onPick) plot.onPick(plot.rows[plot.active]);
});
document.addEventListener('click', (event) => {
  const node = event.target.closest('[data-plot]');
  const plot = plots.get(node?.dataset.plot);
  if (plot?.active >= 0 && plot.onPick) plot.onPick(plot.rows[plot.active]);
});

export function exportChart(frame, filename) {
  const plot = plots.get(frame?.id);
  if (!plot) return;
  const keys = plot.series.map((item) => item.key);
  const rows = plot.rows.map((row, index) => Object.fromEntries([['date', row.date], ...keys.map((key, group) => [key, plot.content[group][index]])]));
  csvDownload(rows, ['date', ...keys], filename);
}
