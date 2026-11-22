import {
  action, attr, blobDownload, count, dateLabel, empty, field, heading, icon, iconButton, names, notice, option, pathPart, pending, safe, savedScreenRoute,
} from './ui.js';
import { exportChart } from './charts.js';
import { industryDataExplanation, industryDataNames, openCoverageDrawer, priceProvider, universeDefinition } from './coverage.js';
import { helpTopic, loadHelp, searchHelp } from './help.js';

const viewModules = {
  overview: () => import('./overview.js'),
  monitor: () => import('./monitor.js'),
  screener: () => import('./screener.js'),
  rankings: () => import('./screener.js'),
  stocklists: () => import('./screener.js'),
  chartbook: () => import('./chartbook.js'),
  industries: () => import('./research.js'),
  history: () => import('./research.js'),
  journal: () => import('./journal.js'),
  screens: () => import('./library.js'),
  watchlists: () => import('./library.js'),
  stock: () => import('./ticker.js'),
  alerts: () => import('./library.js'),
  settings: () => import('./library.js'),
};
const main = document.querySelector('#main');
const contextBar = document.querySelector('#context-bar');
const contextToggle = document.querySelector('#context-toggle');
const replayBanner = document.createElement('aside');
replayBanner.id = 'historical-replay';
replayBanner.className = 'historical-replay';
replayBanner.hidden = true;
contextBar.after(replayBanner);
const modal = document.querySelector('#modal');
const detail = document.querySelector('#detail');
const help = document.querySelector('#help');
const feedback = document.querySelector('#feedback');
const store = {};
const registrations = new Map();
let config = null;
let configError = '';
let analysisStatus = null;
let activeImport = null;
let activePreparation = null;
let activeAnalysisJob = false;
let lastStatusCheck = 0;
let lastInteraction = Date.now();
const batchRefreshMs = 30 * 60 * 1000;
const startupRetryDelays = [400, 1200];
const refreshableViews = new Set(['overview', 'monitor']);
const listViews = new Set(['rankings', 'screener', 'stocklists', 'watchlists']);
const compactContextViews = new Set(['chartbook', 'screens', 'watchlists', 'settings', 'journal', 'alerts']);
for (const type of ['pointerdown', 'keydown', 'input', 'scroll']) {
  document.addEventListener(type, () => { lastInteraction = Date.now(); }, { capture: true, passive: true });
}
let activeView = null;
let generation = 0;
let feedbackTimer;
let buildVersion;
let buildInfo;
let nextBuildVersion;
let checkRunning = false;
let returningToLatest = false;
const routePreparations = new Map();
const contextKeys = ['universe', 'date', 'model', 'benchmark', 'basis', 'classification', 'universeVersion', 'modelVersion', 'dataVersion', 'healthModel', 'reference'];
const recipeKeys = ['universe', 'universeVersion', 'model', 'modelVersion', 'benchmark', 'basis', 'classification', 'reference'];

for (const element of document.querySelectorAll('[data-icon]')) element.insertAdjacentHTML('afterbegin', icon(element.dataset.icon));

function routeFromUrl(hash = location.hash) {
  const [target, query] = hash.slice(1).split('?');
  const page = Object.hasOwn(names, target) ? target : 'overview';
  const state = Object.fromEntries(new URLSearchParams(query));
  return { page, state };
}
let route = routeFromUrl();

function observeBuild(latest) {
  if (!latest) return;
  if (buildVersion && latest.version !== buildVersion) nextBuildVersion = latest.version;
  buildVersion ||= latest.version;
  if (latest.version === buildVersion) buildInfo = latest;
}

function currentContext(selection = route) {
  const { state } = selection;
  const defaults = {
    universeVersion: config?.universes?.find((item) => item.id === (state.universe || 'us-core'))?.version,
    modelVersion: config?.models?.find((item) => item.id === (state.model || 'composite'))?.version,
    universe: 'us-core', model: 'composite', benchmark: config?.availableBenchmarks?.includes('SPY') ? 'SPY' : config?.availableBenchmarks?.includes('VTI') ? 'VTI' : config?.availableBenchmarks?.[0] || 'SPY',
    basis: 'reconstructed',
    classification: state.date && config?.classificationSystems?.includes('sec-sic') ? 'sec-sic' : config?.defaultClassification || 'provider',
    healthModel: 'default', reference: state.date || state.basis === 'known' ? 'as-of' : 'latest',
  };
  return Object.fromEntries(contextKeys.flatMap((key) => {
    const selected = state[key];
    const value = selected === 'auto' ? defaults[key] : selected ?? defaults[key];
    return value == null || value === '' ? [] : [[key, value]];
  }));
}

function routeUrl(page, patch = {}, includeParams = false) {
  const options = includeParams ? { ...currentContext(), ...route.state, ...patch } : { ...currentContext(), ...patch };
  for (const key of ['classification','reference','benchmark']) {
    if (!route.state[key] && !Object.hasOwn(patch,key)) delete options[key];
    if (options[key] === 'auto') delete options[key];
  }
  const query = new URLSearchParams(Object.entries(options).filter(([, value]) => value != null && value !== ''));
  return `#${page}${query.size ? `?${query}` : ''}`;
}

function go(page, patch = {}, replace = false) {
  const hash = routeUrl(page, patch, page === route.page);
  if (hash === location.hash) return render();
  if (replace) {
    history.replaceState(null, '', hash);
    route = routeFromUrl();
    return render();
  }
  location.hash = hash;
}

