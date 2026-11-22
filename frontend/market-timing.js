import { chart } from './charts.js';
import { chartRanges, rangeSegment } from './chart-ranges.js';
import { bindHelpTooltips, compact, count, dateLabel, direction, helpTooltip, percent, rate, safe, segment } from './ui.js';

const phases = { unknown: 'Unknown', correction: 'Correction', baseline: 'Trend baseline', rally: 'Rally attempt', confirmed: 'Follow-through confirmed' };
const stages = { unknown: 'Unknown', conservative: 'Conservative', test: 'Test', constructive: 'Constructive', pressure: 'Pressure' };
const stageOrder = ['conservative', 'pressure', 'test', 'constructive'];
const stageAxis = ['Cons.', 'Press.', 'Test', 'Constr.'];
const signalLabels = { 'follow-through': 'Follow-through', 'subsequent-follow-through': 'Subsequent follow-through',
  'follow-through-candidate': 'Price-qualified candidate', distribution: 'Distribution', 'rally-low-break': 'Rally-low break',
  'follow-through-low-break': 'Follow-through-low break', 'rally-start': 'Rally attempt started', 'correction-start': 'Correction started',
  'support-reclaim': 'Support reclaimed', 'support-break': 'Support broken', 'strong-trend-entry': 'Strong-trend checklist met',
  'strong-trend-exit': 'Strong-trend checklist exited', 'rally-continuity-unknown': 'Rally continuity unknown' };
const guards = { 'elevated-distribution': 'Elevated distribution', 'below-ema21': 'Sustained EMA21 weakness', 'failed-rally': 'Failed rally' };
const expiryLabels = { 'session-window': '25-session window', 'price-recovery': '5% price recovery' };
const tone = (stage) => ({ conservative: 'negative', pressure: 'negative', constructive: 'positive' })[stage] || '';
const titleCase = (value) => value ? value[0].toUpperCase() + value.slice(1) : 'Unavailable';

function loadStyles(doc) {
  if (doc.head.querySelector('[data-market-timing-styles]')) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./market-timing.css', import.meta.url).href;
  link.setAttribute('data-market-timing-styles', '');
  doc.head.append(link);
}

function phaseLabel(row) {
  if (row?.state !== 'observed') return 'Unavailable';
  return row.phase === 'rally' ? `Rally day ${row.rally.day}` : phases[row.phase] || 'Unknown';
}

export function timingSummary(review) {
  if (review?.state !== 'ready') return '';
  const { instruments, risk } = review.session;
  if (!Object.values(instruments).some((row) => row.state === 'observed')) return '';
  return `<div class="timing-summary">
    <button class="timing-summary-link text-link" type="button" data-action="overview-tab" data-value="monitor">Session review</button>
    <span class="timing-stage ${tone(risk.stage)}">${safe(stages[risk.stage])}</span>
    ${Object.entries(instruments).map(([symbol, row]) => `<span class="timing-summary-reading">
      <b title="${safe(review.instruments[symbol].label)}">${safe(symbol)}</b> ${safe(phaseLabel(row))}
      ${row.state === 'observed' ? `<span class="muted" title="Active distribution days">${count(row.distribution.count)} dist.</span>` : ''}</span>`).join('')}
  </div>`;
}

const priceText = (value) => numericPrice(value) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value) : '—';
const numericPrice = (value) => typeof value === 'number' && Number.isFinite(value);
const rateText = (value) => numericPrice(value) ? rate(value) : 'Unavailable';
const supplyText = (value) => numericPrice(value) ? compact(value) : 'Unavailable';
const sessionDate = (date) => date ? dateLabel(date) : '—';
const followSignal = ({ type }) => type === 'follow-through' || type === 'subsequent-follow-through';

function signalEvidence(signal) {
  const label = signalLabels[signal.type];
  if (!label) return '';
  if (followSignal(signal) || signal.type === 'follow-through-candidate' || signal.type === 'distribution') {
    const comparisons = `volume ${supplyText(signal.volume)} vs ${supplyText(signal.previousVolume)}`;
    const rallyDay = signal.day ? ` · rally day ${signal.day}` : '';
    return `${label} · ${rateText(signal.dayReturn ?? signal.return)} · ${comparisons}${rallyDay}`;
  }
  if (signal.type === 'rally-low-break' || signal.type === 'follow-through-low-break') {
    return `${label} · session low ${priceText(signal.low)} · threshold ${priceText(signal.rallyLow ?? signal.followThroughLow)}`;
  }
  if (signal.average) return `${label} · ${signal.average === 'sma20' ? '20D SMA' : '50D SMA'} ${priceText(signal.value)}`;
  return label;
}

