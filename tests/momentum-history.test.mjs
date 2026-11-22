import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

test('momentum heading history reads saved pairs, defaults to one year, and retains context', async t=>{
  const dom=new JSDOM('<dialog open><main></main></dialog>');
  const previous=globalThis.document;
  globalThis.document=dom.window.document;
  t.after(()=>{globalThis.document=previous;dom.window.close();});
  const {openMomentumHistory,momentumStanding}=await import('../frontend/momentum-history.js');
  const {momentumExtremeClass,render:renderMonitor}=await import('../frontend/monitor.js');
  assert.equal(momentumExtremeClass(90),'');
  assert.equal(momentumExtremeClass(95),' extreme-high');
  assert.equal(momentumExtremeClass(5),' extreme-low');
  assert.equal(momentumExtremeClass(97,2),'');
  assert.equal(momentumExtremeClass(98,2),' extreme-high');
  assert.equal(momentumExtremeClass(2,2),' extreme-low');
  assert.equal(momentumExtremeClass(0),' extreme-low');
  assert.equal(momentumExtremeClass(null),'');
  assert.equal(momentumExtremeClass(101),'');
  const rows=Array.from({length:65},(_,i)=>({date:new Date(Date.UTC(2026,0,i+1)).toISOString().slice(0,10),
    up_50pct_20d:i===64?5:i%5,down_50pct_20d:2,up_50pct_20d_numerator:5,up_50pct_20d_denominator:100,
    down_50pct_20d_numerator:2,down_50pct_20d_denominator:100}));
  const standing=momentumStanding(rows,'up_50pct_20d');
  assert.equal(standing.percentile,100);
  assert.equal(standing.observations,64);
  assert.equal(standing.low,0);
  assert.equal(momentumStanding([{date:'2026-01-01',x:0}],'x').value,0);
  assert.equal(momentumStanding([{date:'2026-01-01',x:null}],'x'),null);
  assert.equal(momentumStanding(rows.slice(-3),'up_50pct_20d').percentile,null);
  assert.equal(momentumStanding([...rows.slice(0,-1),{...rows.at(-1),up_50pct_20d_extreme_percentile:0,up_50pct_20d_calibration_observations:252}],'up_50pct_20d').percentile,0);
  assert.equal(momentumStanding([{date:'2026-01-01',x:0},{date:'2026-01-02',x:null}],'x'),null,'do not call an old observation the latest reading');
  const calls=[];
  const detail=document.querySelector('dialog');
  const env={detail,context:{universe:'us-core',dataVersion:18914},config:{universes:[{id:'us-core',name:'US Core'}]},
    showDialog(_detail,title,markup,subtitle){detail.dataset.title=title;detail.dataset.subtitle=subtitle;document.querySelector('main').innerHTML=markup;return document.querySelector('main');},
    async api(path,options){calls.push({path,...options});return{rows,materialization:{missingDates:['2026-01-03']}};},toast(){}};
  await openMomentumHistory(env,{pair:{label:'Large monthly moves',sessions:20,threshold:50},data:{rows:[rows.at(-1)]}});
  assert.equal(calls[0].path,'market/monitor');
  assert.deepEqual(calls[0].params,{date:rows.at(-1).date,limit:252,metrics:'up_50pct_20d,down_50pct_20d'});
  assert.match(detail.dataset.subtitle,/US Core/);
  assert.equal(document.querySelector('[data-action="momentum-range"][aria-pressed="true"]').dataset.value,'252');
  assert.match(detail.textContent,/100.0 historical percentile/);
  assert.match(detail.textContent,/1 sessions are not yet prepared/);
  assert.equal(document.querySelectorAll('.chart-line').length,2);
  assert.equal(document.querySelector('[data-chart-scale="focus"]').getAttribute('aria-pressed'),'true');
  assert.equal(document.querySelectorAll('[data-momentum-side]').length,2);
  document.querySelector('[data-action="momentum-range"][data-value="1260"]').click();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(calls.at(-1).params.limit,1260);
  detail.dispatchEvent(new dom.window.Event('close'));
  assert.equal(calls.at(-1).signal.aborted,true);

  let actions;
  const main=document.querySelector('main');
  await renderMonitor({main,state:{},config:{},setActions(value){actions=value;},isActive:()=>true,routeUrl:()=> '#settings',
    publishedSeries:async()=>({rows:[rows.at(-1)],coverage:{state:'complete'},metrics:[],ratioDefinitions:[]})});
  await new Promise(resolve=>setTimeout(resolve,0));
  const headings=[...main.querySelectorAll('.monitor-table thead tr:last-child th')].map(node=>node.textContent);
  assert.match(headings[0],/Daily momentum/);
  assert.match(headings[1],/U\/D participation/);
  assert.match(headings[2],/Quarterly momentum/);
  assert.match(headings[3],/Monthly momentum/);
  assert.match(headings[4],/Large monthly moves/);
  assert.match(headings[5],/34-session moves/);
  assert.deepEqual([...main.querySelectorAll('.monitor-tier-row [scope="colgroup"]')].map(node=>[node.textContent,node.colSpan]),
    [['Primary breadth indicators',3],['Secondary breadth indicators',3]]);
  assert.deepEqual([...main.querySelectorAll('thead [data-action="monitor-pair-history"]')].map(node=>node.dataset.value),['0','3','1','2','4']);
  const cells=main.querySelector('.monitor-table tbody tr').children;
  assert.ok(cells[2].querySelector('[data-action="monitor-ratio"]'));
  assert.ok(cells[3].querySelector('[data-value="down_25pct_63d"]'));
  assert.ok(cells[4].querySelector('[data-value="down_25pct_20d"]'));
  assert.equal(cells[1].querySelector('.breadth-bar').dataset.value,'up_4pct');
  assert.equal(cells[1].querySelector('.breadth-bar:last-child').dataset.value,'down_4pct');
  assert.match(main.querySelector('.bar-column-head span').textContent,/Up ≥ 4%/);
  actions['change:monitor-extreme-tail']('2');
  assert.match(main.querySelector('[data-extreme-lower]').textContent,/2nd percentile/);
  assert.match(main.querySelector('[data-extreme-upper]').textContent,/98th percentile/);
});
