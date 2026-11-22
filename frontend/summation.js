import { chart } from './charts.js';
import { rangeSegment } from './chart-ranges.js';
import { count, dateLabel, direction, empty, notice, number, panelHead, pending, rate, safe, segment, signed } from './ui.js';

const title = 'NYSE Summation Index proxy';
const subtitle = 'McClellan-style summation of observed NYSE common-stock breadth';
const averageChoices = [['both', '10D & 20D'], ['10', '10D SMA'], ['20', '20D SMA']];
const gapReasons = {
  'missing-breadth': 'No prepared breadth counts for this session.',
  'invalid-counts': 'The breadth counts are incomplete or inconsistent.',
  'insufficient-traded': 'Too few traded stocks in the observed universe.',
  'insufficient-comparable': 'Too few traded stocks have a comparable prior close.',
  'no-directional-issues': 'No advancing or declining stocks for the ratio-adjusted input.',
};

function coverageText(row) {
  return row.comparable == null || row.traded == null ? '' :
    `${count(row.comparable)} / ${count(row.traded)} traded stocks comparable (${rate(row.comparableFraction, 1, false)})`;
}

function crossText(cross) {
  return cross ? `Crossed ${cross.direction} on ${dateLabel(cross.date)}` : '';
}

function averageTile(row, period) {
  const position = row[`position${period}`];
  const lastCross = crossText(row[`lastCross${period}`]);
  const comparison = { above: 'Proxy above SMA', below: 'Proxy below SMA', equal: 'Proxy at SMA' }[position] || 'Waiting for comparable readings';
  return `<div class="metric-tile"><span>${period}D SMA</span><strong>${number(row[`sma${period}`])}</strong><small>${safe(comparison)}</small>
    ${lastCross ? `<small>${safe(lastCross)}</small>` : ''}</div>`;
}

function currentReading(row, metadata, periods) {
  const label = dateLabel(row.date);
  if (row.state === 'gap') return notice(`Coverage gap · ${label}`, [gapReasons[row.reason], coverageText(row)].filter(Boolean).join(' '));
  if (row.state === 'warmup') {
    return notice(`Indicator warming up · ${label}`,
      `${row.consecutiveObservations} of ${metadata.warmupSessions} consecutive observations required before display. ${coverageText(row)}`.trim());
  }
  const slope = row.slope == null ? '' : `${row.slope > 0 ? 'Rising' : row.slope < 0 ? 'Falling' : 'Flat'} · ${signed(row.slope)} pts vs prior session`;
  return `<div class="metric-grid" aria-label="Summation readings for ${safe(label)}">
    <div class="metric-tile"><span>${safe(label)} · ${safe(metadata.units)}</span><strong>${number(row.value)}</strong>
    ${slope ? `<small class="${direction(row.slope)}">${safe(slope)}</small>` : ''}${coverageText(row) ? `<small>${safe(coverageText(row))}</small>` : ''}</div>
    ${periods.map((period) => averageTile(row, period)).join('')}</div>`;
}

function methodology(metadata) {
  const links = (metadata.methodologySources || []).filter(({ url }) => url.startsWith('https://www.mcoscillator.com/')).map(({ label, url }) =>
    `<a href="${safe(url)}" class="text-link" target="_blank" rel="noopener noreferrer">${safe(label)}</a>`);
  return `<details class="section-space"><summary>Methodology and coverage</summary>
    <p class="muted section-space">${safe(metadata.source)}. The published NYSE all-issues series uses a different universe and calibration.</p>
    <p class="muted section-space">Daily input is ${safe(metadata.input)}. The oscillator is the difference between the 10% and 5% EMAs. The proxy accumulates that difference from a zero seed${metadata.seedStart ? ` using history from ${safe(dateLabel(metadata.seedStart))}` : ''}.</p>
    <p class="muted section-space">Sessions require at least ${count(metadata.minimumTraded)} traded stocks and ${rate(metadata.minimumComparableFraction, 0, false)} of traded stocks with comparable closes. A gap restarts the ${count(metadata.warmupSessions)}-session warmup and both moving averages. ${links.join(' · ')}</p></details>`;
}

function describePoint(row, periods) {
  const counts = coverageText(row);
  const crosses = periods.flatMap((period) => row[`cross${period}`] ? [`Crossed ${row[`cross${period}`]} ${period}D SMA`] : []);
  return [counts, row.reason ? gapReasons[row.reason] : row.state === 'warmup' ? 'EMA warmup' : '', ...crosses].filter(Boolean);
}

export async function mountSummation(target, env) {
  if (!target) return;
  const { api, signal, state } = env;
  let range = state?.summationRange ?? 252;
  let average = averageChoices.some(([key]) => key === state?.summationAverage) ? state.summationAverage : 'both';
  let result;
  let run = 0;
  const active = () => target.isConnected && !signal?.aborted;
  const panel = (content, controls = '') => `<section class="panel panel-body">${panelHead(title, subtitle, rangeSegment('summation-range', range) + controls)}${content}</section>`;

  function paint() {
    const { rows, status, metadata, through, preparationState } = result;
    if (!rows.length) {
      const waiting = ['queued', 'running'].includes(preparationState);
      const message = waiting ? 'Summation history is being prepared for this data version.' : status === 'empty'
        ? 'No market sessions are available for this selection.' : 'Summation history has yet to be prepared for this data version.';
      target.innerHTML = panel(empty('No prepared summation readings', message, 'chart') + methodology(metadata));
      return;
    }

    const summary = status === 'partial' ? notice('Summation history is incomplete', `Prepared through ${dateLabel(through)}.`) : '';
    const hasValues = rows.some((row) => row.state === 'available');
    const periods = average === 'both' ? [10, 20] : [Number(average)];
    const latest = currentReading(rows.at(-1), metadata, periods);
    const history = hasValues ? chart(rows, [
      { key: 'value', label: 'Summation proxy', format: number },
      ...periods.map((period) => ({ key: `sma${period}`, label: `${period}D SMA`, format: number, dash: period === 20,
        color: period === 10 ? '#bae489' : '#84a9fa' })),
    ], { label: 'Observed NYSE common-stock summation and simple moving averages in index points',
      height: 264, describePoint: (row) => describePoint(row, periods) }) : '';
    target.innerHTML = panel(summary + latest + (history ? `<div class="section-space">${history}</div>` : '') + methodology(metadata),
      hasValues ? segment('summation-average', averageChoices, average) : '');
  }
  async function load() {
    const id = ++run;
    result = undefined;
    target.innerHTML = panel(pending('Loading prepared summation history…'));
    try {
      const data = await api('market/summation', { signal, params: { limit: range } });
      if (!active() || id !== run) return;
      result = data;
      paint();
    } catch (error) {
      if (active() && id === run && error.name !== 'AbortError') {
        target.innerHTML = panel(notice('Summation history unavailable', error.message, '', true));
      }
    }
  }
  const choose = async (event) => {
    const button = event.target.closest('[data-action="summation-range"], [data-action="summation-average"]');
    if (!button || button.getAttribute('aria-pressed') === 'true') return;
    const { action, value } = button.dataset;
    if (action === 'summation-range') {
      range = Number(value);
      if (state) state.summationRange = range;
      await load();
    } else if (result) {
      average = value;
      if (state) state.summationAverage = average;
      paint();
    }
    target.querySelector(`[data-action="${action}"][aria-pressed="true"]`)?.focus();
  };
  target.addEventListener('click', choose);
  signal?.addEventListener('abort', () => target.removeEventListener('click', choose), { once: true });
  return load();
}