async function api(path, options = {}) {
  const params = new URLSearchParams(Object.entries({ ...(!options.plain ? currentContext() : {}), ...options.params })
    .filter(([, value]) => value != null && value !== ''));
  const suffix = params.size ? `?${params}` : '';
  const response = await fetch(`/api/v1/${path}${suffix}`, {
    method: options.method || (options.body != null ? 'POST' : 'GET'),
    cache: 'no-store',
    headers: options.body != null ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body == null ? undefined : JSON.stringify(options.body), signal: options.signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw Object.assign(new Error(payload.error || `Request failed (${response.status})`), { status: response.status });
  }
  if (options.file && response.headers.get('content-type')?.includes('application/json')) {
    const payload = await response.json();
    throw new Error(payload.error || 'The export is still being prepared.');
  }
  return options.file ? response.blob() : response.json();
}

function waitForNextCheck(ms, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

async function publishedSeries(path, options = {}, onProgress = () => {}, request = api) {
  const { signal } = options;
  let response = options.initialResponse || await request(path, options);
  const observedJobs = new Set();
  while (response.materialization?.pending || response.materialization?.captureInProgress) {
    const materialization = response.materialization;
    if (materialization.captureInProgress) {
      let capture;
      do {
        onProgress(response, { status: 'waiting_for_capture', capture });
        await waitForNextCheck(15000, signal);
        capture = (await api('data/status', { plain: true, signal })).bootstrap;
      } while (capture?.active);
      response = await request(path, options);
      continue;
    }
    let job = { id: materialization.jobId, status: materialization.status || 'queued', progress: materialization.progress };
    if (!job.id || observedJobs.has(job.id)) throw new Error('Publication has not completed. Retry to check the requested history.');
    observedJobs.add(job.id);
    while (job.status === 'queued' || job.status === 'running') {
      onProgress(response, job);
      await waitForNextCheck(900, signal);
      job = await api(`jobs/${pathPart(job.id)}`, { plain: true, signal });
    }
    if (job.status !== 'complete') throw new Error(job.error || 'Historical calculations could not be published.');
    response = await request(path, options);
  }
  if (response.pendingOnly && response.materialization?.preparationState && response.materialization.prepareAction !== 'range') {
    throw new Error(response.materialization.error || 'This calculation is not prepared for the selected session. Use Settings & Data → Jobs to prepare its context.');
  }
  return response;
}

function requestFor(context, observe) {
  return async (path, options = {}) => {
    const params = { ...(!options.plain ? context : {}), ...options.params };
    const result = await api(path, { ...options, params });
    if (!options.plain && params.date === context.date && recipeKeys.every((key) => params[key] === context[key])) {
      observe?.(path, result?.preparation || result?.materialization);
    }
    return result;
  };
}

function snapshotContext() {
  const context = currentContext();
  const dataVersion = context.dataVersion ?? analysisStatus?.dataVersion;
  const liveListDate = currentListRoute() ? analysisStatus?.latestDate : null;
  return { ...context, ...(dataVersion == null ? {} : { dataVersion }), ...(liveListDate ? { date: liveListDate } : {}) };
}

function toast(message) {
  clearTimeout(feedbackTimer);
  feedback.textContent = message;
  feedback.hidden = false;
  feedbackTimer = setTimeout(() => { feedback.hidden = true; }, 4200);
}

const analysisStorageKey = 'market-intelligence.analysis-revision';
function applyAnalysisStatus(status) {
  analysisStatus = { ...status, appliedAt: status.appliedAt || Date.now() };
  try {
    window.sessionStorage.setItem(analysisStorageKey, JSON.stringify({
      dataVersion: status.dataVersion, latestDate: status.latestDate, state: status.state, appliedAt: analysisStatus.appliedAt,
    }));
  } catch {
    // Analysis state remains available for the current page.
  }
}
function listAnalysisStatus(status, options) {
  const prepared = preparedAnalysisStatus(status, options);
  if (prepared) return prepared;
  const ready = status?.latestAnalysis;
  return ready && { ...status, latestDate: ready.date, dataVersion: ready.dataVersion, appliedAt: undefined };
}
function preparedAnalysisStatus(status, { allowPinned = false, selection = route } = {}) {
  if (!status?.preparation?.total || !allowPinned && (selection.state.date || selection.state.dataVersion)) return null;
  const point = currentPreparationPoint(status, selection);
  return point?.stages?.current === 'complete' && point.stages.recent === 'complete'
    ? { ...status, latestDate: point.date, dataVersion: status.preparation.dataVersion, appliedAt: undefined } : null;
}
function currentPreparationPoint(status, selection = route) {
  const context = currentContext(selection);
  return status?.preparation?.contexts?.find((item) => item.date === status.latestDate &&
    recipeKeys.every((key) => item[key] == null || String(item[key]) === String(context[key])));
}
const historicalBackfill = (job) => ['recent', 'history'].includes(job?.phase || job?.payload?.phase);
function dataUpdateCandidate() {
  const status = config?.status;
  if (!status) return null;
  const next = listViews.has(route.page) || config.automaticPreparation && route.page === 'stock'
    ? listAnalysisStatus(status, { allowPinned: true })
    : config.automaticPreparation && refreshableViews.has(route.page)
      ? preparedAnalysisStatus(status, { allowPinned: true }) : status;
  const current = snapshotContext();
  const displayedDate = current.date || analysisStatus?.latestDate;
  const displayedVersion = Number(current.dataVersion);
  const revision = Number(next?.dataVersion);
  if (!next?.latestDate || !Number.isInteger(revision) || revision < displayedVersion || next.latestDate < displayedDate) return null;
  return revision > displayedVersion || !route.state.date && !route.state.dataVersion && next.latestDate > displayedDate ? next : null;
}
function newerAnalysis(next, current) {
  if (!next?.latestDate) return false;
  if (!current) return true;
  const nextVersion = Number(next.dataVersion);
  const currentVersion = Number(current.dataVersion || 0);
  return nextVersion >= currentVersion && next.latestDate >= (current.latestDate || '') &&
    (nextVersion > currentVersion || next.latestDate > (current.latestDate || ''));
}
function currentListRoute() {
  return listViews.has(route.page) && !route.state.date && !route.state.dataVersion;
}
function canRefreshList() {
  if (!currentListRoute()) return false;
  if (route.page === 'watchlists') return store.watchlists?.live === true;
  if (route.page === 'screener') {
    const screen = config?.screens.find(({ id }) => id === route.state.screen);
    if (screen && savedScreenRoute(screen.definition).date) return false;
  }
  return !store[route.page]?.selected?.size;
}
function initialAnalysisStatus(status) {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(analysisStorageKey));
    if (Number.isInteger(saved?.dataVersion) && saved.dataVersion <= status.dataVersion && saved.latestDate) return saved;
  } catch {
    // A new tab defaults to the current warehouse revision.
  }
  if (config?.automaticPreparation) return listAnalysisStatus(status) || status;
  return status;
}

const importLabels = { 'provider-import': 'Importing prices', 'provider-bootstrap': 'Loading market history', 'provider-reference': 'Loading reference data' };
const calculationJobs = new Set(['prepare-context', 'prepare-stock-details', 'prepare-range', 'prepare-range-history', 'prepare-risk-history',
  'materialize', 'rank-materialize', 'workspace-precompute', 'production-precompute', 'health-precompute', 'optimized-five-year']);
const setIfChanged = (element, text) => { if (element.textContent !== text) element.textContent = text; };