function timingChart(review, symbol, availableHistory) {
  const rows = availableHistory.map((session) => {
    const row = session.instruments[symbol];
    return { date: session.date, close: row.close, ema21: row.averages?.ema21, sma50: row.averages?.sma50,
      phase: row.phase, stage: session.risk.stage, signals: row.signals,
      followThrough: row.signals.some(followSignal) ? row.close : null,
      distribution: row.signals.some(({ type }) => type === 'distribution') ? row.close : null };
  });
  const dataSeries = [
    { key: 'close', label: 'Close', color: '#dcf0f6', format: priceText },
    { key: 'ema21', label: 'EMA21', color: '#6f9ab1', format: priceText },
    { key: 'sma50', label: 'SMA50', color: '#b4a0ca', dash: true, format: priceText },
    { key: 'followThrough', label: 'F · Follow-through', color: '#76e2a7', pointMarker: 'F', format: priceText },
    { key: 'distribution', label: 'D · Distribution', color: '#ff8c94', pointMarker: 'D', format: priceText },
  ];
  const trendChart = chart(rows, dataSeries, { label: `${symbol} ${review.instruments[symbol].label} historical price and timing signals`,
    width: 1000, height: 282, axisFormat: priceText, describePoint: (row) => [
      `${phases[row.phase] || 'Unknown'} · ${stages[row.stage]} posture`, ...row.signals.map(signalEvidence).filter(Boolean),
    ] });
  const riskChart = chart(rows, [{ key: 'riskStage', label: 'Market risk posture', color: '#8bb7ca',
    value: (row) => row.stage === 'unknown' ? null : stageOrder.indexOf(row.stage), format: (value) => stages[stageOrder[value]] || 'Unknown' }], {
    width: 1000, height: 108, domain: [-1, 3], label: 'Historical market risk posture',
    axisFormat: (value) => stageAxis[value] || '',
  });
  return `<div class="timing-chart">${trendChart}</div><details class="timing-panel-details timing-risk-history">
    <summary>Risk posture history</summary>${riskChart}</details>`;
}

function auditTable(row, history, symbol) {
  const records = new Map();
  for (const { date, instruments } of history) {
    const instrument = instruments[symbol];
    for (const signal of instrument.signals) {
      if (signal.type === 'distribution') records.set(date, { ...signal, status: 'Historical' });
    }
    for (const expired of instrument.distribution.expired) {
      records.set(expired.date, { ...expired, status: `Expired · ${expiryLabels[expired.expiryReason]}` });
    }
  }
  for (const entry of row.distribution.active) records.set(entry.date, { ...entry, status: 'Active' });
  const detailRows = [...records.values()].sort((a, b) => b.date.localeCompare(a.date));
  return `<details class="timing-panel-details"${detailRows.some(({ status }) => status === 'Active') ? ' open' : ''}>
    <summary>Distribution audit <span class="muted">${count(row.distribution.count)} active</span>
    ${helpTooltip('timing-distribution-help', 'distribution counts and expiry', 'A decline of at least 0.20% qualifies when actual volume exceeds the preceding session. A count expires at age 25 sessions or when the close reaches 5% above its distribution close. The volume coverage count identifies gaps in the inputs.')}</summary>
    <div class="timing-audit-tools">
      <label>Find distribution dates <input type="search" data-timing-audit-search placeholder="YYYY-MM-DD or status"></label>
      <label><input type="checkbox" data-timing-audit-active checked> Active only</label>
      <span class="muted">${count(row.distribution.comparableSessions)} of ${count(row.distribution.expectedSessions)} sessions with volume comparisons</span>
    </div>
    <div class="table-scroll" role="region" aria-label="Distribution evidence for ${safe(symbol)}" tabindex="0"><table class="timing-audit">
      <thead><tr><th scope="col">Session</th><th scope="col">Close</th><th scope="col">Return</th><th scope="col">Volume</th><th scope="col">Prior volume</th><th scope="col">Status</th></tr></thead>
      <tbody>${detailRows.map((entry) => {
        const status = entry.status === 'Active' ? `Active · age ${entry.age}` : `${entry.status}${entry.expiredOn ? ` · ${entry.expiredOn}` : ''}`;
        return `<tr data-timing-audit-row data-active="${entry.status === 'Active'}" data-search="${safe(`${entry.date} ${status}`.toLowerCase())}"${entry.status === 'Active' ? '' : ' hidden'}>
          <th scope="row"><time datetime="${safe(entry.date)}">${safe(entry.date)}</time></th><td>${priceText(entry.close)}</td>
          <td class="negative">${rate(entry.return)}</td><td>${count(entry.volume)}</td><td>${count(entry.previousVolume)}</td><td>${safe(status)}</td></tr>`;
      }).join('')}<tr data-timing-audit-empty${row.distribution.active.length ? ' hidden' : ''}><td colspan="6">No matching distribution events.</td></tr></tbody>
    </table></div></details>`;
}

