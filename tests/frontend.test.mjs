import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { CALCULATION_VERSION, createJob, dataVersion, importDataset, openDatabase, recordDailyPublication, updateJob } from '../backend/database.mjs';
import { expectedSessions } from '../backend/calendar.mjs';
import { createHandler } from '../backend/server.mjs';
import { createService, scheduledPrecomputeKey } from '../backend/service.mjs';
import { generateJournal } from '../backend/journal.mjs';

const require = createRequire(import.meta.url);
let JSDOM;
try {
  ({ JSDOM } = require(process.env.MARKET_JS_DOM || 'jsdom'));
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND' || process.env.MARKET_JS_DOM) throw error;
}

const sourcePath = process.env.MARKET_FRONTEND_DATABASE;
const cssPath = new URL('../frontend/styles.css', import.meta.url);
const baseUrl = 'http://localhost:4173';
const pageNames = {
  overview: 'Market Overview', monitor: 'Market Monitor', screener: 'Stock Screener', screens: 'Saved Screens', watchlists: 'Watchlists',
  rankings: 'RS Rankings', industries: 'Industries', history: 'Historical Explorer', journal: 'Market Journal', alerts: 'Alerts', settings: 'Settings & Data',
  stock: 'Ticker',
};

function seedFixture(db) {
  const dates = expectedSessions('2024-10-01','2026-11-20').slice(-480);
  const symbols = ['TESTA','TESTB','TESTC','TESTD','SPY'];
  const securities = symbols.map((symbol,index) => ({ symbol, name:`Frontend fixture ${symbol}`,
    type: index === 4 ? 'ETF' : 'Common Stock', exchange:'NASDAQ', listingDate:dates[0], knownAt:dates[0] }));
  const prices = symbols.flatMap((symbol,index) => dates.map((date,position)=>{
    const trend = [0.0002,-0.0003,0.0007,0.0018,0.0005][index];
    const close = (56 + index*13) * Math.exp(trend*position) * (1 + 0.012*Math.sin(position/6+index));
    const open = close * (1 + 0.003*Math.sin(position+index));
    return { symbol,date,knownAt:date,open,high:Math.max(open,close)*1.012,low:Math.min(open,close)*0.988,close,
      adjustedClose:close,volume:900000+index*26000+position*93 };
  }));
  const classifications = symbols.slice(0, 4).map((symbol, index) => ({ symbol, sector: 'Fixture sector',
    industry: index < 2 ? 'Fixture industry A' : 'Fixture industry B', effectiveFrom: dates[0], knownAt: dates[0] }));
  importDataset(db,{ provider:'frontend-fixture',dataset:'dated-test-prices',scope:'sample',catalogDate:dates.at(-1),securities,prices,classifications });
}

async function useFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'market-frontend-'));
  const target = join(dir,'market.sqlite');
  let db;
  t.after(async () => {
    db?.close();
    await rm(dir,{ recursive:true,force:true });
  });
  if (sourcePath) {
    const source = new DatabaseSync(sourcePath,{ readOnly:true });
    try {
      assert.ok(source.prepare('SELECT count(*) AS count FROM daily_prices').get().count >= 100, 'Explicit fixture warehouse contains price history');
      await backup(source,target);
    } finally { source.close(); }
  }
  db = openDatabase(target);
  if (!sourcePath) seedFixture(db);
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='bootstrap_plans'").get()) {
    db.exec('UPDATE bootstrap_plans SET owner_pid=NULL, owner_host=NULL, lease_until=NULL');
  }
  return db;
}

