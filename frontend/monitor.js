import {
  action, chip, count, csvDownload, dateLabel, direction, empty, field, heading, notice, numeric, option, panelHead,
  pending, publishingHistory, percent, ratio, safe, signed, summary,
} from './ui.js';
import { partialCoverage } from './overview.js';
import { openBreadthDrawer } from './contributors.js';

const rowLimits = [20, 63, 126, 252];
const stockbeePairs = [
  { id:'daily', label:'Daily momentum', period:'1 session', threshold:4, sessions:1 },
  { id:'swing', label:'Swing momentum', period:'20 sessions', threshold:25, sessions:20 },
  { id:'surge', label:'Large swings', period:'20 sessions', threshold:50, sessions:20 },
  { id:'quarter', label:'Quarterly momentum', period:'63 sessions', threshold:25, sessions:63 },
  { id:'intermediate', label:'Intermediate moves', period:'34 sessions', threshold:13, sessions:34 },
];
const keyOf = (side, threshold, sessions) => `${side}_${threshold}pct${sessions > 1 ? `_${sessions}d` : ''}`;
const ratioKeys = ['up_down_4pct_5d','up_down_4pct_10d'];
const readingKeys = (pairs) => pairs.flatMap(({threshold,sessions})=>['up','down'].map((side)=>keyOf(side,threshold,sessions)));
const exact = (row, key) => `${count(row[`${key}_numerator`])} / ${count(row[`${key}_denominator`])}`;
const pctPoint = (value) => numeric(value) ? `${signed(value)} pp` : '—';
const movingPeriods = [5, 10, 20];
const changePeriods = [1, 5, 21];

function bar(row, side, pair, state, scale) {
  const key = keyOf(side,pair.threshold,pair.sessions);
  const value = row[key];
  const historical = row[`${key}_extreme_percentile`];
  const available = numeric(value);
  const calibrated = numeric(historical);
  const label = `${side === 'up' ? 'Up' : 'Down'} ≥ ${pair.threshold}% · ${pair.sessions}D`;
  const legend = calibrated ? `Historical percentile ${Math.round(historical)}` : 'Historical calibration unavailable';
  const averages = movingPeriods.map((n) => percent(row[`${key}_sma${n}`]));
  const changes = changePeriods.map((n) => pctPoint(row[`${key}_change${n}`]));
  const details = `5/10/20D means ${averages.join(' / ')} · 1/5/21D change ${changes.join(' / ')}`;
  const extreme = calibrated ? historical >= 90 ? ' extreme-high' : historical <= 10 ? ' extreme-low' : '' : '';
  const width = available ? Math.min(100,Math.max(0,value / scale * 100)) : 0;
  return `<button type="button" class="breadth-bar ${side}${state.extremes ? extreme : ''}${available ? '' : ' missing'}${state.statistics ? ' with-statistics' : ''}"
    data-action="monitor-detail" data-value="${safe(key)}" data-date="${safe(row.date)}" style="--bar-size:${width}%"
    title="${safe(`${dateLabel(row.date)} · ${label} · ${percent(value)} · ${exact(row,key)} qualifying/comparable · ${legend} · ${details}`)}"
    aria-label="${safe(`${dateLabel(row.date)} ${label}: ${percent(value)}, ${exact(row,key)} qualifying over comparable. Open contributors.`)}">
    <span class="bar-fill"></span><span class="bar-value">${percent(value, value === 0 ? 0 : 1)}</span>
    ${state.counts ? `<small class="bar-count">${exact(row,key)}</small>` : ''}
    ${state.statistics ? `<small class="bar-count">SMA ${averages.join(' · ')}</small><small class="bar-count">Δ ${changes.join(' · ')}</small>` : ''}
    ${state.extremes && extreme ? '<span class="extreme-mark" aria-hidden="true"></span>' : ''}</button>`;
}