function breadthLens({ breadth, leadership, risk }) {
  const metric = (key) => breadth.metrics?.[key];
  const counts = (key) => metric(key)?.denominator > 0 ? count(metric(key).numerator) : '—';
  const lowerCoverage = [20, 50, 200].flatMap((days) => {
    const evidence = breadth.comparability?.[`above_${days}d`];
    return evidence && !evidence.usable ? [`${days}D ${count(evidence.observations)} of ${count(breadth.traded)}`] : [];
  });
  return `<div class="timing-lens">
    <div><strong>Observed breadth</strong><span class="muted">${safe(titleCase(breadth.state))}${breadth.traded ? ` · ${count(breadth.traded)} US Core stocks` : ''}</span></div>
    <div><strong>Above 20 / 50 / 200 SMA</strong><span>${['above_20d', 'above_50d', 'above_200d'].map((key) => percent(metric(key)?.value)).join(' / ')}</span>
      ${lowerCoverage.length ? `<small class="muted">Lower coverage · ${safe(lowerCoverage.join(' · '))} comparable</small>` : ''}</div>
    <div><strong>20D highs / lows</strong><span>${counts('new_high_20d')} / ${counts('new_low_20d')}</span></div>
    <div><strong>Volume and breakouts</strong><span>Up ${supplyText(breadth.volume?.up)} / down ${supplyText(breadth.volume?.down)} · ${counts('breakout_20d')} breakouts</span></div>
    <div><strong>Lagged leader response</strong><span class="${direction(leadership.return5d)}">${rateText(leadership.return5d)} · ${count(leadership.comparable)} of 5 sessions</span></div>
    <div><strong>Personal trade feedback</strong><span class="muted">${safe(titleCase(risk.personalTradeFeedback))}</span></div>
  </div>`;
}

function trendDetails(row) {
  if (!row.trend) return '';
  return `<details class="timing-panel-details"><summary>Moving averages and slopes</summary>
    <div class="timing-lens">${[['ema21', '21D EMA'], ['sma20', '20D SMA'], ['sma50', '50D SMA'], ['sma150', '150D SMA'], ['sma200', '200D SMA']].map(([key, label]) =>
      `<div><strong>${label}</strong><span>${priceText(row.trend.averages[key])}</span>
        <small class="${direction(row.trend.slopes[key])}">${rateText(row.trend.slopes[key])} · 5-session slope</small></div>`).join('')}</div></details>`;
}