function analysisReadinessLabel(status) {
  if (!status) return configError ? 'Analysis unavailable' : 'Checking analysis';
  const { analysisReadiness: proof, preparation } = status;
  const currentGeneration = !!proof?.date && proof.date === status.latestDate && proof.dataVersion != null &&
    Number(proof.dataVersion) === Number(status.dataVersion) && !!proof.calculationVersion && proof.calculationVersion === status.calculationVersion;
  const work = [preparation, ...Object.values(preparation?.phases || {}), preparation?.stockDetails, preparation?.stockDetails?.history,
    preparation?.ranges?.current, preparation?.ranges?.history].filter(Boolean);
  if (activeImport || activeAnalysisJob || status.bootstrap?.active || status.captureSchedule?.state === 'capturing' ||
      preparation?.current || preparation?.stockDetails?.current || work.some((group) => group.queued > 0 || group.running > 0) ||
      currentGeneration && proof.state === 'preparing') return 'Analysis preparing';

  // The daily publication and the registered job totals do not certify the full archive.
  const incomplete = work.some((group) => group.failed > 0 || group.superseded > 0 || group.cancelled > 0 ||
    group.total > 0 && group.complete !== group.total);
  return currentGeneration && proof.state === 'ready' && !incomplete ? 'Current analysis ready' : 'Analysis incomplete';
}

function footerStatus(status) {
  const writeFacts = (id, facts) => {
    const target = document.getElementById(id);
    const html = facts.filter(Boolean).map((value) => `<span>${safe(value)}</span>`).join('');
    if (target.innerHTML !== html) target.innerHTML = html;
  };
  writeFacts('footer-build', [
    buildInfo?.appVersion ? `App v${buildInfo.appVersion}` : 'Checking app version',
    buildInfo?.builtAt && `Built ${dateLabel(buildInfo.builtAt)}`,
  ]);
  writeFacts('footer-data', [
    status?.latestDate && `Prices through ${dateLabel(status.latestDate)}`,
    status?.lastSuccess && `Last import ${dateLabel(status.lastSuccess)}`,
    analysisReadinessLabel(status),
  ]);
}

function statusLine() {
  const status = config?.status;
  const visible = analysisStatus || status;
  const source = priceProvider(status);
  setIfChanged(document.querySelector('#source-name'), source ? `Prices: ${source}` : 'Market warehouse');
  const priceSource = document.querySelector('#context-price-source');
  if (priceSource) setIfChanged(priceSource, source ? `Prices: ${source}` : 'Price source unavailable');
  setIfChanged(document.querySelector('#source-caption'), visible?.latestDate ? `Through ${dateLabel(visible.latestDate)}`
    : configError ? 'Service unavailable' : 'No sessions loaded');
  const badge = document.querySelector('#data-badge');
  const available = visible?.state === 'available';
  const capture = status?.bootstrap;
  const histories = capture?.stages?.prices?.complete;
  const preparing = status?.preparation?.current;
  const active = preparing || activePreparation;
  const backfill = historicalBackfill(active);
  const update = capture?.active ? (Number.isInteger(histories) && histories > 0 ? `History import · ${count(histories)} symbols` : 'Loading market history')
    : activeImport ? `${importLabels[activeImport.type]} · ${count(activeImport.progress)}%`
    : active ? backfill ? `Historical backfill · ${count(active.progress)}%`
      : `Preparing ${config?.universes?.find(({id}) => id === preparing?.universe)?.name || 'analytics'} · ${count(active.progress)}%` : '';
  const contents = configError ? '<span class="status-dot"></span> Service unavailable'
    : update ? `<span class="status-dot syncing"></span>
      <button class="status-action" data-action="warehouse-jobs" type="button" title="View warehouse jobs">${safe(update)}</button>`
      : visible?.latestDate ? `<span class="status-dot ${available ? 'live' : ''}"></span><span>${available ? 'EOD data' : 'Partial EOD data'}</span>`
        : '<span class="status-dot"></span> Awaiting data';
  if (badge.innerHTML !== contents) badge.innerHTML = contents;
  const view = snapshotContext();
  const viewDate = view.date || visible?.latestDate;
  badge.title = viewDate ? `Analysis through ${dateLabel(viewDate)} · revision ${view.dataVersion ?? 'unknown'}` : '';
  document.querySelector('.data-source .status-dot').classList.toggle('live', available);
  footerStatus(status);
  const selectedDate = currentContext().date;
  replayBanner.hidden = !selectedDate || !status?.latestDate || selectedDate >= status.latestDate;
  if (replayBanner.hidden) {
    if (replayBanner.hasChildNodes()) replayBanner.replaceChildren();
  } else {
    const content = `<strong role="status">Historical replay · ${safe(dateLabel(selectedDate))}</strong>${action('Return to latest', 'current', 'clock',
      { disabled: returningToLatest })}`;
    if (replayBanner.innerHTML !== content) replayBanner.innerHTML = content;
  }
}

function updateContextIndicators() {
  const markup = [];
  if (nextBuildVersion) markup.push(action('Reload build', 'reload-build', 'refresh', { className: 'updated-button' }));
  const update = dataUpdateCandidate();
  if (update) {
    markup.push(action('Update data', 'apply-data', 'pulse', { className: 'updated-button',
      title: `View warehouse revision ${update.dataVersion}. Current view uses revision ${snapshotContext().dataVersion}.` }));
  }
  if (config?.automaticPreparation && routePreparations.size) {
    const states = [...routePreparations.values()];
    const state = states.find((item) => ['unregistered', 'failed', 'superseded'].includes(item)) || states[0];
    if (['unregistered', 'failed', 'superseded'].includes(state)) {
      markup.push(action(state === 'failed' ? 'Retry context preparation' : 'Prepare this context', 'prepare-context', 'refresh'));
    } else if (['queued', 'running'].includes(state)) {
      markup.push('<span class="muted" role="status">Preparing this context…</span>');
    }
  }
  const target = contextBar.querySelector('#context-updates');
  const content = markup.join('');
  if (target && target.innerHTML !== content) target.innerHTML = content;
}

function registerContext(selection, { retry = false } = {}) {
  const context = currentContext(selection);
  const followLatest = !context.date && !context.dataVersion;
  const key = JSON.stringify([...recipeKeys, 'date', 'dataVersion'].map((field) => String(context[field] ?? '')));
  const existing = registrations.get(key);
  if (existing?.pending || (!retry && existing)) return existing.promise;
  const entry = { pending: true };
  entry.promise = api('data/preparation', { plain: true, body: { context: { ...context, followLatest }, retry } })
    .then((result) => {
      if (result.waitingForCapture) registrations.delete(key);
      return result;
    })
    .catch((error) => { registrations.delete(key); throw error; })
    .finally(() => { entry.pending = false; });
  registrations.set(key, entry);
  return entry.promise;
}