function sideRatio(row,key) {
  const n=key.endsWith('5d')?5:10;
  const value=ratio(row[key],row[`${key}_state`]);
  const numerator=row[`${key}_numerator`];
  const denominator=row[`${key}_denominator`];
  return `<button type="button" class="ratio-bar ${direction(numeric(row[key])?row[key]-1:0)}" data-action="monitor-ratio" data-value="${key}" data-date="${safe(row.date)}"
    title="${safe(`${n} sessions · sum up ${percent(numerator)} / sum down ${percent(denominator)}`)}" aria-label="${safe(`${dateLabel(row.date)} ${n}-session up/down 4% participation ratio ${value}`)}">${value}</button>`;
}

function timeline(data,pairs,state) {
  const rows = data.rows || [];
  if (!rows.length) return empty('No sessions in this range','Choose another as-of date or analysis context.','pulse');
  const scales = pairs.map(({ threshold, sessions }) => {
    if (state.scale === 'common') return 100;
    const [up, down] = ['up', 'down'].map((side) => keyOf(side, threshold, sessions));
    const maximum = Math.max(0, ...rows.flatMap((row) => [row[up] || 0, row[down] || 0]));
    return [5, 10, 20, 50, 100].find((value) => value >= maximum) || 100;
  });
  return `<div class="monitor-scroll"  role="region" aria-label="Market breadth timeline" tabindex="0"><table class="monitor-table">
    <thead><tr><th scope="col" class="monitor-date">Session<span>Traded</span></th>
      ${pairs.map(({label,period,threshold}, index)=>`<th scope="col"><strong>${safe(label)}</strong><small>${safe(period)} · 0–${scales[index]}%</small><div class="bar-column-head"><span>Down ≥ ${threshold}%</span><span>Up ≥ ${threshold}%</span></div></th>`).join('')}
      <th scope="col"><strong>U/D participation</strong><small>±4% daily readings</small><div class="bar-column-head"><span>5D ratio</span><span>10D ratio</span></div></th>
    </tr></thead><tbody>${rows.toReversed().map((row)=>{
      return `<tr${row.coverage === 'complete' ? '' : ' class="partial-row"'}>
        <th class="monitor-date" scope="row"><button type="button" class="date-button" data-action="replay-monitor" data-value="${safe(row.date)}" title="Replay ${safe(dateLabel(row.date))}">
          ${safe(dateLabel(row.date,true))}<small>${count(row.traded)} traded</small></button></th>
        ${pairs.map((pair,index)=>`<td><div class="opposed-bars">${bar(row,'down',pair,state,scales[index])}${bar(row,'up',pair,state,scales[index])}</div></td>`).join('')}
        <td><div class="opposed-bars ratio-pair">${ratioKeys.map((key)=>sideRatio(row,key)).join('')}</div></td></tr>`;
    }).join('')}</tbody></table></div>`;
}

