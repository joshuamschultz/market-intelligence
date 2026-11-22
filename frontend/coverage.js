import { count, dateLabel, empty, icon, safe } from './ui.js';

const common = 'Operating common stocks';
export const marketUniverses = [
  { id: 'us-core', name: 'US Core', definition: `${common} on NYSE and Nasdaq` },
  { id: 'us-extended', name: 'US Extended', definition: `${common} on NYSE, Nasdaq, and NYSE American` },
  { id: 'us-all', name: 'US All Listed', definition: 'All supported downloaded listed types, including ETFs and other non-common securities. Excludes index benchmarks.' },
  { id: 'liquid-us', name: 'Liquid US', definition: 'NYSE and Nasdaq common stocks with a price of at least $5 and 20-session average daily dollar volume of at least $10 million' },
  { id: 'small-cap', name: 'Small Caps', definition: 'NYSE and Nasdaq common stocks with dated market capitalization of $300 million to $2 billion' },
  { id: 'nyse', name: 'NYSE Common', definition: 'Operating common stocks listed on NYSE' },
  { id: 'nasdaq', name: 'Nasdaq Common', definition: 'Operating common stocks listed on Nasdaq' },
];
export const universeDefinition = (id) => marketUniverses.find((universe) => universe.id === id)?.definition;
export const industryDataNames = {
  nasdaq: 'Nasdaq directory', 'sec-sic': 'SEC/SIC filings', provider: 'Price provider taxonomy',
};
export const industryDataExplanation = 'Industry data groups securities by business activity. The Universe selection determines listing and eligibility rules.';

export function priceProvider(status) {
  const provider = status?.runs?.find((run) => run.status === 'complete' && run.rows > 0)?.provider
    || (status?.provider === 'eodhd' ? status.provider : null);
  return provider?.toUpperCase() || null;
}

const validCount = (value) => Number.isInteger(value) && value >= 0 ? value : null;

function reading(point, result) {
  const coverage = result?.coverage;
  const preparation = result?.preparation || result?.materialization;
  if (result?.pendingOnly || coverage?.state === 'unprepared') {
    return { status: { running: 'Preparing', queued: 'Queued', failed: 'Preparation failed' }[preparation?.preparationState] || 'Not prepared' };
  }
  if (result?.date !== point.date || result?.dataVersion != null && String(result.dataVersion) !== String(point.dataVersion)) {
    return { status: 'Requested snapshot unavailable' };
  }
  const eligible = validCount(coverage?.listed);
  const traded = validCount(coverage?.traded);
  const ranked = validCount(coverage?.ranked);
  if (eligible != null && traded != null && traded > eligible || traded != null && ranked != null && ranked > traded) {
    return { status: 'Counts unavailable' };
  }
  const missing = eligible != null && traded != null ? eligible - traded : null;
  return { eligible, traded, ranked, missing,
    status: [eligible, traded, ranked].every((value) => value != null) ? 'Available' : 'Some counts unavailable' };
}

function row(universe, isSelected, values = { status: 'Loading' }) {
  const counts = ['eligible', 'traded', 'ranked', 'missing'].map((key) =>
    `<td class="numeric" data-count="${key}">${count(values[key])}</td>`).join('');
  return `<tr data-universe-count="${universe.id}"${isSelected ? ' class="universe-count-selected"' : ''}>
    <th scope="row"><strong>${safe(universe.name)}</strong>${isSelected ? ' <span class="muted">(selected)</span>' : ''}
      <div class="muted">${safe(universe.definition)}</div></th>${counts}
    <td class="muted">${safe(values.status)}</td></tr>`;
}

export async function loadUniverseCounts(env, point, { signal, update }) {
  await Promise.all(marketUniverses.map(async (universe) => {
    if (!point?.date || point.dataVersion == null) {
      update(universe, { status: 'Dated counts unavailable' });
      return;
    }
    const selected = env.config?.universes?.find(({ id }) => id === universe.id);
    const params = { ...point, universe: universe.id,
      universeVersion: (universe.id === point.universe && point.universeVersion) || selected?.version || 1 };
    let values;
    try {
      values = reading(point, await env.api('market/overview', { signal, params }));
    } catch {
      values = { status: 'Counts unavailable' };
    }
    if (!signal?.aborted) update(universe, values);
  }));
}

