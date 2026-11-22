import {
  action, attr, blobDownload, chip, count, csvDownload, dateLabel, direction, empty, field, heading, icon, iconButton, money, notice,
  number, numeric, option, panelHead, pathPart, pending, percent, publishingHistory, safe, segment, summary,
} from './ui.js';
import { chart } from './charts.js';
import { chartRanges } from './chart-ranges.js';

const entryPath = (date) => `journal/entries/${pathPart(date)}`;
const promptText = (item) => item?.prompt ?? item?.definition?.prompt ?? '';
const factorList = (item) => item?.factors ?? item?.definition?.factors ?? [];
const factorsFor = (data) => Array.isArray(data) ? data : Object.entries(data || {}).map(([key, value]) => ({ key, label: key, value }));
const timeLabel = (data) => {
  if (!data || Number.isNaN(Date.parse(data))) return 'Unavailable';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(data)) + ' ET';
};
const todayEastern = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' })
    .formatToParts(new Date()).map(({type,value})=>[type,value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const noteFrom = (response) => Array.isArray(response?.notes) ? response.notes[0] : response?.notes || response?.note || null;
const saveJson = (record, filename) => blobDownload(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }), filename);
const settingsLink = (env) => `<a class="button" href="${safe(env.routeUrl('settings', { tab: 'journal' }))}">${icon('settings')} Journal settings</a>`;
const titleFrom = (entry) => entry?.output?.title || 'Market update';
const entryDate = (entry) => entry.asOfDate || entry.date;
const matchingVersion = (versions, version) => versions.find((item) => String(item.version) === String(version));
const formatKey = (value) => String(value || '').replaceAll('_', ' ');

function errorAt(target, error) {
  const element = target.querySelector('.form-error');
  if (element) {
    element.hidden = false;
    element.textContent = error.message;
  }
}