function methodology(review) {
  return `<details class="timing-panel-details"><summary>Method and sources</summary>
    <div class="timing-method">
      <p>Split-adjusted benchmark prices as of each session use reconstructed warehouse revision ${safe(review.dataVersion)}. The S&P 500 and Nasdaq-100 ETFs are proxies with their own share volume. Nasdaq Composite uses reported index volume.</p>
      <p>Two closes below the 20-session average with the latest close below the 50-session average establish a correction. After confirmation, a fresh break of those averages can reopen correction. An up close starts a rally attempt. The correction low anchors the rally. Undercutting it resets the rally count. Breaking the first follow-through low returns the benchmark to correction.</p>
      <p>Follow-through requires at least +1.25% from rally day 4 and strictly higher volume than the previous exchange session. Distribution requires a decline of at least 0.20% on strictly higher volume. Counts expire at age 25 sessions or at 5% close recovery. Missing price breaks trend continuity. Missing or quarantined volume withholds the comparison.</p>
      <p>The strength checklist needs 10 consecutive lows above EMA21, 5 sessions of EMA21 above SMA50, a rising five-session SMA50 slope and a nonnegative close-to-close return. Crossing below SMA50 exits the checklist. EMA and SMA readings initialize from contiguous observed closes.</p>
      <p>Risk posture uses SPY and Nasdaq Composite, participation and five compounded daily responses of each prior session’s top-decile cohort where coverage allows. ${safe(review.session.risk.conditions.constructive)} ${safe(review.session.risk.conditions.increaseRisk)}</p>
      <p class="muted">${safe(review.profile.label)} · ${safe(review.modelVersion)}</p>
      <div class="timing-reference-links">${review.profile.references.map(({ label, url }) => `<a class="text-link" href="${safe(url)}" target="_blank" rel="noreferrer">${safe(label)}</a>`).join('')}</div>
    </div></details>`;
}

const unavailableMessages = {
  'unsupported-basis': 'Switch to the reconstructed data basis to view the prepared session review.',
  'before-benchmark-history': 'The selected session precedes loaded benchmark history.',
  'no-market-session': 'Load benchmark prices to view a session review.',
};

const retryMessage = '<p class="timing-load-error" role="status">Session review could not be loaded. <button class="text-link" type="button" data-action="timing-retry">Retry</button></p>';

export function timingPanel(review, symbol, range, { loading = false, failed = false } = {}) {
  if (review?.state !== 'ready') return `<section class="panel panel-body timing-review"><h2>Session review</h2>
    ${failed ? retryMessage : `<p class="muted" role="status">${safe(loading ? 'Loading session review…' : unavailableMessages[review?.reason] ?? review?.action ?? 'Session review is unavailable.')}</p>`}</section>`;
  const instrument = review.instruments[symbol];
  const row = review.session.instruments[symbol];
  const { risk } = review.session;
  const history = review.history.slice(-range);
  const events = row.signals.map(signalEvidence).filter(Boolean);
  const volumeText = row.evidence.higherVolume == null ? 'Prior-session volume comparison unavailable'
    : `Volume ${supplyText(row.evidence.volume)} vs ${supplyText(row.evidence.previousVolume)}`;
  const support = row.trend?.support;
  const supportText = (reading) => reading?.side ? `${titleCase(reading.side)} · ${reading.days} ${reading.days === 1 ? 'session' : 'sessions'}` : 'Warming up';
  return `<section class="panel panel-body timing-review">
    <header class="timing-head"><div><h2>Session review ${helpTooltip('timing-warmup-help', 'unknown and warming-up readings', 'The model initializes from contiguous observations. Missing or quarantined prices reset trend and rally continuity. Volume comparisons require two adjacent sessions with positive, usable volumes from the same series.')}</h2>
      <p class="muted">${safe(sessionDate(review.date))} · Market risk posture <strong class="${tone(risk.stage)}">${safe(stages[risk.stage])}</strong></p></div>
      ${segment('timing-instrument', Object.keys(review.instruments).map((key) => [key, key]), symbol)}
    </header>
    <div class="timing-chart-head"><div><h3>${safe(symbol)} <span class="muted">${safe(instrument.label)}</span></h3>
      <p class="muted">${safe(instrument.volume)}</p></div>${rangeSegment('timing-range', range)}</div>
    <div class="timing-readings"><span><b>${safe(phaseLabel(row))}</b> ${helpTooltip('timing-rally-help', 'rally count and follow-through', 'An up close after a correction starts day 1. The correction low anchors the attempt. An undercut resets it. From day 4, a gain of at least 1.25% on greater actual volume than the preceding session confirms the attempt.')}</span>
      <span class="${direction(row.evidence.dayReturn)}">${rateText(row.evidence.dayReturn)}</span><span class="muted">${safe(volumeText)}</span>
      ${row.rally ? `<span class="muted">Rally low ${priceText(row.rally.low)} · ${safe(sessionDate(row.rally.lowDate))}</span>` : ''}
      ${row.confirmation ? `<span class="muted">First follow-through ${safe(sessionDate(row.confirmation.date))} · low ${priceText(row.confirmation.low)}</span>` : ''}
      ${row.warmup ? '<span class="muted">Trend warmup</span>' : ''}</div>
    ${timingChart(review, symbol, history)}
    ${loading ? '<p class="muted" role="status">Loading selected history…</p>' : ''}
    ${failed ? retryMessage : ''}
    <div class="timing-readings timing-technical"><span><b>Trend ${safe(titleCase(row.trend?.state))}</b></span>
      <span>20D SMA ${safe(supportText(support?.sma20))}</span><span>50D SMA ${safe(supportText(support?.sma50))}</span>
      ${row.trend?.strongTrend.active ? '<span class="positive">Strong-trend checklist active</span>' : ''}
      ${(row.pressure || []).map((key) => `<span class="negative">${safe(guards[key])}</span>`).join('')}</div>
    ${events.length ? `<ul class="timing-events" aria-label="Selected session signals">${events.map((label) => `<li>${safe(label)}</li>`).join('')}</ul>` : ''}
    ${breadthLens(review.session)}
    ${auditTable(row, history, symbol)}
    ${trendDetails(row)}
    ${methodology(review)}
  </section>`;
}

