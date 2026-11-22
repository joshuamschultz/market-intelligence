import {
  action, bindHelpTooltips, breadthMoveHelp, breadthMoveKey as keyOf, breadthMovePresets, chip, count, csvDownload,
  dateLabel, direction, empty, heading, helpField, helpTooltip, notice, numeric, option, panelHead,
  pending, publishingHistory, percent, ratio, safe, signed, summary,
} from './ui.js';
import { partialCoverage } from './overview.js';
import { openBreadthDrawer } from './contributors.js';
import { chartRanges } from './chart-ranges.js';
import { openMomentumHistory } from './momentum-history.js';

const ratioKeys = ['up_down_4pct_5d','up_down_4pct_10d'];
const readingKeys = (pairs) => pairs.flatMap(({threshold,sessions})=>['up','down'].map((side)=>keyOf(side,threshold,sessions)));
const exact = (row, key) => `${count(row[`${key}_numerator`])} / ${count(row[`${key}_denominator`])}`;
const pctPoint = (value) => numeric(value) ? `${signed(value)} pp` : '—';
const movingPeriods = [5, 10, 20];
const changePeriods = [1, 5, 21];
const ordinal = (value) => `${value}${value === 2 ? 'nd' : 'th'}`;
export function momentumExtremeClass(percentile, tail = 5) {
  if (!numeric(percentile) || percentile < 0 || percentile > 100) return '';
  return percentile >= 100-tail ? ' extreme-high' : percentile <= tail ? ' extreme-low' : '';
}

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
  const tail = state.extremeTail ?? 5;
  const extreme = momentumExtremeClass(calibrated ? historical : null, tail);
  const width = available ? Math.min(100,Math.max(0,value / scale * 100)) : 0;
  return `<button type="button" class="breadth-bar ${side}${state.extremes ? extreme : ''}${available ? '' : ' missing'}${state.statistics ? ' with-statistics' : ''}"
    data-action="monitor-detail" data-value="${safe(key)}" data-date="${safe(row.date)}" style="--bar-size:${width}%"
    title="${safe(`${dateLabel(row.date)} · ${label} · ${percent(value)} · ${exact(row,key)} qualifying/comparable · ${legend} · Extremes: top/bottom ${tail}% · ${details}`)}"
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

function timeline(data,pairs,state,{ ratios = true } = {}) {
  const rows = data.rows || [];
  if (!rows.length) return empty('No sessions in this range','Choose another as-of date or analysis context.','pulse');
  if (ratios) pairs=['daily','quarter','swing','surge','intermediate'].map(id=>pairs.find(pair=>pair.id===id)).filter(Boolean);
  const scales = pairs.map(({ threshold, sessions }) => {
    if (state.scale === 'common') return 100;
    const [up, down] = ['up', 'down'].map((side) => keyOf(side, threshold, sessions));
    const maximum = Math.max(0, ...rows.flatMap((row) => [row[up] || 0, row[down] || 0]));
    return [5, 10, 20, 50, 100].find((value) => value >= maximum) || 100;
  });
  const dateHeader=`<th scope="col" class="monitor-date"${ratios?' rowspan="2"':''}>Session<span>Traded</span></th>`;
  const ratioHeader='<th scope="col" class="monitor-ratios"><strong>U/D participation</strong><small>±4% daily readings</small><div class="bar-column-head"><span>5D ratio</span><span>10D ratio</span></div></th>';
  const incomplete=data.materialization?.pending || data.materialization?.missingDates?.length;
  return `<div class="monitor-scroll" role="region" aria-label="${ratios ? 'Standard market breadth timeline' : 'Custom market breadth timeline'}" tabindex="0"><p class="muted monitor-current-note" data-monitor-available-range>Showing ${count(rows.length)} stored sessions of up to ${count(state.limit)} requested · ${safe(dateLabel(rows[0].date))} – ${safe(dateLabel(rows.at(-1).date))}.${incomplete?' Additional history is awaiting preparation.':''}</p><table class="monitor-table${ratios ? ' grouped-presets' : ' single-comparison'}">
    <thead>${ratios?`<tr class="monitor-tier-row">${dateHeader}<th scope="colgroup" colspan="3">Primary breadth indicators</th><th scope="colgroup" colspan="3" class="secondary-start">Secondary breadth indicators</th></tr>`:''}<tr>${ratios?'':dateHeader}
      ${pairs.map((pair, index)=>{
        const {label,sessions,threshold}=pair;
        const originalIndex=ratios?breadthMovePresets.findIndex(item=>item.id===pair.id):index;
        return `<th scope="col"${ratios&&index===2?' class="secondary-start"':''}><button type="button" class="text-link" data-action="monitor-pair-history" data-value="${originalIndex}" data-custom="${!ratios}" aria-label="${safe(`${label}: open upside and downside historical chart`)}"><strong>${safe(label)}</strong></button><small>${count(sessions)} ${sessions === 1 ? 'session' : 'sessions'} · 0–${scales[index]}%</small><div class="bar-column-head"><span>Up ≥ ${threshold}%</span><span>Down ≥ ${threshold}%</span></div></th>${ratios&&index===0?ratioHeader:''}`;
      }).join('')}
    </tr></thead><tbody>${rows.toReversed().map((row)=>{
      return `<tr${row.coverage === 'complete' ? '' : ' class="partial-row"'}>
        <th class="monitor-date" scope="row"><button type="button" class="date-button" data-action="replay-monitor" data-value="${safe(row.date)}" title="Replay ${safe(dateLabel(row.date))}">
          ${safe(dateLabel(row.date,true))}<small>${count(row.traded)} traded</small></button></th>
        ${pairs.map((pair,index)=>`<td${ratios&&index===2?' class="secondary-start"':''}><div class="opposed-bars">${bar(row,'up',pair,state,scales[index])}${bar(row,'down',pair,state,scales[index])}</div></td>${ratios&&index===0?`<td class="monitor-ratios"><div class="opposed-bars ratio-pair">${ratioKeys.map((key)=>sideRatio(row,key)).join('')}</div></td>`:''}`).join('')}</tr>`;
    }).join('')}</tbody></table></div>`;
}

export async function render(env) {
  const {state,main,signal} = env;
  state.limit ||= 63;
  state.window ||= 63;
  state.threshold ??= 13;
  state.counts ??= false;
  state.extremes ??= true;
  state.extremeTail ??= 5;
  state.statistics ??= false;
  state.scale ||= 'auto';
  let loadRun=0;
  let drillRun=0;
  let current;
  let customRun=0;
  let customData;

  const customPair = () => ({ label:'Custom comparison', threshold:state.threshold, sessions:state.window });
  function filters() {
    const toggle = (key, label, checked, help) => `<div class="field-caption"><label class="checkbox-label"><input type="checkbox" data-change="monitor-${key}"
      aria-describedby="monitor-${key}-help"${checked ? ' checked' : ''}> ${label}</label>${helpTooltip(`monitor-${key}-help`,label,help)}</div>`;
    return `<div class="monitor-toolbar">
      ${helpField('monitor-limit','Visible sessions',(attrs)=>`<select ${attrs} data-change="monitor-limit">${chartRanges.map(([sessions, label])=>option(sessions,`${label} · ${sessions} sessions`,state.limit)).join('')}</select>`,breadthMoveHelp.visible)}
      ${helpField('monitor-scale','Bar scale',(attrs)=>`<select ${attrs} data-change="monitor-scale">${option('auto','Focus range per group',state.scale)}${option('common','Full scale · 0–100%',state.scale)}</select>`,breadthMoveHelp.scale)}
      <span class="context-spacer"></span>
      ${toggle('counts','Show counts',state.counts,breadthMoveHelp.counts)}
      ${toggle('extremes','Mark extremes',state.extremes,breadthMoveHelp.extremes)}
      ${helpField('monitor-extreme-tail','Extreme cutoff',(attrs)=>`<select ${attrs} data-change="monitor-extreme-tail">${[5,2,10].map(tail=>option(tail,`Top / bottom ${tail}%`,state.extremeTail)).join('')}</select>`,'The cutoff applies independently to the upside and downside participation series. Top/bottom 5% marks historical percentiles at least 95 or at most 5; 2% marks at least 98 or at most 2. It changes highlighting, not the price-move thresholds or underlying values.')}
      ${toggle('statistics','Show averages and changes',state.statistics,breadthMoveHelp.statistics)}
    </div>`;
  }
  function customControls() {
    return `<details id="monitor-custom" class="monitor-custom"${state.customEnabled ? ' open' : ''}><summary>Custom comparison</summary>
      <form id="monitor-filter" class="monitor-toolbar">
      ${helpField('monitor-window','Rolling window',(attrs)=>`<input ${attrs} name="sessions" type="number" min="1" max="7560" value="${state.window}" required>`,breadthMoveHelp.window)}
      ${helpField('monitor-threshold','Rolling threshold (%)',(attrs)=>`<input ${attrs} name="magnitude" type="number" min=".01" max="1000" step=".01" value="${state.threshold}" required>`,breadthMoveHelp.threshold)}
      <button type="submit" class="button">Apply custom comparison</button>
      ${action('Export custom CSV','monitor-export-custom','download',{disabled:true})}</form>
      <p class="muted section-space">This comparison is separate from the fixed breadth presets.</p>
      <div id="monitor-custom-results" class="section-space"></div></details>`;
  }
  function shell() {
    main.innerHTML=heading('Market Monitor','Track shifts in upside and downside participation across trading sessions.',
      action('Export CSV','monitor-export','download',{ disabled: true }) +
      (env.config.exportFormats?.includes('parquet') ? action('Export Parquet','monitor-export-parquet','download',{ disabled: true }) : ''))
      + `<div id="monitor-coverage"></div><section class="panel monitor-panel">
        <div class="monitor-head">${panelHead('Standard breadth presets','Bar length is the share of comparable securities meeting each fixed threshold.',
          helpTooltip('monitor-fixed-help','fixed preset definitions',breadthMoveHelp.fixed))}${filters()}</div>
        <div id="monitor-timeline">${pending('Loading breadth timeline…')}</div>
        <footer class="monitor-footer">
          <div class="legend"><span class="legend-item"><i class="legend-mark" style="--series-color:#58e2c3"></i> Upside</span>
          <span class="legend-item"><i class="legend-mark" style="--series-color:#ff8c94"></i> Downside</span>
          <span class="legend-item"><i class="extreme-key high"></i> <span data-extreme-upper>At or above ${ordinal(100-state.extremeTail)} percentile</span></span>
          <span class="legend-item"><i class="extreme-key low"></i> <span data-extreme-lower>At or below ${ordinal(state.extremeTail)} percentile</span></span></div>
          <p class="muted">Extremes compare with the prior 252 sessions and require 60 comparable readings. Choose a bar to inspect its count, denominator, and exclusions.</p>
          ${customControls()}
        </footer>
      </section>`;
    bindHelpTooltips(main);
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
    target.innerHTML=timeline(current,breadthMovePresets,state);
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
      const params = { limit: state.limit, metrics: readingKeys(breadthMovePresets).join(',') };
      const data = await env.publishedSeries('market/monitor', { signal, params }, (partial, job) => {
        if (run !== loadRun || !target.isConnected) return;
        const previous = target.querySelector('.monitor-scroll');
        const scroll = [previous?.scrollTop||0,previous?.scrollLeft||0];
        const latestOnly = !partial.rows?.length && partial.currentReading?.traded > 0;
        current = latestOnly ? {...partial,rows:[partial.currentReading]} : partial;
        main.querySelector('#monitor-coverage').innerHTML = partialCoverage(partial.coverage, env.routeUrl);
        target.innerHTML = publishingHistory(job) + (latestOnly ? '<p class="muted monitor-current-note">Latest session shown while history calculates.</p>' : '')
          + (current.rows?.length ? timeline(current, breadthMovePresets, state) : '');
        const table = target.querySelector('.monitor-scroll');
        if (table) [table.scrollTop,table.scrollLeft] = scroll;
      });
      if (run!==loadRun || !target.isConnected || !env.isActive()) return;
      current=data;
      enableExports(data.rows?.length > 0);
      main.querySelector('#monitor-coverage').innerHTML=partialCoverage(data.coverage,env.routeUrl);
      showRows();
      const work = data.materialization;
      if (work?.preparationState && work.missingDates?.length) {
        if (!data.rows.length && data.currentReading) {
          current = { ...data, rows: [data.currentReading] };
          showRows();
        }
        target.insertAdjacentHTML('afterbegin',notice('Some Monitor history is not prepared',
          work.error || `${count(work.missingDates.length)} requested sessions are missing from this calculation archive.`,
          `<a class="text-link" href="${safe(env.routeUrl('settings',{tab:'jobs'}))}">Preparation progress</a>`));
      }
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
  function exportData(data, pairs, custom = false) {
    if (!data?.rows.length) return;
    const keys=readingKeys(pairs);
    const includes=[...new Set(keys.flatMap((key)=>[key,`${key}_numerator`,`${key}_denominator`,`${key}_extreme_percentile`,`${key}_calibration_observations`,
      ...movingPeriods.map((n)=>`${key}_sma${n}`),...changePeriods.map((n)=>`${key}_change${n}`)]))];
    csvDownload(data.rows,['date','coverage','traded',...includes,
      ...(custom ? [] : ratioKeys.flatMap((key)=>[key,`${key}_numerator`,`${key}_denominator`,`${key}_state`]))],
      custom ? 'market-monitor-custom.csv' : 'market-monitor.csv');
  }

  function paintCustom() {
    const target = main.querySelector('#monitor-custom-results');
    if (target && customData) target.innerHTML = timeline(customData, [customPair()], state, { ratios:false });
  }

  async function loadCustom({ register = false } = {}) {
    if (!state.customEnabled) return;
    const target = main.querySelector('#monitor-custom-results');
    const exportButton = main.querySelector('[data-action="monitor-export-custom"]');
    const run = ++customRun;
    const pair = customPair();
    const metrics = readingKeys([pair]);
    customData = null;
    exportButton.disabled = true;
    if (breadthMovePresets.some(({ threshold,sessions }) => threshold === pair.threshold && sessions === pair.sessions)) {
      target.innerHTML = '<p class="muted">This comparison is already in the standard table.</p>';
      return;
    }
    target.innerHTML = pending('Loading the custom comparison…');
    try {
      if (register && env.config.automaticPreparation) await env.api('data/preparation', { plain:true, body:{ context:{
        ...env.snapshotContext, breadthKeys:metrics, followLatest:!env.context.date && !env.context.dataVersion,
      } } });
      const data = await env.publishedSeries('market/monitor', { signal, params:{ limit:state.limit, metrics:metrics.join(',') } }, (partial,job) => {
        if (target.isConnected && run === customRun) target.innerHTML = publishingHistory(job) +
          (partial.rows?.length ? timeline(partial,[pair],state,{ratios:false}) : '');
      });
      if (!target.isConnected || run !== customRun) return;
      if (!data.rows.length && data.materialization?.preparationState) {
        target.innerHTML = notice('Custom comparison is not prepared', data.materialization.error || 'Apply the custom comparison to prepare its history.');
        return;
      }
      customData = data;
      exportButton.disabled = !data.rows.length;
      paintCustom();
    } catch (error) {
      if (target.isConnected && run === customRun && error.name !== 'AbortError') target.innerHTML = notice('Custom comparison unavailable',error.message,'',true);
    }
  }

  env.setActions({
    'monitor-retry':()=>load(),
    'monitor-export':()=>exportData(current,breadthMovePresets),
    'monitor-export-custom':()=>exportData(customData,[customPair()],true),
    'monitor-export-parquet':()=>env.exportFile('market/monitor',{params:{limit:state.limit,metrics:readingKeys(breadthMovePresets).join(','),export:'parquet'}},'market-monitor.parquet'),
    'change:monitor-limit'(value){state.limit=Number(value);return Promise.all([load(),loadCustom()]);},
    'change:monitor-scale'(value){state.scale=value;showRows();paintCustom();},
    'change:monitor-counts'(value,input){state.counts=input.checked;showRows();paintCustom();},
    'change:monitor-extremes'(value,input){state.extremes=input.checked;showRows();paintCustom();},
    'change:monitor-extreme-tail'(value){
      if (![2,5,10].includes(Number(value))) return;
      state.extremeTail=Number(value);
      main.querySelector('[data-extreme-upper]').textContent=`At or above ${ordinal(100-state.extremeTail)} percentile`;
      main.querySelector('[data-extreme-lower]').textContent=`At or below ${ordinal(state.extremeTail)} percentile`;
      showRows();paintCustom();
    },
    'change:monitor-statistics'(value,input){state.statistics=input.checked;showRows();paintCustom();},
    'monitor-detail'(key,button) {
      const date=button.dataset.date;
      const data=button.closest('#monitor-custom-results') ? customData : current;
      const title=data?.metrics.find((item)=>item.key===key)?.label || key.replaceAll('_',' ');
      const reading=data?.rows.find((row)=>row.date===date);
      drillRun++;
      return openBreadthDrawer(env,{key,date,title,reading});
    },
    'monitor-ratio':(key,button)=>ratioDetail(key,button.dataset.date),
    'monitor-pair-history':(index,button)=>{
      const custom=button.dataset.custom==='true';
      const pair=custom?customPair():breadthMovePresets[Number(index)];
      if (!pair) return;
      drillRun++;
      return openMomentumHistory(env,{pair,data:custom?customData:current});
    },
    'replay-monitor':(date)=>env.go('overview',{date,dataVersion:env.snapshotContext.dataVersion}),
  });
  shell();
  main.querySelector('#monitor-filter').onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    state.window = Number(form.get('sessions'));
    state.threshold = Number(form.get('magnitude'));
    event.currentTarget.elements.sessions.defaultValue = String(state.window);
    event.currentTarget.elements.magnitude.defaultValue = String(state.threshold);
    state.customEnabled = true;
    await loadCustom({ register:true });
  };
  load();
  loadCustom();
}