function markdown(text) {
  const inline = (value) => safe(value).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/`([^\n`]+)`/g, '<code>$1</code>');
  return String(text || '').trim().split(/\n\s*\n/).filter(Boolean).map((block) => {
    const lines = block.split('\n');
    if (lines.every((line) => /^[-*]\s/.test(line))) return `<ul>${lines.map((line) => `<li>${inline(line.slice(2))}</li>`).join('')}</ul>`;
    if (lines.every((line) => /^\d+\.\s/.test(line))) return `<ol>${lines.map((line) => `<li>${inline(line.replace(/^\d+\.\s/, ''))}</li>`).join('')}</ol>`;
    return lines.map((line) => {
      const m = /^(#{1,6})\s+(.+)$/.exec(line);
      const size = m ? Math.min(5, m[1].length + 2) : 0;
      return m ? `<h${size}>${inline(m[2])}</h${size}>` : `<p>${inline(line)}</p>`;
    }).join('');
  }).join('');
}

function factorEditor(row = {}, index = 0) {
  return `<fieldset class="factor-editor" data-factor-row="${index}">
    <legend>Factor ${index + 1}</legend>
    <div class="form-grid">${field('Name', `<input data-factor-key="label" value="${safe(row.label)}" maxlength="90" placeholder="Liquidity trend" required>`)}
    ${field('Field key', `<input data-factor-key="key" value="${safe(row.key)}" maxlength="40" pattern="[a-z][a-z0-9_]*" placeholder="liquidity_trend" required>`)}
    ${field('Minimum', `<input data-factor-key="minimum" type="number" step="any" value="${safe(row.minimum)}" placeholder="Optional">`)}
    ${field('Maximum', `<input data-factor-key="maximum" type="number" step="any" value="${safe(row.maximum)}" placeholder="Optional">`)}
    </div>${field('Definition', `<input data-factor-key="description" maxlength="500" value="${safe(row.description)}" placeholder="Describe how to score this factor">`)}
    <button class="button danger" type="button" data-factor-remove="${index}">${icon('trash')} Remove factor</button></fieldset>`;
}

export async function mountJournalSettings(env, container) {
  container.innerHTML = pending('Loading journal settings…');
  try {
    let [settings, prompts] = await Promise.all([
      env.api('journal/settings', { plain: true, signal: env.signal }), env.api('journal/prompts', { plain: true, signal: env.signal }),
    ]);
    if (!container.isConnected) return;
    let active = prompts.active;
    let factors = structuredClone(factorList(active));
    let promptBody = { name: active?.name || 'Daily market update', text: promptText(active) };
    let removeConfirm = false;

    function draw() {
      const model = settings.model || '';
      const enabled = settings.schedule?.enabled ?? settings.enabled ?? false;
      const scheduleStatus = settings.scheduleEffective ? chip('Automatic generation active','accent')
        : enabled ? chip(settings.schedulerAvailable === false ? 'Schedule saved · scheduler unavailable'
          : 'Schedule saved · connection required','warning') : chip('Automatic generation off');
      container.innerHTML = `<div class="stack">
        <section class="panel panel-body">${panelHead('Claude connection','Generate a structured market update using the selected model and prompt.',
          chip(settings.configured ? 'API key configured' : 'API key required', settings.configured ? 'accent' : 'warning'))}
          <form class="stack" id="journal-settings-form">
            <div class="form-grid">
              ${field('API key', `<input type="password" name="key" autocomplete="new-password" spellcheck="false" placeholder="${settings.configured ? 'Leave blank to keep the current key' : 'Enter your Anthropic API key'}">`)}
              ${field('Model', `<input name="model" value="${safe(model)}" maxlength="100" placeholder="Claude model ID" required>`)}
              ${field('Daily time (Eastern)', `<input type="time" name="after" value="${safe(settings.schedule?.after || '20:30')}" required>`)}
            </div>
            <label class="checkbox-label"><input type="checkbox" name="enabled"${enabled ? ' checked' : ''}> Generate automatically on finalized market sessions</label>
            <div class="inline-stack" id="journal-schedule-status">${scheduleStatus}</div>
            <p class="muted">Scheduled generations wait for published market data, then send it and the active prompt to Anthropic. Personal notes stay local.</p>
            <div class="form-error" role="alert" hidden></div>
            <div class="actions"><button type="submit" class="button primary">${icon('check')} Save Claude settings</button>
            ${settings.configured ? `<button type="button" data-journal-settings="remove-key" class="button danger">${removeConfirm ? 'Confirm remove key' : 'Remove key'}</button>` : ''}</div>
          </form></section>
        <section class="panel panel-body">${panelHead('Daily market prompt','Publish a versioned Markdown prompt or paste a skill you want Claude to follow.',
          active ? chip(`Active version ${count(active.version)}`,'accent') : '')}
          <form class="stack" id="journal-prompt-form">
            <div class="form-grid">${field('Prompt name', `<input name="name" maxlength="100" value="${safe(promptBody.name)}" required>`)}
            ${field('Load a prior revision', `<select name="version">${option('', 'Choose a revision', '')}
              ${(prompts.versions || []).map((item) => option(String(item.version), `v${item.version} · ${item.name || 'Daily market update'}`, '')).join('')}</select>`)}</div>
            ${field('Prompt or skill Markdown', `<textarea name="prompt" class="journal-prompt" rows="12" maxlength="24000" required>${safe(promptBody.text)}</textarea>`)}
            <div><h3 class="section-title">Structured factors</h3><p class="muted">The update always includes sentiment, market health, risk posture, and confidence. Add numeric fields to track alongside those readings.</p></div>
            <div id="journal-factor-list" class="stack">${factors.map(factorEditor).join('')}</div>
            <div class="form-error" role="alert" hidden></div><div class="actions">
              <button type="button" data-journal-settings="add-factor" class="button">${icon('plus')} Add factor</button>
              <button type="submit" class="button primary">${icon('check')} Publish prompt revision</button></div>
          </form></section></div>`;
    }
    function persistPromptDraft(form) {
      promptBody = { name: form.elements.name.value, text: form.elements.prompt.value };
      factors = [...form.querySelectorAll('[data-factor-row]')].map((row) => Object.fromEntries([...row.querySelectorAll('[data-factor-key]')]
        .filter((input) => input.value !== '').map((input) => [input.dataset.factorKey, input.type === 'number' ? Number(input.value) : input.value])));
    }
    container.onchange = (event) => {
      if (event.target.name !== 'version' || !event.target.value) return;
      const version = matchingVersion(prompts.versions || [], event.target.value);
      if (!version) return;
      promptBody = { name: version.name || 'Daily market update', text: promptText(version) };
      factors = structuredClone(factorList(version));
      draw();
    };
    container.onclick = async (event) => {
      const control = event.target.closest('[data-journal-settings], [data-factor-remove]');
      if (!control) return;
      const form = container.querySelector('#journal-prompt-form');
      persistPromptDraft(form);
      if (control.dataset.journalSettings === 'add-factor') {
        if (factors.length >= 20) return env.toast('A prompt supports up to 20 custom factors.');
        factors.push({});
        container.querySelector('#journal-factor-list').innerHTML = factors.map(factorEditor).join('');
        return;
      }
      if (control.dataset.factorRemove != null) {
        factors.splice(Number(control.dataset.factorRemove), 1);
        container.querySelector('#journal-factor-list').innerHTML = factors.map(factorEditor).join('');
        return;
      }
      if (control.dataset.journalSettings === 'remove-key') {
        if (!removeConfirm) {
          removeConfirm = true;
          control.textContent = 'Confirm remove key';
          return;
        }
        try {
          settings = await env.api('journal/settings', { method: 'PUT', plain: true,
            body: { apiKey: null, schedule: { enabled: false, after: settings.schedule?.after || '20:30' } } });
          removeConfirm = false;
          env.toast('Claude key removed');
          draw();
        } catch (error) { errorAt(container.querySelector('#journal-settings-form'), error); }
      }
    };
    container.onsubmit = async (event) => {
      event.preventDefault();
      const form = event.target;
      if (form.id === 'journal-settings-form') {
        persistPromptDraft(container.querySelector('#journal-prompt-form'));
        const values = new FormData(form);
        const key = String(values.get('key') || '').trim();
        const body = { model: String(values.get('model')).trim(), schedule: { enabled: values.has('enabled'), after: values.get('after') },
          ...(key ? { apiKey: key } : {}) };
        const keyInput = form.elements.key;
        keyInput.value = '';
        try {
          settings = await env.api('journal/settings', { method: 'PUT', body, plain: true });
          env.toast('Claude settings saved');
          draw();
        } catch (error) { errorAt(form, error); }
      } else if (form.id === 'journal-prompt-form') {
        persistPromptDraft(form);
        try {
          if (factors.some((item) => numeric(item.minimum) && numeric(item.maximum) && item.minimum >= item.maximum)) {
            throw new Error('A factor minimum needs to be below its maximum.');
          }
          const published = await env.api('journal/prompts', { plain: true, body: { name: promptBody.name, prompt: promptBody.text, factors } });
          prompts = Array.isArray(published.versions) ? published : await env.api('journal/prompts', { plain: true });
          active = prompts.active;
          factors = structuredClone(factorList(active));
          promptBody = { name: active?.name || 'Daily market update', text: promptText(active) };
          env.toast('Prompt revision published');
          draw();
        } catch (error) { errorAt(form, error); }
      }
    };
    draw();
  } catch (error) {
    if (container.isConnected && error.name !== 'AbortError') container.innerHTML = notice('Journal settings unavailable', error.message, '', true);
  }
}

async function waitForJournalJob(env, starting, onProgress, alive = () => env.isActive()) {
  let job = starting;
  while (['queued','running'].includes(job.status)) {
    if (!alive()) return null;
    onProgress(job);
    await new Promise((resolve) => setTimeout(resolve, 850));
    if (!alive()) return null;
    job = await env.api(`jobs/${pathPart(job.id)}`, { plain: true, signal: env.signal });
  }
  if (job.status === 'failed') throw new Error(job.error || 'The journal job failed.');
  return job.result;
}

function outputPanel(entry) {
  const data = entry.output || {};
  const factors = factorsFor(data.factors);
  const confidence = numeric(data.confidence) ? `${number(data.confidence)} / 10` : '—';
  return `<section class="panel panel-body journal-report">
    ${panelHead(titleFrom(entry), `Market session ${dateLabel(entryDate(entry))} · revision ${count(entry.revision)}`,
      (entry.retrospective ? chip('Retrospective', 'warning') : '') + action('Export JSON', 'journal-export', 'download') +
      action('Export Markdown', 'journal-export-markdown', 'download'))}
    <div class="summary-grid three">
      ${summary('Market health', numeric(data.market_health) ? `${number(data.market_health)} / 10` : '—', 'Claude assessment', {glyph:'pulse'})}
      ${summary('Sentiment', numeric(data.sentiment_score) ? number(data.sentiment_score) : '—', data.sentiment ? `${data.sentiment} · range −1 to +1` : 'Unavailable', {glyph:'chart'})}
      ${summary('Risk posture', data.risk_posture ? formatKey(data.risk_posture) : '—', `Confidence ${confidence}`, {small:true,glyph:'info'})}
    </div>
    ${factors.length ? `<div class="metric-grid journal-factor-values">${factors.map((factor) => `<div class="metric-tile"><span>${safe(factor.label || factor.key)}</span>
      <strong>${number(factor.value,2)}</strong><small>${safe(factor.key)}</small></div>`).join('')}</div>` : ''}
    <div class="journal-narrative">${markdown(data.markdown) || '<p class="muted">No narrative was returned.</p>'}</div>
    <div class="journal-facts">
      <div><span>Generated</span><strong>${safe(timeLabel(entry.generatedAt))}</strong></div>
      <div><span>Available at</span><strong>${safe(timeLabel(entry.availableAt))}</strong></div>
      <div><span>First tradable session</span><strong>${dateLabel(entry.tradableDate)}</strong></div>
      <div><span>Data revision</span><strong>${count(entry.dataVersion)}</strong></div>
      <div><span>Prompt revision</span><strong>${count(entry.promptVersion)}</strong></div>
      <div><span>Model</span><strong>${safe(entry.model || '—')}</strong></div>
      <div><span>Benchmark</span><strong>${safe(entry.benchmark || '—')}</strong></div>
    </div></section>`;
}

export async function render(env) {
  const {main,state,signal} = env;
  const contextDate = env.context.date || env.config.status.latestDate;
  let [settings, archive] = await Promise.all([
    env.api('journal/settings', { plain: true, signal }), env.api('journal/entries', { plain: true, signal }),
  ]);
  if (!env.isActive()) return;
  let entries = archive.entries || [];
  let noteDates = archive.noteDates || [];
  let selected = env.params.journalDate || contextDate || entryDate(entries[0] || {});
  let activeRun = 0;
  let details;
  let revision = env.params.journalRevision ? Number(env.params.journalRevision) : undefined;
  let noteRevision;
  state.drafts ||= {};
  const archivedDates = () => [...new Set([...entries.map(entryDate), ...noteDates].filter(Boolean))].sort().reverse();

  function drawBase() {
    const archiveList = archivedDates();
    const canGenerate = settings.configured && selected && selected <= env.config.status.latestDate;
    main.innerHTML = heading('Market Journal','Save dated observations and compare them with Claude’s market updates.',
      settingsLink(env) + action('Generate update','journal-generate','plus',{className:'primary',disabled:!canGenerate})) +
      (!settings.configured ? notice('Claude connection required','Add an Anthropic API key to generate updates. Personal notes are available now.', settingsLink(env)) : '') +
      `<div id="journal-job" aria-live="polite"></div>
      <div class="journal-layout">
        <div class="stack" id="journal-report-area">${pending('Loading journal entry…')}</div>
        <aside class="stack">
          <section class="panel panel-body">${panelHead('Sessions', '', iconButton('Export journal archive CSV','journal-archive-export','download'))}
            ${field('Journal date', `<input type="date" data-change="journal-date"${attr('value',selected)} max="${safe(todayEastern())}">`)}
            <div class="journal-archive section-space">${archiveList.slice(0,60).map((date) => {
              const report = entries.find((entry) => entryDate(entry) === date);
              return `<button type="button" class="journal-date-row" data-action="journal-open" data-value="${safe(date)}" aria-pressed="${date === selected}">
                <span>${dateLabel(date)}</span><small>${safe(report ? titleFrom(report) : 'Personal note')}</small></button>`;
            }).join('') || '<p class="muted">Saved sessions will appear here.</p>'}</div></section>
          <div id="journal-note">${pending('Loading personal notes…')}</div>
        </aside>
      </div>`;
  }

  function drawEntry() {
    const report = main.querySelector('#journal-report-area');
    const notes = main.querySelector('#journal-note');
    if (!report || !notes) return;
    const revisions = details?.entries || [];
    const chosen = matchingVersion(revisions.map((item) => ({ ...item, version: item.revision })), revision) || revisions[0];
    const note = noteFrom(details);
    const former = matchingVersion(details?.noteVersions || [],noteRevision);
    report.innerHTML = revisions.length ? `<div class="inline-form journal-revision">${field('AI revision', `<select data-change="journal-revision">
      ${revisions.map((item) => option(String(item.revision), `Revision ${item.revision} · ${timeLabel(item.generatedAt)}`, String(chosen.revision))).join('')}</select>`)}</div>${outputPanel(chosen)}`
      : empty('No AI report for this session', settings.configured ? 'Generate an update or choose a date with a saved report.' : 'Connect Claude to generate structured market updates.', 'journal');
    notes.innerHTML = `<section class="panel panel-body">${panelHead('Personal notes', selected ? dateLabel(selected) : 'Select a date',
      note ? chip(`Version ${count(note.version)}`) : '')}
      <form class="stack" id="journal-note-form">
        ${field('Observations', `<textarea name="markdown" rows="8" maxlength="40000" placeholder="Record what you noticed, what changed, and what you want to revisit…" ${selected ? '' : 'disabled'}>${safe(state.drafts[selected] ?? note?.markdown ?? '')}</textarea>`)}
        <p class="muted">Notes stay in this workspace unless you explicitly include them in a generation request.</p>
        ${note?.updatedAt ? `<p class="muted">Saved ${safe(timeLabel(note.updatedAt))}</p>` : ''}
        <div class="form-error" role="alert" hidden></div><div class="actions">
          <button type="submit" class="button primary" ${selected ? '' : 'disabled'}>${icon('check')} Save note</button>
          ${note?.markdown ? action('Export note','journal-note-export','download') : ''}</div></form>
      ${details?.noteVersions?.length > 1 ? `<div class="section-space">${field('Note revision history',
        `<select data-change="journal-note-revision">${option('','Choose a saved version','')}${details.noteVersions.map((item)=>option(String(item.version),
          `Version ${item.version} · ${timeLabel(item.updatedAt)}`,String(noteRevision || ''))).join('')}</select>`)}
        ${former ? `<div class="journal-narrative">${markdown(former.markdown) || '<p class="muted">Empty note</p>'}</div>
          ${action('Copy to editor','journal-note-reuse','copy')}` : ''}</div>` : ''}</section>`;
    const form = notes.querySelector('form');
    form.oninput = (event) => { state.drafts[selected] = event.target.value; };
    form.onsubmit = async (event) => {
      event.preventDefault();
      const text = new FormData(form).get('markdown');
      try {
        await env.api(entryPath(selected), { plain: true, method: 'PUT', body: { markdown: text } });
        delete state.drafts[selected];
        noteDates = [...new Set([...noteDates, selected])];
        env.toast('Journal note saved');
        drawBase();
        await loadEntry();
      } catch (error) { errorAt(form,error); }
    };
  }

  async function loadEntry() {
    if (!selected) { drawEntry(); return; }
    const target = main.querySelector('#journal-report-area');
    const run = ++activeRun;
    try {
      const next = await env.api(entryPath(selected), { plain: true, signal });
      if (run !== activeRun || !env.isActive()) return;
      details = next;
      drawEntry();
    } catch (error) {
      if (target?.isConnected && error.name !== 'AbortError') target.innerHTML = notice('Journal entry unavailable', error.message, '', true);
    }
  }

  function selectDate(date) {
    if (date && date !== selected) env.go('journal', { journalDate: date });
  }

  async function showJob(job) {
    const target = main.querySelector('#journal-job');
    try {
      const result = await waitForJournalJob(env, job, (value) => {
        if (target.isConnected) target.innerHTML = pending(`Generating market update · ${count(value.progress)}%`);
      }, () => target.isConnected && env.isActive());
      if (!result || !target.isConnected) return;
      state.job = null;
      const record = result.entry || result;
      const refreshed = await env.api('journal/entries', { plain:true, signal });
      if (!env.isActive()) return;
      entries = refreshed.entries || entries;
      noteDates = refreshed.noteDates || noteDates;
      revision = record.revision;
      selected = entryDate(record) || selected;
      env.toast('Market update saved');
      drawBase();
      await loadEntry();
    } catch (error) {
      state.job = null;
      if (target.isConnected && error.name !== 'AbortError') target.innerHTML = notice('Generation failed', error.message, '', true);
    }
  }

  async function generate() {
    const prompts = await env.api('journal/prompts', { plain:true, signal });
    if (!env.isActive()) return;
    const latest = env.config.status.latestDate;
    const retro = selected < latest;
    const target = env.showDialog(env.modal,'Generate market update',`<form class="stack">
      <div class="inline-stack">${chip(dateLabel(selected))}${chip(settings.model)}${retro ? chip('Retrospective','warning') : ''}</div>
      ${field('Prompt revision',`<select name="prompt">${(prompts.versions || []).map((item) => option(String(item.version),`Version ${item.version} · ${item.name || 'Daily market update'}`,String(prompts.active?.version))).join('')}</select>`)}
      <label class="checkbox-label"><input type="checkbox" name="includeNotes"> Include the saved personal note for this session in the Claude request</label>
      <p class="muted">This request sends the selected market snapshot and prompt to Anthropic. ${retro ? 'This update is retrospective and is excluded from backtests by default.' : 'The saved report records when it became available.'}</p>
      <div class="form-error" role="alert" hidden></div><div><button type="submit" class="button primary">${icon('pulse')} Generate update</button></div></form>`);
    target.onsubmit = async (event) => {
      event.preventDefault();
      const values = new FormData(event.target);
      const button = event.target.querySelector('[type="submit"]');
      button.disabled = true;
      try {
        const job = await env.api('journal/generate',{plain:true,body:{asOfDate:selected,context:{...env.snapshotContext,date:selected},
          ...(values.get('prompt') ? {promptVersion:Number(values.get('prompt'))} : {}),...(values.has('includeNotes') ? {includeNotes:true} : {}),
          retrospective:retro,force:!!details?.entries?.length}});
        state.job = job;
        env.modal.close();
        await showJob(job);
      } catch (error) {
        errorAt(target,error);
        button.disabled = false;
      }
    };
  }

  env.setActions({
    'journal-open':selectDate,
    'change:journal-date':selectDate,
    'change:journal-revision'(value) { revision=Number(value); drawEntry(); },
    'change:journal-note-revision'(value) { noteRevision=Number(value); drawEntry(); },
    'journal-note-reuse'() {
      const entry=matchingVersion(details?.noteVersions||[],noteRevision);
      if (entry) { state.drafts[selected]=entry.markdown; drawEntry(); main.querySelector('#journal-note-form textarea')?.focus(); }
    },
    'journal-generate':generate,
    'journal-archive-export':()=>env.exportFile('journal/entries',{plain:true,params:{export:'csv',limit:7560}},'market-journal.csv'),
    'journal-export-markdown'() {
      const entry = details?.entries.find((item) => item.revision === revision) || details?.entries?.[0];
      if (entry) blobDownload(new Blob([entry.output?.markdown || ''],{type:'text/markdown;charset=utf-8'}),`market-journal-${entryDate(entry)}-v${entry.revision}.md`);
    },
    'journal-export'() {
      const entry = details?.entries.find((item) => item.revision === revision) || details?.entries?.[0];
      if (entry) saveJson(entry,`market-journal-${entryDate(entry)}-v${entry.revision}.json`);
    },
    'journal-note-export'() {
      const note = noteFrom(details);
      if (note) blobDownload(new Blob([note.markdown],{type:'text/markdown;charset=utf-8'}),`market-note-${selected}.md`);
    },
  });
  drawBase();
  await loadEntry();
  if (state.job && env.isActive()) showJob(state.job);
}

const factorLabels = new Map([
  ['market_health','Market health'], ['sentiment_score','Sentiment score'], ['confidence','Confidence'],
]);
const overlayLabels = new Map([
  ['benchmarkClose','Benchmark close'], ['above_50d','Above 50D SMA'], ['above_200d','Above 200D SMA'], ['up_4pct','Up ≥ 4%'],
  ['down_4pct','Down ≥ 4%'], ['adSpread','Advance / decline spread'],
]);
const thresholdOps = [['gte','At least'], ['gt','Above'], ['lte','At most'], ['lt','Below']];
function signalValue(row, key) {
  if (factorLabels.has(key)) return row[{market_health:'marketHealth',sentiment_score:'sentimentScore'}[key] || key];
  return factorsFor(row.factors).find((item) => item.key === key || `factor.${item.key}` === key)?.value;
}

function recipeLabel(recipe, config) {
  if (!recipe) return 'No eligible recipe';
  const universe = config.universes?.find(({id})=>id===recipe.universe)?.name || recipe.universe || 'Unspecified universe';
  const model = config.models?.find(({id})=>id===recipe.analysisModel)?.name || recipe.analysisModel || 'Unspecified RS model';
  return [`${universe} v${recipe.universeVersion || '—'}`, `${model} v${recipe.analysisModelVersion || '—'}`, recipe.benchmark,
    recipe.classificationSystem, recipe.referenceMode, recipe.claudeModel, `Prompt v${recipe.promptVersion || '—'}`,
    recipe.calculationVersion].filter(Boolean).join(' · ');
}

function countSummary(selection = {}) {
  return [
    ['Other recipes excluded', selection.otherRecipesExcluded], ['Retrospectives excluded',selection.retrospectiveExcluded],
    ['Revisions excluded',selection.revisionsExcluded], ['Same-session duplicates',selection.sameSessionExcluded],
    ['Retrospectives used',selection.retrospective],
  ].filter(([,value])=>numeric(value)).map(([label,value])=>chip(`${label} · ${count(value)}`)).join('');
}

function signalRows(rows, env) {
  const links = rows.slice(-30).reverse().map((item)=>{
    const date = item.asOfDate || item.journalAsOfDate;
    const tradeDate = item.tradableDate || item.date;
    const url = env.routeUrl('journal',{journalDate:date,journalRevision:item.revision||undefined});
    return `<div class="simple-row" data-journal-id="${safe(item.id||item.journalId)}"><a class="text-link" href="${safe(url)}">Report ${dateLabel(date)}</a>
      <span class="muted">${dateLabel(tradeDate)} tradable${item.retrospective ? ' · Retrospective' : ''}</span></div>`;
  }).join('');
  return links ? `<details class="formula-help section-space"><summary>Trace ${count(rows.length)} report observation${rows.length===1?'':'s'}</summary>${links}</details>` : '';
}

function forwardResults(result, env) {
  const groups = result?.results || result?.horizons || [];
  const rows = groups.flatMap((group) => Object.entries(group.benchmarks || { [group.benchmark || result.benchmark || 'Benchmark']: group.summary || group })
    .map(([benchmark, stats]) => ({ horizon: group.horizon || group.sessions, benchmark, ...stats })));
  return `<section class="panel panel-body">${panelHead('Journal signal results','Benchmark returns start at the first eligible session’s close.')}
    <p class="muted">${safe(recipeLabel(result.recipe,env.config))}</p>
    <div class="inline-stack section-space">${chip(result.priceBasis==='reconstructed'?'Outcome prices · reconstructed':'Outcome prices · known then','accent')}
      ${countSummary(result.selectionCounts)}</div>
    ${result.availabilityPolicy ? `<p class="muted section-space">${safe(result.availabilityPolicy)}</p>` : ''}
    <div class="summary-grid three section-space">
      ${summary('Matching signals',count(result.eventCount ?? result.matchedCount ?? result.matched), 'Rule passed on available signals')}
      ${summary('Retrospectives excluded',count(result.excludedRetrospective ?? result.selectionCounts?.retrospectiveExcluded), 'Excluded by the selected report policy')}
      ${summary('Eligible signals',count(result.journalObservations ?? result.eligibleCount ?? result.signalCount ?? result.evaluatedCount), 'Available during the study range')}
    </div>
    <div class="table-scroll" tabindex="0" role="region" aria-label="Journal signal forward returns">
    <table><thead><tr><th>Holding period</th><th>Benchmark</th><th>Observations</th><th>Mean return</th><th>Median return</th><th>Win rate</th>
        <th>Max adverse excursion</th><th>Max drawdown</th></tr></thead><tbody>${rows.map((row) => `<tr>
        <td>${count(row.horizon)}D</td><td>${safe(row.benchmark)}</td><td class="numeric">${count(row.count ?? row.observations)}</td>
        <td class="numeric ${direction(row.mean)}">${percent(row.mean,2,true)}</td>
        <td class="numeric ${direction(row.median)}">${percent(row.median,2,true)}</td><td class="numeric">${percent(row.winRate,1)}</td>
        <td class="numeric">${percent(row.maximumAdverseExcursion,2,true)}</td><td class="numeric">${percent(row.maximumDrawdown,2,true)}</td></tr>`).join('')
      || '<tr><td class="no-rows" colspan="8">No comparable forward observations for this rule.</td></tr>'}</tbody></table></div>
    ${signalRows(result.events||[],env)}
    <div class="actions section-space"><button class="button" type="button" data-journal-research="export-backtest">${icon('download')} Export study JSON</button></div></section>`;
}

export async function mountJournalHistory(env, target, { firstDate, lastDate }) {
  const options = env.state.journalAnalytics ||= {
    metric:'market_health',overlay:'benchmarkClose',retrospective:false,limit:126,priceBasis:'known',
  };
  const scope = { universe:env.snapshotContext.universe, universeVersion:env.snapshotContext.universeVersion,
    basis:env.snapshotContext.basis, asOf:lastDate };
  const scopeKey = JSON.stringify(scope);
  if (options.scope!==scopeKey) {
    options.scope=scopeKey;
    options.recipeKey='';
    options.result=null;
    options.draft=null;
  }
  const alive = () => target.isConnected && env.isActive();
  const labels = new Map(factorLabels);
  let selection;
  let recipes = [];
  let run = 0;
  const loadSelection = (recipeKey, retrospective) => env.api('journal/factors',{plain:true,signal:env.signal,
    params:{...scope,recipeKey,includeRetrospective:retrospective?'1':'0'}});
  function applySelection(next) {
    selection=next;
    labels.clear();
    for (const [key,label] of factorLabels) labels.set(key,label);
    for (const row of selection.rows||[]) for (const factor of factorsFor(row.factors)) {
      if (factor.key) labels.set(`factor.${factor.key}`,factor.label||factor.key);
    }
    if (!labels.has(options.metric)) options.metric='market_health';
  }
  target.innerHTML = pending('Loading journal signals…');
  try {
    const available = await loadSelection('',options.retrospective);
    if (!alive()) return;
    recipes = available.recipes||[];
    if (!recipes.some(({key})=>key===options.recipeKey)) options.recipeKey='';
    applySelection(options.recipeKey ? await loadSelection(options.recipeKey,options.retrospective) : available);
    if (!alive()) return;
  } catch (error) {
    if (alive() && error.name!=='AbortError') target.innerHTML=notice('Journal signals unavailable',error.message,settingsLink(env),true);
    return;
  }

  function draw() {
    const draft=options.draft||{};
    target.innerHTML = `<div class="stack"><section class="panel panel-body">${panelHead('Journal factor overlays',
      'Charts and backtests share one recipe and use its first live report for each market session.',
      `<a class="button" href="${safe(env.routeUrl('journal'))}">${icon('journal')} Market Journal</a>`)}
      <form class="inline-form" id="journal-recipe-form">
        ${field('Journal recipe',`<select name="recipeKey">${option('','Automatic · earliest live recipe',options.recipeKey||'')}
          ${recipes.map((recipe)=>option(recipe.key,recipeLabel(recipe,env.config),options.recipeKey)).join('')}</select>`)}
        <label class="checkbox-label"><input name="includeRetrospective" type="checkbox"${options.retrospective?' checked':''}> Fill missing live reports with retrospectives</label>
        <button class="button" type="submit">Apply report scope</button>
        <div class="form-error" role="alert" hidden></div>
      </form>
      <p class="muted section-space" id="journal-applied-recipe">${safe(recipeLabel(selection.recipe,env.config))}</p>
      <div class="inline-stack section-space">${countSummary(selection.counts)}</div>
      <form class="inline-form section-space" id="journal-overlay-form">
        ${field('Factor',`<select name="metric">${[...labels].map(([key,label])=>option(key,label,options.metric)).join('')}</select>`)}
        ${field('Overlay',`<select name="overlay">${option('','Journal factor only',options.overlay)}
          ${[...overlayLabels].map(([key,label])=>option(key,label,options.overlay)).join('')}</select>`)}
        ${field('Trading sessions',`<select name="limit">${chartRanges.map(([n, label])=>option(n,`${label} · ${n} sessions`,options.limit)).join('')}</select>`)}
        <button class="button primary" type="submit">Apply overlay</button>
      </form><div id="journal-overlay-plot" class="section-space">${pending()}</div></section>
      <section class="panel panel-body">${panelHead('Backtest a journal signal','Historical benchmark returns after an available signal meets your threshold.')}
      <form class="stack" id="journal-backtest-form">
        <div class="form-grid">
          ${field('Signal',`<select name="metric">${[...labels].map(([key,label])=>option(key,label,labels.has(draft.metric)?draft.metric:options.metric)).join('')}</select>`)}
          ${field('Comparison',`<select name="op">${thresholdOps.map(([key,label])=>option(key,label,draft.op||'gte')).join('')}</select>`)}
          ${field('Value',`<input name="value" type="number" step="any" value="${safe(draft.value??5)}" required>`)}
          ${field('Forward sessions',`<input name="horizons" value="${safe(draft.horizons||'5, 10, 20, 60')}" required>`)}
          ${field('Outcome price basis',`<select name="priceBasis">${option('known','Known then',draft.priceBasis||options.priceBasis||'known')}
            ${option('reconstructed','Reconstructed closes',draft.priceBasis||options.priceBasis)}</select>`,
            'Controls benchmark prices only. Report availability still uses its actual timestamp.')}
          ${field('Benchmark', `<select name="benchmark">${(env.config.availableBenchmarks?.length ? env.config.availableBenchmarks : [env.context.benchmark])
            .map((symbol)=>option(symbol,symbol,draft.benchmark||env.context.benchmark)).join('')}</select>`)}
          ${field('Start date',`<input name="start" type="date" value="${safe(draft.start||firstDate)}" max="${safe(lastDate)}" required>`)}
          ${field('End date',`<input name="end" type="date" value="${safe(draft.end||lastDate)}" max="${safe(lastDate)}" required>`)}
        </div>
        <div class="form-error" role="alert" hidden></div>
        <div><button class="button primary" type="submit">${icon('chart')} Run backtest</button></div></form></section>
      <div id="journal-backtest-output" aria-live="polite">${options.result ? forwardResults(options.result,env) : ''}</div></div>`;
    loadOverlay();
  }

  function paintOverlay(base = [], availability = '') {
    const plot = target.querySelector('#journal-overlay-plot');
    if (!plot) return;
    const visible = selection.rows||[];
    const tradeDates = new Map(visible.map((row)=>[row.tradableDate,row]));
    const baseline = new Map(base.map((row)=>[row.date,row]));
    const earliestBaseline = base[0]?.date;
    const signalDates = [...tradeDates.keys()].filter((date) => (!lastDate || date <= lastDate) && (!earliestBaseline || date >= earliestBaseline));
    const dates = [...new Set([...baseline.keys(), ...signalDates])].sort().slice(-options.limit);
    const data = dates.map((date) => {
      const signal = tradeDates.get(date);
      return { date, factor: signal ? signalValue(signal,options.metric) : null, overlay: baseline.get(date)?.[options.overlay], signal };
    });
    const hasSignals = data.some(({factor}) => numeric(factor));
    const upcoming = visible.filter((row) => row.tradableDate > lastDate).length;
    const label = labels.get(options.metric) || options.metric;
    const series = [{ key:'factor', label, format:(value)=>number(value,2), color:'#58e2c3' }];
    if (options.overlay && base.length) series.push({ key:'overlay',
      label:options.overlay==='benchmarkClose' ? `${env.context.benchmark} close` : overlayLabels.get(options.overlay),
      format:options.overlay==='benchmarkClose' ? money : percent, axis:'right', color:'#84a9fa' });
    const overlayDomain = !options.overlay || options.overlay === 'benchmarkClose' ? undefined : options.overlay === 'adSpread' ? [-100, 100] : [0, 100];
    plot.innerHTML = (hasSignals || base.length ? chart(data,series,{height:235,domain:options.metric==='sentiment_score'?[-1,1]:['market_health','confidence'].includes(options.metric)?[0,10]:undefined,
      ...(series.length > 1 && { rightDomain: overlayDomain, rightAxisFormat: overlayDomain ? percent : undefined })}) :
      empty('No available journal signals','The selected recipe has no comparable reports available by this session.','journal'))
      + (availability ? `<div class="section-space">${availability}</div>` : '')
      + (upcoming ? `<p class="muted section-space">${count(upcoming)} ${upcoming === 1 ? 'report has' : 'reports have'} a first tradable session beyond the loaded prices.</p>` : '')
      + (hasSignals ? `<div class="actions section-space"><button class="button" type="button" data-journal-research="export-factor">${icon('download')} Export aligned signals</button>
        ${chip(`${count(data.filter(({factor})=>numeric(factor)).length)} available signals`)}${options.retrospective?chip('Retrospective fills allowed','warning'):''}</div>
        ${signalRows(data.filter(({signal,factor})=>signal&&numeric(factor)).map(({signal})=>signal),env)}` : '');
    options.exportRows = data.map(({date,factor,overlay,signal})=>({tradable_date:date,session_date:signal?.asOfDate,available_at:signal?.availableAt,
      journal_id:signal?.id,recipe_key:signal?.recipeKey,retrospective:signal?.retrospective,value:factor,overlay}));
  }

  async function loadOverlay() {
    const id = ++run;
    paintOverlay();
    if (!options.overlay) return;
    try {
      const result = await env.publishedSeries('market/breadth',{signal:env.signal,params:{series:1,metrics:options.overlay,limit:options.limit}},(partial,job)=>{
        if (alive() && id===run) paintOverlay(partial.rows || [],publishingHistory(job));
      });
      if (alive() && id===run) paintOverlay(result.rows || []);
    } catch(error) {
      if (alive() && id===run && error.name!=='AbortError') paintOverlay([],notice('Price and breadth overlay unavailable',error.message,'',true));
    }
  }

  target.onsubmit = async (event)=>{
    event.preventDefault();
    const form = event.target;
    const values = new FormData(form);
    if (form.id==='journal-recipe-form') {
      const button=form.querySelector('[type="submit"]');
      button.disabled=true;
      try {
        const retrospect=values.has('includeRetrospective');
        const requested=values.get('recipeKey');
        const next=await loadSelection(requested,retrospect);
        if (!alive()||!form.isConnected) return;
        const backtest=target.querySelector('#journal-backtest-form');
        options.draft=backtest?Object.fromEntries(new FormData(backtest)):null;
        options.recipeKey=requested;
        options.retrospective=retrospect;
        options.result=null;
        applySelection(next);
        draw();
      } catch(error) { if (form.isConnected&&error.name!=='AbortError') errorAt(form,error); }
      finally { button.disabled=false; }
      return;
    }
    if (form.id==='journal-overlay-form') {
      options.metric=values.get('metric');
      options.overlay=values.get('overlay');
      options.limit=Number(values.get('limit'));
      loadOverlay();
      return;
    }
    if (form.id!=='journal-backtest-form') return;
    const output = target.querySelector('#journal-backtest-output');
    const button = form.querySelector('[type="submit"]');
    button.disabled=true;
    try {
      const horizons=[...new Set(String(values.get('horizons')).split(',').map((value)=>Number(value.trim())))];
      if (!horizons.every((value)=>Number.isInteger(value)&&value>0&&value<=5040)) throw new Error('Enter positive trading-session counts separated by commas.');
      output.innerHTML=pending('Submitting journal backtest…');
      const benchmark=values.get('benchmark');
      options.draft=Object.fromEntries(values);
      options.priceBasis=values.get('priceBasis');
      const job=await env.api('journal/backtest',{plain:true,body:{...scope,metric:values.get('metric'),op:values.get('op'),value:Number(values.get('value')),horizons,
        start:values.get('start'),end:values.get('end'),benchmarks:[benchmark],priceBasis:options.priceBasis,context:env.snapshotContext,
        recipeKey:selection.recipe?.key||options.recipeKey||undefined,includeRetrospective:options.retrospective}});
      const result=await waitForJournalJob(env,job,(current)=>{
        if (output.isConnected) output.innerHTML=pending(`Running historical comparison · ${count(current.progress)}%`);
      },()=>alive()&&output.isConnected);
      if (result&&alive()&&output.isConnected) {
        options.result=result;
        output.innerHTML=forwardResults(result,env);
      }
    } catch(error) {
      if (output.isConnected&&error.name!=='AbortError') output.innerHTML=notice('Journal backtest unavailable',error.message,'',true);
    } finally { button.disabled=false; }
  };
  target.onclick=(event)=>{
    const action=event.target.closest('[data-journal-research]')?.dataset.journalResearch;
    if (action==='export-factor') csvDownload(options.exportRows || [],['tradable_date','session_date','available_at','journal_id','recipe_key','retrospective','value','overlay'],'journal-factors.csv');
    if (action==='export-backtest'&&options.result) saveJson(options.result,'journal-signal-backtest.json');
  };
  draw();
}