export function universeCountFacts(values) {
  if (!values || values.eligible == null && values.traded == null && values.ranked == null) {
    return `<p class="muted">${safe(values?.status || 'Loading dated counts…')}</p>`;
  }
  const entries = [['Eligible', values.eligible], ['Traded', values.traded], ['RS-ranked', values.ranked], ['No usable price', values.missing]];
  return `<dl class="universe-count-facts">${entries.map(([label, value]) =>
    `<div><dt>${label}</dt><dd class="numeric">${count(value)}</dd></div>`).join('')}</dl>`;
}

export async function openCoverageDrawer(env, point) {
  const source = priceProvider(env.config?.status);
  const industry = industryDataNames[point.classification] || point.classification;
  const model = env.config?.models?.find(({ id, version }) => id === point.model &&
    (point.modelVersion == null || String(point.modelVersion) === String(version)))?.name || point.model;
  const catalog = env.config?.status;
  const body = env.showDialog(env.detail, 'Universe counts', !point.date || point.dataVersion == null
    ? empty('Dated counts unavailable', 'Select a price session with an available warehouse revision.', 'layers')
    : `<div class="stack">
      <p class="muted coverage-sources">${safe([source && `Prices: ${source}`, industry && `Industry data: ${industry}`, model && `RS model: ${model}`].filter(Boolean).join(' · '))}</p>
      <p class="muted">Common-stock universes exclude identified ETFs, ADRs, REITs, preferred shares, warrants, rights, and units.</p>
      <div class="table-scroll" role="region" aria-label="Dated universe counts" tabindex="0">
        <table class="universe-counts"><thead><tr><th scope="col">Universe definition</th><th scope="col">Eligible</th>
        <th scope="col">Traded</th><th scope="col">RS-ranked</th><th scope="col">No usable price</th><th scope="col">Status</th></tr></thead>
        <tbody>${marketUniverses.map((universe) => row(universe, universe.id === point.universe)).join('')}</tbody></table>
      </div>
      <p class="muted" id="universe-counts-progress" role="status">Loading dated universe counts…</p>
      <p class="muted">Eligible counts are for the selected session. A breadth metric can use a smaller comparable denominator based on the history that metric requires.</p>
      ${validCount(catalog?.securities) != null
        ? `<p class="muted"><strong>Warehouse catalog</strong> · ${count(catalog.securities)} security records${catalog.dataVersion != null ? ` at revision ${safe(catalog.dataVersion)}` : ''}. This includes historical records across all dates.</p>` : ''}
      <a class="text-link" href="${safe(env.routeUrl('settings', { tab: 'jobs', date: null, dataVersion: null }))}">Data &amp; jobs ${icon('chevron-right')}</a>
    </div>`, point.date && point.dataVersion != null ? `${dateLabel(point.date)} · Revision ${point.dataVersion}` : '');
  if (!point.date || point.dataVersion == null) return;
  const controller = new AbortController();
  const { signal } = controller;
  const stop = () => controller.abort();
  const events = ['close', 'workspace:dialog-change'];
  for (const type of events) env.detail.addEventListener(type, stop, { once: true });
  env.signal?.addEventListener('abort', stop, { once: true });
  const active = () => !signal.aborted && body.isConnected && env.detail.open;
  try {
    await loadUniverseCounts(env, point, { signal, update(universe, values) {
      if (active()) body.querySelector(`[data-universe-count="${universe.id}"]`).outerHTML = row(universe, universe.id === point.universe, values);
    } });
    if (active()) body.querySelector('#universe-counts-progress').remove();
  } finally {
    for (const type of events) env.detail.removeEventListener(type, stop);
    env.signal?.removeEventListener('abort', stop);
  }
}
