import { action, chip, count, dateLabel, empty, field, icon, notice, option, panelHead, pathPart, pending, safe, stockLink } from './ui.js';

const kinds = {
  price: ['Price quarantine', 'OHLC and returns for the affected session are unavailable.'],
  volume: ['Volume withheld', 'Volume-dependent metrics are unavailable for the affected session.'],
  'adjusted-close': ['Vendor adjusted close withheld', 'The vendor-adjusted value is excluded from return reconstruction.'],
  split: ['Split record quarantined', 'The reviewed split is excluded from adjustment calculations.'],
  notice: ['Source notice', 'The evidence is recorded alongside the data.'],
};

function marketDate() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map(({type,value})=>[type,value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function evidenceLink(value, label = 'Source evidence') {
  let url;
  try { url = new URL(value); } catch { return ''; }
  if (url.protocol !== 'https:' || url.username || url.password) return '';
  return `<a class="text-link quality-evidence" href="${safe(url.href)}" target="_blank" rel="noopener noreferrer">${safe(label)} ${icon('arrow-up-right')}</a>`;
}

function dateRange(record) {
  return dateLabel(record.effective_from) + (record.effective_to !== record.effective_from ? ` to ${dateLabel(record.effective_to)}` : '');
}

function recordStatus(record, asOf) {
  if (!record.active) return chip('Cleared');
  if (!asOf) return chip('Active','warning');
  if (record.effective_from > asOf) return chip('Future window');
  if (record.effective_to < asOf) return chip('Historical issue');
  return chip('Effective on selected date','warning');
}

export function stockQualityPanel(records, asOf) {
  if (!records?.length) return '';
  return `<section class="panel panel-body stock-source-quality" aria-label="Reviewed source quality">
    ${panelHead('Reviewed source quality','Effective dates and evidence for this security.')}
    <div class="quality-record-list">${records.map((record)=>{
      const [label,effect] = kinds[record.kind] || [record.kind,''];
      return `<article class="quality-record">
        <div class="inline-stack"><strong>${safe(label)}</strong>${recordStatus(record,asOf)}</div>
        <p class="muted">${safe(dateRange(record))} · Known ${dateLabel(record.known_at)} · Revision ${count(record.version)}</p>
        ${effect ? `<p class="muted">${safe(effect)}</p>` : ''}
        <p>${safe(record.reason)}</p>
        <div class="inline-stack">${evidenceLink(record.evidence_url)}${record.source ? chip(record.source) : ''}</div>
      </article>`;
    }).join('')}</div></section>`;
}

const endpoint = 'data/quality/overrides';

function renderAuditRows(rows, asOf) {
  if (!rows.length) return empty('No reviewed source issues','Reviewed issues for this warehouse revision will appear here.','info');
  return `<div class="table-scroll" role="region" aria-label="Reviewed source issue records" tabindex="0"><table>
    <thead><tr><th>Security</th><th>Issue</th><th>Effective session</th><th>Known date</th><th>Revision</th><th>Status</th><th>Reason and evidence</th><th>Action</th></tr></thead>
    <tbody>${rows.map((row)=>`<tr data-quality-id="${safe(row.id)}">
      <td>${stockLink({symbol:row.symbol||row.security_id,securityId:row.security_id})}</td>
      <td>${safe(kinds[row.kind]?.[0]||row.kind)}</td><td>${safe(dateRange(row))}</td><td>${dateLabel(row.known_at)}</td>
      <td class="mono">${count(row.version)}</td><td>${recordStatus(row,asOf)}</td>
      <td class="quality-reason"><p>${safe(row.reason)}</p><div class="inline-stack">${evidenceLink(row.evidence_url)}${row.source?chip(row.source):''}</div></td>
      <td>${row.active ? action('Clear issue','quality-clear','check',{value:row.id}) : '—'}</td></tr>`).join('')}</tbody></table></div>`;
}

function qualityEditor(env, record, saved) {
  const cleared = !!record;
  const latest = env.snapshotContext.date || env.config.status.latestDate || marketDate();
  const known = cleared && record.known_at > marketDate() ? record.known_at : marketDate();
  const target = env.showDialog(env.modal,cleared?'Clear reviewed source issue':'Record reviewed source issue',`<form class="stack" id="quality-review-form">
    ${cleared ? `<div class="stack"><p><strong>${safe(kinds[record.kind]?.[0]||record.kind)} · ${safe(record.security_id)}</strong></p>
      <p class="muted">${safe(dateRange(record))} · Revision ${count(record.version)}</p>${evidenceLink(record.evidence_url,'Earlier evidence')}</div>` : `
      <div class="form-grid">
        ${field('Ticker or permanent security ID','<input name="security" placeholder="Ticker" autocomplete="off" spellcheck="false" required>')}
        ${field('Review action',`<select name="kind">${Object.entries(kinds).map(([kind,[label]])=>option(kind,label,'notice')).join('')}</select>`)}
        ${field('First affected session',`<input type="date" name="from" value="${safe(latest)}" required>`)}
        ${field('Last affected session','<input type="date" name="to">','Leave blank for a single session.')}
      </div><p class="muted" id="quality-action-effect">${safe(kinds.notice[1])}</p>`}
    ${field('Known date',`<input type="date" name="knownAt" value="${safe(known)}"${record?` min="${safe(record.known_at)}"`:''} required>`)}
    ${field(cleared?'Reason for clearing':'Review reason','<textarea name="reason" maxlength="1000" rows="3" required></textarea>')}
    ${field('HTTPS evidence URL','<input type="url" name="evidenceUrl" maxlength="1000" placeholder="https://…" autocomplete="off" required>')}
    <p class="muted">${cleared?'This appends a clear revision. Earlier versions and the source data remain available.':'Use source evidence to support the selected scope. This appends an override and preserves the raw feed.'}</p>
    <div class="form-error" role="alert" hidden></div><div class="actions"><button class="button primary" type="submit">
      ${icon('check')} ${cleared?'Clear issue':'Save review'}</button></div></form>`);
  const form = target.querySelector('form');
  form.elements.kind?.addEventListener('change',()=>{
    target.querySelector('#quality-action-effect').textContent=kinds[form.elements.kind.value][1];
  });
  form.onsubmit = async (event)=>{
    event.preventDefault();
    const values = new FormData(form);
    const output = target.querySelector('.form-error');
    const button = target.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const evidenceUrl = String(values.get('evidenceUrl')||'').trim();
      if (!evidenceLink(evidenceUrl)) throw new Error('Enter an HTTPS evidence URL without credentials.');
      const from = record?.effective_from || values.get('from');
      const to = record?.effective_to || values.get('to') || from;
      if (from > to) throw new Error('The final session must be on or after the first session.');
      const reason=String(values.get('reason')||'').trim();
      if (!reason) throw new Error('Enter a review reason.');
      const securityId = record?.security_id ||
        (await env.api(`stocks/${pathPart(String(values.get('security')).trim())}/metrics`,{params:{dataVersion:'',date:from}})).securityId;
      const body = { id:record?.id || `review-${crypto.randomUUID()}`, securityId, kind:record?.kind||values.get('kind'),
        from,to,knownAt:values.get('knownAt'),reason,evidenceUrl,active:!cleared };
      const result = await env.api(endpoint,{plain:true,body});
      env.modal.close();
      env.toast(cleared?'Source issue cleared':'Reviewed source issue saved');
      saved(result.version,cleared);
      await env.reloadConfig();
    } catch(error) {
      if (output.isConnected) { output.hidden=false;output.textContent=error.message; }
    } finally { button.disabled=false; }
  };
}

export function mountQualityAudit(env, container, { asOf, initial = [] }) {
  let rows = initial;
  let version = env.snapshotContext.dataVersion;
  let includeCleared = false;
  let newest = false;
  let run = 0;
  let status = '';

  function draw() {
    const tools = action('Review latest revision','quality-newest','refresh') + action('Record source issue','quality-open-editor','plus',{className:'primary'});
    const updated = version != null && String(version)!==String(env.snapshotContext.dataVersion);
    container.innerHTML = `<section class="panel panel-body section-space" id="quality-source-audit">
      ${panelHead('Reviewed source issues', `As of ${dateLabel(asOf)} · review revision ${count(Number(version))}`,tools)}
      <div class="actions"><label class="checkbox-label"><input type="checkbox" data-quality-cleared${includeCleared?' checked':''}> Include cleared issues</label>
      ${updated?chip(`Analysis remains on revision ${env.snapshotContext.dataVersion}`,'warning'):''}</div>
      ${status?`<div class="section-space">${status}</div>`:''}
      ${renderAuditRows(rows,asOf)}</section>`;
  }

  async function load() {
    const ticket=++run;
    status=pending('Loading source reviews…');
    draw();
    try {
      const result=await env.api(endpoint,{signal:env.signal,params:{includeCleared:includeCleared?'1':null,
        ...(newest?{dataVersion:''}:version != null?{dataVersion:version}:{})}});
      if (ticket!==run || !container.isConnected) return;
      rows=result.overrides||[];
      version=result.dataVersion;
      status='';
      draw();
    } catch (error) {
      if (ticket===run && container.isConnected && error.name!=='AbortError') {
        status=notice('Source reviews unavailable',error.message,action('Retry','quality-retry','refresh'),true);
        draw();
      }
    }
  }

  function saved(revision, cleared) {
    if (!container.isConnected) return;
    version=revision ?? version;
    newest=false;
    includeCleared ||= cleared;
    load();
  }

  container.onclick=(event)=>{
    const control=event.target.closest('[data-action^="quality-"]');
    if (!control) return;
    if (control.dataset.action==='quality-open-editor') qualityEditor(env,null,saved);
    if (control.dataset.action==='quality-clear') {
      const row=rows.find((item)=>item.id===control.dataset.value);
      if (row?.active) qualityEditor(env,row,saved);
    }
    if (control.dataset.action==='quality-newest') { newest=true;load(); }
    if (control.dataset.action==='quality-retry') load();
  };
  container.onchange=(event)=>{
    if (event.target.matches('[data-quality-cleared]')) { includeCleared=event.target.checked;load(); }
  };
  load();
}
