import { breadthMoveKey, count, dateLabel, empty, notice, numeric, pending, percent, safe, summary } from './ui.js';
import { chart } from './charts.js';
import { rangeSegment } from './chart-ranges.js';
import { openBreadthDrawer } from './contributors.js';

// These summaries inspect stored readings only; they do not calculate stock metrics.
export function momentumStanding(rows, key) {
  const ordered=[...rows].sort((a,b)=>a.date.localeCompare(b.date));
  const latest=ordered.at(-1);
  if (!latest || !numeric(latest[key])) return null;
  const prior=ordered.slice(0,-1).map(row=>row[key]).filter(numeric);
  const calibrated=latest[`${key}_extreme_percentile`] ?? latest[`${key}_historical_percentile`];
  const stored=numeric(calibrated);
  const percentile=stored?calibrated:prior.length>=60
    ?100*prior.reduce((sum,value)=>sum+(value<latest[key]?1:value===latest[key]?0.5:0),0)/prior.length:null;
  const sample=ordered.map(row=>row[key]).filter(numeric);
  return {date:latest.date,value:latest[key],numerator:latest[`${key}_numerator`],denominator:latest[`${key}_denominator`],
    percentile,observations:stored?latest[`${key}_calibration_observations`]:prior.length,
    basis:stored?'prior sessions':'loaded prior readings',low:Math.min(...sample),high:Math.max(...sample),readings:sample.length};
}

export async function openMomentumHistory(env,{pair,data}) {
  const keys=['up','down'].map(side=>breadthMoveKey(side,pair.threshold,pair.sessions));
  const anchor=data?.rows?.at(-1)?.date || env.context.date;
  const universe=env.config.universes.find(item=>item.id===env.context.universe)?.name || env.context.universe;
  const body=env.showDialog(env.detail,pair.label,`<div class="stack" data-momentum-history>
    <p>Share of comparable stocks gaining at least ${safe(pair.threshold)}% or declining at least ${safe(pair.threshold)}% over ${count(pair.sessions)} trading ${pair.sessions===1?'session':'sessions'}. Moves inside that band are excluded.</p>
    <div data-momentum-controls></div><div data-momentum-standing></div><div data-momentum-chart>${pending('Reading stored momentum history…')}</div>
    <p class="muted" data-momentum-coverage></p><div data-momentum-selected></div>
    <p class="muted">Choose a chart session, then Upside stocks or Downside stocks to inspect its constituents. Calibrated percentiles use up to 252 prior sessions and require 60 comparable readings.</p>
  </div>`,`${universe} · Through ${dateLabel(anchor)}`);
  const controller=new AbortController();
  const stop=()=>controller.abort();
  for (const event of ['close','workspace:dialog-change']) env.detail.addEventListener(event,stop,{once:true});
  env.signal?.addEventListener('abort',stop,{once:true});
  controller.signal.addEventListener('abort',()=>{
    for (const event of ['close','workspace:dialog-change']) env.detail.removeEventListener(event,stop);
    env.signal?.removeEventListener('abort',stop);
  },{once:true});
  const active=()=>body.isConnected && env.detail.open && !controller.signal.aborted;
  let range=252, rows=[],selectedDate,request=0;
  function select(date) {
    selectedDate=date;
    const row=rows.find(item=>item.date===date);
    const target=body.querySelector('[data-momentum-selected]');
    target.innerHTML=row?`<p><strong>${safe(dateLabel(date))}</strong></p><div class="inline-form">${keys.map((key,index)=>
      `<button type="button" class="button" data-momentum-side="${index}">${index?'Downside':'Upside'} stocks · ${percent(row[key])} · ${count(row[`${key}_numerator`])} / ${count(row[`${key}_denominator`])} comparable</button>`).join('')}</div>`:'';
  }
  function paint(result) {
    const available=result.rows?.length?result.rows:result.currentReading?[result.currentReading]:(data?.rows||[]).slice(-range);
    rows=[...available].sort((a,b)=>a.date.localeCompare(b.date));
    body.querySelector('[data-momentum-standing]').innerHTML=`<div class="summary-grid two">${keys.map((key,index)=>{
      const item=momentumStanding(rows,key);
      if (!item) return summary(index?'Downside':'Upside','—','Latest session has no comparable reading');
      const rank=numeric(item.percentile)?`${item.percentile.toFixed(1)} historical percentile · ${count(item.observations)} ${item.basis}`:'Percentile needs at least 60 prior comparable readings';
      return `<div>${summary(index?'Downside':'Upside',percent(item.value),`${dateLabel(item.date,true)} · ${count(item.numerator)} / ${count(item.denominator)} comparable`)}
        <p class="muted">${safe(rank)}. Loaded range ${percent(item.low)}–${percent(item.high)} across ${count(item.readings)} readings.</p></div>`;
    }).join('')}</div>`;
    body.querySelector('[data-momentum-chart]').innerHTML=rows.length?chart(rows,keys.map((key,index)=>({key,label:index?`Down ≥ ${pair.threshold}%`:`Up ≥ ${pair.threshold}%`,color:index?'#ff8c94':'#58e2c3',format:percent})),
      {domain:[0,100],height:260,axisFormat:value=>percent(value,0),label:`${pair.label}: upside and downside participation`,onPick:row=>select(row.date),
        describePoint:row=>keys.map(key=>`${count(row[`${key}_numerator`])} / ${count(row[`${key}_denominator`])} comparable`)})
      :empty('History is not prepared yet','This view reads saved results. Preparation progress is available in Settings & Data.','chart');
    const missing=result.materialization?.missingDates?.length;
    body.querySelector('[data-momentum-coverage]').textContent=`${rows.length} stored sessions shown of up to ${range} requested${rows.length?` · ${dateLabel(rows[0].date)} – ${dateLabel(rows.at(-1).date)}`:''}.${missing?` ${missing} sessions are not yet prepared.`:''} Universe and data revision match the Monitor. Historical denominators may change.`;
    // Focus narrow participation ranges while retaining the explicit full-scale choice.
    body.querySelector('[data-chart-scale="focus"]')?.click();
    if (rows.length) select(rows.at(-1).date);
  }
  async function load() {
    const run=++request;
    body.querySelector('[data-momentum-controls]').innerHTML=rangeSegment('momentum-range',range);
    for (const selector of ['[data-momentum-standing]','[data-momentum-selected]','[data-momentum-coverage]']) body.querySelector(selector).replaceChildren();
    body.querySelector('[data-momentum-chart]').innerHTML=pending('Reading stored momentum history…');
    try {
      const result=await env.api('market/monitor',{signal:controller.signal,params:{date:anchor,limit:range,metrics:keys.join(',')}});
      if (active() && run===request) paint(result);
    } catch(error) {
      if (active() && run===request && error.name!=='AbortError') body.querySelector('[data-momentum-chart]').innerHTML=notice('Momentum history unavailable',error.message,'',true);
    }
  }
  body.addEventListener('click',event=>{
    const button=event.target.closest('[data-action="momentum-range"], [data-momentum-side]');
    if (!button) return;
    event.stopPropagation();
    if (button.dataset.action==='momentum-range') {range=Number(button.dataset.value);load();return;}
    const index=Number(button.dataset.momentumSide);
    if (!keys[index] || !selectedDate) return;
    openBreadthDrawer(env,{key:keys[index],date:selectedDate,title:`${pair.label} · ${index?'Downside':'Upside'}`,reading:rows.find(row=>row.date===selectedDate)}).catch(error=>env.toast(error.message));
  });
  await load();
}
