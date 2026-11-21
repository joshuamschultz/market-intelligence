import {
  action, blobDownload, chip, count, dateLabel, empty, field, heading, icon, iconButton, notice, number, option,
  panelHead, pagination, pathPart, pending, percent, safe, segment, summary, table,
} from './ui.js';
import { partialCoverage } from './overview.js';
import { modelEditor } from './screener.js';
import { mountJournalSettings } from './journal.js';
import { mountQualityAudit } from './data-quality.js';

const rateKeys = ['close', 'return_1d', 'return_21d', 'rsRank', 'rsPercentile', 'velocity4w', 'udv_50d'];
const listColumns = ['symbol', 'name', ...rateKeys];
const jobTitles = {
  'provider-import': 'Import prices', 'provider-probe': 'Check provider access', 'event-study': 'Breadth event study',
  'provider-bootstrap': 'Load market history', 'provider-reference': 'Refresh current reference data', 'rank-materialize': 'Archive stock rankings', 'workspace-precompute': 'Precompute workspace history',
  'journal-generate': 'Generate market update', 'journal-backtest': 'Backtest journal signals',
  cohort: 'Cohort analysis', materialize: 'Materialize history', backup: 'Warehouse backup',
};
const builtins = new Set(['composite','short-momentum','benchmark-relative']);
const healthParts = {
  shortBreadth: 'Short-term breadth', intermediateBreadth: 'Intermediate-term breadth', longBreadth: 'Long-term breadth',
  priceMomentum: 'Price momentum', volumeParticipation: 'Volume participation', industryLeadership: 'Industry leadership', highsLows: 'Highs vs lows',
};
const savedContext = (screen) => ({ ...screen?.definition?.context, date: screen?.definition?.context?.date || null });
const screenUrl = (env, screen) => env.routeUrl('screener', { ...savedContext(screen), screen: screen.id });
const splitValues = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
const timestamp = (value) => value ? `${dateLabel(value)} ${String(value).slice(11,16)} UTC` : '—';
const itemPath = (area, id) => `${area}/${pathPart(id)}`;
const braceJSON = (data) => JSON.stringify(data, null, 2);

function saveError(target, error) {
  const output = target.querySelector('.form-error');
  if (output) {
    output.hidden = false;
    output.textContent = error.message;
  }
}
function confirmDelete(env, name, effect) {
  const target = env.showDialog(env.modal, `Delete ${name}?`, `<form class="stack"><p class="muted">This removes the item from your workspace.</p>
    <div class="form-error" role="alert" hidden></div><div class="actions"><button class="button danger" type="submit">${icon('trash')} Delete</button>
    ${action('Cancel','close-dialog','close')}</div></form>`);
  target.onsubmit = async (event) => {
    event.preventDefault();
    try {
      await effect();
      env.modal.close();
      env.toast('Deleted');
      await env.reloadConfig();
      env.render();
    } catch (error) { saveError(target,error); }
  };
}
function card(title, kind, body, controls, glyph) {
  return `<article class="panel library-card"><header><div class="item-icon">${icon(glyph)}</div><div><h2>${safe(title)}</h2><p class="muted">${safe(kind)}</p></div></header>
    <div class="library-card-content">${body}</div><div class="actions library-card-actions">${controls}</div></article>`;
}

function countRules(node) {
  if (!node) return 0;
  return node.filters ? node.filters.reduce((sum,child)=>sum+countRules(child),0) : 1;
}

async function renderScreens(env) {
  const screens = await env.api('screens',{plain:true,signal:env.signal});
  if (!env.isActive()) return;
  const edit = (id) => {
    const screen = screens.find((item)=>item.id === id);
    if (screen) env.go('screener',{...savedContext(screen),screen:id});
  };
  env.setActions({
    'open-screen':edit,
    async 'duplicate-screen'(id) {
      const copy = await env.api(`${itemPath('screens',id)}/duplicate`,{body:{},plain:true});
      env.toast(`Created ${copy.name}`);
      await env.reloadConfig();
      env.render();
    },
    'delete-screen': (id) => confirmDelete(env, 'screen',()=>env.api(itemPath('screens',id),{method:'DELETE',plain:true})),
    'export-view'(id) {
      const screen = screens.find((item)=>item.id===id);
      if (!screen) return;
      blobDownload(new Blob([braceJSON(screen)],{type:'application/json'}),`screen-${id.slice(0,8)}.json`);
    },
    'versions-screen'(id) {
      const screen = screens.find((item)=>item.id===id);
      if (!screen) return;
      const target = env.showDialog(env.modal,`${screen.name} · versions`, `<form class="inline-form">
        ${field('Version',`<input type="number" name="version" min="1" max="${screen.version}" value="${screen.version}" required>`)}
        <button class="button primary" type="submit">Inspect version</button></form><div id="version-result" class="section-space"></div>`);
      target.onsubmit = async (event) => {
        event.preventDefault();
        const version = Number(new FormData(event.target).get('version'));
        const output = target.querySelector('#version-result');
        output.innerHTML = pending();
        try {
          const snapshot=await env.api(itemPath('screens',id),{params:{version},plain:true});
          output.innerHTML = `<pre class="json-preview">${safe(braceJSON(snapshot.definition))}</pre>`;
        } catch(error) { output.innerHTML=notice('Version unavailable',error.message,'',true); }
      };
    },
  });
  env.main.innerHTML = heading('Saved Screens','Reopen, duplicate, and export your research filters and table layouts.',
    `<a class="button primary" href="${safe(env.routeUrl('screener'))}">${icon('plus')} Build screen</a>`) +
    (screens.length ? `<div class="library-grid">${screens.map((screen)=>card(screen.name,`Version ${screen.version || 1}`,
      `<div class="inline-stack">${chip(`${countRules(screen.definition?.filter)} rules`)}${chip(`${count(screen.definition?.columns?.length || 0)} columns`)}
      ${chip(screen.definition?.context?.date ? dateLabel(screen.definition.context.date) : 'Latest session')}</div>`,
      action('Open in screener','open-screen','screener',{value:screen.id,className:'primary'}) + iconButton('Duplicate','duplicate-screen','copy',screen.id) +
      iconButton('Inspect versions','versions-screen','history',screen.id) + iconButton('Export definition JSON','export-view','download',screen.id) +
      iconButton('Delete','delete-screen','trash',screen.id),'screens')).join('')}</div>`
      : empty('No saved screens','Use the screener to build a query and save its current view.','screens',
        `<a class="button" href="${safe(env.routeUrl('screener'))}">Open stock screener ${icon('chevron-right')}</a>`));
}

