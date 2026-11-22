import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { bindResearchNoteMarkers, loadResearchNotes, mountResearchNoteHistory, noteSubject,
  openResearchNoteEditor, renderResearchNoteMarkers } from '../frontend/research-notes.js';

const date = '2025-05-30';
const previous = '2025-05-29';
const subject = noteSubject('stock', 'fixture:ABCD', { date, dataVersion: 19, basis: 'known' });
const attack = '<img src=x onerror="steal()"><script>steal()</script>';
const note = { id: 'note-1', subjectType: 'stock', subjectId: subject.id, date, markdown: attack,
  createdAt: '2025-05-30T22:00:00.000Z', updatedAt: '2025-06-01T00:00:00.000Z', version: 1, source: 'chartbook-note' };
const journal = { ...note, id: 'journal-1', subjectType: 'market', subjectId: 'journal', source: 'journal-note', markdown: 'User market journal' };

function fixture(t, html = '<main></main>') {
  const { window } = new JSDOM(html);
  t.after(() => window.close());
  const document = window.document;
  const main = document.querySelector('main');
  return { window, document, main };
}

test('note markers use exact plotted dates and safely show all co-dated bodies and UTC audit timestamps', (t) => {
  const { window, document, main } = fixture(t, '<dialog open><main></main></dialog>');
  const rows = [{ date: previous }, { date }];
  const notes = [note, journal, { ...note, date: '2025-05-28' }, { ...note, date: '2025-06-02' }];
  const markers = renderResearchNoteMarkers(notes, { rows, x: (index) => 20 + index * 50, y: 14 });
  assert.doesNotMatch(markers, /steal|Market journal/);
  main.innerHTML = `<svg>${markers}</svg>`;
  const chartNotes = main.querySelectorAll('[data-research-note-marker]');
  assert.equal(chartNotes.length, 1);
  const [marker] = chartNotes;
  assert.equal(marker.getAttribute('transform'), 'translate(70 14)');
  assert.match(marker.getAttribute('aria-label'), /2 research notes on May 30, 2025/);
  const edited = [];
  const controller = new AbortController();
  bindResearchNoteMarkers(main, notes, { onEdit: (item) => edited.push(item), signal: controller.signal });
  const tooltip = () => document.querySelector('.research-note-tooltip');
  const key = (target, key) => target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  marker.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true }));
  assert.equal(tooltip().closest('dialog'), main.closest('dialog'));
  assert.equal(tooltip().querySelectorAll('article').length, 2);
  assert.equal(tooltip().querySelector('.research-note-copy').textContent, attack);
  assert.equal(tooltip().querySelector('script, img'), null);
  assert.match(tooltip().textContent, /Market journal.*User market journal/s);
  assert.equal(tooltip().querySelector('time').dateTime, note.createdAt);
  assert.match(tooltip().textContent, /Created.*UTC.*Updated.*UTC/s);
  marker.focus();
  assert.equal(key(marker, 'Enter'), false);
  assert.equal(document.activeElement, tooltip().querySelector('button'));
  tooltip().querySelectorAll('button')[1].click();
  assert.deepEqual(edited, [journal]);
  assert.equal(tooltip(), null);
  marker.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true }));
  assert.equal(key(marker, 'Escape'), false);
  assert.equal(marker.hasAttribute('aria-describedby'), false);
  marker.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true }));
  controller.abort();
  assert.equal(tooltip(), null);
  marker.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true }));
  assert.equal(tooltip(), null);
});

test('the editor retains a conflicting draft, displays the latest saved version, and emits the saved note', async (t) => {
  const { window, document, main } = fixture(t, '<main><button id="opener">Open notes</button></main>');
  const writes = [];
  const events = [];
  const newer = { ...note, markdown: 'Concurrent edit', version: 2 };
  const save = { ...newer, markdown: 'My draft', version: 3 };
  const env = { main, async api(path, options) {
    assert.equal(path, 'research-notes');
    assert.equal(options.plain, true);
    assert.equal(options.params.date, date);
    assert.equal(options.params.dataVersion, 19);
    if (options.method !== 'PUT') {
      assert.equal(options.params.from, date);
      assert.equal(options.params.to, date);
      return { notes: [newer] };
    }
    writes.push(options.body);
    if (writes.length === 1) throw Object.assign(new Error('Conflict'), { status: 409 });
    return save;
  } };
  document.addEventListener('research-note:changed', (event) => events.push(event.detail));
  document.querySelector('#opener').focus();
  openResearchNoteEditor(env, { subject, date, note });
  const form = document.querySelector('dialog form');
  const text = form.elements.namedItem('note');
  assert.equal(document.activeElement, text);
  assert.equal(text.value, attack);
  text.value = 'My draft';
  const submit = () => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  submit();
  await setImmediate();
  const button = form.querySelector('[data-note-editor-save]');
  const review = form.querySelector('[data-note-editor-review]');
  assert.equal(button.disabled, true);
  assert.equal(review.hidden, false);
  assert.match(form.textContent, /Your draft is still here/);
  assert.equal(text.value, 'My draft');
  review.click();
  await setImmediate();
  assert.equal(text.value, 'My draft');
  assert.match(form.querySelector('[data-note-editor-latest]').textContent, /Concurrent edit/);
  assert.equal(button.disabled, false);
  submit();
  await setImmediate();
  assert.deepEqual(writes.map(({ expectedVersion, noteId, markdown }) => [expectedVersion, noteId, markdown]),
    [[1, note.id, 'My draft'], [2, note.id, 'My draft']]);
  assert.equal(document.querySelector('dialog'), null);
  assert.equal(document.activeElement.id, 'opener');
  assert.deepEqual(events, [{ subject, note: save }]);
});