async function requestConfig(signal, retryTransient) {
  const delays = retryTransient ? startupRetryDelays : [];
  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(10000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await api('config', { plain: true, signal: requestSignal });
    } catch (error) {
      signal?.throwIfAborted();
      const transient = error.name === 'TypeError' || error.name === 'TimeoutError' || [502, 503, 504].includes(error.status);
      if (!transient || attempt === delays.length) throw error;
      await waitForNextCheck(delays[attempt], signal);
    }
  }
}

async function reloadConfig({ signal, retryTransient = false } = {}) {
  try {
    const settings = await requestConfig(signal, retryTransient);
    const screensTimeout = AbortSignal.timeout(5000);
    const screensSignal = signal ? AbortSignal.any([signal, screensTimeout]) : screensTimeout;
    const screens = await api('screens', { plain: true, signal: screensSignal }).catch(() => config?.screens || []);
    signal?.throwIfAborted();
    config = { ...settings, screens };
    if (!buildInfo) observeBuild(settings.build);
    if (!analysisStatus) applyAnalysisStatus(initialAnalysisStatus(config.status));
    configError = '';
  } catch (error) {
    if (signal?.aborted) throw error;
    configError = error.message;
    statusLine();
    return null;
  }
  statusLine();
  contextControls();
  return config;
}

function contextOptions(options, key, label, display = (item) => item.name, description) {
  const context = currentContext();
  const selected = ['classification', 'reference','benchmark'].includes(key) ? route.state[key] || 'auto' : context[key];
  const values = options.map((item) => typeof item === 'string' ? { id: item, name: item } : item);
  const descriptionId = `context-${key}-description`;
  return `<label class="context-field"${attr('title', description)}><span>${safe(label)}</span>
    ${description ? `<span id="${descriptionId}" class="sr-only">${safe(description)}</span>` : ''}
    <select data-change="context" data-value="${key}" aria-label="${safe(label)}"${attr('aria-describedby', description ? descriptionId : null)}>
    ${values.some((item) => item.id === selected) ? '' : option(selected || '', selected || 'Select', selected)}
    ${values.map((item) => option(item.id, display(item), selected)).join('')}</select></label>`;
}

function contextControls() {
  if (!config) return;
  const context = currentContext();
  const source = priceProvider(config.status);
  contextBar.innerHTML = contextOptions(config.universes || [], 'universe', 'Universe', undefined, universeDefinition(context.universe)) +
    `<button type="button" class="button" data-action="universe-counts" aria-haspopup="dialog" aria-controls="detail">${icon('layers')}Universe counts</button>` +
    `<label class="context-field"><span>As of</span><input type="date" aria-label="As-of date" data-change="context" data-value="date"${attr('value', context.date || analysisStatus?.latestDate || config.status?.latestDate)} max="${safe(config.status?.latestDate || '')}"></label>
    ${context.date || context.dataVersion ? iconButton('Return to latest session', 'current', 'clock') : ''}` +
    contextOptions(config.models || [], 'model', 'RS model') +
    contextOptions(['auto', ...(config.benchmarks || [])], 'benchmark', 'Benchmark', (item) =>
      item.id === 'auto' ? `Auto · ${context.benchmark}` : config.availableBenchmarks?.includes(item.id) ? item.name : `${item.name} (unavailable)`) +
    contextOptions([{ id: 'reconstructed', name: 'Reconstructed' }, { id: 'known', name: 'Known then' }], 'basis', 'Data basis') +
    contextOptions(['auto', ...(config.classificationSystems || ['provider'])], 'classification', 'Industry data', (item) =>
      item.id === 'auto' ? `Auto · ${industryDataNames[context.classification] || context.classification}`
        : industryDataNames[item.id] || item.name, industryDataExplanation) +
    `<span class="chip" id="context-price-source">${safe(source ? `Prices: ${source}` : 'Price source unavailable')}</span>` +
    contextOptions([
      { id: 'auto', name: context.reference === 'latest' ? 'Auto · latest capture' : 'Auto · as of session' },
      { id: 'latest', name: 'Latest capture (current only)' }, { id: 'as-of', name: 'As of session' },
    ], 'reference', 'Reference') +
    `<label class="context-field"><span>Saved view</span><select data-change="saved-view" aria-label="Saved view">${option('', 'Select view', '')}
      ${(config.screens || []).map((item) => option(item.id, item.name, route.state.screen)).join('')}</select></label>
    <span class="context-spacer"></span><span id="context-updates" class="inline-stack"></span>
    ${iconButton('Check for data updates', 'refresh', 'refresh')}`;
  updateContextIndicators();
}

function contextVisibility() {
  const compact = compactContextViews.has(route.page);
  const opened = detail.open && detail.contains(contextBar);
  contextBar.hidden = compact && !opened;
  contextToggle.hidden = !compact;
  contextToggle.setAttribute('aria-expanded', String(opened));
}

function restoreContextBar() {
  if (!detail.contains(contextBar)) return;
  replayBanner.before(contextBar);
  contextVisibility();
}

function openContext(opener) {
  if (!compactContextViews.has(route.page)) return;
  const controls = showDialog(detail, 'Analysis context', '', '', opener);
  controls.classList.add('context-drawer-body');
  controls.append(contextBar);
  contextVisibility();
  contextBar.querySelector('select')?.focus();
}