async function resolveSecurities(env, entries, existing = []) {
  const known = new Set(existing);
  return Promise.all([...new Set(entries)].map(async (value) => {
    if (known.has(value)) return value;
    return (await env.api(`stocks/${pathPart(value)}/metrics`)).securityId;
  }));
}

function watchEditor(env, screens, existing, defaultMembers = []) {
  const start = existing?.definition || {};
  const target = env.showDialog(env.modal, existing ? 'Edit watchlist' : 'Create watchlist', `<form class="stack">
    ${field('Name',`<input name="name" required maxlength="100" placeholder="Leadership candidates" value="${safe(existing?.name || '')}">`)}
    ${field('List type',`<select name="mode">${option('manual','Manual selections',start.mode || 'manual')}${option('dynamic','Dynamic from a saved screen',start.mode)}</select>`)}
    <div id="watch-form-details"></div><div class="form-error" role="alert" hidden></div>
    <div><button class="button primary" type="submit">${icon('check')} Save watchlist</button></div></form>`);
  function update(mode) {
    const selected = start.members || defaultMembers;
    target.querySelector('#watch-form-details').innerHTML = mode === 'dynamic'
      ? field('Saved screen',`<select name="screen" required>${option('','Select a saved screen',start.screenId || '')}${screens.map(({id,name})=>option(id,name,start.screenId)).join('')}</select>`,
        screens.length ? 'Membership updates from the screen query.' : 'Save a screen before creating a dynamic watchlist.')
      : field('Optional stock tickers',`<input name="symbols" placeholder="AAPL, MSFT, …">`, selected.length ? `${selected.length} selected members are already included.` : 'Separate tickers with commas.');
  }
  target.querySelector('[name="mode"]').onchange = (event) => update(event.target.value);
  target.onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      const all = form.get('mode') === 'manual' ? [...new Set([...(start.members || defaultMembers), ...await resolveSecurities(env,splitValues(form.get('symbols')))])] : [];
      const saved = await env.api(existing ? itemPath('watchlists',existing.id) : 'watchlists', { method: existing ? 'PUT' : 'POST', plain:true,
        body:{name:form.get('name'),definition:{members:all,screenId:form.get('screen') || null}} });
      env.modal.close();
      env.toast(`Saved ${saved.name}`);
      if (env.page === 'watchlists') env.go('watchlists',{list:saved.id});
    } catch(error) { saveError(target,error); }
  };
  update(start.mode || 'manual');
}

export async function openAddWatchlist(env, ids) {
  if (!ids.length) return;
  const lists = (await env.api('watchlists',{plain:true})).filter((item)=>!item.definition?.screenId);
  const target = env.showDialog(env.modal,'Add to watchlist',`<form class="stack">
    ${field('Watchlist',`<select name="list" required>${option('','Choose a manual watchlist','')}${lists.map(({id,name})=>option(id,name,'')).join('')}
      ${option('new','Create a new watchlist','')}</select>`)}
    <div id="new-list-name" hidden>${field('New watchlist name','<input name="name" maxlength="100" placeholder="Watchlist name">')}</div>
    <div class="form-error" role="alert" hidden></div><div><button class="button primary" type="submit">${icon('check')} Add ${count(ids.length)} ${ids.length === 1 ? 'stock' : 'stocks'}</button></div></form>`);
  target.querySelector('[name="list"]').onchange = (event) => {
    const show = event.target.value === 'new';
    const name = target.querySelector('#new-list-name');
    name.hidden = !show;
    name.querySelector('input').required = show;
  };
  target.onsubmit = async (event) => {
    event.preventDefault();
    const values = new FormData(event.target);
    const id = values.get('list');
    try {
      const result = id === 'new' ? await env.api('watchlists',{plain:true,body:{name:values.get('name'),definition:{members:ids}}})
        : await env.api(`${itemPath('watchlists',id)}/members`,{plain:true,body:{add:ids}});
      env.modal.close();
      env.toast(`Added to ${result.name}`);
      if (env.page === 'watchlists') env.render();
    } catch(error) { saveError(target,error); }
  };
}

async function renderWatchlists(env) {
  const all = await env.api('watchlists',{plain:true,signal:env.signal});
  if (!env.isActive()) return;
  const selected = all.find(({id})=>id===env.params.list) || all[0];
  const currentScreen = env.config.screens.find(({id})=>id===selected?.definition?.screenId);
  const dynamic = !!selected?.definition?.screenId;
  let page = 1;
  async function load() {
    const target = env.main.querySelector('#members');
    if (!target || !selected) return;
    target.innerHTML = pending('Loading members…');
    try {
      const result = await env.api(`${itemPath('watchlists',selected.id)}/members`,{signal:env.signal,params:{page,perPage:50}});
      if (!target.isConnected) return;
      target.innerHTML = (result.unavailable?.length ? notice('Some members are unavailable', `${count(result.unavailable.length)} saved securities fall outside the selected universe or session.`) : '') +
        table(result.rows,listColumns,{emptyText:'No tracked securities in this context.',
          rowAction:dynamic ? null : (row)=>iconButton('Remove from watchlist','remove-member','trash',row.securityId)}) + pagination(result,'members-page');
    } catch(error) { if (target.isConnected && error.name!=='AbortError') target.innerHTML=notice('Members unavailable',error.message,'',true); }
  }
  env.setActions({
    'new-watch':()=>watchEditor(env,env.config.screens),
    'select-watch':(id)=>env.go('watchlists',{list:id}),
    'edit-watch':()=>watchEditor(env,env.config.screens,selected),
    'delete-watch':()=>confirmDelete(env,'watchlist',()=>env.api(itemPath('watchlists',selected.id),{method:'DELETE',plain:true})),
    'members-page'(value) { page=Number(value); return load(); },
    async 'remove-member'(id) {
      await env.api(`${itemPath('watchlists',selected.id)}/members`,{plain:true,body:{remove:[id]}});
      env.toast('Removed from watchlist');
      return load();
    },
    'add-members'() {
      const target=env.showDialog(env.modal,'Add watchlist members',`<form class="stack">${field('Stock tickers','<input name="symbols" required placeholder="AAPL, MSFT, …">')}
        <div class="form-error" role="alert" hidden></div><div><button class="button primary" type="submit">Add stocks</button></div></form>`);
      target.onsubmit=async(event)=>{
        event.preventDefault();
        try {
          const add = await resolveSecurities(env,splitValues(new FormData(event.target).get('symbols')));
          await env.api(`${itemPath('watchlists',selected.id)}/members`,{plain:true,body:{add}});
          env.modal.close();
          env.toast('Watchlist updated');
          load();
        } catch(error) {saveError(target,error);}
      };
    },
  });
  env.main.innerHTML = heading('Watchlists','Track manually selected stocks or continuously evaluate a saved screen.',
    action('Create watchlist','new-watch','plus',{className:'primary'})) +
    (selected ? `<div class="library-layout"><section class="panel panel-body library-nav">${panelHead('Your lists')}${all.map((item)=>`<button type="button" class="library-option"
      data-action="select-watch" data-value="${safe(item.id)}" aria-pressed="${item.id===selected.id}">${icon('watchlists')}<span>${safe(item.name)}</span></button>`).join('')}</section>
      <section class="panel panel-body">${panelHead(selected.name,dynamic ? `Dynamic · ${currentScreen?.name || 'Source screen unavailable'}` : 'Manual watchlist',
      (dynamic ? currentScreen ? `<a class="button" href="${safe(screenUrl(env,currentScreen))}">Source screen ${icon('chevron-right')}</a>` : '' : action('Add stocks','add-members','plus'))+
      iconButton('Edit watchlist','edit-watch','edit')+iconButton('Delete watchlist','delete-watch','trash'))}<div id="members">${pending()}</div></section></div>`
      : empty('No watchlists','Create a manual list or connect a saved screen.','watchlists',action('Create watchlist','new-watch','plus')));
  if (selected) await load();
}

