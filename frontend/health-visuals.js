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

const coveragePercent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 3 });
const preciseCoveragePercent = new Intl.NumberFormat('en-US', { style: 'percent', maximumSignificantDigits: 17 });

function belowCoverage(ratio, threshold) {
  if (!numeric(ratio) || !numeric(threshold) || ratio >= threshold) return '';
  const format = coveragePercent.format(ratio) === coveragePercent.format(threshold) ? preciseCoveragePercent : coveragePercent;
  return `(${format.format(ratio)}), below the ${format.format(threshold)} minimum.`;
}

function coverageGap({ observed, expected, ratio, threshold }, label) {
  const below = belowCoverage(ratio, threshold);
  return below && numeric(observed) && numeric(expected) ? `${count(observed)} of ${count(expected)} ${label} ${below}` : '';
}

function sourceGate(health, snapshotCoverage) {
  const coverage = health.coverage || snapshotCoverage;
  const observedMode = health.coverageMode === 'observed';
  const reportedFailure = health.state === 'insufficient_coverage' || health.reason === 'insufficient_coverage';
  const coverageFailure = health.coverage ? coverage.ready === false : !observedMode && coverage.state === 'partial';
  if (!reportedFailure && !coverageFailure) return null;
  if (observedMode) {
    const { traded, listed, ratio, threshold, minimum } = coverage.observed || {};
    const below = coverageGap({ observed: traded, expected: listed, ratio, threshold }, 'eligible securities traded');
    const sample = numeric(traded) && numeric(minimum) && traded < minimum
      ? `${count(traded)} securities traded, below the ${count(minimum)} minimum sample.` : '';
    return { label: 'Observed universe coverage', detail: [below, sample].filter(Boolean).join(' ') || 'Eligible and traded counts did not establish adequate coverage.' };
  }
  const { ratio, completenessThreshold: threshold, received, traded, expected } = coverage;
  const observed = numeric(received) && numeric(traded) ? Math.min(received, traded) : received ?? traded;
  const below = belowCoverage(ratio, threshold);
  const counts = numeric(observed) && numeric(expected) ? `${count(observed)} of ${count(expected)} expected securities` : 'Recorded coverage';
  const detail = below ? `${counts} ${below}` : numeric(ratio)
    ? 'This context does not qualify for verified market coverage.' : 'A reconciled provider roster is unavailable for this session.';
  return { label: 'Provider source coverage', detail };
}

function componentCoverage(part, minimum) {
  const { adequacy } = part;
  if (!adequacy) return [];
  const { observed, expected, groupRatio, observedIndustries, comparableIndustries, threshold } = adequacy;
  const classifiedSubset = adequacy.comparisonScope === 'observed_classified_subset';
  const industry = part.id === 'industryLeadership';
  const securityGap = !classifiedSubset && coverageGap(adequacy, industry ? 'securities classified' : 'comparable securities');
  const groupGap = coverageGap({ observed: observedIndustries, expected: comparableIndustries, ratio: groupRatio, threshold }, 'comparable industries');
  const sampleMinimum = classifiedSubset ? adequacy.minimumClassified : minimum;
  const sampleGap = numeric(observed) && numeric(sampleMinimum) && observed < sampleMinimum
    ? `${count(observed)} ${industry ? 'classified' : 'comparable'} securities, below the ${count(sampleMinimum)} minimum sample.` : '';
  return [securityGap, groupGap, sampleGap].filter(Boolean);
}

function componentGate(part, minimum, datedHealthUrl) {
  const industryMissing = part.id === 'industryLeadership' && !numeric(part.value) &&
    (part.reason === 'input_unavailable' || part.denominator === 0);
  if (part.reason === 'insufficient_calibration_history') {
    const { observations, minObservations } = part.calibration || {};
    return { detail: numeric(observations) && numeric(minObservations)
      ? `Calibration has ${count(observations)} prior readings and requires ${count(minObservations)}.` : reasons[part.reason] };
  }
  const details = part.reason === 'insufficient_comparable_coverage' ? componentCoverage(part, minimum) : [];
  if (industryMissing) details.push(datedHealthUrl
    ? 'Four-week relative strength comparison unavailable with the Nasdaq directory.'
    : 'No comparable four-week industry relative strength readings.');
  const { ratio, groupRatio, threshold, comparisonScope } = part.adequacy || {};
  const comparableRatios = comparisonScope === 'observed_classified_subset' ? [groupRatio] : [ratio, groupRatio];
  const gap = numeric(threshold) ? Math.max(0, ...comparableRatios.filter(numeric).map((value) => threshold - value)) : 0;
  return { detail: details.join(' ') || reasons[part.reason] || 'Score unavailable.',
    missingInput: industryMissing || part.reason === 'input_unavailable', gap, url: industryMissing ? datedHealthUrl : null };
}

export function renderHealthAvailability(health = {}, { coverage = {}, datedHealthUrl } = {}) {
  if (numeric(health.score)) return '';
  if (health.state === 'loading') return '<p id="health-availability" class="muted" role="status">Loading market health for the selected coverage…</p>';
  const source = sourceGate(health, coverage);
  const missing = new Set(health.missingComponents);
  const supplied = new Map((health.components || []).map((part) => [part.id, part]));
  const sorted = components.flatMap(([id, label]) => {
    const part = supplied.get(id);
    if (!missing.has(id) && !(part?.weight > 0 && part.score === null)) return [];
    return [{ label, ...componentGate(part || { id }, health.observedMinimum ?? health.coverage?.observed?.minimum, datedHealthUrl) }];
  }).sort((left, right) => Number(Boolean(right.missingInput)) - Number(Boolean(left.missingInput)) || (right.gap || 0) - (left.gap || 0));
  const item = ({ label, detail, url }) => `<li><strong>${safe(label)}</strong> · ${safe(detail)}${url
    ? ` <a class="text-link" href="${safe(url)}">Use filing-dated SEC groups</a>` : ''}</li>`;
  const initial = [source, ...sorted.slice(0, 3)].filter(Boolean);
  const more = sorted.slice(3);
  const summary = initial.length || health.reason === 'insufficient_inputs' || health.state === 'insufficient_inputs'
    ? 'The model requires adequate coverage and a score for every positively weighted component.'
    : health.reason || '';
  return `<div id="health-availability"><p class="muted"><strong>Composite score unavailable.</strong> ${safe(summary)}</p>
    ${initial.length ? `<ul class="muted">${initial.map(item).join('')}</ul>` : ''}
    ${more.length ? `<details class="formula-help"><summary>${count(more.length)} more component ${more.length === 1 ? 'requirement' : 'requirements'}</summary>
      <ul class="muted">${more.map(item).join('')}</ul></details>` : ''}</div>`;
}

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
    <details class="formula-help section-space"><summary>Component details</summary>
      ${missingScores ? `<p class="muted">${count(missingScores)} component ${missingScores === 1 ? 'score unavailable' : 'scores unavailable'}.</p>` : ''}
      ${missingIndustry && industryUrl ? `<p class="muted"><a class="text-link" href="${safe(industryUrl)}">View filing-dated SEC industry rankings</a></p>` : ''}
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