function bindAudit(root) {
  const search = root.querySelector('[data-timing-audit-search]');
  const active = root.querySelector('[data-timing-audit-active]');
  const empty = root.querySelector('[data-timing-audit-empty]');
  if (!search || !active || !empty) return;
  const rows = root.querySelectorAll('[data-timing-audit-row]');
  const filter = () => {
    const query = search.value.trim().toLowerCase();
    let shown = 0;
    for (const row of rows) {
      row.hidden = active.checked && row.dataset.active !== 'true' || !row.dataset.search.includes(query);
      if (!row.hidden) shown++;
    }
    empty.hidden = shown > 0;
  };
  search.addEventListener('input', filter);
  active.addEventListener('change', filter);
}

export function createTimingReview(env, point) {
  const { signal, state } = env;
  let summary, panel, review, request, loaded = 0, failed = false;
  state.timingRange ||= 63;
  state.timingInstrument ||= 'IXIC';
  function paint(loading = false, focus) {
    if (summary?.isConnected) summary.innerHTML = timingSummary(review);
    if (!panel?.isConnected) return;
    panel.innerHTML = timingPanel(review, state.timingInstrument, state.timingRange, { loading, failed });
    bindHelpTooltips(panel);
    bindAudit(panel);
    if (focus) panel.querySelector(`[data-action="${focus}"][aria-pressed="true"]`)?.focus({ preventScroll: true });
  }
  async function load(focus) {
    const limit = panel ? state.timingRange : 1;
    if (!point.date || loaded >= limit || review && review.state !== 'ready') {
      failed = false;
      return paint(false, focus);
    }
    if (request && request.limit >= limit) return paint(true, focus);
    request?.controller.abort();
    const token = { limit, controller: new AbortController() };
    request = token;
    failed = false;
    paint(true, focus);
    try {
      const result = await env.api('market/timing', { plain: true, signal: signal ? AbortSignal.any([signal, token.controller.signal]) : token.controller.signal,
        params: { ...point, limit } });
      if (request !== token || !env.isActive()) return;
      review = result;
      loaded = limit;
      paint(false, focus);
    } catch (error) {
      if (request === token && env.isActive() && error.name !== 'AbortError') {
        failed = true;
        paint(false, focus);
      }
    } finally {
      if (request === token) request = null;
    }
  }
  return {
    mount(summaryTarget, panelTarget) {
      summary = summaryTarget;
      panel = panelTarget;
      if (summary || panel) loadStyles((summary || panel).ownerDocument);
      return load();
    },
    instrument(symbol) {
      if (!review?.instruments?.[symbol]) return;
      state.timingInstrument = symbol;
      paint(!!request, 'timing-instrument');
    },
    range(value) {
      const range = Number(value);
      if (!chartRanges.some(([sessions]) => sessions === range)) return;
      state.timingRange = range;
      return load('timing-range');
    },
    retry: () => load(),
  };
}