function navState() {
  const title = names[route.page];
  document.body.classList.toggle('chartbook-route', route.page === 'chartbook');
  document.title = `${title} | Market Intelligence`;
  document.querySelector('#breadcrumb-page').textContent = title;
  helpButton.title = `Help for ${title}`;
  helpButton.setAttribute('aria-label', helpButton.title);
  document.querySelector('#footer-jobs').href = routeUrl('settings', { tab: 'jobs', date: null, dataVersion: null });
  for (const link of document.querySelectorAll('[data-route]')) {
    link.href = routeUrl(link.dataset.route);
    if (link.closest('nav') && link.dataset.route === route.page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  closeNavigation();
  if (!detail.open) restoreContextBar();
  contextVisibility();
  contextControls();
  statusLine();
}

const dialogOpeners = new WeakMap();
const dialogs = [];
let actionControl;

function activeDialog() {
  return dialogs.findLast((node) => node.open);
}

function focusOpener(opener) {
  if (!opener) return;
  const fallback = opener.id ? document.getElementById(opener.id) : opener.dataset.action &&
    [...main.querySelectorAll('[data-action]')].find((control) =>
      control.dataset.action === opener.dataset.action && control.dataset.value === opener.dataset.value);
  const target = opener.isConnected ? opener : fallback;
  if (target && !target.disabled && !target.closest('[hidden]')) target.focus();
  else if (!activeDialog()) main.focus();
}

detail.addEventListener('workspace:dialog-change', restoreContextBar);
for (const node of [modal, detail, help]) {
  let outsideStart;
  const isBackdrop = (event) => {
    if (event.target !== node) return false;
    const { left, right, top, bottom, width, height } = node.getBoundingClientRect();
    return !(width && height) || event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom;
  };
  node.addEventListener('pointerdown', (event) => { outsideStart = isBackdrop(event); });
  node.addEventListener('pointercancel', () => { outsideStart = undefined; });
  node.addEventListener('click', (event) => {
    if (node.open && outsideStart !== false && isBackdrop(event)) node.close();
    outsideStart = undefined;
  });
  node.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (node.open) node.close();
  });
  node.addEventListener('close', () => {
    if (node.open) return;
    if (node === detail) restoreContextBar();
    outsideStart = undefined;
    const index = dialogs.indexOf(node);
    if (index !== -1) dialogs.splice(index, 1);
    const opener = dialogOpeners.get(node);
    dialogOpeners.delete(node);
    node.querySelector('.dialog-content').replaceChildren();
    const active = activeDialog();
    if (!active || opener && active.contains(opener)) focusOpener(opener);
  });
}

function closeDialogs() {
  for (const node of [...dialogs].reverse()) if (node.open) node.close();
}

function showDialog(node, title, body, subtitle = '', opener = actionControl || document.activeElement) {
  node.dispatchEvent(new window.Event('workspace:dialog-change'));
  node.setAttribute('aria-label', title);
  node.querySelector('.dialog-content').innerHTML = `<div class="dialog-head"><div><h2>${safe(title)}</h2>${subtitle ? `<p class="muted">${safe(subtitle)}</p>` : ''}</div>
    ${iconButton('Close', 'close-dialog', 'close')}</div><div class="dialog-body">${body}</div>`;
  if (!node.open) {
    dialogOpeners.set(node, opener);
    const previous = dialogs.indexOf(node);
    if (previous !== -1) dialogs.splice(previous, 1);
    dialogs.push(node);
    node.showModal();
  }
  (node.querySelector('[autofocus]') || node.querySelector('.dialog-head button'))?.focus();
  return node.querySelector('.dialog-body');
}

async function openStock(id, selectedContext = {}) {
  if (!id) return;
  const context = { ...snapshotContext(), ...selectedContext };
  closeDialogs();
  return go('stock', { ...context, symbol: id });
}

async function openAddWatchlist(ids) {
  const entry = await import('./library.js');
  return entry.openAddWatchlist(makeEnvironment(), ids);
}

function makeEnvironment(signal) {
  const localRoute = route;
  const pageStore = store[localRoute.page] ||= {};
  const requestContext = snapshotContext();
  const request = requestFor(requestContext, (path, preparation) => {
    if (signal?.aborted || localRoute !== route) return;
    if (preparation?.preparationState && !preparation.prepareAction) {
      routePreparations.set(path, preparation.preparationState);
    } else {
      routePreparations.delete(path);
    }
    updateContextIndicators();
  });
  return {
    main, modal, detail, page: localRoute.page, params: localRoute.state, config, state: pageStore,
    coverageContext: { ...requestContext, date: requestContext.date || analysisStatus?.latestDate || config?.status?.latestDate,
      dataVersion: requestContext.dataVersion ?? config?.status?.dataVersion },
    context: currentContext(), snapshotContext: requestContext, go, routeUrl, api: request,
    publishedSeries: (path, options, onProgress) => publishedSeries(path, options, onProgress, request),
    signal, toast, render, reloadConfig, showDialog, openStock, openAddWatchlist,
    replaceParams(patch) {
      if (localRoute !== route || signal?.aborted) return;
      history.replaceState(null, '', routeUrl(localRoute.page, patch, true));
      for (const [key, value] of Object.entries(patch)) {
        if (value == null || value === '') delete localRoute.state[key];
        else localRoute.state[key] = String(value);
      }
    },
    setActions(actions) { activeView = actions; },
    isActive() { return localRoute === route && !signal?.aborted; },
    async exportFile(path, options, filename) { blobDownload(await request(path, { ...options, file: true }), filename); },
  };
}

let controller;
async function render({ reload = false } = {}) {
  const current = ++generation;
  controller?.abort();
  controller = new AbortController();
  const { signal } = controller;
  activeView = null;
  routePreparations.clear();
  navState();
  main.setAttribute('aria-busy', 'true');
  main.innerHTML = heading(names[route.page]) + pending();
  try {
    if (reload || !config || configError) {
      const loaded = await reloadConfig({ signal, retryTransient: true });
      if (!loaded) throw new Error(configError || 'Could not connect to the market warehouse');
    }
    if (current !== generation) return;
    const ready = currentListRoute() ? listAnalysisStatus(config.status)
      : refreshableViews.has(route.page) ? preparedAnalysisStatus(config.status) : null;
    if (newerAnalysis(ready, analysisStatus)) {
      applyAnalysisStatus(ready);
      statusLine();
    }
    if (!location.hash.includes('?')) {
      history.replaceState(null, '', routeUrl(route.page));
      route = routeFromUrl();
    }
    navState();
    const view = await viewModules[route.page]();
    if (signal.aborted) return;
    main.onsubmit = null;
    await view.render(makeEnvironment(signal));
  } catch (error) {
    if (!signal.aborted) main.innerHTML = heading(names[route.page]) + notice('Could not load this view', error.message, action('Retry', 'retry-view', 'refresh'), true);
  } finally {
    if (current === generation) main.removeAttribute('aria-busy');
  }
}

const searchButton = document.querySelector('#ticker-search');
const helpButton = document.querySelector('#context-help');
const menuToggle = document.querySelector('.menu-toggle');
const searchGroups = { stocks: 'Securities', pages: 'Pages', screens: 'Saved screens', watchlists: 'Watchlists', help: 'Help' };