const alertTypes = [['breadth','Breadth threshold crossing'],['stocks','Stock condition entry or exit'],['screen','Saved screen membership'],['industry','Industry rank entry'],['regime','Market-health regime change']];
function alertLabel(def, config) {
  if (def.type==='breadth') {
    const metric=config.breadthMetrics.find(({key})=>key===def.metric)?.label || def.metric;
    return `${metric} crosses ${def.direction || 'above'} ${percent(def.threshold)}`;
  }
  if (def.type==='screen') return `${def.direction || 'Membership changes'} · ${config.screens.find(({id})=>id===def.screenId)?.name || 'Saved screen'}`;
  if (def.type==='stocks') return `${def.direction || 'Membership changes'} · ${def.filter?.expression || def.filter?.field || 'Stock condition'}`;
  if (def.type==='industry') return `Industry enters top ${def.top || 10}`;
  return 'Market-health regime changes';
}
function alertEditor(env, existing = null) {
  const current = existing?.definition || {};
  const target=env.showDialog(env.modal,existing ? 'Edit alert rule' : 'Create alert rule',`<form class="stack">
    ${field('Name',`<input name="name" required maxlength="100" value="${safe(existing?.name || '')}" placeholder="50D breadth turns up">`)}
    ${field('Trigger',`<select name="type">${alertTypes.map(([id,label])=>option(id,label,current.type || 'breadth')).join('')}</select>`)}
    <div id="alert-form-details"></div>
    <label class="checkbox-label"><input type="checkbox" name="active"${current.active===false ? '' : ' checked'}> Enable this rule</label>
    <p class="muted">Rules use ${safe(env.config.universes.find(({id})=>id===(current.context?.universe || env.context.universe))?.name || env.context.universe)} when evaluating finalized sessions.</p>
    <div class="form-error" role="alert" hidden></div><div><button class="button primary" type="submit">Save rule</button></div></form>`);
  const directionField = () => field('Membership event',`<select name="direction">${option('both','Enters or leaves',current.direction || 'both')}
    ${option('enters','Enters',current.direction)}${option('leaves','Leaves',current.direction)}</select>`);
  function update(type) {
    target.querySelector('#alert-form-details').innerHTML = type === 'breadth' ? `<div class="form-grid">
      ${field('Breadth metric',`<select name="metric">${env.config.breadthMetrics.map(({key,label})=>option(key,label,current.metric || 'above_50d')).join('')}</select>`)}
      ${field('Direction',`<select name="direction">${option('above','Crosses above',current.direction || 'above')}${option('below','Crosses below',current.direction)}</select>`)}
      ${field('Threshold (%)',`<input type="number" step=".01" min="0" max="100" name="threshold" required value="${safe(current.threshold ?? 50)}">`)}</div>`
      : type==='stocks' ? `<div class="stack">${field('Screen expression',`<input name="expression" maxlength="1000" required value="${safe(current.filter?.expression || '')}" placeholder="rsPercentile &gt;= 95">`, 'Use screener metric IDs and comparison operators.')}${directionField()}</div>`
      : type==='screen' ? `<div class="form-grid">${field('Saved screen',`<select name="screen" required>${option('','Choose a saved screen','')}
        ${env.config.screens.map(({id,name})=>option(id,name,current.screenId)).join('')}</select>`)}${directionField()}</div>`
      : type==='industry' ? field('Top rank',`<input name="top" type="number" min="1" max="1000" value="${safe(current.top || 10)}" required>`)
      : '<p class="muted">Triggered when consecutive published sessions have different regimes.</p>';
  }
  target.querySelector('[name="type"]').onchange=(event)=>update(event.target.value);
  target.onsubmit=async(event)=>{
    event.preventDefault();
    const entries=Object.fromEntries(new FormData(event.target));
    const context = { ...env.context, ...current.context };
    delete context.date;
    delete context.dataVersion;
    const details = { type:entries.type,active:!!entries.active,context,...(entries.direction ? {direction:entries.direction} : {}) };
    if (entries.type==='breadth') Object.assign(details,{metric:entries.metric,threshold:Number(entries.threshold)});
    if (entries.type==='stocks') details.filter={expression:entries.expression};
    if (entries.type==='screen') details.screenId=entries.screen;
    if (entries.type==='industry') details.top=Number(entries.top);
    try {
      await env.api(existing ? itemPath('alert-rules',existing.id) : 'alert-rules',{method:existing?'PUT':'POST',plain:true,
        body:{name:entries.name,definition:details}});
      env.modal.close();
      env.toast('Alert rule saved');
      env.render();
    } catch(error) {saveError(target,error);}
  };
  update(current.type || 'breadth');
}

