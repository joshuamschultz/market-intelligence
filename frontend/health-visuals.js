import { count, dateLabel, direction, money, number, numeric, percent, safe, signed } from './ui.js';

const components = [
  ['shortBreadth', 'Short-term breadth', 'Share above the 20-session SMA', 'above_20d'],
  ['intermediateBreadth', 'Intermediate-term breadth', 'Share above the 50-session SMA', 'above_50d'],
  ['longBreadth', 'Long-term breadth', 'Share above the 200-session SMA', 'above_200d'],
  ['priceMomentum', 'Price momentum participation', 'Share with a positive 21-session return', 'positive_21d'],
  ['volumeParticipation', 'Volume participation', 'Advancing share of advancing and declining dollar volume'],
  ['industryLeadership', 'Industry leadership breadth', 'Share of comparable industries with positive 4-week RS velocity'],
  ['highsLows', 'New highs versus new lows', 'New 252-session high share minus new low share'],
];

const reasons = {
  insufficient_comparable_coverage: 'Too few comparable observations for this component.',
  insufficient_calibration_history: 'Too few historical readings for the selected calibration.',
  input_unavailable: 'Required observations are unavailable for this component.',
};

function rawInput(snapshot, id, breadthKey) {
  if (breadthKey) return snapshot.breadth?.[breadthKey] || {};
  if (id === 'volumeParticipation') {
    const { upDollar, downDollar } = snapshot.aggregates || {};
    const denominator = upDollar + downDollar;
    if (numeric(upDollar) && upDollar >= 0 && numeric(downDollar) && downDollar >= 0 && numeric(denominator) && denominator > 0) {
      return { value: 100 * upDollar / denominator, numerator: upDollar, denominator };
    }
  }
  if (id === 'highsLows') {
    const highs = snapshot.breadth?.new_high_252d;
    const lows = snapshot.breadth?.new_low_252d;
    if (within(highs?.value, 0, 100) && within(lows?.value, 0, 100) && highs.denominator !== 0 && lows.denominator !== 0) {
      return { value: highs.value - lows.value, readings: { highs, lows } };
    }
  }
  return {};
}

const within = (value, min, max) => numeric(value) && value >= min && value <= max;
const millisecondsPerDay = 86_400_000;
const rawFormat = (value, spread) => spread ? `${signed(value)} pp` : percent(value);

function scale(label, value, spread) {
  const min = spread ? -100 : 0;
  const start = spread ? Math.min(50, 50 + value / 2) : 0;
  const width = spread ? Math.abs(value / 2) : value;
  return `<div class="health-raw-scale${spread ? ' diverging' : ''}" role="meter" aria-label="${safe(label)}" aria-valuemin="${min}"
    aria-valuemax="100" aria-valuenow="${value}" aria-valuetext="${rawFormat(value, spread)}">
    <div class="health-raw-track"><i class="${spread ? direction(value) : ''}" style="--health-bar-start:${start}%;--health-bar-span:${width}%"></i></div>
    <span class="health-raw-ticks" aria-hidden="true"><span>${spread ? '−100 pp' : '0%'}</span>${spread ? '<span>0</span>' : ''}<span>${spread ? '+100 pp' : '100%'}</span></span></div>`;
}