async function openHelp(id = route.page, anchor, opener = helpButton) {
  const body = showDialog(help, 'Workspace help', pending('Loading the workspace guide…'), '', opener);
  try {
    const topics = await loadHelp();
    if (!help.open || !body.isConnected) return;
    const { title, html } = helpTopic(topics, id, routeUrl);
    help.setAttribute('aria-label', `Help · ${title}`);
    help.querySelector('.dialog-head h2').textContent = title;
    body.innerHTML = html;
    help.scrollTop = 0;
    if (anchor) document.getElementById(anchor)?.focus();
    else body.querySelector('[data-help-topic]')?.focus();
  } catch (error) {
    if (help.open && body.isConnected) body.innerHTML = notice('Help unavailable', error.message, action('Retry', 'help-topic', 'refresh', { value: id }), true);
  }
}

function searchDialog(opener = searchButton) {
  const context = snapshotContext();
  const body = showDialog(modal, 'Search workspace', `<form id="ticker-form">${field('Ticker, company, page, saved item, or definition',
    '<input id="ticker-input" type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="ticker-results" autocomplete="off" spellcheck="false">')}</form>
    <p id="search-scope" class="muted"></p>
    <div id="search-status" class="search-status" role="status" aria-live="polite"></div>
    <div id="ticker-results" class="section-space" role="listbox" aria-label="Search results"></div>`, '', opener);
  const input = body.querySelector('#ticker-input');
  const target = body.querySelector('#ticker-results');
  const status = body.querySelector('#search-status');
  const scope = body.querySelector('#search-scope');
  const workspaceRequest = new AbortController();
  let request;
  let timer;
  let query = '';
  let point = { ...context, date: context.date || analysisStatus?.latestDate };
  let stocks = [];
  let watchlists = [];
  let topics = [];
  let stockError = '';
  let localErrors = [];
  let searching = false;
  let activateWhenReady = false;
  let selected = null;
  let options = [];
  const isOpen = () => modal.open && body.isConnected;
  const matches = (title) => query.toLowerCase().split(/\s+/).every((term) => title.toLowerCase().includes(term));
  const select = (value) => {
    selected = value;
    let activeId;
    for (const option of target.querySelectorAll('[role="option"]')) {
      const active = options[Number(option.dataset.searchIndex)]?.key === selected;
      option.setAttribute('aria-selected', active);
      if (active) activeId = option.id;
    }
    if (activeId) input.setAttribute('aria-activedescendant', activeId);
    else input.removeAttribute('aria-activedescendant');
  };
  function paint() {
    if (!isOpen()) return;
    const items = {
      stocks,
      pages: Object.entries(names).filter(([id, name]) => id !== 'stock' && matches(name))
        .map(([id, title]) => ({ id, title })),
      screens: (config?.screens || []).filter(({ name }) => query && matches(name)).slice(0, 8)
        .map((screen) => ({ id: screen.id, title: screen.name, screen })),
      watchlists: watchlists.filter(({ name }) => query && matches(name)).slice(0, 8).map(({ id, name }) => ({ id, title: name })),
      help: searchHelp(topics, query),
    };
    options = [];
    target.innerHTML = Object.entries(items).filter(([, entries]) => entries.length).map(([kind, entries]) =>
      `<section class="search-group" role="group" aria-label="${searchGroups[kind]}"><h3 aria-hidden="true">${searchGroups[kind]}</h3>
        ${entries.map((entry) => {
          const index = options.length;
          options.push({ ...entry, kind, key: `${kind}:${entry.id}:${entry.anchor || ''}` });
          return `<button type="button" class="search-option" role="option" tabindex="-1" aria-selected="false" id="workspace-option-${index}"
            data-search-index="${index}" data-search-kind="${kind}"><strong>${safe(entry.title)}</strong>${entry.description ? `<span>${safe(entry.description)}</span>` : ''}</button>`;
        }).join('')}</section>`).join('');
    input.setAttribute('aria-expanded', String(options.length > 0));
    select(options.some(({ key }) => key === selected) ? selected : null);
    const revision = point.dataVersion;
    const warehouse = config?.status?.dataVersion;
    setIfChanged(scope, [
      point.date ? `Securities as of ${dateLabel(point.date)}` : '',
      revision != null ? `revision ${revision}` : '',
      warehouse != null && revision != null && Number(warehouse) > Number(revision) ? `newer warehouse revision ${warehouse} available` : '',
    ].filter(Boolean).join(' · '));
    const message = [stockError, ...(query ? localErrors : [])].filter(Boolean).join(' ');
    status.innerHTML = searching ? pending('Searching securities…')
      : message ? notice('Some results are unavailable', message)
      : query && !options.length ? empty('No matching items', 'Try another ticker, company name, or workspace term.', 'search') : '';
  }
  function choose(option) {
    if (!option || !isOpen()) return;
    modal.close();
    switch (option.kind) {
      case 'stocks': return openStock(option.id, option.context);
      case 'pages': return go(option.id);
      case 'screens': return go('screener', { ...savedScreenRoute(option.screen.definition), screen: option.id });
      case 'watchlists': return go('watchlists', { list: option.id });
      case 'help': return openHelp(option.id, option.anchor, opener);
      default: return undefined;
    }
  }
  function activateSelection() {
    const selectedOption = options.find(({ key }) => key === selected);
    if (selectedOption || !searching) choose(selectedOption || options[0]);
    else activateWhenReady = true;
  }
  const stop = () => {
    clearTimeout(timer);
    request?.abort();
    workspaceRequest.abort();
    for (const type of ['close', 'workspace:dialog-change']) modal.removeEventListener(type, stop);
  };
  for (const type of ['close', 'workspace:dialog-change']) modal.addEventListener(type, stop, { once: true });
  const restart = () => {
    clearTimeout(timer);
    request?.abort();
    query = input.value.trim();
    selected = null;
    activateWhenReady = false;
    stocks = [];
    stockError = '';
    searching = !!query;
    paint();
    if (!query) return;
    const search = query;
    const searchRequest = new AbortController();
    request = searchRequest;
    const { signal } = searchRequest;
    timer = setTimeout(async () => {
      const scoped = requestFor(context);
      try {
        let result;
        try {
          result = await scoped('stocks/search', { params: { q: search, limit: 12 }, signal });
        } catch (error) {
          if (error.status !== 404) throw error;
        }
        if (!Array.isArray(result?.rows)) {
          result = await scoped('screens/query', { body: { search, perPage: 12, includeUntraded: true }, signal });
          if (result.pendingOnly) throw new Error('Security search is unavailable for the selected analysis context.');
        }
        if (!signal.aborted) {
          point = { ...context, date: result.date || context.date || analysisStatus?.latestDate,
            dataVersion: result.dataVersion ?? context.dataVersion };
          stocks = (result.rows || []).map((row) => ({ id: row.securityId || row.symbol, title: row.symbol,
            description: [row.name, row.exchange, row.matchedAlias && row.matchedAlias !== row.symbol ? `Former ticker ${row.matchedAlias}` : null]
              .filter(Boolean).join(' · '), context: point }));
        }
      } catch (error) {
        if (!signal.aborted) stockError = error.message || 'Securities could not be searched.';
      } finally {
        if (!signal.aborted) {
          searching = false;
          paint();
          if (activateWhenReady && !stockError) choose(options[0]);
        }
      }
    }, 200);
  };
  input.addEventListener('input', restart);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      activateSelection();
      return;
    }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) || !options.length) return;
    event.preventDefault();
    const index = options.findIndex(({ key }) => key === selected);
    const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : options.length - 1)
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    select(options[next].key);
    document.getElementById(`workspace-option-${next}`)?.scrollIntoView?.({ block: 'nearest' });
  });
  body.querySelector('form').addEventListener('submit', (event) => {
    event.preventDefault();
    activateSelection();
  });
  target.addEventListener('click', (event) => {
    const index = event.target.closest('[data-search-index]')?.dataset.searchIndex;
    if (index != null) choose(options[Number(index)]);
  });
  const local = (promise, assign, label) => promise.then(assign).catch(() => {
    if (!workspaceRequest.signal.aborted) localErrors = [...localErrors, `${label} could not be loaded.`];
  }).finally(paint);
  local(api('watchlists', { plain: true, signal: workspaceRequest.signal }), (result) => { watchlists = result; }, 'Watchlists');
  local(loadHelp(), (result) => { topics = result; }, 'Help');
  paint();
  input.focus();
}