test('an initial lookup loads the saved body before allowing edits and locks the text while saving', async (t) => {
  const { window, document, main } = fixture(t);
  const { promise: lookup, resolve: resolveLookup } = Promise.withResolvers();
  const { promise: write, resolve: resolveWrite } = Promise.withResolvers();
  const writes = [];
  const env = { main, api(_path, options) {
    if (options.method !== 'PUT') return lookup;
    writes.push(options.body);
    return write;
  } };
  openResearchNoteEditor(env, { subject, date });
  const form = document.querySelector('form');
  const text = form.elements.namedItem('note');
  const button = form.querySelector('[data-note-editor-save]');
  const submit = () => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(text.readOnly, true);
  assert.equal(button.disabled, true);
  text.value = 'Synthetic input while readonly';
  text.dispatchEvent(new window.Event('input'));
  submit();
  assert.deepEqual(writes, []);
  resolveLookup({ notes: [note] });
  await setImmediate();
  assert.equal(text.value, note.markdown);
  assert.equal(text.readOnly, false);
  text.value = 'Reviewed edit';
  submit();
  assert.equal(text.readOnly, true);
  assert.equal(button.disabled, true);
  assert.equal(writes[0].markdown, 'Reviewed edit');
  assert.equal(writes[0].expectedVersion, 1);
  resolveWrite({ ...note, markdown: writes[0].markdown, version: 2 });
  await setImmediate();
  assert.equal(document.querySelector('dialog'), null);
});

test('the market journal editor accepts a small edit of a legacy note longer than 20,000 characters', async (t) => {
  const { window, document, main } = fixture(t);
  const journalSubject = noteSubject('market', 'journal', subject.context);
  const longJournal = { ...journal, markdown: 'A'.repeat(25_000) };
  const writes = [];
  const env = { main, async api(_path, options) {
    writes.push(options.body);
    return { ...longJournal, markdown: options.body.markdown, version: 2 };
  } };
  openResearchNoteEditor(env, { subject: journalSubject, date, note: longJournal });
  const text = document.querySelector('[name="note"]');
  assert.equal(text.maxLength, 40_000);
  assert.equal(text.value, longJournal.markdown);
  text.value += '!';
  text.form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await setImmediate();
  assert.equal(writes[0].noteId, longJournal.id);
  assert.equal(writes[0].markdown, longJournal.markdown + '!');
  assert.equal(document.querySelector('dialog'), null);
});

test('unsaved text survives closing the editor, keeps the original version, and clears on save', async (t) => {
  const { window, document, main } = fixture(t);
  const writes = [];
  let saved;
  const env = { main, async api(_path, options) {
    writes.push(options.body);
    saved = { ...note, version: 2, markdown: options.body.markdown };
    return saved;
  } };
  const open = (current = note, editing = subject) => {
    openResearchNoteEditor(env, { subject: editing, date, note: current });
    return document.querySelector('dialog textarea');
  };
  const cancel = () => document.querySelector('[data-note-editor-close]').click();
  open().value = 'Draft retained in this workspace';
  cancel();
  assert.equal(open(note, { ...subject, id: 'fixture:OTHER' }).value, note.markdown);
  cancel();
  const text = open({ ...note, markdown: 'Edited elsewhere', version: 2 }, {
    ...subject, context: { ...subject.context, dataVersion: 20, modelVersion: 3 },
  });
  assert.equal(text.value, 'Draft retained in this workspace');
  assert.match(text.form.textContent, /Unsaved draft restored/);
  text.form.dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
  await setImmediate();
  assert.equal(writes[0].expectedVersion, 1);
  assert.equal(open({ ...saved, version: 3, markdown: 'Current saved content' }).value, 'Current saved content');
  cancel();
});

