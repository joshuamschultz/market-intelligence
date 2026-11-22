import { count, dateLabel, number, numeric, percent, rate, safe, signed } from './ui.js';

const metrics = new Map([
  ['medianRS', { label: 'Median RS percentile', bounds: [0, 100], format: number }],
  ['equalWeight', { label: '21-session return', minimumSpan: 0.01, format: (value) => rate(value, 2) }],
  ['velocity4w', { label: '4W RS velocity', minimumSpan: 1, bounds: [-100, 100], format: (value) => `${signed(value)} pts` }],
  ['above50', { label: 'Above 50D SMA', bounds: [0, 100], format: percent }],
]);

export const groupHeatmapMetrics = [...metrics].map(([key, { label }]) => [key, label]);

const levels = new Map([['sector', 'Sectors'], ['industry', 'Industries'], ['subindustry', 'Subindustries'], ['theme', 'Themes']]);
const colors = { low: [114, 41, 59], middle: [35, 48, 60], high: [29, 108, 80], missing: [30, 39, 45] };
const rgb = (channels) => `rgb(${channels.join(', ')})`;
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const inBounds = (value, bounds) => numeric(value) && (!bounds || (value >= bounds[0] && value <= bounds[1]));

function selectedGroups(groups, level) {
  return (groups ?? []).filter((row) => row && (level == null || row.level === level));
}

function color(value, [low, midpoint, high]) {
  if (value == null) return rgb(colors.missing);
  const endpoint = value < midpoint ? colors.low : colors.high;
  const span = value < midpoint ? midpoint - low : high - midpoint;
  const weight = Math.min(1, Math.abs(value - midpoint) / span);
  return rgb(colors.middle.map((channel, index) => Math.round(channel + (endpoint[index] - channel) * weight)));
}

function thresholds(spec, rows) {
  if (spec.minimumSpan) {
    const bound = rows.reduce((maximum, { value }) => Math.max(maximum, Math.abs(value ?? 0)), spec.minimumSpan);
    return [-bound, 0, bound];
  }
  const [low, high] = spec.bounds;
  return [low, (low + high) / 2, high];
}

function safeRoute(url) {
  if (typeof url !== 'string' || /[\u0000-\u001f\u007f\\]/.test(url)) return null;
  return url.startsWith('#') || /^\/(?!\/)/.test(url) ? url : null;
}

function renderTile({ group, value }, metric, spec, bounds, { routeUrl, action }) {
  const name = group.name || group.id || 'Unnamed group';
  const reading = value == null ? 'Unavailable' : spec.format(value);
  const counts = [isCount(group.count) && `${count(group.count)} traded`, isCount(group.rankedCount) && `${count(group.rankedCount)} ranked`];
  const comparable = group.counts?.above50;
  if (metric === 'above50' && value != null && isCount(comparable?.numerator) && isCount(comparable?.denominator) &&
    comparable.denominator > 0 && comparable.numerator <= comparable.denominator) {
    counts.push(`${count(comparable.numerator)} of ${count(comparable.denominator)} comparable`);
  }
  const metadata = counts.filter(Boolean).join(' · ');
  const tile = `<span class="group-heatmap-name">${safe(name)}</span><strong>${safe(reading)}</strong>
    ${metadata ? `<small class="group-heatmap-meta">${safe(metadata)}</small>` : ''}`;
  const attributes = `class="group-heatmap-tile" style="--group-heatmap-color:${color(value, bounds)}"`;
  const href = group.id && typeof routeUrl === 'function' ? safeRoute(routeUrl(group)) : null;
  const label = [name, `${spec.label} ${reading}`, metadata].filter(Boolean).join(' · ');
  if (href) return `<a ${attributes} href="${safe(href)}" aria-label="${safe(label)}">${tile}</a>`;
  if (group.id && typeof action === 'string' && /^[a-z][a-z0-9-]*$/.test(action)) {
    return `<button type="button" ${attributes} data-action="${action}" data-value="${safe(group.id)}" aria-label="${safe(label)}">${tile}</button>`;
  }
  return `<div ${attributes}>${tile}</div>`;
}

export function renderGroupHeatmap(groups, { metric = 'medianRS', level = 'industry', routeUrl, action, date, contextLabel, unavailableReason } = {}) {
  const key = metrics.has(metric) ? metric : 'medianRS';
  const spec = metrics.get(key);
  const rows = selectedGroups(groups, level).map((group) => ({ group, value: inBounds(group[key], spec.bounds) ? group[key] : null }));
  const available = rows.filter(({ value }) => value != null).length;
  const bounds = thresholds(spec, rows);
  const detail = [date && dateLabel(date), contextLabel, `${count(available)} of ${count(rows.length)} groups with a value`].filter(Boolean).join(' · ');
  const legend = [...(available ? bounds : []), null].map((value) =>
    `<span><i aria-hidden="true" style="background:${color(value, bounds)}"></i>${safe(value == null ? 'Unavailable' : spec.format(value))}</span>`).join('');
  const message = !available && unavailableReason ? unavailableReason : !rows.length ? 'No prepared groups for the selected context.' : '';
  const heading = `${levels.get(level) || 'Groups'} by ${spec.label.toLowerCase()}`;
  return `<div class="group-heatmap" role="group" aria-label="${safe(heading)}">
    <p class="muted group-heatmap-meta">${safe(detail)}</p>
    ${message ? `<p class="muted">${safe(message)}</p>` : ''}
    ${rows.length ? `<div class="group-heatmap-legend" aria-label="${safe(`${spec.label} color scale`)}">${legend}</div>
      <div class="group-heatmap-grid">${rows.map((row) => renderTile(row, key, spec, bounds, { routeUrl, action })).join('')}</div>` : ''}
  </div>`;
}

export function buildLeadershipMap(groups, { level, velocity = 'velocity4w' } = {}) {
  const key = velocity === 'velocity12w' ? velocity : 'velocity4w';
  const selected = selectedGroups(groups, level);
  const points = selected.filter((group) => inBounds(group.percentile, [0, 100]) && inBounds(group[key], [-100, 100]));
  const quadrants = { higherRSRising: 0, higherRSFalling: 0, lowerRSRising: 0, lowerRSFalling: 0, flat: 0 };
  for (const point of points) {
    const change = point[key];
    if (change === 0) quadrants.flat++;
    else if (point.percentile >= 50) quadrants[change > 0 ? 'higherRSRising' : 'higherRSFalling']++;
    else quadrants[change > 0 ? 'lowerRSRising' : 'lowerRSFalling']++;
  }
  return { points, plotted: points.length, omitted: selected.length - points.length, total: selected.length, velocity: key, quadrants };
}