function closeNavigation(restoreFocus = false) {
  if (!document.body.classList.contains('nav-open')) return;
  document.body.classList.remove('nav-open');
  menuToggle.setAttribute('aria-expanded', 'false');
  if (restoreFocus) menuToggle.focus();
}

searchButton.addEventListener('click', () => searchDialog());
helpButton.addEventListener('click', () => openHelp());
document.querySelector('.skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  main.focus();
});
menuToggle.addEventListener('click', () => {
  if (document.body.classList.contains('nav-open')) return closeNavigation(true);
  document.body.classList.add('nav-open');
  menuToggle.setAttribute('aria-expanded', 'true');
  document.querySelector('nav [aria-current="page"], #navigation a')?.focus();
});
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented) return;
  const layer = activeDialog();
  if (event.key === 'Escape' && (layer || document.body.classList.contains('nav-open'))) {
    event.preventDefault();
    if (layer) layer.close();
    else closeNavigation(true);
    return;
  }
  if (layer || event.isComposing || event.target.closest?.('input, textarea, select, [contenteditable]')) return;
  const slash = event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey;
  const command = event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey) && !event.altKey;
  if (slash || command) {
    event.preventDefault();
    const opener = document.activeElement === document.body ? searchButton : document.activeElement;
    searchDialog(opener);
  }
});

const globalActions = {
  current: returnToLatest,
  'open-context'(value, control) { return openContext(control); },
  'universe-counts'() {
    const env = makeEnvironment(controller?.signal);
    return openCoverageDrawer(env, env.coverageContext);
  },
  'retry-view'() { return render({ reload: true }); },
  async refresh() {
    if (!config || configError) return render({ reload: true });
    await checkBuild(true);
    updateContextIndicators();
  },
  async 'apply-data'() {
    const selection = route;
    if (!await reloadConfig()) return toast('New data could not be loaded. Try again.');
    if (route !== selection) return;
    const update = dataUpdateCandidate();
    if (!update) return updateContextIndicators();
    applyAnalysisStatus(update);
    statusLine();
    return route.state.dataVersion ? go(route.page, { dataVersion: null }) : render();
  },
  'warehouse-jobs'() { return go('settings', { tab: 'jobs', date: null, dataVersion: null }); },
  async 'prepare-context'(value, control) {
    control.disabled = true;
    const hash = location.hash;
    try {
      const result = await registerContext(route, { retry: true });
      if (hash === location.hash) {
        if (result.waitingForCapture) toast('Context saved. Preparation will start when the import finishes.');
        else await render();
      }
    } finally {
      if (control.isConnected) control.disabled = false;
    }
  },
  'use-universe'(id) { return selectContext({ universe: id, universeVersion: null }); },
  'use-model'(id) { return selectContext({ model: id, modelVersion: null }); },
  'use-health'(id) { return selectContext({ healthModel: id }); },
  'help-topic'(id) { return openHelp(id); },
  'reload-build'() {
    if (activeDialog()) return toast('Close the open panel before reloading.');
    if (hasFormDraft()) return toast('Apply or clear the form edits before reloading.');
    location.reload();
  },
  stock(value) { return openStock(value); },
  'close-dialog'(value, element) { element.closest('dialog')?.close(); },
  'export-chart'(value, element) { exportChart(element.closest('.panel')?.querySelector('[data-chart]'), value || 'market-series.csv'); },
};

async function returnToLatest() {
  if (returningToLatest) return;
  returningToLatest = true;
  const original = route;
  const view = snapshotContext();
  statusLine();
  try {
    const fresh = await reloadConfig();
    if (route !== original) return;
    if (!fresh) return toast('The latest session could not be checked. Try again.');
    const screen = fresh.screens.find(({ id }) => id === original.state.screen);
    const patch = { date: null, dataVersion: null,
      ...(screen && savedScreenRoute(screen.definition).date ? { screen: null } : {}) };
    const selection = routeFromUrl(routeUrl(route.page, patch, true));
    const ready = listAnalysisStatus(fresh.status, { selection }) ||
      (!fresh.automaticPreparation || !fresh.status?.preparation?.total ? fresh.status : null);
    const minimum = Math.max(Number(view.dataVersion || 0), Number(analysisStatus?.dataVersion || 0));
    if (ready?.latestDate && Number(ready.dataVersion) >= minimum && ready.latestDate >= (view.date || '')) {
      applyAnalysisStatus(ready);
    } else if (Number(view.dataVersion) > Number(analysisStatus?.dataVersion || 0)) {
      // Keep an explicitly selected, newer receipt when its replacement is still preparing.
      patch.dataVersion = view.dataVersion;
    }
    await selectContext(patch);
  } finally {
    returningToLatest = false;
    statusLine();
  }
}

