import { dateLabel, notice, panelHead, pending, safe } from './ui.js';

const endpoint = 'research-notes';
const markerSelector = '[data-research-note-marker]';
const changedEvent = 'research-note:changed';
const scopedContextKeys = ['universe', 'universeVersion', 'basis', 'classification'];
const draftsByDocument = new WeakMap();
const utcTimestamp = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium', timeStyle: 'long', timeZone: 'UTC',
});
let tooltipId = 0;

export function noteSubject(type, id, context) {
  return { type, id, context: { ...context } };
}

function sameSubject(a, b) {
  return a?.type === b.type && a.id === b.id && (a.type === 'stock' ||
    scopedContextKeys.every((key) => String(a.context[key]) === String(b.context[key])));
}

export function loadResearchNoteStyles(doc) {
  if (doc.head.querySelector('[data-research-notes-styles]')) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./research-notes.css', import.meta.url).href;
  link.setAttribute('data-research-notes-styles', '');
  doc.head.append(link);
}

export async function loadResearchNotes(env, subject, { from, to, signal = env.signal } = {}) {
  const result = await env.api(endpoint, {
    plain: true, signal, params: { ...subject.context, subjectType: subject.type, subjectId: subject.id,
      ...(from && { from }), ...(to && { to }) },
  });
  if (!Array.isArray(result?.notes)) throw new Error('The note list was unavailable.');
  return result.notes;
}

function noteTimes(note) {
  return ['createdAt', 'updatedAt'].map((field) => {
    const value = note[field];
    if (!value || !Number.isFinite(Date.parse(value))) return '';
    const label = field === 'createdAt' ? 'Created' : 'Updated';
    return `<span>${label} <time datetime="${safe(value)}">${safe(utcTimestamp.format(new Date(value)))}</time></span>`;
  }).join('');
}

function noteBody(note) {
  return `<div class="research-note-audit">${noteTimes(note)}</div><p class="research-note-copy">${safe(note.markdown || 'Empty note')}</p>`;
}

function notesByDate(notes) {
  const groups = new Map();
  for (const note of notes ?? []) {
    if (!groups.has(note.date)) groups.set(note.date, []);
    groups.get(note.date).push(note);
  }
  return groups;
}

export function renderResearchNoteMarkers(notes, { rows, x, y }) {
  if (!notes?.length) return '';
  const groups = notesByDate(notes);
  const shown = new Set();
  return rows.map((row, index) => {
    const dates = [...new Set(row.noteDates ?? [row.date])].filter((date) => groups.has(date));
    const count = dates.reduce((sum, date) => sum + groups.get(date).length, 0);
    if (!count || shown.has(row.date)) return '';
    const px = x(index, row);
    const py = typeof y === 'function' ? y(index, row) : y;
    if (![px, py].every(Number.isFinite)) return '';
    shown.add(row.date);
    const label = `${count} research note${count === 1 ? '' : 's'} ${row.noteDates ? 'in week ending' : 'on'} ${dateLabel(row.date)}`;
    const datesAttribute = row.noteDates ? ` data-research-note-dates="${safe(dates.join(' '))}"` : '';
    return `<g class="research-note-marker" data-research-note-marker="${safe(row.date)}"${datesAttribute} role="button"
      tabindex="0" aria-label="${safe(label)}" transform="translate(${px} ${py})"><rect x="-7" y="-7" width="14" height="14" rx="3"/>
      <text x="0" y="0" dy=".34em" text-anchor="middle" aria-hidden="true">N</text></g>`;
  }).join('');
}