async function renderAlerts(env) {
  const [rules,events] = await Promise.all([env.api('alert-rules',{plain:true,signal:env.signal}),env.api('alerts',{plain:true,signal:env.signal})]);
  if (!env.isActive()) return;
  env.state.tab ||= 'events';
  function draw() {
    env.main.innerHTML=heading('Alerts','Review dated leadership and breadth transitions.',action('Create rule','new-alert','plus',{className:'primary'})+
      action('Evaluate session','eval-alerts','refresh'))+
      segment('alerts-tab',[['events',`Event log (${events.length})`],['rules',`Rules (${rules.length})`]],env.state.tab,'tabs')+
      (env.state.tab==='rules'
        ? rules.length ? `<div class="library-grid">${rules.map((rule)=>card(rule.name,alertTypes.find(([id])=>id===rule.definition.type)?.[1] || rule.definition.type,
          `<p class="muted">${safe(alertLabel(rule.definition,env.config))}</p><div class="section-space">${chip(rule.definition.active===false?'Paused':'Enabled',rule.definition.active===false?'warning':'accent')}</div>`,
          action(rule.definition.active===false?'Enable':'Pause','toggle-rule','pulse',{value:rule.id})+
          iconButton('Edit rule','edit-alert','edit',rule.id)+iconButton('Delete rule','delete-alert','trash',rule.id),'alerts')).join('')}</div>`
          : empty('No alert rules','Create a rule to evaluate a threshold, screen membership, or leadership transition.','alerts')
        : events.length ? `<section class="panel panel-body">${panelHead('Triggered events')}
          <div class="table-scroll" tabindex="0" role="region" aria-label="Triggered alert events"><table><thead><tr>
          <th>Session</th><th>Alert rule</th><th>Subject</th><th>Trigger</th><th>Universe</th><th>Source updated</th><th>Coverage</th></tr></thead>
          <tbody>${events.map((event)=>`<tr><td>${dateLabel(event.date)}</td><td>${safe(event.name)}</td><td>${safe(event.symbol||event.group||event.subject)}</td>
          <td>${safe(event.action||event.regime?.label||alertLabel(event.rule || {},env.config))}</td><td>${safe(event.universe)}</td><td>${safe(timestamp(event.sourceTimestamp))}</td>
          <td>${chip(event.coverage||'unknown',event.coverage==='complete'?'accent':'warning')}</td></tr>`).join('')}</tbody></table></div></section>`
          : empty('No alert events','Events appear after an enabled rule matches a completed session.','alerts'));
  }
  env.setActions({
    'alerts-tab'(value) {env.state.tab=value;draw();},
    'new-alert':()=>alertEditor(env),
    'edit-alert':(id)=>alertEditor(env,rules.find((rule)=>rule.id===id)),
    'delete-alert':(id)=>confirmDelete(env,'alert rule',()=>env.api(itemPath('alert-rules',id),{method:'DELETE',plain:true})),
    async 'toggle-rule'(id) {
      const rule=rules.find((item)=>item.id===id);
      if (!rule) return;
      await env.api(itemPath('alert-rules',id),{method:'PUT',plain:true,
        body:{name:rule.name,definition:{...rule.definition,active:rule.definition.active===false}}});
      env.render();
    },
    async 'eval-alerts'() {
      const result=await env.api('alerts/evaluate',{body:{context:env.context},plain:true});
      env.toast(`${count(result.evaluated)} rules evaluated · ${count(result.fired)} new events`);
      env.state.tab='events';
      env.render();
    },
  });
  draw();
}