function savedDate(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

test('research workspace workflows use the published API and a copy of the local warehouse', {
  skip: JSDOM ? false : 'Install jsdom or set MARKET_JS_DOM to an available jsdom module.',
  timeout: 90000,
}, async (t) => {
  const db = await useFixture(t);
  const journalRequests = [];
  const journalClient = async (request) => {
    journalRequests.push({ system:request.system,user:request.user,model:request.model });
    return { id:'fixture-message', output:{ title:'Fixture market review',markdown:'## Participation\n\nA structured **fixture** report.',
      sentiment:'constructive',sentiment_score:0.25,market_health:6.5,risk_posture:'balanced',confidence:7,
      factors:[{key:'participation',label:'Participation',value:6}] } };
  };
  const service = createService({ db, workers: false, journalClient });
  const handle = createHandler({ service, host: '127.0.0.1' });
  let requests = 0;
  let jobPolls = 0;
  let pendingHistory = 0;
  let unavailableConfig = 0;
  let configRequests = 0;
  let fixtureBuild;
  const requestedRevisions = [];
  const rankingQueries = [];
  const contributorQueries = [];
  const trendQueries = [];
  async function request(url, options = {}) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const target = new URL(url, baseUrl);
    if (target.pathname === '/api/v1/build' && fixtureBuild) {
      return new Response(fixtureBuild, { headers:{'content-type':'application/json'} });
    }
    if (target.pathname === '/api/v1/config') {
      configRequests++;
      if (unavailableConfig > 0) {
        unavailableConfig--;
        return new Response(JSON.stringify({error:'Fixture server restarting'}), {
          status:503, headers:{'content-type':'application/json'},
        });
      }
    }
    const req = Object.assign(Readable.from(options.body ? [Buffer.from(options.body)] : []), {
      method: options.method || 'GET', url: target.pathname + target.search, headers: { host: target.host, origin: target.origin },
    });
    let status;
    let headers;
    let body;
    await handle(req, {
      writeHead(code, values) { status = code; headers = values; },
      end(value) { body = value; },
    });
    if (target.pathname === '/api/v1/build' && status === 200) fixtureBuild = body;
    if (target.pathname.startsWith('/api/v1/')) requests++;
    if (target.pathname.startsWith('/api/v1/jobs/')) jobPolls++;
    if (target.pathname.endsWith('/contributors')) contributorQueries.push(target);
    if (target.pathname.startsWith('/api/v1/market/breadth/') && target.searchParams.get('series')==='1') trendQueries.push(target);
    if (target.pathname === '/api/v1/market/monitor' && typeof body === 'string') {
      requestedRevisions.push(target.searchParams.get('dataVersion'));
      if (JSON.parse(body).materialization?.pending) pendingHistory++;
    }
    if (target.pathname === '/api/v1/screens/query' && options.body) {
      const input = JSON.parse(options.body);
      if (input.rankingPeriod) rankingQueries.push({ input, revision: Number(target.searchParams.get('dataVersion')) });
    }
    return new Response(body, { status, headers });
  }

  const config = await request('/api/v1/config').then((response) => response.json());
  const status = config.status;
  const context = { benchmark: config.availableBenchmarks.includes('SPY') ? 'SPY' : config.availableBenchmarks.includes('VTI') ? 'VTI' : config.availableBenchmarks[0] || 'SPY' };
  const initial = await service.dispatch({ url: `/api/v1/market/overview?${new URLSearchParams(context)}` });
  const expected = initial.body;
  if (expected.coverage?.traded < 2 || expected.leaders?.length < 2) {
    t.skip('The warehouse requires comparable stocks and price history to exercise the research workflows.');
    return;
  }

  const response = await request('/');
  assert.equal(response.status, 200);
  const dom = new JSDOM(await response.text(), { url: baseUrl + '/', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const win = dom.window;
  const bindings = { window: win, document: win.document, location: win.location, history: win.history,
    FormData: win.FormData, HashChangeEvent: win.HashChangeEvent, fetch: request };
  const originals = new Map(Object.keys(bindings).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(bindings)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const interval = globalThis.setInterval;
  const timers = [];
  const intervalHandlers = [];
  globalThis.setInterval = (...args) => {
    intervalHandlers.push(args[0]);
    const timer = interval(...args);
    timers.push(timer);
    return timer;
  };
  t.after(() => {
    globalThis.setInterval = interval;
    timers.forEach((timer) => clearInterval(timer));
  });
  if (!win.HTMLDialogElement.prototype.showModal) {
    win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    win.HTMLDialogElement.prototype.close = function () {
      this.open = false;
      queueMicrotask(() => this.dispatchEvent(new win.Event('close')));
    };
  }

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const wait = async (callback, description) => {
    const start = Date.now();
    while (Date.now() - start < 18000) {
      if (callback()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const read = (selector) => $(selector).textContent.trim().slice(0, 380);
    assert.fail(`Timed out waiting for ${description}. Main: ${read('#main')}. Modal: ${read('#modal')}. Detail: ${read('#detail')}.`);
  };
  const click = (selector) => {
    const target = $(selector);
    assert.ok(target, selector);
    target.click();
  };
  const set = (selector, value, event = 'change') => {
    const target = $(selector);
    assert.ok(target, selector);
    target.value = value;
    target.dispatchEvent(new win.Event(event, { bubbles: true }));
  };
  const submit = (selector) => {
    const form = $(selector);
    assert.ok(form, selector);
    form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  };
  const route = async (name, selector) => {
    click(`nav [data-route="${name}"]`);
    await wait(() => $('.page-intro h1')?.textContent === pageNames[name] && $(selector), name);
  };
  const only = (name) => `Browser fixture ${name} ${Date.now()}`;
  const savedScreen = only('screen');
  const savedList = only('watchlist');
  const savedModel = only('RS model');
  const savedAlert = only('alert');
  const savedLeaders = only('monthly leaders');
  const crossListWatch = only('cross-list watchlist');

  unavailableConfig = 3;
  await import('../frontend/app.js');
  await wait(() => $('#main [data-action="retry-view"]'), 'startup recovery control');
  assert.equal(unavailableConfig, 0);
  assert.match($('#data-badge').textContent, /Service unavailable/);
  const beforeRetry = configRequests;
  click('#main [data-action="retry-view"]');
  assert.equal($('#main').getAttribute('aria-busy'), 'true');
  await wait(() => $('#overview-chart [data-plot]'), 'successful startup retry');
  assert.equal(configRequests, beforeRetry + 1);
  assert.doesNotMatch($('#data-badge').textContent, /Service unavailable/);

  const { bindVirtualTable, table } = await import('../frontend/ui.js');
  const tableFixture = document.createElement('div');
  const fixtureRows = Array.from({ length: 100 }, (_, index) => ({ symbol: `TEST${index}`, name: `Fixture ${index}` }));
  tableFixture.innerHTML = table(fixtureRows, ['symbol', 'name'], { virtualRows: true });
  document.body.append(tableFixture);
  bindVirtualTable(tableFixture);
  const windowed = tableFixture.firstElementChild;
  assert.equal(windowed.querySelectorAll('tbody tr[aria-rowindex]').length, 30);
  windowed.querySelector('.stock-link').focus();
  windowed.scrollTop = 1800;
  windowed.dispatchEvent(new win.Event('scroll'));
  assert.ok(windowed.querySelector('[aria-rowindex="52"]'));
  assert.equal(document.activeElement, windowed);
  tableFixture.remove();
  await wait(() => $('#overview-chart [data-plot]'), 'overview chart');
  assert.equal($('#breadcrumb-page').textContent, 'Market Overview');
  if (expected.coverage.state !== 'complete') assert.match($('#main').textContent, /Limited market coverage.*Market health is withheld/s);
  click('[data-action="breadth"][data-value="above_50d"]');
  await wait(() => $('#detail #breadth-list .pagination'), 'overview contributors');
  click('#detail [data-action="breadth-drawer-tab"][data-value="denominator"]');
  await wait(() => $('#detail #breadth-list .pagination'), 'comparable denominator rows');
  assert.equal($$('#detail #breadth-list tbody .stock-link').length, Math.min(expected.breadth.above_50d.denominator, 50));
  await wait(() => $$('#detail [data-breadth-session] option').length>10 && $('#breadth-trend-chart [data-plot]'), 'breadth trend inside contributor drawer');
  click('#detail [data-breadth-counts]');
  assert.match($('#breadth-trend-chart .legend').textContent,/Comparable securities/);
  const previousDate=$$('#detail [data-breadth-session] option').at(-1).value;
  const plot=$('#breadth-trend-chart [data-plot]');
  plot.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Home',bubbles:true}));
  assert.match($('#breadth-trend-chart .chart-tooltip').textContent,/Comparable.*Coverage/s);
  plot.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  await wait(() => contributorQueries.at(-1)?.searchParams.get('date')===previousDate && $('#detail #breadth-list .pagination'), 'past-session constituents');
  assert.equal($('#detail [data-breadth-session]').value,previousDate);
  assert.equal(contributorQueries.at(-1).searchParams.get('dataVersion'),String(status.dataVersion));
  assert.equal(contributorQueries.at(-1).searchParams.get('universe'),'us-core');
  assert.equal(contributorQueries.at(-1).searchParams.get('include'),'denominator');
  click('#detail [data-action="close-dialog"]');

  click('[data-action="overview-tab"][data-value="health"]');
  assert.ok($('#health-coverage-form [name="observedMinimum"]').disabled);
  set('#health-coverage-form [name="coverageMode"]','observed');
  assert.equal($('#health-coverage-form [name="observedMinimum"]').value,'20');
  set('#health-coverage-form [name="observedMinimum"]','3');
  set('#health-coverage-form [name="observedThreshold"]','0.75');
  submit('#health-coverage-form');
  await wait(() => $('#current-health')?.textContent.includes('Minimum 3 traded securities · 75.0% comparable coverage'),
    'observed health controls reach API and label coverage policy');
  click('[data-action="overview-tab"][data-value="monitor"]');
  await wait(() => $('#large-move-results [data-value="up_25pct_63d"]'), 'Overview fixed quarterly preset');
  assert.equal($('#monitor-form').closest('details').open, false);
  assert.ok($('#large-move-results [data-value="down_13pct_34d"]'));

  await route('monitor', '.monitor-table');
  assert.equal($('#monitor-custom').open, false);
  assert.ok($('#monitor-timeline [data-value="up_25pct_63d"]'));
  const visibleHelp = $('button[aria-describedby="monitor-limit-help"]');
  const visibleTip = $('#monitor-limit-help');
  assert.equal(visibleTip.hidden, true);
  visibleHelp.parentElement.dispatchEvent(new win.Event('pointerenter'));
  assert.equal(visibleTip.hidden, false);
  assert.match(visibleTip.textContent, /dated rows/);
  visibleHelp.parentElement.dispatchEvent(new win.Event('pointerleave'));
  assert.equal(visibleTip.hidden, true);
  visibleHelp.focus();
  assert.equal(visibleTip.hidden, false);
  visibleHelp.dispatchEvent(new win.KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
  assert.equal(visibleTip.hidden, true);
  visibleHelp.blur();
  assert.ok($$('.monitor-table tbody tr').length >= 20);
  click('.monitor-table [data-action="monitor-detail"][data-value="up_13pct_34d"]');
  await wait(() => $('#detail #breadth-list .pagination') && trendQueries.some((url)=>url.searchParams.get('metrics')==='up_13pct_34d'),'custom monitor contributors and exact trend');
  click('#detail [data-action="close-dialog"]');
  click('.monitor-table [data-action="monitor-ratio"]');
  await wait(() => $('#detail .table-scroll'), 'monitor ratio inputs');
  click('#detail [data-action="close-dialog"]');
  click('[data-change="monitor-counts"]');
  assert.ok($('.monitor-table .bar-count'));
  set('[data-change="monitor-scale"]', 'common');
  assert.match($('.monitor-table thead').textContent, /0–100%/);
  click('[data-change="monitor-statistics"]');
  assert.match($('.monitor-table .with-statistics').textContent, /SMA.*Δ/s);
  click('#monitor-custom > summary');
  assert.equal($('#monitor-custom').open, true);
  const thresholdHelp = document.getElementById($('#monitor-filter [name="magnitude"]').getAttribute('aria-describedby'));
  assert.match(thresholdHelp.textContent, /34-session comparison at 13%.*counts a 34-session return of −15% and excludes −5%.*upside reading counts returns of \+13% or more/);
  set('#monitor-filter [name="sessions"]', '37');
  set('#monitor-filter [name="magnitude"]', '12.5');
  submit('#monitor-filter');
  await wait(() => $('#monitor-custom-results [data-value="up_12.5pct_37d"]'), 'custom numeric Monitor threshold and window');
  assert.equal($('#monitor-timeline [data-value="up_12.5pct_37d"]'), null);
  assert.ok($('#monitor-timeline [data-value="up_25pct_63d"]'));
  if (process.env.MARKET_FRONTEND_MONITOR_CAPTURE) {
    set('[data-change="monitor-scale"]', 'auto');
    const style = document.createElement('style');
    style.textContent = await readFile(cssPath, 'utf8');
    document.head.append(style);
    const source = dom.serialize().replace(/<script[^>]*src="\/app\.js"[^>]*><\/script>/, '');
    await writeFile(process.env.MARKET_FRONTEND_MONITOR_CAPTURE, source);
  }

  await route('screener', '#result-table tbody .stock-link');
  assert.equal($$('#result-table tbody .stock-link').length, Math.min(expected.coverage.traded, 30));
  assert.ok($('[data-action="export-screen"][data-value="csv"]'));
  if (config.exportFormats.includes('parquet')) assert.ok($('[data-action="export-screen"][data-value="parquet"]'));
  click('#result-table tbody .stock-link');
  await wait(() => location.hash.startsWith('#stock?') && $('#stock-price-panel [data-plot] rect'), 'ticker dashboard defaults to candles');
  assert.ok($('#ticker-dashboard a[href*="tradingview.com"]'));
  click('#stock-price-panel [data-action="stock-cadence-local"][data-value="weekly"]');
  assert.ok($('#stock-price-panel [data-plot] rect'));
  const unzoomed = $('#stock-price-panel [data-chart]').id;
  click('#stock-price-panel [data-chart-command="zoom"]');
  assert.notEqual($('#stock-price-panel [data-chart]').id, unzoomed);
  const originalObjectUrl = URL.createObjectURL;
  const originalAnchorClick = win.HTMLAnchorElement.prototype.click;
  let exported;
  try {
    URL.createObjectURL = (blob) => { exported = blob; return 'blob:weekly-fixture'; };
    win.HTMLAnchorElement.prototype.click = function () {};
    click('#stock-price-panel [data-action="stock-export-local"]');
    const csv = await exported.text();
    assert.match(csv, /^"date","open","high","low","close","volume"(?:,.*)?\r?\n/);
    assert.ok(csv.trim().split(/\r?\n/).length > 2);
    click('#stock-price-panel [data-chart-command="reset"]');
    click('#stock-price-panel [data-action="stock-export-local"]');
    assert.ok((await exported.text()).trim().split(/\r?\n/).length > csv.trim().split(/\r?\n/).length);
  } finally {
    URL.createObjectURL = originalObjectUrl;
    win.HTMLAnchorElement.prototype.click = originalAnchorClick;
  }
  click('#ticker-dashboard [data-action="stock-tab-local"][data-value="rs"]');
  await wait(() => $('#stock-rs-chart [data-plot]'), 'stock rank history');
  win.history.back();
  await wait(() => location.hash.startsWith('#screener?') && $('#result-table .stock-link'), 'return to the originating screen');

  click('[data-action="compare-date-editor"]');
  set('#modal [name="date"]', savedDate(status.latestDate, 7));
  set('#modal [name="metric"]', 'close');
  submit('#modal form');
  await wait(() => $('#result-table thead')?.textContent.includes('Past Close'), 'historic metric comparison');
  click('[data-action="compare-date-editor"]');
  click('#clear-date-compare');
  await wait(() => $('#result-table thead') && !$('#result-table thead').textContent.includes('Past Close'), 'clear historical comparison');

  for (const action of ['filters', 'sort-editor', 'columns']) {
    const opener = $(`[data-action="${action}"]`);
    opener.click();
    assert.ok($('#modal').open);
    $('#modal .dialog-body').click();
    assert.ok($('#modal').open, 'clicking inside an editor leaves it open');
    $('#modal').dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, clientX: -2, clientY: -2 }));
    $('#modal').dispatchEvent(new win.MouseEvent('click', { bubbles: true, clientX: -2, clientY: -2 }));
    await wait(() => !$('#modal').open && document.activeElement === opener, `${action} backdrop closes and restores focus`);
  }

  click('[data-action="filters"]');
  click('[data-editor="add-rule"]');
  set('#filter-editor [data-rule-key="value"]', '65', 'input');
  submit('#filter-editor');
  await wait(() => !$('#modal').open && $('#result-table tbody .stock-link'), 'validated nested filter');
  assert.ok($$('#result-table tbody .rs-cell').every((node) => Number(node.textContent) >= 65));
  click('[data-action="save-screen"]');
  set('#modal [name="name"]', savedScreen);
  submit('#modal form');
  await wait(() => location.hash.includes('screen=') && $('#result-table tbody'), 'save screen');
  click('#result-table tbody .stock-link');
  await wait(() => $('#ticker-dashboard [data-action="stock-tab-local"][data-value="screens"]'), 'screen membership tab');
  click('#ticker-dashboard [data-action="stock-tab-local"][data-value="screens"]');
  await wait(() => $('#stock-screens')?.textContent.includes(savedScreen), 'point-in-time screen membership');
  win.history.back();
  await wait(() => $('#result-table .stock-link') && location.hash.includes('screen='), 'saved filter remains after ticker navigation');
  click('#result-table tbody [data-change="select-stock"]');
  click('[data-action="add-selected"]');
  await wait(() => $('#modal [name="list"]'), 'watchlist chooser');
  set('#modal [name="list"]', 'new');
  set('#modal [name="name"]', savedList);
  submit('#modal form');
  await wait(() => !$('#modal').open, 'save watchlist');

  await route('screens', '.library-card');
  assert.ok($$('.library-card h2').some((node) => node.textContent === savedScreen));
  await route('watchlists', '.library-option');
  const choice = $$('.library-option').find((node) => node.textContent.trim() === savedList);
  assert.ok(choice);
  choice.click();
  await wait(() => $('#members tbody .stock-link') && $('.library-option[aria-pressed="true"]').textContent.trim() === savedList, 'watchlist members');
  assert.equal($$('#members tbody .stock-link').length, 1);

  await route('rankings', '#result-table tbody .stock-link');
  assert.equal($('.results-head h2').textContent,'Ranking warehouse');
  click('[data-action="ranking-list"][data-value="1m"]');
  await wait(() => $('#result-table thead')?.textContent.includes('Period rank') && $('#result-table .tradingview-link'), 'monthly leaders with direct chart action');
  assert.match($('.ranking-lists').textContent, /Live EOD.*completed daily publications/);
  assert.match($('#results-meta').textContent, /top 2(?:\.00)?% cutoff: .* comparable · 21 sessions/);
  const externalChart = $('#result-table .tradingview-link');
  assert.equal(externalChart.target, '_blank');
  assert.equal(externalChart.rel, 'noopener noreferrer');
  assert.equal(new URL(externalChart.href).hostname, 'www.tradingview.com');
  assert.ok($('#result-table .stock-link'));
  set('#rs-cutoff-form input', '10');
  submit('#rs-cutoff-form');
  await wait(() => $('#results-meta')?.textContent.includes('top 10'), 'adjustable leadership cutoff');
  const monthlyStock = $('#result-table [data-change="select-stock"]');
  const monthlyId = monthlyStock.value;
  monthlyStock.click();
  click('[data-action="ranking-list"][data-value="3m"]');
  await wait(() => $('#results-meta')?.textContent.includes('63 sessions') && $('#selection-tools').textContent.includes('1 selected'),
    'period list switch preserves stock selection');
  set('#rs-cutoff-form input', '100');
  submit('#rs-cutoff-form');
  await wait(() => $('#results-meta')?.textContent.includes('top 100') && $$('#result-table [data-change="select-stock"]').some((box) => box.value !== monthlyId),
    'quarterly list has another selectable stock');
  const quarterlyStock = $$('#result-table [data-change="select-stock"]').find((box) => box.value !== monthlyId);
  const quarterlyId = quarterlyStock.value;
  quarterlyStock.click();
  assert.match($('#selection-tools').textContent, /2 selected/);
  click('[data-action="add-selected"]');
  await wait(() => $('#modal').open && $('#modal [type="submit"]')?.textContent.includes('Add 2 stocks'), 'multi-list watchlist chooser');
  set('#modal [name="list"]', 'new');
  set('#modal [name="name"]', crossListWatch);
  submit('#modal form');
  await wait(() => !$('#modal').open, 'saved multi-list watchlist');
  const collected = (await request('/api/v1/watchlists').then((response) => response.json())).find(({ name }) => name === crossListWatch);
  assert.ok(collected);
  assert.deepEqual(new Set(collected.definition.members), new Set([monthlyId, quarterlyId]));
  click('[data-action="clear-selected"]');
  click('[data-action="ranking-list"][data-value="1m"]');
  await wait(() => $('#results-meta')?.textContent.includes('21 sessions'), 'return to monthly cutoff');
  set('#rs-cutoff-form input', '10');
  submit('#rs-cutoff-form');
  await wait(() => /top 10(?:\.00)?%/.test($('#results-meta')?.textContent || '') && $('#result-table .tradingview-link'), 'monthly save context');
  click('.ranking-lists [data-action="save-screen"]');
  set('#modal [name="name"]', savedLeaders);
  submit('#modal form');
  await wait(() => $('.results-head h2')?.textContent === savedLeaders && $('#result-table .tradingview-link'), 'named live list saved with charts');
  const savedRule = (await request('/api/v1/screens').then((response) => response.json())).find(({ name }) => name === savedLeaders);
  assert.deepEqual([savedRule.definition.rankingPeriod, savedRule.definition.topPercent, savedRule.definition.dateMode, savedRule.definition.members],
    ['1m', 10, 'latest', undefined]);
  await route('rankings', '[data-change="ranking-list"]');
  set('[data-change="ranking-list"]', 'top-rs');
  await wait(() => $('.results-head h2')?.textContent === 'Top RS' && $('#results-meta')?.textContent.includes('qualify of'), 'model signal list');
  set('[data-change="ranking-list"]', '');
  await wait(() => $('.results-head h2')?.textContent === 'Ranking warehouse' && $('#result-table tbody'), 'return to composite model results');
  click('[data-action="new-model"]');
  set('#modal [name="name"]', savedModel);
  submit('#modal form');
  await wait(() => !$('#modal').open && $('.model-summary h2')?.textContent === savedModel && $('#result-table tbody'), 'custom RS model');
  set('[data-change="compare-model"]', 'composite');
  await wait(() => $('#result-table thead')?.textContent.includes('Comparison rank'), 'model comparison');

  await route('industries', '#main .panel');
  if (!expected.coverage.classifications) assert.match($('#main').textContent, /classification has no eligible groups/);
  if ($('#main [data-change="group-compare"]')) {
    const metrics = $('[data-change="group-chart"]');
    assert.equal(metrics.querySelector('[value="percentile"]').textContent, 'Group RS percentile');
    assert.equal(metrics.querySelector('[value="medianRS"]').textContent, 'Median constituent RS percentile');
    assert.equal(metrics.querySelector('[value="emergingLeaderCount"]').textContent, 'Emerging leader count');
    click('#main [data-change="group-compare"]');
    set('[data-change="group-chart"]', 'percentile');
    set('[data-change="group-secondary"]', 'emergingLeaderCount');
    await wait(() => $('#industry-chart [data-plot]')?.getAttribute('aria-label').includes('Group RS percentile') &&
      $('#industry-chart [data-plot]').getAttribute('aria-label').includes('Emerging leader count'), 'dated group percentile and emerging-leader comparison');
    for (const key of ['rankChange4w','rankChange12w','parentRelativeRS','parentRelativeReturn']) {
      const selector = `[data-action="group-sort"][data-value="${key}"]`;
      click(selector);
      assert.equal($(selector).closest('th').getAttribute('aria-sort'), 'descending');
      assert.ok($(`[data-change="rotation-x"] option[value="${key}"]`));
    }
    set('[data-change="rotation-x"]', 'rankChange4w');
    set('[data-change="rotation"]', 'parentRelativeRS');
    assert.match($('.rotation-chart').getAttribute('aria-label'), /4W rank change versus Median RS vs parent/);
  }
  await route('history', '#history-chart [data-plot]');
  set('#history-form [name="transform"]', 'rebased');
  submit('#history-form');
  await wait(() => $('#history-chart [data-plot]'), 'transformed history');
  set('#history-form [name="primary"]', 'leadershipPersistence');
  set('#history-form [name="secondary"]', 'leadershipTurnover');
  set('#history-form [name="transform"]', 'values');
  submit('#history-form');
  await wait(() => $('#history-chart [data-plot]')?.getAttribute('aria-label').includes('Top-decile leadership turnover'), 'leadership history plots both stored series');
  $('#history-chart [data-plot]').dispatchEvent(new win.KeyboardEvent('keydown', { key:'End', bubbles:true }));
  assert.match($('#history-chart .chart-tooltip:not([hidden])')?.textContent, /prior-session leaders have comparable ranks/);
  click('[data-action="history-tab"][data-value="event"]');
  assert.equal($('#event-form [name="metric"] option[value="leadershipPersistence"]'), null);
  set('#event-form [name="start"]', savedDate(status.latestDate, 10));
  submit('#event-form');
  await wait(() => $('#research-results .summary-grid'), 'event study through the job API');
  if (expected.coverage.state !== 'complete') assert.match($('#research-results').textContent, /No comparable event observations/);
  assert.ok($('#event-form [name="observedThreshold"]').disabled);
  set('#event-form [name="coverageMode"]','observed');
  set('#event-form [name="observedMinimum"]','3');
  set('#event-form [name="observedThreshold"]','0.75');
  submit('#event-form');
  await wait(() => $('#research-results')?.textContent.includes('Minimum 3 traded securities · 75.0% comparable coverage'),
    'observed event-study controls reach worker and label coverage policy');

  click('[data-action="history-tab"][data-value="cohort"]');
  set('#cohort-form [name="date"]', savedDate(status.latestDate, 42));
  set('#cohort-form [name="horizons"]', '5');
  submit('#cohort-form');
  await wait(() => $('#research-results .summary-grid'), 'cohort results');
  assert.ok($('#research-results .histogram') || $('#research-results').textContent.includes('Some entry prices are unavailable'));

  await route('alerts', '[data-action="new-alert"]');
  click('[data-action="new-alert"]');
  set('#modal [name="name"]', savedAlert);
  set('#modal [name="type"]', 'stocks');
  set('#modal [name="expression"]', 'rsPercentile >= 95');
  submit('#modal form');
  await wait(() => !$('#modal').open && $('[data-action="alerts-tab"]'), 'alert persistence');
  click('[data-action="alerts-tab"][data-value="rules"]');
  assert.ok($$('.library-card h2').some((node) => node.textContent === savedAlert));

  await route('settings', '.quality-facts');
  assert.match($('#quality-universe-coverage').textContent,/Source expected.*Source received.*Universe expected.*Universe received/s);
  assert.match($('#quality-universe-coverage').textContent,/Excluded from expected roster.*Excluded from received capture.*Unverified provider common/s);
  if (expected.coverage.subtypeCoverage?.unverifiedProviderCommon>0) {
    assert.match($('#quality-universe-coverage').textContent,/remain eligible when independent subtype data is unavailable/);
  }
  assert.ok($('#main').textContent.includes(new Intl.NumberFormat('en-US').format(status.prices)));
  click('[data-action="settings-tab"][data-value="config"]');
  assert.ok($('#main').textContent.includes(savedModel));
  const journalNote = 'Private fixture note exactly once';
  click('[data-action="settings-tab"][data-value="journal"]');
  await wait(() => $('#journal-settings-form') && $('#journal-prompt-form'), 'journal settings');
  assert.equal($('#journal-settings-form [name="key"]').value,'');
  assert.equal($('#journal-settings-form [name="key"]').type,'password');
  click('#journal-settings-form [name="enabled"]');
  submit('#journal-settings-form');
  await wait(() => $('#journal-schedule-status')?.textContent.includes('Schedule saved · connection required'),'configured preference without effective schedule');
  set('#journal-settings-form [name="key"]','sk-ant-fixture-key-not-for-network');
  submit('#journal-settings-form');
  await wait(() => $('#journal-settings')?.textContent.includes('API key configured'), 'encrypted API key status');
  assert.equal($('#journal-settings-form [name="key"]').value,'');
  assert.doesNotMatch(document.body.textContent,/sk-ant-fixture-key/);
  assert.match($('#journal-schedule-status').textContent,/Automatic generation active/);

  set('#journal-prompt-form [name="name"]','Fixture daily market skill');
  set('#journal-prompt-form [name="prompt"]','# Daily context\n\nStudy market participation.');
  click('[data-journal-settings="add-factor"]');
  set('[data-factor-key="key"]','participation');
  set('[data-factor-key="label"]','Participation');
  set('[data-factor-key="minimum"]','0');
  set('[data-factor-key="maximum"]','10');
  submit('#journal-prompt-form');
  await wait(() => $('#journal-prompt-form [name="version"]').textContent.includes('Fixture daily market skill'), 'versioned journal prompt');

  await route('journal','#journal-note-form');
  set('#journal-note-form [name="markdown"]', journalNote,'input');
  submit('#journal-note-form');
  await wait(() => $('.journal-date-row') && $('#journal-note-form [name="markdown"]').value===journalNote, 'dated journal note');
  click('[data-action="journal-generate"]');
  await wait(() => $('#modal').open && $('#modal form [name="includeNotes"]'), 'Claude generation confirmation');
  assert.equal($('#modal [name="includeNotes"]').checked,false);
  submit('#modal form');
  await wait(() => $('.journal-report h2')?.textContent==='Fixture market review','persisted journal generation');
  assert.doesNotMatch(journalRequests[0].user,/Private fixture note exactly once/);
  assert.match($('.journal-report').textContent,/6\.5 \/ 10/);
  assert.match($('.journal-report').textContent,/First tradable session/);

  click('[data-action="journal-generate"]');
  await wait(() => $('#modal').open && $('#modal [name="includeNotes"]'),'journal revision confirmation');
  click('#modal [name="includeNotes"]');
  submit('#modal form');
  await wait(() => $('.journal-report')?.textContent.includes('revision 2'),'explicit note-sharing generation');
  assert.match(journalRequests[1].user,/Private fixture note exactly once/);

  const [reportDate,laterDate]=expectedSessions(savedDate(status.latestDate,21),savedDate(status.latestDate,14));
  const versions=await request('/api/v1/journal/prompts').then((response)=>response.json());
  const reportContext={date:reportDate,dataVersion:status.dataVersion,calculationVersion:status.calculationVersion,
    basis:'reconstructed',benchmark:context.benchmark,model:{id:'composite',version:1},classificationSystem:'provider',referenceMode:'as-of'};
  const seedReport=(universe,date,retro,health)=>generateJournal(db,{asOfDate:reportDate,
    context:{...reportContext,universe:{id:universe,version:1}},promptVersion:versions.active.version,
    retrospective:retro,force:true,now:()=>new Date(`${date}T23:50:00-05:00`),
    client:async()=>({...((await journalClient({})).output),market_health:health})});
  const live=await seedReport('us-core',reportDate,false,7);
  const laterRevision=await seedReport('us-core',laterDate,true,9);
  const alternative=await seedReport('nasdaq',reportDate,false,8);
  assert.equal(live.retrospective,false);
  assert.equal(laterRevision.retrospective,true);
  assert.notEqual(live.recipeKey,alternative.recipeKey);

  await route('history','[data-action="history-tab"][data-value="journal"]');
  click('[data-action="history-tab"][data-value="journal"]');
  await wait(() => $('#journal-backtest-form') && $('#journal-overlay-plot [data-journal-id]'),'journal factor research');
  assert.equal($('#journal-recipe-form [name="includeRetrospective"]').checked,false);
  assert.equal($('#journal-backtest-form [name="priceBasis"]').value,'known');
  assert.deepEqual($$('#journal-overlay-plot [data-journal-id]').map((row)=>row.dataset.journalId),[live.id]);
  submit('#journal-backtest-form');
  await wait(() => $('#journal-backtest-output [data-journal-id]'),'journal backtest matches overlay');
  assert.deepEqual($$('#journal-backtest-output [data-journal-id]').map((row)=>row.dataset.journalId),[live.id]);
  assert.match($('#journal-backtest-output').textContent,/Outcome prices · known then/);
  assert.match($('#journal-backtest-output').textContent,/Retrospectives excluded · 1/);

  click('#journal-recipe-form [name="includeRetrospective"]');
  submit('#journal-recipe-form');
  await wait(() => !$('#journal-backtest-output [data-journal-id]') && $('#journal-overlay-plot [data-journal-id]'), 'retrospective policy applied');
  assert.deepEqual($$('#journal-overlay-plot [data-journal-id]').map((row)=>row.dataset.journalId),[live.id]);
  set('#journal-backtest-form [name="priceBasis"]','reconstructed');
  submit('#journal-backtest-form');
  await wait(() => $('#journal-backtest-output [data-journal-id]'), 'retrospective backtest policy matches chart');
  assert.deepEqual($$('#journal-backtest-output [data-journal-id]').map((row)=>row.dataset.journalId),[live.id]);
  assert.match($('#journal-backtest-output').textContent,/Outcome prices · reconstructed/);

  const references = db.prepare('SELECT count(*) AS total FROM securities').get().total;
  if (references <= 300) {
    importDataset(db, {
      provider: 'browser-test', dataset: 'unpriced-reference-fixture', catalogDate: status.latestDate,
      securities: Array.from({ length: 301 - references }, (_, n) => ({
        symbol: `TESTETF${n + 1}`, name: `Browser test reference ${n + 1}`, type: 'ETF', exchange: 'NYSE',
        listingDate: status.earliestDate, knownAt: status.latestDate,
      })),
    });
    const pollsBefore = jobPolls;
    click('[data-action="refresh"]');
    await wait(() => $('[data-action="apply-data"]'), 'new revision notice');
    await route('monitor', '#monitor-timeline');
    await wait(() => /Queued for background preparation|Calculating historical sessions/.test($('#monitor-timeline').textContent), 'queued timeline calculation');
    assert.doesNotMatch($('#monitor-timeline').textContent, /No sessions in this range/);
    await wait(() => $$('.monitor-table tbody tr').length>1 && !$('#monitor-timeline .pending'), 'timeline republished after its job');
    assert.ok(jobPolls > pollsBefore);
    assert.ok(pendingHistory > 0);
    assert.equal(requestedRevisions.at(-1), String(status.dataVersion));
    const wallTime=Date.now;
    Date.now=()=>wallTime()+31*60000;
    try {
      click('.monitor-table [data-action="monitor-detail"]');
      await wait(() => $('#detail').open, 'drawer remains open during background checks');
      await intervalHandlers[0]();
      assert.equal(JSON.parse(win.sessionStorage.getItem('market-intelligence.analysis-revision')).dataVersion,status.dataVersion);
      click('#detail [data-action="close-dialog"]');

      await route('overview','[data-action="overview-tab"][data-value="monitor"]');
      click('[data-action="overview-tab"][data-value="monitor"]');
      const draft=$('#monitor-form [name="sessions"]');
      draft.value=String(Number(draft.defaultValue)+1);
      await intervalHandlers[0]();
      assert.equal(JSON.parse(win.sessionStorage.getItem('market-intelligence.analysis-revision')).dataVersion,status.dataVersion);
      assert.notEqual(draft.value,draft.defaultValue);
      draft.value=draft.defaultValue;

      await route('monitor', '.monitor-table');
      const select=$('[data-change="monitor-limit"]');
      select.focus();
      assert.equal(document.activeElement,select);
      await intervalHandlers[0]();
      await wait(() => $('.monitor-table tbody tr') && requestedRevisions.at(-1) !== String(status.dataVersion), 'idle monitor refresh with a focused selector');
      assert.ok(JSON.parse(win.sessionStorage.getItem('market-intelligence.analysis-revision')).dataVersion>status.dataVersion);
    } finally { Date.now=wallTime; }
  }

  await route('settings','[data-action="settings-tab"][data-value="quality"]');
  click('[data-action="settings-tab"][data-value="quality"]');
  await wait(() => $('#quality-source-audit [data-action="quality-open-editor"]'),'reviewed source issue audit');
  const beforeReview = JSON.parse(win.sessionStorage.getItem('market-intelligence.analysis-revision')).dataVersion;
  const security = expected.leaders[0];
  const evidence = 'https://www.sec.gov/Archives/fixture-volume-review';
  const correction = 'https://www.sec.gov/Archives/fixture-volume-correction';
  click('#quality-source-audit [data-action="quality-open-editor"]');
  set('#quality-review-form [name="security"]',security.symbol);
  set('#quality-review-form [name="kind"]','volume');
  set('#quality-review-form [name="from"]',status.latestDate);
  set('#quality-review-form [name="reason"]','Fixture evidence supports withholding source volume.','input');
  set('#quality-review-form [name="evidenceUrl"]',evidence,'input');
  submit('#quality-review-form');
  const auditRow = () => $('#quality-source-audit tr[data-quality-id]');
  await wait(() => auditRow()?.querySelector('.quality-evidence[href="'+evidence+'"]'),'recorded review and source evidence');
  assert.match(auditRow().textContent,/Volume withheld/);
  assert.match(auditRow().textContent,/Effective on selected date/);
  assert.match($('#quality-source-audit').textContent,new RegExp(`Analysis remains on revision ${beforeReview}`));
  await wait(() => $('[data-action="apply-data"]'),'review warehouse revision available');
  click('[data-action="apply-data"]');
  await wait(() => auditRow() && !$('#quality-source-audit').textContent.includes('Analysis remains on revision'), 'applied review revision');
  const reviewedRevision = JSON.parse(win.sessionStorage.getItem('market-intelligence.analysis-revision')).dataVersion;
  assert.ok(reviewedRevision > beforeReview);
  const overrideId = auditRow().dataset.qualityId;
  click('#quality-source-audit [data-action="stock"]');
  await wait(() => $('#ticker-dashboard .stock-source-quality .quality-evidence'),'stock source quality warning');
  assert.equal($('#ticker-dashboard .stock-source-quality .quality-evidence').href,evidence);
  assert.match($('#ticker-dashboard .stock-source-quality').textContent,/Volume withheld/);
  const inspectLastBar = () => {
    $('#stock-price-panel [data-plot]').dispatchEvent(new win.KeyboardEvent('keydown',{key:'End',bubbles:true}));
    const tooltip = $('#stock-price-panel .chart-tooltip:not([hidden])');
    assert.match(tooltip?.textContent,/Close \$/);
    assert.match(tooltip?.textContent,/Share volume: Unavailable · reviewed source override/);
  };
  inspectLastBar();
  click('#stock-price-panel [data-action="stock-cadence-local"][data-value="weekly"]');
  inspectLastBar();
  win.history.back();
  await wait(() => location.hash.startsWith('#settings?') && auditRow()?.dataset.qualityId === overrideId, 'return to the source review');
  click('#quality-source-audit [data-action="quality-clear"]');
  set('#quality-review-form [name="reason"]','Fixture evidence confirms the source correction.','input');
  set('#quality-review-form [name="evidenceUrl"]',correction,'input');
  submit('#quality-review-form');
  await wait(() => auditRow()?.querySelector('.quality-evidence[href="'+correction+'"]'),'cleared review and revised source evidence');
  assert.match(auditRow().textContent,/Cleared/);
  assert.equal(auditRow().dataset.qualityId,overrideId);
  const oldReview = await request(`/api/v1/data/quality/overrides?dataVersion=${reviewedRevision}`).then((response)=>response.json());
  assert.equal(oldReview.overrides.find(({id})=>id===overrideId)?.active,1);
  const newReview = await request('/api/v1/data/quality/overrides?includeCleared=1').then((response)=>response.json());
  assert.equal(newReview.overrides.find(({id})=>id===overrideId)?.active,0);

  if (!sourcePath) {
    const date = status.latestDate;
    const base = dataVersion(db);
    const publish = (version) => {
      const job = createJob(db, 'production-precompute', { scheduledFor: date, jobKey: scheduledPrecomputeKey(date, version) });
      updateJob(db, job.id, 'complete', 100, { date, dataVersion: version, calculationVersion: CALCULATION_VERSION });
    };
    recordDailyPublication(db, { date, rawVersion: base, dataRevision: base, models: [] });
    publish(base);
    await intervalHandlers[0](true);
    await route('rankings', '[data-action="ranking-list"][data-value="1m"]');
    click('[data-action="ranking-list"][data-value="1m"]');
    await wait(() => $('#result-table .tradingview-link') && rankingQueries.at(-1)?.revision === base, 'live leaders use ready revision');
    const compare = JSON.parse(win.sessionStorage.getItem('market-intelligence.analysis-revision'));
    const quote = db.prepare(`SELECT p.* FROM daily_prices p JOIN identifiers i ON p.security_id=i.security_id
      WHERE p.date=? AND i.symbol='TESTB'`).get(date);
    const close = quote.close * 1.5;
    const pendingRevision = importDataset(db, { provider: 'frontend-fixture', dataset: 'restatement',
      prices: [{ securityId: quote.security_id, date, knownAt: date, open: close, high: close, low: close, close, adjustedClose: close, volume: quote.volume }],
    }).version;
    assert.ok(pendingRevision > base);
    const clock = Date.now;
    Date.now = () => clock() + 130000;
    try {
      await intervalHandlers[0](true);
      assert.equal(rankingQueries.at(-1).revision, base, 'raw revision does not refresh the open list');
      assert.equal(JSON.parse(win.sessionStorage.getItem('market-intelligence.analysis-revision')).dataVersion, compare.dataVersion);
      click('#result-table [data-change="select-stock"]');
      publish(pendingRevision);
      await intervalHandlers[0](true);
      assert.match($('#selection-tools').textContent, /1 selected/);
      assert.equal(rankingQueries.at(-1).revision, base, 'update waits while stock selection is active');
      click('[data-action="clear-selected"]');
      click('[data-action="refresh"]');
      await wait(() => rankingQueries.at(-1)?.revision === pendingRevision && $('#result-table .stock-link')?.textContent === 'TESTB',
        'completed EOD update changes membership on the open list');
    } finally { Date.now = clock; }
    const back = savedDate(date, 7);
    set('[data-change="context"][data-value="date"]', back);
    await wait(() => location.hash.includes('date=') && location.hash.includes('dataVersion=') &&
      $('.ranking-lists')?.textContent.includes('Historical replay'), 'historical ranking pin');
    set('[data-change="saved-view"]', savedRule.id);
    await wait(() => location.hash.startsWith('#screener?') && $('.results-head h2')?.textContent === savedLeaders &&
      $('#result-table .stock-link')?.textContent === 'TESTB' && rankingQueries.at(-1)?.revision === pendingRevision,
    'saved period rule follows current ready leaders from historical replay');
    const params = new URLSearchParams(location.hash.split('?')[1]);
    assert.equal(params.has('date'), false);
    assert.equal(params.has('dataVersion'), false);
    set('[data-change="context"][data-value="date"]', back);
    await wait(() => $('[data-action="current"]') && location.hash.includes('dataVersion='), 'weekly replay pin restored');
    click('[data-action="current"]');
    await wait(() => !$('[data-action="current"]') && !location.hash.includes('dataVersion=') && !location.hash.includes('date='),
      'current control clears both replay pins');
  }

  assert.ok(requests >= 45);
  t.diagnostic(`${requests} real local API requests, ${pendingHistory} pending monitor responses, ${jobPolls} job polls`);
});