export function bindResearchNoteMarkers(container, notes, { onEdit, onShow, signal } = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  let marker;
  let groups = notesByDate(notes);
  let tooltip;
  let byDate = [];
  const handlers = [];
  const add = (target, type, listener) => {
    target.addEventListener(type, listener);
    handlers.push(() => target.removeEventListener(type, listener));
  };
  const hide = () => {
    if (!tooltip) return false;
    marker.removeAttribute('aria-describedby');
    tooltip.remove();
    win.removeEventListener('resize', position);
    win.removeEventListener('scroll', position, true);
    marker = tooltip = null;
    byDate = [];
    return true;
  };
  const cleanup = Object.assign(() => {
    hide();
    for (const remove of handlers.splice(0)) remove();
    groups = new Map();
  }, { hide });
  if (!groups.size || signal?.aborted || !container.querySelector(markerSelector)) return cleanup;
  loadResearchNoteStyles(doc);

  function position() {
    if (!tooltip) return;
    const bounds = marker.getBoundingClientRect();
    const { offsetWidth, offsetHeight } = tooltip;
    const left = Math.max(8, Math.min(bounds.left, win.innerWidth - offsetWidth - 8));
    const top = bounds.bottom + offsetHeight <= win.innerHeight - 8 ? bounds.bottom : Math.max(8, bounds.top - offsetHeight);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }
  function show(node) {
    if (!node || node === marker) return;
    const { researchNoteMarker: session, researchNoteDates } = node.dataset;
    const shownNotes = researchNoteDates ? researchNoteDates.split(' ').flatMap((date) => groups.get(date) ?? []) : groups.get(session);
    if (!shownNotes?.length) return;
    hide();
    onShow?.();
    marker = node;
    byDate = shownNotes;
    tooltip = doc.createElement('div');
    tooltip.className = 'research-note-tooltip';
    tooltip.id = `research-note-tooltip-${++tooltipId}`;
    tooltip.setAttribute('role', 'region');
    tooltip.setAttribute('aria-label', 'Research notes for this session');
    tooltip.innerHTML = `<strong>${researchNoteDates ? 'Week ending' : 'Session'} ${safe(dateLabel(session))}</strong>${byDate.map((note, index) =>
      `<article>${researchNoteDates ? `<strong>Session ${safe(dateLabel(note.date))}</strong> ` : ''}
        ${note.source === 'journal-note' ? '<strong>Market journal</strong>' : ''}${noteBody(note)}
        ${onEdit ? `<button type="button" class="button" data-research-note-tooltip-edit="${index}">Edit ${note.source === 'journal-note' ? 'market journal note' : 'note'}</button>` : ''}</article>`).join('')}`;
    marker.setAttribute('aria-describedby', tooltip.id);
    container.append(tooltip);
    position();
    win.addEventListener('resize', position);
    win.addEventListener('scroll', position, true);
  }
  const findMarker = (target) => target.closest?.(markerSelector);
  function leaving(event) {
    if (!tooltip || (!marker.contains(event.target) && !tooltip.contains(event.target))) return;
    const destination = event.relatedTarget;
    if (destination?.nodeType && (marker.contains(destination) || tooltip.contains(destination))) return;
    if (event.type === 'pointerout' && (marker.contains(doc.activeElement) || tooltip.contains(doc.activeElement))) return;
    hide();
  }
  function activate() {
    if (byDate.length === 1 && onEdit) {
      const [note] = byDate;
      hide();
      onEdit(note);
    } else tooltip?.querySelector('button')?.focus();
  }
  add(container, 'pointerover', (event) => show(findMarker(event.target)));
  add(container, 'pointerout', leaving);
  add(container, 'focusin', (event) => show(findMarker(event.target)));
  add(container, 'focusout', leaving);
  add(container, 'keydown', (event) => {
    const node = findMarker(event.target);
    if (event.key === 'Escape' && tooltip) {
      const returnFocus = tooltip.contains(event.target);
      const previous = marker;
      if (returnFocus) previous.focus();
      hide();
    } else if (event.key === 'Enter' && node) {
      show(node);
      activate();
    } else return;
    event.preventDefault();
    event.stopPropagation();
  });
  add(container, 'click', (event) => {
    const node = findMarker(event.target);
    const button = event.target.closest?.('[data-research-note-tooltip-edit]');
    if (node) {
      show(node);
      activate();
    } else if (button && tooltip?.contains(button)) {
      const note = byDate[Number(button.dataset.researchNoteTooltipEdit)];
      marker.focus();
      hide();
      onEdit?.(note);
    } else return;
    event.stopPropagation();
  });
  if (signal) add(signal, 'abort', cleanup);
  return cleanup;
}