function jobDetails(env, job) {
  const target=env.showDialog(env.modal,jobTitles[job.type] || 'Warehouse job',pending('Loading job details…'));
  let current=job;
  async function paint() {
    try {
      current=await env.api(itemPath('jobs',current.id),{plain:true});
      if (!target.isConnected || !env.modal.open) return;
      const text = current.error ? notice('Job failed',current.error,'',true) : '';
      const outcome = current.result?.status;
      const checkpointed = current.type === 'provider-bootstrap' && ['paused', 'incomplete'].includes(outcome);
      const displayStatus = checkpointed ? outcome : current.status;
      target.innerHTML=`<div class="inline-stack">${chip(displayStatus,current.status==='complete' && !checkpointed?'accent':'warning')}
        ${chip(`${count(current.progress)}% job progress`)}${chip(timestamp(current.updated_at))}</div>
        ${checkpointed ? `<p class="muted section-space">Completed tasks are checkpointed. Reopen Load market history with the same dates and scope to resume.</p>` : ''}
        ${text ? `<div class="section-space">${text}</div>` : ''}
        ${current.result ? `<pre class="json-preview section-space">${safe(braceJSON(current.result))}</pre>` : ''}`;
      if (['queued','running'].includes(current.status)) setTimeout(paint,1100);
      else if (current.status==='complete') {
        await env.reloadConfig();
        if (env.page==='settings' && env.isActive()) env.render();
      }
    } catch(error) { if (target.isConnected) target.innerHTML=notice('Job status unavailable',error.message,'',true); }
  }
  paint();
}
function importEditor(env) {
  const last=env.config.status.latestDate || '';
  const target=env.showDialog(env.modal,'Import EODHD data',`<form class="stack">
    ${field('Import mode',`<select name="mode">${option('symbols','Symbol history','symbols')}${option('bulk','Exchange-wide bulk sessions','')}</select>`)}
    <div class="form-grid">${field('From',`<input type="date" name="from" value="${safe(env.config.status.earliestDate || last)}" required>`)}
      ${field('To',`<input type="date" name="to" value="${safe(last)}" required>`)}</div>
    <div id="provider-symbols">${field('Ticker symbols','<input name="symbols" value="AAPL, MSFT, AMZN, TSLA, VTI" required>')}</div>
    <label class="checkbox-label"><input name="actions" type="checkbox" checked> Include available corporate actions</label>
    <label class="checkbox-label"><input name="reference" type="checkbox"> Request available reference fields</label>
    <label class="checkbox-label"><input name="delisted" type="checkbox"> Request the delisted catalog for bulk imports</label>
    <div class="form-error" role="alert" hidden></div><div><button class="button primary" type="submit">Queue import</button></div></form>`);
  target.querySelector('[name="mode"]').onchange=(event)=>{
    const bulk=event.target.value==='bulk';
    target.querySelector('#provider-symbols').hidden=bulk;
    target.querySelector('[name="symbols"]').required=!bulk;
  };
  target.onsubmit=async(event)=>{
    event.preventDefault();
    const form=Object.fromEntries(new FormData(event.target));
    try {
      const body={from:form.from,to:form.to,date:form.to,bulk:form.mode==='bulk',actions:!!form.actions,reference:!!form.reference,delisted:!!form.delisted};
      if (!body.bulk) body.symbols=splitValues(form.symbols);
      const job=await env.api('data/refresh',{body,plain:true});
      jobDetails(env,job);
    } catch(error) {saveError(target,error);}
  };
}
function bootstrapEditor(env, existing = null) {
  const settings = existing?.payload || {};
  const latest = env.config.status.latestDate;
  const asDate = latest ? new Date(`${latest}T00:00:00Z`) : null;
  if (asDate) asDate.setUTCFullYear(asDate.getUTCFullYear() - 10);
  const target = env.showDialog(env.modal, 'Load market history', `<form class="stack">
    <div class="form-grid">
      ${field('From', `<input name="from" type="date" value="${safe(settings.from || asDate?.toISOString().slice(0,10))}" required>`)}
      ${field('Through', `<input name="to" type="date" value="${safe(settings.to || latest)}" required>`)}
      ${field('Daily provider credit budget', `<input name="maxCalls" type="number" min="1" max="1000000" value="${safe(settings.maxCalls || 10000)}" required>`)}
      ${field('Concurrent requests', `<input name="concurrency" type="number" min="1" max="10" value="${safe(settings.concurrency || 3)}" required>`)}
    </div>
    ${field('Limit to ticker symbols', `<input name="symbols" value="${safe(settings.symbols?.join?.(', ') || settings.symbols || '')}" placeholder="Blank for the US common-stock catalog">`)}
    <div class="form-grid">
      <label class="checkbox-label"><input type="checkbox" name="includeDelisted" ${settings.includeDelisted === false ? '' : 'checked'}> Include delisted companies</label>
      <label class="checkbox-label"><input type="checkbox" name="actions" ${settings.actions === false ? '' : 'checked'}> Include corporate actions</label>
      <label class="checkbox-label"><input type="checkbox" name="reference" ${settings.reference ? 'checked' : ''}> Include current reference data</label>
      <label class="checkbox-label"><input type="checkbox" name="includeAmex" ${settings.includeAmex ? 'checked' : ''}> Include NYSE American</label>
      <label class="checkbox-label"><input type="checkbox" name="includeAdrs" ${settings.includeAdrs ? 'checked' : ''}> Include ADRs</label>
      <label class="checkbox-label"><input type="checkbox" name="includeReits" ${settings.includeReits ? 'checked' : ''}> Include REITs</label>
    </div>
    <p class="muted">Reusing the same dates and scope resumes completed checkpoints. Choose a budget within your EODHD plan.</p>
    <div class="form-error" role="alert" hidden></div><div><button class="button primary" type="submit">Queue history load</button></div></form>`);
  target.onsubmit = async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target));
    const body = { from: values.from, to: values.to, symbols: splitValues(values.symbols),
      concurrency: Number(values.concurrency), maxCalls: Number(values.maxCalls),
      ...Object.fromEntries(['includeDelisted', 'actions', 'reference', 'includeAmex', 'includeAdrs', 'includeReits'].map((key) => [key, !!values[key]])),
      ...(settings.benchmarks ? { benchmarks: settings.benchmarks } : {}) };
    try { jobDetails(env, await env.api('data/bootstrap', { body, plain: true })); }
    catch (error) { saveError(target, error); }
  };
}

function referenceEditor(env) {
  const target = env.showDialog(env.modal, 'Refresh current reference data', `<form class="stack">
    ${field('Ticker symbols', '<input name="symbols" placeholder="Blank to refresh by exchange">')}
    <div class="form-grid">
      ${field('Exchanges', '<input name="exchanges" value="NYSE, NASDAQ" required>')}
      ${field('Maximum pages per exchange', '<input type="number" name="maxPages" min="1" max="50" value="20" required>')}
    </div>
    <p class="muted">Available classifications, public float, and shares are dated to the provider capture. Historical research uses only data available for its selected date.</p>
    <div class="form-error" role="alert" hidden></div><div><button class="button primary" type="submit">Queue reference refresh</button></div></form>`);
  target.onsubmit = async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target));
    const body = { symbols: splitValues(values.symbols), exchanges: splitValues(values.exchanges).map((symbol) => symbol.toUpperCase()),
      maxPages: Number(values.maxPages) };
    try { jobDetails(env, await env.api('data/reference', { body, plain: true })); }
    catch (error) { saveError(target, error); }
  };
}