test('a weekly marker lists notes from actual covered sessions and preserves each original date', (t) => {
  const { window, document, main } = fixture(t);
  const days = ['2025-05-27', previous, date];
  const notes = [note, { ...note, id: 'first-week-note', date: days[0], markdown: 'Tuesday comment' },
    { ...note, id: 'outside-bucket', date: '2025-05-28', markdown: 'Unavailable session' }];
  main.innerHTML = `<svg>${renderResearchNoteMarkers(notes, { rows: [{ date, noteDates: days }], x: () => 20, y: 14 })}</svg>`;
  const marker = main.querySelector('[data-research-note-marker]');
  assert.equal(marker.dataset.researchNoteDates, `${days[0]} ${date}`);
  const edits = [];
  bindResearchNoteMarkers(main, notes, { onEdit: (value) => edits.push(value) });
  marker.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true }));
  const tooltip = main.querySelector('.research-note-tooltip');
  assert.match(tooltip.textContent, /Week ending May 30, 2025/);
  assert.match(tooltip.textContent, /Session May 27, 2025.*Tuesday comment/s);
  assert.match(tooltip.textContent, /Session May 30, 2025/);
  assert.doesNotMatch(tooltip.textContent, /Unavailable session/);
  tooltip.querySelector('button').click();
  assert.equal(edits[0].date, days[0]);
  assert.equal(document.querySelector('.research-note-tooltip'), null);
});

test('history requests the complete pinned series, refreshes matching changes, and cleans up on abort', async (t) => {
  const { window, document, main } = fixture(t);
  const controller = new AbortController();
  const requests = [];
  const changes = [];
  const old = { ...note, id: 'earlier', date: previous };
  const env = { main, signal: controller.signal, async api(path, options) {
    assert.equal(path, 'research-notes');
    requests.push(options);
    return { notes: [old, note] };
  } };
  assert.equal((await loadResearchNotes(env, subject, { from: previous, to: date }))[0].date, previous);
  assert.deepEqual(requests.pop().params, { ...subject.context, subjectType: 'stock', subjectId: subject.id, from: previous, to: date });
  mountResearchNoteHistory(main, env, subject, { onChange: (notes) => changes.push(notes) });
  await setImmediate();
  assert.deepEqual(requests[0].params, { ...subject.context, subjectType: 'stock', subjectId: subject.id });
  assert.equal(main.querySelectorAll('[data-research-note-edit]').length, 2);
  assert.equal(main.querySelector('img, script'), null);
  assert.match(main.querySelector('article').textContent, /May 30, 2025/);
  const changed = (subject, note) => document.dispatchEvent(new window.CustomEvent('research-note:changed', { detail: { subject, note } }));
  changed({ ...subject, id: 'different-stock' }, note);
  changed(subject, { ...note, date: '2025-06-02' });
  assert.equal(requests.length, 1);
  changed(subject, note);
  await setImmediate();
  assert.equal(requests.length, 2);
  assert.deepEqual(changes, [[old, note], [old, note]]);
  main.querySelectorAll('[data-research-note-edit]')[1].click();
  assert.match(document.querySelector('dialog').textContent, /May 29, 2025/);
  assert.equal(document.querySelectorAll('[data-research-notes-styles]').length, 1);
  controller.abort();
  changed(subject, note);
  assert.equal(requests.length, 2);
  assert.equal(document.querySelector('dialog'), null);
});

test('generic chart zoom rebinds visible exact-date notes and disposes the tooltip from the previous frame', async (t) => {
  const { window, document, main } = fixture(t);
  const oldDocument = globalThis.document;
  globalThis.document = document;
  t.after(() => { globalThis.document = oldDocument; });
  const { chart } = await import('../frontend/charts.js');
  const rows = Array.from({ length: 10 }, (_, index) => ({ date: `2025-05-${21 + index}`, close: 30 + index }));
  const older = { ...note, id: 'older', date: rows[0].date, markdown: 'Older note' };
  const picked = [];
  const edited = [];
  main.innerHTML = chart(rows, [{ key: 'close', label: 'Close' }], {
    notes: [older, note], onNoteEdit: (item) => edited.push(item), onPick: (item) => picked.push(item),
  });
  const selector = '[data-research-note-marker]';
  const markers = () => [...main.querySelectorAll(selector)];
  const tooltip = () => main.querySelector('.research-note-tooltip');
  const pointer = (node, type) => node.dispatchEvent(new window.MouseEvent(type, { bubbles: true }));
  const key = (node, key) => node.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  assert.deepEqual(markers().map((item) => item.dataset.researchNoteMarker), [older.date, date]);
  const svg = main.querySelector('[data-plot]');
  key(svg, 'End');
  assert.equal(main.querySelector('.chart-tooltip').hidden, false);
  const [firstMarker] = markers();
  pointer(firstMarker, 'pointerover');
  assert.equal(main.querySelector('.chart-tooltip').hidden, true);
  assert.match(tooltip().textContent, /Older note/);
  main.querySelector('[data-chart-command="zoom"]').click();
  assert.equal(tooltip(), null);
  assert.deepEqual(markers().map((item) => item.dataset.researchNoteMarker), [date]);
  pointer(firstMarker, 'pointerover');
  assert.equal(tooltip(), null);
  const [currentMarker] = markers();
  currentMarker.focus();
  assert.match(tooltip().textContent, /steal/);
  assert.equal(key(currentMarker, 'Enter'), false);
  assert.deepEqual(picked, []);
  assert.deepEqual(edited, [note]);
});