export async function render(env) {
  const {state,main,signal} = env;
  state.limit ||= 63;
  state.window ||= 63;
  state.threshold ??= 25;
  state.counts ??= false;
  state.extremes ??= true;
  state.statistics ??= false;
  state.scale ||= 'auto';
  let loadRun=0;
  let drillRun=0;
  let current;

  function shownPairs() {
    return stockbeePairs.map((item)=>item.id === 'quarter' ? { ...item, label: state.window === 63 ? 'Quarterly momentum' : 'Rolling momentum',
      period:`${state.window} sessions`,threshold:state.threshold,sessions:state.window } : item);
  }
  function filters() {
    return `<form class="monitor-toolbar" id="monitor-filter">
      ${field('Visible sessions',`<select data-change="monitor-limit">${rowLimits.map((key)=>option(key,`${key} sessions`,state.limit)).join('')}</select>`)}
      ${field('Rolling window',`<input name="sessions" type="number" min="1" max="7560" value="${state.window}" required>`)}
      ${field('Rolling threshold (%)',`<input name="magnitude" type="number" min=".01" max="1000" step=".01" value="${state.threshold}" required>`)}
      <button type="submit" class="button">Apply threshold</button>
      ${field('Bar scale', `<select data-change="monitor-scale">${option('auto','Auto per group',state.scale)}${option('common','Common 0–100%',state.scale)}</select>`)}
      <span class="context-spacer"></span>
      <label class="checkbox-label"><input type="checkbox" data-change="monitor-counts" ${state.counts?'checked':''}> Show counts</label>
      <label class="checkbox-label"><input type="checkbox" data-change="monitor-extremes" ${state.extremes?'checked':''}> Mark extremes</label>
      <label class="checkbox-label"><input type="checkbox" data-change="monitor-statistics" ${state.statistics?'checked':''}> Show averages and changes</label>
    </form>`;
  }
  function shell() {
    main.innerHTML=heading('Market Monitor','Track shifts in upside and downside participation across trading sessions.',
      action('Export CSV','monitor-export','download',{ disabled: true }) +
      (env.config.exportFormats?.includes('parquet') ? action('Export Parquet','monitor-export-parquet','download',{ disabled: true }) : ''))
      + `<div id="monitor-coverage"></div><section class="panel monitor-panel">
        <div class="monitor-head">${panelHead('Breadth timeline','Bar length is the share of comparable securities meeting each threshold.')}${filters()}</div>
        <div id="monitor-timeline">${pending('Loading breadth timeline…')}</div>
        <footer class="monitor-footer">
          <div class="legend"><span class="legend-item"><i class="legend-mark" style="--series-color:#ff8c94"></i> Downside</span>
          <span class="legend-item"><i class="legend-mark" style="--series-color:#58e2c3"></i> Upside</span>
          <span class="legend-item"><i class="extreme-key high"></i> At or above 90th percentile</span>
          <span class="legend-item"><i class="extreme-key low"></i> At or below 10th percentile</span></div>
          <p class="muted">Extremes compare with the prior 252 sessions and require 60 comparable readings. Choose a bar to inspect its count, denominator, and exclusions.</p>
        </footer>
      </section>`;
  }
  function enableExports(enabled) {
    for (const button of main.querySelectorAll('[data-action="monitor-export"], [data-action="monitor-export-parquet"]')) button.disabled = !enabled;
  }
  function showRows() {
    const target=main.querySelector('#monitor-timeline');
    if (!target || !current) return;
    const scroll=target.firstElementChild;
    const scrollTop=scroll?.scrollTop || 0;
    const scrollLeft=scroll?.scrollLeft || 0;
    target.innerHTML=timeline(current,shownPairs(),state);
    if (target.firstElementChild) {
      target.firstElementChild.scrollTop=scrollTop;
      target.firstElementChild.scrollLeft=scrollLeft;
    }
  }
  async function load() {
    const target=main.querySelector('#monitor-timeline');
    const run=++loadRun;
    current = null;
    enableExports(false);
    target.innerHTML=pending('Loading breadth timeline…');
    try {
      const params = { limit: state.limit, metrics: readingKeys(shownPairs()).join(',') };
      const data = await env.publishedSeries('market/monitor', { signal, params }, (partial, job) => {
        if (run !== loadRun || !target.isConnected) return;
        const previous = target.querySelector('.monitor-scroll');
        const scroll = [previous?.scrollTop||0,previous?.scrollLeft||0];
        const latestOnly = !partial.rows?.length && partial.currentReading?.traded > 0;
        current = latestOnly ? {...partial,rows:[partial.currentReading]} : partial;
        main.querySelector('#monitor-coverage').innerHTML = partialCoverage(partial.coverage, env.routeUrl);
        target.innerHTML = publishingHistory(job) + (latestOnly ? '<p class="muted monitor-current-note">Latest session shown while history calculates.</p>' : '')
          + (current.rows?.length ? timeline(current, shownPairs(), state) : '');
        const table = target.querySelector('.monitor-scroll');
        if (table) [table.scrollTop,table.scrollLeft] = scroll;
      });
      if (run!==loadRun || !target.isConnected || !env.isActive()) return;
      current=data;
      enableExports(data.rows?.length > 0);
      main.querySelector('#monitor-coverage').innerHTML=partialCoverage(data.coverage,env.routeUrl);
      showRows();
    } catch(error) {
      if (target.isConnected && error.name!=='AbortError') target.innerHTML=notice('Monitor unavailable',error.message,action('Retry','monitor-retry','refresh'),true);
    }
  }

  async function ratioDetail(key,date) {
    const definition = current?.ratioDefinitions.find((item)=>item.key===key);
    if (!definition) return;
    const run=++drillRun;
    const target=env.showDialog(env.detail,definition.label,pending(),dateLabel(date));
    try {
      const data = await env.publishedSeries('market/monitor', { signal, params: { date, limit: definition.lookback, metrics: 'up_4pct,down_4pct' } }, (partial, job) => {
        if (target.isConnected && run === drillRun) target.innerHTML = publishingHistory(job);
      });
      if (run!==drillRun || !target.isConnected) return;
      const now=data.rows.at(-1);
      target.innerHTML=`<p class="muted">${safe(definition.definition)}</p>
        <div class="summary-grid three section-space">
          ${summary('Up/down ratio',ratio(now?.[key],now?.[`${key}_state`]),`Through ${dateLabel(date,true)}`)}
          ${summary('Sum of up percentages',percent(now?.[`${key}_numerator`]),'Numerator')}
          ${summary('Sum of down percentages',percent(now?.[`${key}_denominator`]),'Denominator')}
        </div><div class="table-scroll" role="region" aria-label="Participation ratio inputs" tabindex="0">
        <table><thead><tr><th>Session</th><th>Up ≥ 4%</th><th>Down ≥ 4%</th></tr></thead><tbody>
          ${data.rows.toReversed().map((row)=>`<tr><td>${dateLabel(row.date)}</td>${['up_4pct','down_4pct'].map((metric)=>`<td>
            <button class="stock-link numeric" type="button" data-action="monitor-detail" data-value="${metric}" data-date="${safe(row.date)}">${percent(row[metric])} · ${exact(row,metric)}</button>
          </td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    } catch(error) { if (target.isConnected) target.innerHTML=notice('Ratio inputs unavailable',error.message,'',true); }
  }
  function exportData() {
    if (!current?.rows.length) return;
    const keys=readingKeys(shownPairs());
    const includes=[...new Set(keys.flatMap((key)=>[key,`${key}_numerator`,`${key}_denominator`,`${key}_extreme_percentile`,`${key}_calibration_observations`,
      ...movingPeriods.map((n)=>`${key}_sma${n}`),...changePeriods.map((n)=>`${key}_change${n}`)]))];
    csvDownload(current.rows,['date','coverage','traded',...includes,
      ...ratioKeys.flatMap((key)=>[key,`${key}_numerator`,`${key}_denominator`,`${key}_state`])],'market-monitor.csv');
  }

  env.setActions({
    'monitor-retry':()=>load(),
    'monitor-export':exportData,
    'monitor-export-parquet':()=>env.exportFile('market/monitor',{params:{limit:state.limit,metrics:readingKeys(shownPairs()).join(','),export:'parquet'}},'market-monitor.parquet'),
    'change:monitor-limit'(value){state.limit=Number(value);return load();},
    'change:monitor-scale'(value){state.scale=value;showRows();},
    'change:monitor-counts'(value,input){state.counts=input.checked;showRows();},
    'change:monitor-extremes'(value,input){state.extremes=input.checked;showRows();},
    'change:monitor-statistics'(value,input){state.statistics=input.checked;showRows();},
    'monitor-detail'(key,button) {
      const date=button.dataset.date;
      const title=current?.metrics.find((item)=>item.key===key)?.label || key.replaceAll('_',' ');
      const reading=current?.rows.find((row)=>row.date===date);
      drillRun++;
      return openBreadthDrawer(env,{key,date,title,reading});
    },
    'monitor-ratio':(key,button)=>ratioDetail(key,button.dataset.date),
    'replay-monitor':(date)=>env.go('overview',{date,dataVersion:env.snapshotContext.dataVersion}),
  });
  shell();
  main.querySelector('#monitor-filter').onsubmit = (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    state.window = Number(form.get('sessions'));
    state.threshold = Number(form.get('magnitude'));
    load();
  };
  load();
}