function universeEditor(env, existing=null) {
  const settings = existing?.definition || {};
  const target = env.showDialog(env.modal,existing?'Edit universe':'Create universe',`<form class="stack">
    ${field('Name',`<input name="name" required maxlength="100" value="${safe(existing?.name || '')}" placeholder="Liquid growth stocks">`)}
    <div class="form-grid">
      ${field('Exchanges',`<input name="exchanges" value="${safe(settings.exchanges?.join(', ') ?? 'NYSE, NASDAQ')}" placeholder="NYSE, NASDAQ">`)}
      ${field('Security types',`<input name="types" value="${safe(settings.types?.join(', ') ?? 'common')}" placeholder="common, etf">`)}
      ${field('Minimum price',`<input name="minPrice" type="number" min="0" step=".01" value="${safe(settings.minPrice)}">`)}
      ${field('Minimum 20D average dollar volume',`<input name="minAdv20" type="number" min="0" value="${safe(settings.minAdv20)}">`)}
      ${field('Minimum market cap',`<input name="minCap" type="number" min="0" value="${safe(settings.minCap)}">`)}
      ${field('Maximum market cap',`<input name="maxCap" type="number" min="0" value="${safe(settings.maxCap)}">`)}
    </div>${field('Explicit members',`<input name="members" value="${safe((settings.members || []).map((item)=>item.securityId || item).join(', '))}" placeholder="Optional comma-separated tickers">`)}
    <label class="checkbox-label"><input name="observed" type="checkbox" ${settings.observedOnly?'checked':''}> Require price coverage through the as-of session</label>
    <div class="form-error" role="alert" hidden></div><div><button class="button primary" type="submit">Save and use universe</button></div></form>`);
  target.onsubmit = async (event)=>{
    event.preventDefault();
    const values=Object.fromEntries(new FormData(event.target));
    try {
      const memberIds=await resolveSecurities(env,splitValues(values.members),(settings.members || []).map((item)=>item.securityId || item));
      const old = new Map((settings.members||[]).filter((item)=>typeof item==='object').map((item)=>[item.securityId,item]));
      const definition={exchanges:splitValues(values.exchanges),types:splitValues(values.types),members:memberIds.map((id)=>old.get(id) || id),
        observedOnly:!!values.observed,...Object.fromEntries(['minPrice','minAdv20','minCap','maxCap'].map((key)=>[key,values[key] === '' ? null:Number(values[key])]))};
      const universe=await env.api(existing?itemPath('universes',existing.id):'universes',{method:existing?'PUT':'POST',body:{name:values.name,definition},plain:true});
      env.modal.close();
      await env.reloadConfig();
      env.toast(`Saved ${universe.name}`);
      env.go('settings',{universe:universe.id,universeVersion:universe.version});
    } catch(error) {saveError(target,error);}
  };
}
function healthEditor(env, existing) {
  const settings=existing?.definition || env.config.healthModels[0];
  const target=env.showDialog(env.modal,existing?'Edit health model':'Create health model',`<form class="stack">
  ${field('Name',`<input name="name" required maxlength="100" value="${safe(existing?.name || '')}" placeholder="Momentum breadth model">`)}
  <div class="form-grid">${Object.entries(healthParts).map(([id,label])=>field(label,`<input type="number" name="${id}" min="0" step=".01" required value="${safe(settings.weights?.[id] ?? env.config.healthModels[0].weights?.[id] ?? 0)}">`)).join('')}</div>
  <p class="muted">Weights are normalized. A score is published only when coverage and weighted components are available.</p>
  <div class="form-error" role="alert" hidden></div><div><button class="button primary" type="submit">Save and use model</button></div></form>`);
  target.onsubmit=async(event)=>{
    event.preventDefault();
    const form=new FormData(event.target);
    try {
      const model=await env.api(existing?itemPath('health-models',existing.id):'health-models',{method:existing?'PUT':'POST',plain:true,
        body:{name:form.get('name'),definition:{...settings,weights:Object.fromEntries(Object.keys(healthParts).map((id)=>[id,Number(form.get(id))]))}}});
      env.modal.close();
      await env.reloadConfig();
      env.toast(`Saved ${model.name}`);
      env.go('settings',{healthModel:model.id});
    } catch(error) { saveError(target,error); }
  };
}

const subtypeLabels = { adr:'ADRs', reit:'REITs', preferred:'Preferred shares', warrant:'Warrants', right:'Rights', unit:'Units', etf:'ETFs' };

function facts(items, label) {
  return `<div class="quality-facts"${label ? ` aria-label="${safe(label)}"` : ''}>${items.map(([key,value]) =>
    `<div><span>${safe(key)}</span><strong class="mono">${safe(value)}</strong></div>`).join('')}</div>`;
}

function universeCoverage(coverage = {}) {
  const subtype = coverage.subtypeCoverage;
  const exact = subtype?.receivedExact === true;
  const breakdown = Object.entries(subtype?.excludedBySubtype || {}).filter(([,value])=>value>0);
  return `<section class="panel panel-body" id="quality-universe-coverage">
    ${panelHead('Universe coverage', 'Provider capture and the selected universe have separate counts.')}
    <div class="split-grid">
      ${facts([['Source expected',count(coverage.sourceExpected)],['Source received',count(coverage.sourceReceived)],
        ['Universe expected',count(coverage.expected)],['Universe received',count(coverage.received)]],'Provider and universe counts')}
      ${facts([['Identified subtype exclusions',count(subtype?.excluded)],['Excluded from expected roster',count(exact ? subtype.excludedExpected : null)],
        ['Excluded from received capture',count(exact ? subtype.excludedReceived : null)],
        ['Unverified provider common',count(subtype?.unverifiedProviderCommon)]],'Security subtype counts')}
    </div>
    ${breakdown.length ? `<div class="inline-stack">${breakdown.map(([key,value])=>chip(`${subtypeLabels[key] || key} · ${count(value)}`)).join('')}</div>` : ''}
    ${subtype?.receivedExact === false ? '<p class="muted section-space">The source kept aggregate capture totals. Exact subtype exclusions from the expected and received rosters are unavailable for this session.</p>' : ''}
    ${subtype?.unverifiedProviderCommon > 0 ? '<p class="muted section-space">Unverified provider-common securities remain eligible when independent subtype data is unavailable.</p>' : ''}
  </section>`;
}

