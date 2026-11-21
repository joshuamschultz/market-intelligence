import {
  action, attr, blobDownload, count, dateLabel, empty, field, heading, icon, iconButton, names, notice, option, pathPart, pending, safe, stockLink,
} from './ui.js';
import { exportChart } from './charts.js';

const viewModules = {
  overview: () => import('./overview.js'),
  monitor: () => import('./monitor.js'),
  screener: () => import('./screener.js'),
  rankings: () => import('./screener.js'),
  industries: () => import('./research.js'),
  history: () => import('./research.js'),
  journal: () => import('./journal.js'),
  screens: () => import('./library.js'),
  watchlists: () => import('./library.js'),
  alerts: () => import('./library.js'),
  settings: () => import('./library.js'),
};
const main = document.querySelector('#main');
const contextBar = document.querySelector('#context-bar');
const modal = document.querySelector('#modal');
const detail = document.querySelector('#detail');
const feedback = document.querySelector('#feedback');
const store = {};
let config = null;
let configError = '';
let analysisStatus = null;
let activeImport = null;
let lastStatusCheck = 0;
let lastInteraction = Date.now();
const batchRefreshMs = 30 * 60 * 1000;
const startupRetryDelays = [400, 1200];
const refreshableViews = new Set(['overview', 'monitor']);
for (const type of ['pointerdown', 'keydown', 'input', 'scroll']) {
  document.addEventListener(type, () => { lastInteraction = Date.now(); }, { capture: true, passive: true });
}
let activeView = null;
let generation = 0;
let feedbackTimer;
let buildVersion;
let nextBuildVersion;
let checkRunning = false;
const contextKeys = ['universe', 'date', 'model', 'benchmark', 'basis', 'classification', 'universeVersion', 'modelVersion', 'dataVersion', 'healthModel', 'reference'];

for (const element of document.querySelectorAll('[data-icon]')) element.insertAdjacentHTML('afterbegin', icon(element.dataset.icon));

function routeFromUrl() {
  const [target, query] = location.hash.slice(1).split('?');
  const page = Object.hasOwn(names, target) ? target : 'overview';
  const state = Object.fromEntries(new URLSearchParams(query));
  return { page, state };
}
let route = routeFromUrl();