async function selectContext(patch) {
  const page = route.page;
  const hash = routeUrl(page, patch, true);
  if (hash === location.hash) return;
  const selected = routeFromUrl(hash);
  go(page, patch);
  if (!config?.automaticPreparation || !config.status?.latestDate) return;
  try {
    const result = await registerContext(selected);
    if (location.hash === hash && (result.queued || result.jobs?.length)) await render();
  } catch (error) {
    if (location.hash === hash) toast(error.message);
  }
}

document.addEventListener('click', async (event) => {
  const control = event.target.closest('[data-action]');
  if (!control || control.disabled || control.getAttribute('aria-disabled') === 'true') return;
  const handler = globalActions[control.dataset.action] || activeView?.[control.dataset.action];
  if (!handler) return;
  const previous = actionControl;
  try {
    actionControl = control;
    let result;
    try {
      result = handler(control.dataset.value, control, event);
    } finally {
      actionControl = previous;
    }
    await result;
  } catch (error) {
    if (error.name !== 'AbortError') toast(error.message);
  }
});

document.addEventListener('change', async (event) => {
  const helpTopicControl = event.target.closest('[data-help-topic]');
  if (helpTopicControl) return openHelp(helpTopicControl.value);
  const control = event.target.closest('[data-change]');
  if (!control) return;
  const kind = control.dataset.change;
  if (kind === 'context') {
    const key = control.dataset.value;
    const versions = key === 'universe' || key === 'model' ? { [`${key}Version`]: null } : {};
    if (key === 'date') versions.dataVersion = control.value ? snapshotContext().dataVersion : null;
    await selectContext({ ...versions, [key]: control.value === 'auto' ? null : control.value });
  } else if (kind === 'saved-view' && control.value) {
    const saved = config.screens.find(({ id }) => id === control.value);
    go('screener', { ...savedScreenRoute(saved?.definition), screen: control.value });
  }
  else {
    try { await activeView?.[`change:${kind}`]?.(control.value, control, event); }
    catch (error) { if (error.name !== 'AbortError') toast(error.message); }
  }
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('#sidebar, .menu-toggle')) closeNavigation(Boolean(document.activeElement?.closest('#sidebar')));
  const link = event.target.closest('[data-route]');
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  go(link.dataset.route);
});

window.addEventListener('hashchange', () => {
  closeDialogs();
  route = routeFromUrl();
  render();
});
render();

function hasFormDraft() {
  const search = main.querySelector('#security-search');
  if (search && search.value !== (store[route.page]?.search || '')) return true;
  const controls = main.querySelectorAll('form textarea:not([data-change]), form input:not([data-change]), form select:not([data-change])');
  return [...controls].some((control) => {
    if (control instanceof window.HTMLSelectElement) {
      const choices = [...control.options];
      const defaults = choices.filter((option) => option.defaultSelected);
      if (control.multiple) return choices.some((option) => option.selected !== option.defaultSelected);
      return control.selectedIndex !== choices.indexOf(defaults.at(-1) || choices.find((option) => !option.disabled));
    }
    return ['checkbox', 'radio'].includes(control.type) ? control.checked !== control.defaultChecked : control.value !== control.defaultValue;
  });
}

async function checkBuild(force = false) {
  if (checkRunning) return;
  checkRunning = true;
  try {
    const now = Date.now();
    const checkStatus = force === true || now - lastStatusCheck >= 30000;
    const [jobs, build, status] = await Promise.allSettled([
      api('jobs', { plain: true }),
      checkStatus ? api('build', { plain: true }) : null,
      checkStatus ? api('data/status', { plain: true }) : null,
    ]);
    if (jobs.status === 'fulfilled') {
      activeImport = jobs.value.find((job) => Object.hasOwn(importLabels, job.type) && ['queued', 'running'].includes(job.status)) || null;
      activePreparation = jobs.value.find((job) => job.type === 'prepare-context' && job.status === 'running') || null;
      activeAnalysisJob = jobs.value.some((job) => calculationJobs.has(job.type) && ['queued', 'running', 'building'].includes(job.status));
      document.dispatchEvent(new window.CustomEvent('warehouse:jobs', { detail: jobs.value }));
    }
    if (checkStatus && build.status === 'fulfilled') observeBuild(build.value);
    if (checkStatus && status.status === 'fulfilled' && status.value && config) {
      lastStatusCheck = now;
      config = { ...config, status: status.value };
      document.dispatchEvent(new window.CustomEvent('warehouse:status', { detail: status.value }));
    }
    const safeRefresh = !activeDialog() && !hasFormDraft();
    const canRefresh = refreshableViews.has(route.page) && safeRefresh;
    const canRefreshRankings = canRefreshList() && safeRefresh;
    const idleFor = document.visibilityState === 'hidden' ? Infinity : now - lastInteraction;
    if (nextBuildVersion && canRefresh && idleFor >= 120000) {
      location.reload();
      return;
    }
    const latest = config?.status;
    const ready = canRefreshRankings && listAnalysisStatus(latest);
    if (newerAnalysis(ready, analysisStatus) && (force || idleFor >= 120000)) {
      const previousRoute = route;
      const loaded = await reloadConfig();
      const next = listAnalysisStatus(loaded?.status);
      if (newerAnalysis(next, analysisStatus) && route === previousRoute && canRefreshList() && !activeDialog() && !hasFormDraft()) {
        applyAnalysisStatus(next);
        statusLine();
        render();
        return;
      }
    }
    const plan = latest?.preparation;
    const planReady = preparedAnalysisStatus(latest);
    const newData = latest && analysisStatus && Number(latest.dataVersion) > Number(analysisStatus.dataVersion) &&
      (!plan?.total || planReady);
    const published = Number(latest?.latestAnalysis?.dataVersion ?? latest?.latestPublication?.data_version) > Number(analysisStatus?.dataVersion);
    const batchDue = analysisStatus && now - analysisStatus.appliedAt >= batchRefreshMs;
    if (newData && canRefresh && !route.state.date && !route.state.dataVersion && idleFor >= 120000 && (published || batchDue)) {
      const previousRoute = route;
      const loaded = await reloadConfig();
      if (loaded && route === previousRoute && !activeDialog() && !hasFormDraft() &&
        (document.visibilityState==='hidden' || Date.now() - lastInteraction >= 120000)) {
        applyAnalysisStatus(preparedAnalysisStatus(loaded.status) || loaded.status);
        statusLine();
        render();
        return;
      }
    }
    statusLine();
    updateContextIndicators();
  } finally {
    checkRunning = false;
  }
}
checkBuild();
setInterval(checkBuild, 10000);
document.addEventListener('visibilitychange', checkBuild);