function componentHistory(history, id, label, spread) {
  const points = history.map(({ date, time, components }) => {
    const part = components?.find((item) => item.id === id);
    const value = within(part?.value, spread ? -100 : 0, 100) && part.denominator !== 0 ? part.value : null;
    return { date, time, value };
  });
  const observations = points.filter(({ value }) => numeric(value));
  if (observations.length < 2) return '';

  const values = observations.map(({ value }) => value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const start = points[0].time;
  const span = points.at(-1).time - start;
  const segments = [];
  let last;
  for (const point of points) {
    if (point.value == null) {
      last = null;
      continue;
    }
    const x = span ? 3 + 138 * (point.time - start) / span : 72;
    const y = max > min ? 23 - 20 * (point.value - min) / (max - min) : 13;
    // Weekend closures can separate adjacent readings. Leave other absent dates as gaps.
    const nextWeekday = last && last.time + millisecondsPerDay * (new Date(last.time).getUTCDay() === 5 ? 3 : 1);
    if (!last || point.time !== nextWeekday) segments.push([]);
    segments.at(-1).push([x.toFixed(2), y.toFixed(2)]);
    last = point;
  }
  const range = `${rawFormat(min, spread)} to ${rawFormat(max, spread)}`;
  const title = `${label} raw history · ${range} · ${count(observations.length)} readings · ${dateLabel(observations[0].date)} to ${dateLabel(observations.at(-1).date)}`;
  return `<div class="health-component-sparkline"><svg viewBox="0 0 144 26" role="img" aria-label="${safe(title)}">
    <title>${safe(title)}</title>${segments.map((segment) => segment.length === 1
    ? `<circle cx="${segment[0][0]}" cy="${segment[0][1]}" r="2"/>`
    : `<polyline points="${segment.map((point) => point.join(',')).join(' ')}" vector-effect="non-scaling-stroke"/>`).join('')}</svg>
    <span aria-hidden="true">${range}</span></div>`;
}

function auditInputs(part) {
  const pairs = part.readings
    ? [['New highs', part.readings.highs], ['New lows', part.readings.lows]] : [['', part]];
  return pairs.filter(([, item]) => numeric(item?.denominator)).map(([label, item]) => {
    const format = part.id === 'volumeParticipation' ? money : count;
    return `${label ? `${label} ` : ''}${format(item.numerator)} of ${format(item.denominator)}`;
  }).join(' · ');
}

export function renderHealthComponents(health = {}, { snapshot = {}, weights = {}, industryUrl } = {}) {
  const supplied = new Map((health.components || []).map((part) => [part.id, part]));
  const history = (health.history || []).map((row) => ({ ...row, time: Date.parse(row.date) }))
    .filter(({ time }) => numeric(time)).sort((left, right) => left.time - right.time);
  const activeWeights = { ...weights, ...health.model?.weights };
  const totalWeight = components.reduce((total, [id]) => total + (activeWeights[id] || 0), 0);
  const rows = components.map(([id, label, description, breadthKey]) => {
    const stored = supplied.get(id) || {};
    const raw = numeric(stored.value) ? stored : rawInput(snapshot, id, breadthKey);
    const spread = id === 'highsLows';
    const value = within(raw.value, spread ? -100 : 0, 100) && raw.denominator !== 0 ? raw.value : null;
    const score = within(stored.score, 0, 100) ? stored.score : null;
    const weight = within(stored.weight, 0, 1) ? stored.weight
      : numeric(activeWeights[id]) && totalWeight > 0 ? activeWeights[id] / totalWeight : null;
    return { ...stored, ...raw, id, label, description, spread, value, score, weight,
      reading: value == null ? 'Unavailable' : rawFormat(value, spread), history: componentHistory(history, id, label, spread),
      weightLabel: numeric(weight) ? percent(weight * 100, Number.isInteger(weight * 100) ? 0 : 1) : '—' };
  });
  const missingScores = rows.filter(({ score }) => score == null).length;
  const missingIndustry = rows.find(({ id }) => id === 'industryLeadership').value == null;
  const hasHistory = rows.some((part) => part.history);
  return `<section class="section-space" aria-label="Market health components">
    <p class="muted">Bars show the latest raw readings.${hasHistory ? ' Mini charts show raw history over the selected Health range.' : ''} Published component scores use the model’s 0–100 scale.</p>
    <div class="health-component-list">${rows.map((part) => `<div class="health-component">
      <div class="health-component-line"><strong title="${safe(part.definition || part.description)}">${part.label}</strong>
        <span class="health-raw-value">${part.reading}</span></div>
      ${part.value == null ? '' : scale(part.description, part.value, part.spread)}
      ${part.history}
      <div class="health-component-meta"><span>${part.description}</span>${part.weight == null ? '' : `<span>Weight ${part.weightLabel}</span>`}
        ${part.score == null ? '' : `<span class="health-score">Score ${number(part.score)} / 100</span>`}</div></div>`).join('')}</div>
    ${missingIndustry && industryUrl ? `<p class="muted section-space">Industry velocity needs dated group membership. <a class="text-link" href="${safe(industryUrl)}">View filing-dated SEC groups</a></p>` : ''}
    ${missingScores ? `<p class="muted section-space">${count(missingScores)} component ${missingScores === 1 ? 'score unavailable' : 'scores unavailable'}. See Component details for the underlying inputs and coverage.</p>` : ''}
    <details class="formula-help section-space"><summary>Component details</summary>
      <div class="table-scroll section-space" tabindex="0" role="region" aria-label="Health component inputs and coverage"><table>
        <thead><tr><th scope="col">Component</th><th scope="col">Raw reading</th><th scope="col">Weight</th><th scope="col">Score / 100</th><th scope="col">Inputs and coverage</th></tr></thead>
        <tbody>${rows.map((part) => {
          const facts = [auditInputs(part), part.comparisonDate && `Compared with ${dateLabel(part.comparisonDate)}`,
            numeric(part.adequacy?.observed) && numeric(part.adequacy?.expected) && `${count(part.adequacy.observed)} observed / ${count(part.adequacy.expected)} expected`,
            part.score == null && (reasons[part.reason] || part.reason || 'Score unavailable')].filter(Boolean);
          return `<tr><td title="${safe(part.definition || part.description)}">${part.label}</td><td class="numeric">${part.reading}</td>
            <td class="numeric">${part.weightLabel}</td><td class="numeric">${number(part.score)}</td><td>${safe(facts.join(' · ')) || '—'}</td></tr>`;
        }).join('')}</tbody></table></div></details></section>`;
}