export function openResearchNoteEditor(env, { subject, date, note, onSave }) {
  const doc = env.main?.ownerDocument ?? document;
  if (env.signal?.aborted) return;
  const existing = doc.querySelector('dialog[data-research-note-editor]');
  if (existing) {
    existing.querySelector('textarea')?.focus();
    return;
  }
  loadResearchNoteStyles(doc);
  const opener = doc.activeElement;
  const workspaceModal = env.modal && env.showDialog && !env.modal.open;
  const dialog = workspaceModal ? env.modal : doc.createElement('dialog');
  const controller = new AbortController();
  const signal = controller.signal;
  const draftKey = JSON.stringify([subject.type, subject.id, date, note?.source === 'journal-note',
    ...(subject.type === 'stock' ? [] : scopedContextKeys.map((key) => String(subject.context[key])))]);
  if (!draftsByDocument.has(doc)) draftsByDocument.set(doc, new Map());
  const drafts = draftsByDocument.get(doc);
  const draft = drafts.get(draftKey);
  let current = note?.version > 0 ? note : undefined;
  if (draft) current = draft.note;
  let dirty = !!draft;
  let committed = false;
  const journal = note?.source === 'journal-note';
  const title = journal ? 'Edit market journal note' : 'Research note';
  const maxLength = journal ? 40_000 : 20_000;
  const subtitle = `Trading session ${dateLabel(date)}`;
  dialog.setAttribute('data-research-note-editor', '');
  const markup = `<form class="${workspaceModal ? 'stack' : 'dialog-body stack'}">
      <div class="research-note-audit" data-note-editor-audit></div>
      <label class="field"><span>Note (Markdown text)</span><textarea name="note" rows="9" maxlength="${maxLength}" readonly autofocus></textarea></label>
      <div data-note-editor-status role="status"></div>
      <div data-note-editor-latest hidden></div>
      <div class="actions">
        <button class="button primary" type="submit" data-note-editor-save disabled>Save note</button>
        <button class="button" type="button" data-note-editor-review hidden>Review latest version</button>
        <button class="button" type="button" data-note-editor-close>Close</button>
      </div>
    </form>`;
  if (workspaceModal) env.showDialog(dialog, title, markup, subtitle, opener);
  else {
    dialog.setAttribute('aria-label', title);
    dialog.innerHTML = `<div class="dialog-head"><div><h2>${title}</h2><p class="muted">${safe(subtitle)}</p></div></div>${markup}`;
    (opener?.closest('dialog[open]') ?? doc.body).append(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }
  const form = dialog.querySelector('form');
  const textarea = form.elements.namedItem('note');
  const save = form.querySelector('[data-note-editor-save]');
  const review = form.querySelector('[data-note-editor-review]');
  const status = form.querySelector('[data-note-editor-status]');
  const latest = form.querySelector('[data-note-editor-latest]');
  const audit = form.querySelector('[data-note-editor-audit]');
  const connected = () => dialog.isConnected && !signal.aborted;
  function rememberDraft() {
    if (textarea.readOnly) return;
    dirty = textarea.value !== (current?.markdown ?? '');
    if (dirty) drafts.set(draftKey, { markdown: textarea.value, note: current });
    else drafts.delete(draftKey);
  }
  function close() {
    if (!connected()) return;
    if (!committed) rememberDraft();
    controller.abort();
    env.signal?.removeEventListener('abort', close);
    dialog.removeAttribute('data-research-note-editor');
    dialog.removeEventListener('cancel', cancel);
    dialog.removeEventListener('close', close);
    dialog.removeEventListener('keydown', keydown);
    if (workspaceModal) {
      if (dialog.open) dialog.close();
      form.remove();
    } else {
      dialog.remove();
      if (!env.signal?.aborted && opener?.isConnected) opener.focus();
    }
  }
  function cancel(event) { event.preventDefault(); close(); }
  function keydown(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }
  dialog.addEventListener('cancel', cancel);
  dialog.addEventListener('close', close);
  dialog.addEventListener('keydown', keydown);
  textarea.addEventListener('input', rememberDraft);
  form.querySelector('[data-note-editor-close]').onclick = close;
  env.signal?.addEventListener('abort', close, { once: true });

  function useNote(value, preserveDraft) {
    current = value;
    audit.innerHTML = current ? noteTimes(current) : '';
    textarea.readOnly = false;
    if (!preserveDraft && !dirty) textarea.value = current?.markdown ?? '';
    else rememberDraft();
    save.disabled = false;
    review.hidden = true;
  }
  async function getCurrent() {
    const notes = await loadResearchNotes(env, subject, { from: date, to: date, signal });
    return current?.id ? notes.find((item) => item.id === current.id)
      : notes.find((item) => item.date === date && item.source !== 'journal-note');
  }
  review.onclick = async () => {
    review.disabled = true;
    try {
      const recent = await getCurrent();
      if (!connected()) return;
      const reviewDraft = !textarea.readOnly;
      useNote(recent, reviewDraft);
      if (reviewDraft) {
        latest.hidden = false;
        latest.innerHTML = `<strong>Latest saved version</strong>${recent ? noteBody(recent) : '<p>No saved content for this session.</p>'}`;
      }
      status.textContent = reviewDraft ? 'Review the saved text and your draft before saving.' : '';
      textarea.focus();
    } catch (problem) {
      if (connected()) status.textContent = problem.message;
    } finally {
      review.disabled = false;
    }
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (save.disabled) return;
    if (!current && !textarea.value.trim()) {
      status.textContent = 'Enter a note to save.';
      textarea.focus();
      return;
    }
    if (textarea.value.length > maxLength) {
      status.textContent = journal ? 'Use up to 40,000 characters for a market journal note.' : 'Use up to 20,000 characters for a research note.';
      return;
    }
    rememberDraft();
    textarea.readOnly = true;
    save.disabled = true;
    status.textContent = 'Saving…';
    let saved;
    try {
      saved = await env.api(endpoint, {
        plain: true, method: 'PUT', signal, params: subject.context,
        body: { subjectType: subject.type, subjectId: subject.id, date, markdown: textarea.value,
          expectedVersion: current?.version ?? 0, ...(current?.id && { noteId: current.id }) },
      });
    } catch (problem) {
      if (!connected()) return;
      textarea.readOnly = false;
      status.textContent = problem.status === 409 ? 'This note changed while you were editing. Your draft is still here.' : problem.message;
      review.hidden = problem.status !== 409;
      save.disabled = problem.status === 409;
      return;
    }
    if (!connected()) return;
    committed = true;
    drafts.delete(draftKey);
    close();
    doc.dispatchEvent(new doc.defaultView.CustomEvent(changedEvent, { detail: { subject, note: saved } }));
    try {
      await onSave?.(saved);
    } catch (problem) {
      if (problem.name !== 'AbortError' && !env.signal?.aborted) env.toast?.(problem.message);
    }
  };
  if (draft) textarea.value = draft.markdown;
  textarea.focus();
  if (current || draft) {
    useNote(current, !!draft);
    if (draft) status.textContent = 'Unsaved draft restored.';
  }
  else {
    status.textContent = 'Loading note…';
    void getCurrent().then((value) => {
      if (!connected()) return;
      useNote(value, false);
      status.textContent = '';
    }).catch((problem) => {
      if (!connected()) return;
      status.textContent = problem.message;
      review.hidden = false;
    });
  }
}

export function mountResearchNoteHistory(container, env, subject, { onChange, signal = env.signal, from, to } = {}) {
  const doc = container.ownerDocument;
  const controller = new AbortController();
  let notes = [];
  let request = 0;
  const date = subject.context.date;
  loadResearchNoteStyles(doc);
  container.innerHTML = `${panelHead('Research notes', `Trading sessions through ${dateLabel(date)}`)}
    <form class="research-note-date" data-research-note-new>
      <label class="field"><span>Trading session</span><input name="date" type="date" value="${safe(to ?? date)}" min="${safe(from ?? '1900-01-01')}" max="${safe(to ?? date)}" required></label>
      <button type="submit" class="button">Add note</button>
    </form><div data-research-note-history>${pending('Loading research notes…')}</div>`;
  const list = container.querySelector('[data-research-note-history]');
  const form = container.querySelector('form');
  const edit = (event) => {
    const button = event.target.closest('[data-research-note-edit]');
    if (!button || !list.contains(button)) return;
    const note = notes[Number(button.dataset.researchNoteEdit)];
    if (note) openResearchNoteEditor(env, { subject, date: note.date, note });
  };
  const submit = (event) => {
    event.preventDefault();
    const date = form.elements.namedItem('date').value;
    if (date) openResearchNoteEditor(env, { subject, date, note: notes.find((note) => note.date === date) });
  };
  async function refresh() {
    if (controller.signal.aborted) return;
    const generation = ++request;
    const active = () => generation === request && !controller.signal.aborted && container.isConnected;
    try {
      const result = await loadResearchNotes(env, subject, { signal: controller.signal });
      if (!active()) return;
      notes = result.toReversed();
      list.innerHTML = notes.length ? notes.map((note, index) => `<article class="research-note-history-entry">
        <header><strong>${safe(dateLabel(note.date))}</strong><button class="button" type="button"
          aria-label="Edit note for ${safe(dateLabel(note.date))}" data-research-note-edit="${index}">Edit</button></header>
        ${noteBody(note)}</article>`).join('') : '<p class="muted">No research notes for this ticker.</p>';
      onChange?.(result);
    } catch (problem) {
      if (active() && problem.name !== 'AbortError') list.innerHTML = notice('Research notes unavailable', problem.message, '', true);
    }
  }
  const changed = ({ detail }) => {
    if (detail?.note?.date <= date && sameSubject(detail.subject, subject)) void refresh();
  };
  function cleanup() {
    controller.abort();
    signal?.removeEventListener('abort', cleanup);
    doc.removeEventListener(changedEvent, changed);
    list.removeEventListener('click', edit);
    form.removeEventListener('submit', submit);
  }
  if (signal?.aborted) return cleanup;
  signal?.addEventListener('abort', cleanup, { once: true });
  doc.addEventListener(changedEvent, changed);
  list.addEventListener('click', edit);
  form.addEventListener('submit', submit);
  void refresh();
  return cleanup;
}