function currentContext() {
  const defaults = {
    universeVersion: config?.universes?.find((item) => item.id === (route.state.universe || 'us-core'))?.version,
    modelVersion: config?.models?.find((item) => item.id === (route.state.model || 'composite'))?.version,
    universe: 'us-core', model: 'composite', benchmark: config?.availableBenchmarks?.includes('SPY') ? 'SPY' : config?.availableBenchmarks?.includes('VTI') ? 'VTI' : config?.availableBenchmarks?.[0] || 'SPY',
    basis: 'reconstructed',
    classification: route.state.date && config?.classificationSystems?.includes('sec-sic') ? 'sec-sic' : config?.defaultClassification || 'provider',
    healthModel: 'default', reference: route.state.date || route.state.basis === 'known' ? 'as-of' : 'latest',
  };
  return Object.fromEntries(contextKeys.flatMap((key) => {
    const selected = route.state[key];
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
  return response;
}

function requestFor(context) {
  return (path, options = {}) => api(path, { ...options, params: { ...(!options.plain ? context : {}), ...options.params } });
}

function snapshotContext() {
  const context = currentContext();
  const dataVersion = context.dataVersion ?? analysisStatus?.dataVersion;
  return { ...context, ...(dataVersion == null ? {} : { dataVersion }) };
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
function initialAnalysisStatus(status) {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(analysisStorageKey));
    if (Number.isInteger(saved?.dataVersion) && saved.dataVersion <= status.dataVersion && saved.latestDate) return saved;
  } catch {
    // A new tab defaults to the current warehouse revision.
  }
  return status;
}

const importLabels = { 'provider-import': 'Importing prices', 'provider-bootstrap': 'Loading market history', 'provider-reference': 'Loading reference data' };
const setIfChanged = (element, text) => { if (element.textContent !== text) element.textContent = text; };

function statusLine() {
  const status = config?.status;
  const visible = analysisStatus || status;
  const source = (status?.runs?.find((run) => run.status === 'complete' && run.rows > 0)?.provider
    || (status?.provider === 'eodhd' ? status.provider : null))?.toUpperCase();
  setIfChanged(document.querySelector('#source-name'), source ? `${source} warehouse` : 'Market warehouse');
  setIfChanged(document.querySelector('#source-caption'), visible?.latestDate ? `Through ${dateLabel(visible.latestDate)}`
    : configError ? 'Service unavailable' : 'No sessions loaded');
  const badge = document.querySelector('#data-badge');
  const available = visible?.state === 'available';
  const capture = status?.bootstrap;
  const histories = capture?.stages?.prices?.complete;
  const update = capture?.active ? (Number.isInteger(histories) && histories > 0 ? `History import · ${count(histories)} symbols` : 'Loading market history')
    : activeImport ? `${importLabels[activeImport.type]} · ${count(activeImport.progress)}%` : '';
  const contents = configError ? '<span class="status-dot"></span> Service unavailable'
    : update ? `<span class="status-dot syncing"></span><button class="status-action" data-action="warehouse-jobs" type="button" title="View warehouse jobs">${safe(update)}</button>`
      : visible?.latestDate ? `<span class="status-dot ${available ? 'live' : ''}"></span><span>${available ? 'EOD data' : 'Partial EOD data'}</span>`
        : '<span class="status-dot"></span> Awaiting data';
  if (badge.innerHTML !== contents) badge.innerHTML = contents;
  badge.title = visible?.latestDate ? `Analysis through ${dateLabel(visible.latestDate)} · revision ${snapshotContext().dataVersion ?? 'unknown'}` : '';
  document.querySelector('.data-source .status-dot').classList.toggle('live', available);
}

function updateContextIndicators() {
  const markup = [];
  if (nextBuildVersion) markup.push(action('Reload build', 'reload-build', 'refresh', { className: 'updated-button' }));
  if (config?.status?.dataVersion != null && String(snapshotContext().dataVersion) !== String(config.status.dataVersion)) {
    markup.push(action('Update data', 'apply-data', 'pulse', { className: 'updated-button',
      title: `View warehouse revision ${config.status.dataVersion}. Current view uses revision ${snapshotContext().dataVersion}.` }));
  }
  const target = contextBar.querySelector('#context-updates');
  const content = markup.join('');
  if (target && target.innerHTML !== content) target.innerHTML = content;
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

function contextOptions(options, key, label, display = (item) => item.name) {
  const context = currentContext();
  const selected = ['classification', 'reference','benchmark'].includes(key) ? route.state[key] || 'auto' : context[key];
  const values = options.map((item) => typeof item === 'string' ? { id: item, name: item } : item);
  return `<label class="context-field"><span>${safe(label)}</span><select data-change="context" data-value="${key}" aria-label="${safe(label)}">
    ${values.some((item) => item.id === selected) ? '' : option(selected || '', selected || 'Select', selected)}
    ${values.map((item) => option(item.id, display(item), selected)).join('')}</select></label>`;
}

function contextControls() {
  if (!config) return;
  const context = currentContext();
  contextBar.innerHTML = contextOptions(config.universes || [], 'universe', 'Universe') +
    `<label class="context-field"><span>As of</span><input type="date" aria-label="As-of date" data-change="context" data-value="date"${attr('value', context.date || analysisStatus?.latestDate || config.status?.latestDate)} max="${safe(config.status?.latestDate || '')}"></label>
    ${context.date ? iconButton('Return to latest session', 'current', 'clock') : ''}` +
    contextOptions(config.models || [], 'model', 'RS model') +
    contextOptions(['auto', ...(config.benchmarks || [])], 'benchmark', 'Benchmark', (item) =>
      item.id === 'auto' ? `Auto · ${context.benchmark}` : config.availableBenchmarks?.includes(item.id) ? item.name : `${item.name} (unavailable)`) +
    contextOptions([{ id: 'reconstructed', name: 'Reconstructed' }, { id: 'known', name: 'Known then' }], 'basis', 'Data basis') +
    contextOptions(['auto', ...(config.classificationSystems || ['provider'])], 'classification', 'Classification', (item) => {
      const label = { provider: 'Provider classification', 'sec-sic': 'SEC filing taxonomy', nasdaq: 'Nasdaq current industries' };
      return item.id === 'auto' ? `Auto · ${label[context.classification] || context.classification}` : label[item.id] || item.name;
    }) +
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

function navState() {
  const title = names[route.page];
  document.title = `${title} | Market Intelligence`;
  document.querySelector('#breadcrumb-page').textContent = title;
  for (const link of document.querySelectorAll('[data-route]')) {
    link.href = routeUrl(link.dataset.route);
    if (link.closest('nav') && link.dataset.route === route.page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.body.classList.remove('nav-open');
  document.querySelector('.menu-toggle').setAttribute('aria-expanded', 'false');
  contextControls();
}

function showDialog(node, title, body, subtitle = '') {
  node.dispatchEvent(new window.Event('workspace:dialog-change'));
  node.setAttribute('aria-label', title);
  node.querySelector('.dialog-content').innerHTML = `<div class="dialog-head"><div><h2>${safe(title)}</h2>${subtitle ? `<p class="muted">${safe(subtitle)}</p>` : ''}</div>
    ${iconButton('Close', 'close-dialog', 'close')}</div><div class="dialog-body">${body}</div>`;
  if (!node.open) node.showModal();
  return node.querySelector('.dialog-body');
}

async function openStock(id) {
  const entry = await import('./stocks.js');
  return entry.openStock(makeEnvironment(controller?.signal), id);
}

async function openAddWatchlist(ids) {
  const entry = await import('./library.js');
  return entry.openAddWatchlist(makeEnvironment(), ids);
}

function makeEnvironment(signal) {
  const localRoute = route;
  const pageStore = store[localRoute.page] ||= {};
  const requestContext = snapshotContext();
  const request = requestFor(requestContext);
  return {
    main, modal, detail, page: localRoute.page, params: localRoute.state, config, state: pageStore,
    context: currentContext(), snapshotContext: requestContext, go, routeUrl, api: request,
    publishedSeries: (path, options, onProgress) => publishedSeries(path, options, onProgress, request),
    signal, toast, render, reloadConfig, showDialog, openStock, openAddWatchlist,
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
  navState();
  main.setAttribute('aria-busy', 'true');
  main.innerHTML = heading(names[route.page]) + pending();
  try {
    if (reload || !config || configError) {
      const loaded = await reloadConfig({ signal, retryTransient: true });
      if (!loaded) throw new Error(configError || 'Could not connect to the market warehouse');
    }
    if (current !== generation) return;
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

let tickerSearchRun = 0;
let tickerSearchTimer;
async function tickerResults(query, target) {
  const run = ++tickerSearchRun;
  target.innerHTML = pending('Searching securities…');
  try {
    const result = await requestFor(snapshotContext())('screens/query', { body: { search: query, perPage: 12, includeUntraded: true } });
    if (run !== tickerSearchRun || !target.isConnected) return;
    target.innerHTML = result.rows.length ? result.rows.map((row) =>
      `<div class="search-result">${stockLink(row)}<span>${safe(row.name)}</span><span class="quiet">${safe(row.exchange)}</span></div>`).join('')
      : empty('No matching security', 'Try another ticker or choose a different universe.');
  } catch (error) {
    if (run === tickerSearchRun && target.isConnected) target.innerHTML = notice('Search unavailable', error.message, '', true);
  }
}
function searchDialog() {
  const body = showDialog(modal, 'Find a stock', `<form id="ticker-form">${field('Ticker or company', '<input id="ticker-input" type="search" autocomplete="off" placeholder="Search selected universe">')}</form>
    <div class="search-results section-space" id="ticker-results" aria-live="polite"></div>`);
  const input = body.querySelector('#ticker-input');
  const target = body.querySelector('#ticker-results');
  const prompt = () => {
    ++tickerSearchRun;
    target.innerHTML = empty('Search the warehouse', 'Enter a ticker or company name.', 'search');
  };
  prompt();
  input.focus();
  input.addEventListener('input', () => {
    clearTimeout(tickerSearchTimer);
    const query = input.value.trim();
    if (!query) prompt();
    else tickerSearchTimer = setTimeout(() => tickerResults(query, target), 220);
  });
  body.querySelector('form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (input.value.trim()) {
      modal.close();
      openStock(input.value.trim()).catch((error) => toast(error.message));
    }
  });
  target.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="stock"]')) modal.close();
  });
}

document.querySelector('#ticker-search').addEventListener('click', searchDialog);
document.querySelector('.skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  main.focus();
});
document.querySelector('.menu-toggle').addEventListener('click', (event) => {
  event.currentTarget.setAttribute('aria-expanded', document.body.classList.toggle('nav-open'));
});
document.addEventListener('keydown', (event) => {
  if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !modal.open && !detail.open && !event.target.closest('input, textarea, select, [contenteditable]')) {
    event.preventDefault();
    searchDialog();
  }
});

const globalActions = {
  current() { return go(route.page, { date: null }); },
  'retry-view'() { return render({ reload: true }); },
  async refresh() {
    if (!config || configError) return render({ reload: true });
    await checkBuild(true);
    updateContextIndicators();
  },
  async 'apply-data'() {
    if (!await reloadConfig()) return toast('New data could not be loaded. Try again.');
    applyAnalysisStatus(config.status);
    statusLine();
    return route.state.dataVersion ? go(route.page, { dataVersion: null }) : render();
  },
  'warehouse-jobs'() { return go('settings', { tab: 'jobs' }); },
  'reload-build'() {
    if (modal.open || detail.open) return toast('Close the open panel before reloading.');
    if (hasFormDraft()) return toast('Apply or clear the form edits before reloading.');
    location.reload();
  },
  stock(value) { return openStock(value); },
  'close-dialog'(value, element) { element.closest('dialog')?.close(); },
  'export-chart'(value, element) { exportChart(element.closest('.panel')?.querySelector('[data-chart]'), value || 'market-series.csv'); },
};

document.addEventListener('click', async (event) => {
  const control = event.target.closest('[data-action]');
  if (!control) return;
  const handler = globalActions[control.dataset.action] || activeView?.[control.dataset.action];
  if (!handler) return;
  try {
    await handler(control.dataset.value, control, event);
  } catch (error) {
    if (error.name !== 'AbortError') toast(error.message);
  }
});

document.addEventListener('change', async (event) => {
  const control = event.target.closest('[data-change]');
  if (!control) return;
  const kind = control.dataset.change;
  if (kind === 'context') {
    const key = control.dataset.value;
    const versions = key === 'universe' || key === 'model' ? { [`${key}Version`]: null } : {};
    if (key === 'date' && control.value) versions.dataVersion = snapshotContext().dataVersion;
    go(route.page, { ...versions, [key]: control.value === 'auto' ? null : control.value });
  } else if (kind === 'saved-view' && control.value) {
    const saved = config.screens.find(({ id }) => id === control.value);
    const savedContext = saved?.definition?.context || {};
    go('screener', { ...savedContext, date: savedContext.date || null, screen: control.value });
  }
  else {
    try { await activeView?.[`change:${kind}`]?.(control.value, control, event); }
    catch (error) { if (error.name !== 'AbortError') toast(error.message); }
  }
});

document.addEventListener('click', (event) => {
  const link = event.target.closest('[data-route]');
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  go(link.dataset.route);
});

window.addEventListener('hashchange', () => {
  if (modal.open) modal.close();
  if (detail.open) detail.close();
  route = routeFromUrl();
  render();
});
render();

function hasFormDraft() {
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
      document.dispatchEvent(new window.CustomEvent('warehouse:jobs', { detail: jobs.value }));
    }
    if (checkStatus && build.status === 'fulfilled' && build.value) {
      if (buildVersion && build.value.version !== buildVersion) nextBuildVersion = build.value.version;
      buildVersion ||= build.value.version;
    }
    if (checkStatus && status.status === 'fulfilled' && status.value && config) {
      lastStatusCheck = now;
      config = { ...config, status: status.value };
      document.dispatchEvent(new window.CustomEvent('warehouse:status', { detail: status.value }));
    }
    const canRefresh = refreshableViews.has(route.page) && !modal.open && !detail.open && !hasFormDraft();
    const idleFor = document.visibilityState === 'hidden' ? Infinity : now - lastInteraction;
    if (nextBuildVersion && canRefresh && idleFor >= 120000) {
      location.reload();
      return;
    }
    const latest = config?.status;
    const newData = latest && analysisStatus && Number(latest.dataVersion) > Number(analysisStatus.dataVersion);
    const published = Number(latest?.latestPublication?.data_revision) > Number(analysisStatus?.dataVersion);
    const batchDue = analysisStatus && now - analysisStatus.appliedAt >= batchRefreshMs;
    if (newData && canRefresh && !route.state.date && !route.state.dataVersion && idleFor >= 120000 && (published || batchDue)) {
      const previousRoute = route;
      const loaded = await reloadConfig();
      if (loaded && route === previousRoute && !modal.open && !detail.open && !hasFormDraft() &&
        (document.visibilityState==='hidden' || Date.now() - lastInteraction >= 120000)) {
        applyAnalysisStatus(loaded.status);
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
