import {
  action, chip, count, csvDownload, dateLabel, empty, field, iconButton, notice, numeric, option, panelHead, pagination, pathPart,
  pending, percent, publishingHistory, safe, segment, summary, table,
} from './ui.js';
import { chart } from './charts.js';
import { rangeSegment } from './chart-ranges.js';

const membership = [['numerator','Qualifiers'],['denominator','Comparable'],['excluded','Excluded']];
const sides = [['numerator','Net contributors'],['advancers','Advancers'],['decliners','Decliners'],...membership.slice(1)];
const columns = ['symbol','name','exchange','close','return_1d','rsPercentile','breadthSelection'];

export async function openBreadthDrawer(env, { key, date, title, universe, reading }) {
  const activeUniverse = universe || env.context.universe;
  const universeName = env.config.universes.find(({id})=>id===activeUniverse)?.name || activeUniverse;
  const scoped = universe && universe !== env.context.universe ? { universe, universeVersion:'' } : {};
  const signed = key === 'adSpread';
  const chartKey = pathPart(key);
  const body = env.showDialog(env.detail,title,`<div class="stack" data-breadth-drawer>
    <div id="breadth-reading">${pending('Loading breadth reading…')}</div>
    <section class="panel panel-body" id="breadth-trend">
      ${panelHead('Historical trend', 'Choose a session to see its exact contributing securities.',
        iconButton('Export trend CSV','breadth-drawer-export-trend','download'))}
      <div id="breadth-trend-controls"></div><div id="breadth-trend-chart" class="section-space"></div>
      <div id="breadth-trend-status" class="breadth-trend-progress"></div></section>
    <section class="panel panel-body" id="breadth-constituents" aria-label="Contributing securities">
      <div id="breadth-list-header"></div><div id="breadth-list">${pending('Loading contributing securities…')}</div></section>
  </div>`,`${universeName} · ${dateLabel(date)}`);
  const controller = new AbortController();
  const { signal } = controller;
  const stop = () => controller.abort();
  for (const event of ['close','workspace:dialog-change']) env.detail.addEventListener(event,stop,{once:true});
  signal.addEventListener('abort',()=>{
    for (const event of ['close','workspace:dialog-change']) env.detail.removeEventListener(event,stop);
  },{once:true});
  env.signal?.addEventListener('abort',stop,{once:true});
  const active = () => body.isConnected && env.detail.open && !signal.aborted;
  let selectedDate = date;
  let anchor = date;
  let mode = 'numerator';
  let page = 1;
  let range = 63;
  let showCounts = false;
  let trendRows = reading ? [reading] : [];
  let trendStatus = '';
  let trendLoading = true;
  let constituents;
  let listingRun = 0;
  let historyScope;
  const selected = new Set();

  function controls() {
    const dates = [...new Set([anchor,selectedDate,...trendRows.map((row)=>row.date)].filter(Boolean))].sort().reverse();
    const node = body.querySelector('#breadth-trend-controls');
    if (!node?.isConnected) return;
    const markup = `<div class="inline-form breadth-trend-toolbar">
      ${rangeSegment('breadth-drawer-range',range)}
      ${field('Session',`<select data-breadth-session>${dates.map((value)=>option(value,dateLabel(value),selectedDate)).join('')}</select>`)}
      <label class="checkbox-label"><input type="checkbox" data-breadth-counts${showCounts?' checked':''}> Show counts</label></div>`;
    if (node.innerHTML !== markup) node.innerHTML = markup;
  }

  function paintTrendStatus() {
    const node = body.querySelector('#breadth-trend-status');
    if (node?.isConnected && node.innerHTML !== trendStatus) node.innerHTML = trendStatus;
  }

  function paintTrend() {
    const node = body.querySelector('#breadth-trend-chart');
    if (!node?.isConnected) return;
    const qualifyingLabel = signed ? 'Net advancers' : 'Qualifying securities';
    const series = [
      { key, label:title, format:(value)=>percent(value,1,signed) },
      ...(showCounts ? [
        { key:`${key}_numerator`,label:qualifyingLabel,format:count,axis:'right' },
        { key:`${key}_denominator`,label:'Comparable securities',format:count,axis:'right' },
      ] : []),
    ];
    node.innerHTML = (trendRows.length ? chart(trendRows,series,{
      domain:signed?[-100,100]:[0,100],height:175,fill:true,axisFormat:(value)=>percent(value,0,signed),
      rightAxisFormat:count,onPick:({date: value})=>selectSession(value),
      describePoint:(row)=>[
        `${qualifyingLabel}: ${count(row[`${key}_numerator`])}`,
        `Comparable: ${count(row[`${key}_denominator`])}`,
        `Coverage: ${row.coverage || 'unavailable'}`,
      ],
    }) : trendLoading ? '' : empty('No comparable observations','This metric has no stored readings in the chosen range.','chart'));
    body.querySelector('[data-action="breadth-drawer-export-trend"]').disabled = !node.querySelector('[data-chart]');
    paintTrendStatus();
  }

  function asTrendRow(data, metric) {
    return { date:data.date, coverage:data.coverage?.state, [key]:metric.value,
      [`${key}_numerator`]:metric.numerator,[`${key}_denominator`]:metric.denominator };
  }

  function readout(data, aggregate) {
    const metric = aggregate?.metrics?.adSpread || data.metric;
    const exclusions = data.exclusions || {};
    const untraded = exclusions.untraded || 0;
    const insufficient = exclusions.insufficientHistory || 0;
    body.querySelector('#breadth-reading').innerHTML = `<p class="muted">${signed
      ? 'Advancers minus decliners, divided by comparable traded securities.'
      : safe(data.definition?.definition)}</p>
      <div class="summary-grid three section-space">
        ${summary(title,percent(metric.value,1,signed),dateLabel(data.date))}
        ${summary('Comparable',count(metric.denominator),signed
          ? `${count(aggregate?.metrics?.advancers?.numerator)} advance · ${count(aggregate?.metrics?.decliners?.numerator)} decline`
          : `${count(metric.numerator)} qualify`)}
        ${summary('Excluded',count(untraded+insufficient),`${count(untraded)} untraded · ${count(insufficient)} insufficient history`)}
      </div>`;
    if (!trendRows.some((row)=>row.date===data.date) && data.date===anchor) {
      trendRows = [...trendRows,asTrendRow(data,metric)].sort((a,b)=>a.date.localeCompare(b.date));
      paintTrend();
    }
  }

  function drawListHeader() {
    const node = body.querySelector('#breadth-list-header');
    node.innerHTML = panelHead('Contributing securities',dateLabel(selectedDate),`${selected.size
      ? action(`Add ${count(selected.size)} to watchlist`,'breadth-drawer-watchlist','watchlists') : ''}
      ${action('Export CSV','breadth-drawer-export-list','download',{disabled:!constituents})}`) +
      segment('breadth-drawer-tab',signed?sides:membership,mode,'tabs');
  }

  async function loadList() {
    const run = ++listingRun;
    const target = body.querySelector('#breadth-list');
    const reading = body.querySelector('#breadth-reading');
    constituents = null;
    drawListHeader();
    reading.innerHTML = pending('Loading breadth reading…');
    target.innerHTML = pending('Loading contributing securities…');
    const binary = signed && ['advancers','decliners'].includes(mode) ? mode : key;
    const include = signed && ['advancers','decliners'].includes(mode) ? 'numerator' : mode;
    try {
      const [result,aggregate] = await Promise.all([
        env.publishedSeries(`market/breadth/${pathPart(binary)}/contributors`,{signal,params:{...scoped,date:selectedDate,include,page,perPage:50}},
          (partial, job) => {
            if (!active() || run !== listingRun) return;
            reading.innerHTML = publishingHistory(job);
            target.innerHTML = publishingHistory(job);
          }),
        signed ? env.api('market/breadth',{signal,params:{...scoped,date:selectedDate,metrics:'adSpread'}}) : null,
      ]);
      if (!active() || run!==listingRun) return;
      if (!result.metric || result.pendingOnly) throw new Error(result.materialization?.error ||
        'This breadth reading has yet to be prepared for the selected session.');
      const changed = result.date && result.date !== selectedDate;
      selectedDate = result.date || selectedDate;
      if (!anchor) anchor = selectedDate;
      constituents = { result, binary, include };
      readout(result,aggregate);
      if (changed || !trendRows.length) controls();
      drawListHeader();
      const visibleColumns = binary==='adSpread'?[...columns,'contribution']:columns;
      target.innerHTML = table(result.rows,visibleColumns,{selectable:true,selected,label:'Contributing securities',
        emptyText:'No securities in this selection.'}) + pagination(result,'breadth-drawer-page');
    } catch (error) {
      if (active() && run === listingRun && error.name !== 'AbortError') {
        reading.innerHTML = notice('Breadth reading unavailable', error.message, '', true);
        target.innerHTML = empty('Contributors unavailable', 'No constituent table is available for this reading.', 'screens');
      }
    }
  }

  async function loadTrend() {
    historyScope?.abort();
    historyScope = new AbortController();
    const scope = historyScope;
    signal.addEventListener('abort',()=>scope.abort(),{once:true});
    trendLoading = true;
    trendStatus = pending('Loading historical breadth…');
    controls();
    paintTrend();
    try {
      const result = await env.publishedSeries(`market/breadth/${chartKey}`,{signal:scope.signal,
        params:{...scoped,date:anchor,series:1,metrics:key,limit:range}},(partial,job)=>{
        if (!active() || scope.signal.aborted) return;
        trendStatus = publishingHistory(job);
        if (partial.rows?.length && trendRows !== partial.rows) {
          trendRows = partial.rows;
          controls();
          paintTrend();
        } else paintTrendStatus();
      });
      if (!active() || scope.signal.aborted) return;
      const initial = trendRows.find((row)=>row.date===anchor);
      trendRows = result.rows?.length ? result.rows : initial ? [initial] : [];
      trendLoading = false;
      trendStatus = '';
      controls();
      paintTrend();
    } catch(error) {
      if (active() && error.name!=='AbortError') {
        trendLoading = false;
        trendStatus = notice('Historical trend unavailable',error.message,action('Retry','breadth-drawer-retry-trend','refresh'),true);
        paintTrend();
      }
    }
  }

  function selectSession(value) {
    if (!value || value===selectedDate) return;
    selectedDate=value;
    page=1;
    selected.clear();
    controls();
    loadList();
  }

  body.onclick = (event)=>{
    const ticker = event.target.closest('[data-action="stock"]');
    if (ticker) {
      event.stopPropagation();
      env.openStock(ticker.dataset.value, { ...scoped, date: selectedDate }).catch((error) => env.toast(error.message));
      return;
    }
    const button = event.target.closest('[data-action^="breadth-drawer-"]');
    if (!button) return;
    const {action: id,value} = button.dataset;
    if (id==='breadth-drawer-range') { range=Number(value);loadTrend(); }
    if (id==='breadth-drawer-retry-trend') loadTrend();
    if (id==='breadth-drawer-tab') { mode=value;page=1;loadList(); }
    if (id==='breadth-drawer-page') { page=Number(value);loadList(); }
    if (id==='breadth-drawer-watchlist') env.openAddWatchlist([...selected]).catch((error)=>env.toast(error.message));
    if (id==='breadth-drawer-export-trend' && trendRows.some((row)=>numeric(row[key]))) {
      csvDownload(trendRows,['date',key,`${key}_numerator`,`${key}_denominator`,'coverage'],`breadth-${key}-trend.csv`);
    }
    if (id==='breadth-drawer-export-list' && constituents) {
      const {result,binary,include} = constituents;
      env.exportFile(`market/breadth/${pathPart(binary)}/contributors`,
        {params:{...scoped,date:result.date,include,export:'csv'}},`breadth-${key}-${result.date}-${mode}.csv`).catch((error)=>env.toast(error.message));
    }
  };
  body.onchange = (event)=>{
    const input = event.target;
    if (input.matches('[data-breadth-session]')) selectSession(input.value);
    if (input.matches('[data-breadth-counts]')) { showCounts=input.checked;paintTrend(); }
    if (input.dataset.change==='select-stock') {
      event.stopPropagation();
      if (input.checked) selected.add(input.value);
      else selected.delete(input.value);
      const selectAll = body.querySelector('[data-change="select-page"]');
      if (selectAll) selectAll.checked=constituents.result.rows.every((row)=>selected.has(row.securityId));
      drawListHeader();
    }
    if (input.dataset.change==='select-page' && constituents) {
      event.stopPropagation();
      for (const row of constituents.result.rows) {
        if (input.checked) selected.add(row.securityId);
        else selected.delete(row.securityId);
      }
      body.querySelectorAll('[data-change="select-stock"]').forEach((node)=>{node.checked=input.checked;});
      drawListHeader();
    }
  };
  controls();
  if (anchor) loadTrend();
  await loadList();
  if (anchor && !historyScope && active()) loadTrend();
}