async function renderSettings(env) {
  const { config,state,signal,main } = env;
  state.tab = env.params.tab || state.tab || 'quality';
  let data;
  let warehouse = config.status;
  let jobs = [];
  let qualityRequest;
  let jobsReady = false;
  const tiles = [['Corporate action records','corporateActions'],['Dated float records','float'],['Dated share records','shares'],['Industry classifications','classification']];
  function quality() {
    if (!data) return `<div id="quality-data">${pending('Loading warehouse quality…')}</div>`;
    const coverage = data.latestSession;
    const publication = data.latestPublication;
    return `<div class="summary-grid">
      ${summary('Price observations',count(data.prices),`${dateLabel(data.earliestDate)} – ${dateLabel(data.latestDate)}`,{glyph:'chart'})}
      ${summary('Securities',count(data.securities),`${count(data.coverage?.traded)} traded in the selected universe`,{glyph:'layers'})}
      ${summary('Warehouse version',count(data.dataVersion),`Calculation ${data.calculationVersion}`,{glyph:'settings'})}
      ${summary('Provider',data.provider?.toUpperCase() || '—',`Last successful import ${dateLabel(data.lastSuccess)}`,{glyph:'pulse'})}
    </div>
    ${partialCoverage(data.coverage,env.routeUrl)}
    <div class="split-grid">
      <section class="panel panel-body">${panelHead('Field coverage','These counts reflect the selected warehouse version.')}
      <div class="metric-grid">${tiles.map(([label,key])=>`<div class="metric-tile"><span>${label}</span><strong>${count(data.fieldCoverage?.[key]?.observations)}</strong>
      <small>${data.fieldCoverage?.[key]?.firstDate ? `${dateLabel(data.fieldCoverage[key].firstDate)} – ${dateLabel(data.fieldCoverage[key].lastDate)}` : 'No dated records'}</small></div>`).join('')}</div>
      <div class="inline-stack section-space">${chip(`${count(data.capabilities?.observed?.delistedSecurities)} delisted securities`)}${chip(`Benchmarks: ${data.availableBenchmarks?.join(', ') || 'none'}`)}</div>
      </section>
      <section class="panel panel-body">${panelHead('Session quality',`As of ${dateLabel(data.asOf)}`)}
        <div class="quality-facts">
          ${[['Observed sessions',count(data.observedSessionCount)],
          ['Expected sessions in stored range',count(data.expectedSessionCount)],['Missing trading dates',count(data.missingDateCount)],
          ['Unresolved identifiers',count(data.unresolvedIdentifiers)],['Invalid source rows',count(data.invalidRows)],
          ['Latest finalized session',dateLabel(data.lastFinalizableSession)],['Selected session coverage',data.stale?'Stale':data.coverage?.state || 'Unknown'],
          ['Latest bulk capture',coverage ? `${dateLabel(coverage.date)} · ${count(coverage.eligibleReceived)} / ${count(coverage.expected)} eligible` : 'Unavailable'],
          ['Latest verified analytics',publication ? `${dateLabel(publication.date)} · revision ${count(publication.data_revision)}` : 'No publication record'],
          ['Reference through',data.referenceDate ? dateLabel(data.referenceDate) : 'Unavailable'],
          ['Classification system',data.classificationSystem || 'Unclassified']].map(([label,value])=>`<div><span>${safe(label)}</span><strong class="mono">${safe(value)}</strong></div>`).join('')}
        </div>
      </section>
    </div>
    ${universeCoverage(data.coverage)}
    <div id="quality-source-audit-mount"></div>
    <section class="panel panel-body section-space">${panelHead('Import history','Source datasets and scope')}
      <div class="table-scroll" tabindex="0" role="region" aria-label="Recent ingestion runs"><table><thead><tr><th>Provider</th><th>Dataset</th><th>Scope</th><th>Status</th><th>Price rows</th><th>Completed</th></tr></thead>
      <tbody>${(data.runs || []).map((run)=>`<tr><td>${safe(run.provider)}</td><td>${safe(run.dataset)}</td><td>${safe(run.scope)}</td><td>${chip(run.status,run.status==='complete'?'accent':'warning')}</td>
      <td class="numeric">${count(run.rows)}</td><td>${safe(timestamp(run.finishedAt))}</td></tr>`).join('') || '<tr><td colspan="6" class="no-rows">No imports recorded.</td></tr>'}</tbody></table></div></section>`;
  }
  function configurations() {
    return `<div class="stack"><section class="panel panel-body">${panelHead('Universes','Versioned membership and eligibility rules',action('Create universe','new-universe','plus'))}
      ${config.universes.map((item)=>`<div class="simple-row"><div><strong>${safe(item.name)}</strong><span class="muted"> · version ${count(item.version)}</span></div>
      <div class="actions">${item.id===env.context.universe ? chip('Selected','accent') : action('Use','use-universe','check',{value:item.id})}
      ${item.createdAt || item.created_at ? iconButton('Edit universe','edit-universe','edit',item.id)+iconButton('Delete universe','delete-universe','trash',item.id):''}</div></div>`).join('')}</section>
      <section class="panel panel-body">${panelHead('RS models','Versioned return windows and scoring methods',action('Build RS model','new-rank-model','plus'))}
      ${config.models.map((item)=>`<div class="simple-row"><div><strong>${safe(item.name)}</strong><span class="muted"> · version ${count(item.version)}</span></div>
      <div class="actions">${item.id===env.context.model ? chip('Selected','accent') : action('Use','use-model','check',{value:item.id})}
      ${iconButton(builtins.has(item.id)?'Copy model':'Edit model','edit-rank-model','edit',item.id)}
      ${builtins.has(item.id)?'':iconButton('Delete model','delete-rank-model','trash',item.id)}</div></div>`).join('')}</section>
      <section class="panel panel-body">${panelHead('Market health models','Weights for breadth, momentum, and leadership',action('Create health model','new-health','plus'))}
      ${config.healthModels.map((item)=>`<div class="simple-row"><div><strong>${safe(item.name || 'Default market health')}</strong><span class="muted"> · version ${count(item.version)}</span></div>
      <div class="actions">${item.id===env.context.healthModel?chip('Selected','accent'):action('Use','use-health','check',{value:item.id})}
      ${item.id==='default'?'':iconButton('Edit health model','edit-health','edit',item.id)+iconButton('Delete health model','delete-health','trash',item.id)}</div></div>`).join('')}</section></div>`;
  }
  function jobRows() {
    if (!jobsReady) return '<tr><td colspan="4" class="no-rows">Loading background jobs…</td></tr>';
    return jobs.map((job) => `<tr><td><button type="button" class="stock-link" data-action="job-detail" data-value="${safe(job.id)}">${safe(jobTitles[job.type] || job.type)}</button></td>
      <td>${chip(job.status, job.status === 'complete' ? 'accent' : 'warning')}</td>
      <td><div class="job-progress"><progress max="100" value="${safe(job.progress ?? 0)}" aria-label="${safe(jobTitles[job.type] || job.type)} progress"></progress><span class="numeric">${percent(job.progress, 0)}</span></div></td>
      <td>${safe(timestamp(job.updated_at))}</td></tr>`).join('') || '<tr><td colspan="4" class="no-rows">No background jobs have run.</td></tr>';
  }
  function setJobs(next) {
    if (!env.isActive()) return;
    jobs = next;
    jobsReady = true;
    const target = main.querySelector('#job-rows');
    const row = target?.querySelector('[data-action="job-detail"]:focus');
    if (!target || row) return;
    const html = jobRows();
    if (target.innerHTML !== html) target.innerHTML = html;
  }
  function capturePanel() {
    const capture = warehouse.bootstrap;
    if (!capture) return '';
    const stageLabels = { catalog: 'Security catalog', prices: 'Symbol price history', actions: 'Corporate actions', reference: 'Dated reference' };
    return `<section class="panel panel-body">${panelHead('US equity history import', `${dateLabel(capture.from)} to ${dateLabel(capture.to)}`,
      capture.active ? chip('Running', 'accent') : chip(capture.publishedVersion ? 'Capture published' : 'Checkpoint saved'))}
      <div class="metric-grid">${Object.entries(stageLabels).map(([key,label]) => `<div class="metric-tile"><span>${label}</span>
        <strong>${count(capture.stages?.[key]?.complete || 0)}</strong><small>${count(capture.stages?.[key]?.retry || 0)} to retry</small></div>`).join('')}</div>
      ${capture.active ? `<p class="muted section-space">Current stage · ${safe(stageLabels[capture.phase] || capture.phase || 'Preparing')}</p>` : ''}</section>`;
  }
  function jobList() {
    return `<div class="stack"><div id="bootstrap-progress"${warehouse.bootstrap ? '' : ' hidden'}>${capturePanel()}</div><section class="panel panel-body">${panelHead('Background jobs', 'Warehouse imports, calculations, and research', [
      action('Check provider access', 'provider-probe', 'pulse'), action('Load market history', 'bootstrap-data', 'history'),
      action('Refresh reference data', 'reference-data', 'refresh'), action('Materialize history', 'materialize', 'chart'),
      action('Back up SQLite', 'backup', 'download'), ...(config.exportFormats?.includes('parquet') ? [action('Back up Parquet', 'backup-parquet', 'download')] : []),
    ].join(''))}<div class="table-scroll" tabindex="0" role="region" aria-label="Background jobs"><table><thead><tr>
      <th>Job</th><th>Status</th><th>Progress</th><th>Updated</th></tr></thead><tbody id="job-rows">${jobRows()}</tbody></table></div></section></div>`;
  }
  async function loadQuality() {
    if (data) return;
    try {
      qualityRequest ||= env.api('data/quality', { signal });
      data = await qualityRequest;
      if (env.isActive() && state.tab === 'quality') draw();
    } catch (error) {
      if (error.name !== 'AbortError') {
        qualityRequest = null;
        const target = main.querySelector('#quality-data');
        if (target) target.innerHTML = notice('Warehouse quality unavailable', error.message, action('Retry', 'retry-quality', 'refresh'), true);
      }
    }
  }
  const receiveJobs = (event) => setJobs(event.detail);
  const receiveStatus = (event) => {
    warehouse = event.detail;
    const target = main.querySelector('#bootstrap-progress');
    if (target) {
      target.hidden = !warehouse.bootstrap;
      target.innerHTML = capturePanel();
    }
  };
  document.addEventListener('warehouse:jobs', receiveJobs);
  document.addEventListener('warehouse:status', receiveStatus);
  signal.addEventListener('abort', () => {
    document.removeEventListener('warehouse:jobs', receiveJobs);
    document.removeEventListener('warehouse:status', receiveStatus);
  }, { once: true });
  env.api('jobs', { plain: true, signal }).then(setJobs).catch((error) => {
    const target = main.querySelector('#job-rows');
    if (target && error.name !== 'AbortError') target.innerHTML = `<tr><td colspan="4" class="no-rows">${safe(error.message)}</td></tr>`;
  });
  function draw() {
    main.innerHTML=heading('Settings & Data','Inspect provider coverage, workspace definitions, and warehouse jobs.',action('Import data','import-data','plus',{className:'primary'}))+
      segment('settings-tab',[['quality','Data quality'],['config','Models & universes'],['jobs','Jobs & maintenance'],['journal','Market Journal']],state.tab,'tabs')+
      (state.tab==='quality'?quality():state.tab==='config'?configurations():state.tab==='jobs'?jobList():'<div id="journal-settings"></div>');
    const journal = main.querySelector('#journal-settings');
    if (journal) mountJournalSettings(env,journal);
    const qualityAudit = main.querySelector('#quality-source-audit-mount');
    if (qualityAudit) mountQualityAudit(env,qualityAudit,{asOf:data.asOf,initial:data.qualityOverrides});
  }
  const launch=(path,body={})=>env.api(path,{body,plain:true}).then((job)=>jobDetails(env,job));
  async function deleteAndReset(area,id,kind,key,reset) {
    confirmDelete(env,kind,async()=>{
      await env.api(itemPath(area,id),{method:'DELETE',plain:true});
      if (env.context[key]===id) {
        const patch = {[key]:reset};
        if (key==='model'||key==='universe') patch[`${key}Version`]=null;
        history.replaceState(null,'',env.routeUrl('settings',patch));
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      }
    });
  }
  env.setActions({
    'settings-tab'(value) { state.tab=value; draw(); if (value === 'quality') loadQuality(); },
    'retry-quality': () => loadQuality(),
    'import-data':()=>importEditor(env),
    'provider-probe':()=>launch('data/probe'),
    'bootstrap-data':()=>bootstrapEditor(env),
    'reference-data':()=>referenceEditor(env),
    backup:()=>launch('data/backup'),
    'backup-parquet':()=>launch('data/backup', { format: 'parquet' }),
    materialize() {
      const target=env.showDialog(env.modal,'Materialize historical analytics',`<form class="stack">
        ${field('Calculation','<select name="kind"><option value="breadth">Market breadth and industries</option><option value="rankings">Stock rankings</option><option value="workspace">Core workspace history</option></select>')}
        <div class="form-grid">
        ${field('From',`<input name="from" type="date" value="${safe(config.status.earliestDate)}" required>`)}
        ${field('Through',`<input name="to" type="date" value="${safe(env.context.date || config.status.latestDate)}" required>`)}</div>
        <div class="form-error" role="alert" hidden></div><div><button type="submit" class="button primary">Queue materialization</button></div></form>`);
      target.onsubmit=async(event)=>{
        event.preventDefault();
        try {
          await launch('data/materialize',{...Object.fromEntries(new FormData(event.target)),context:env.snapshotContext});
        } catch(error) { saveError(target,error); }
      };
    },
    'job-detail':(id)=>jobDetails(env,jobs.find((job)=>job.id===id)),
    'new-universe':()=>universeEditor(env),
    'edit-universe':(id)=>universeEditor(env,config.universes.find((item)=>item.id===id)),
    'delete-universe':(id)=>deleteAndReset('universes',id,'universe','universe','us-core'),
    'use-universe':(id)=>env.go('settings',{universe:id,universeVersion:null}),
    'new-rank-model':()=>modelEditor(env),
    'edit-rank-model':(id)=>modelEditor(env,config.models.find((item)=>item.id===id)),
    'delete-rank-model':(id)=>deleteAndReset('ranking-models',id,'RS model','model','composite'),
    'use-model':(id)=>env.go('settings',{model:id,modelVersion:null}),
    'new-health':()=>healthEditor(env),
    'edit-health':(id)=>healthEditor(env,config.healthModels.find((item)=>item.id===id)),
    'delete-health':(id)=>deleteAndReset('health-models',id,'market health model','healthModel','default'),
    'use-health':(id)=>env.go('settings',{healthModel:id}),
  });
  draw();
  if (state.tab === 'quality') await loadQuality();
}

const renderers={screens:renderScreens,watchlists:renderWatchlists,alerts:renderAlerts,settings:renderSettings};
export async function render(env) { return renderers[env.page](env); }
