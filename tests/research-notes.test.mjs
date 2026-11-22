import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { analysisWorkspaceScopeHash } from '../backend/analysis-readiness.mjs';
import { CALCULATION_VERSION, dataVersion, getWorkspace, openDatabase } from '../backend/database.mjs';
import { saveJournalNote } from '../backend/journal.mjs';
import { createResearchNotes } from '../backend/research-notes.mjs';

const thursday = '2025-05-29';
const friday = '2025-05-30';
const monday = '2025-06-02';
const created = '2025-05-30T22:00:00.000Z';
const updated = '2025-06-01T00:00:00.000Z';
const securityId = 'fixture:ABCD';
const stock = { subjectType: 'stock', subjectId: securityId };
const market = { subjectType: 'market', subjectId: 'daily-4' };
const industry = { subjectType: 'industry', subjectId: 'industry:semiconductors' };
const journal = { subjectType: 'market', subjectId: 'journal' };
const stockNoteKey = (date) => createHash('sha256').update(JSON.stringify([securityId, date])).digest('hex');

function fixture(t, listing = {}) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const route = createResearchNotes(db, {}).route;
  const point = { date: friday, latestDate: monday, dataVersion: 19, universe: { id: 'us-core', version: 2 },
    basis: 'known', classification: 'sec-sic', model: { id: 'composite', version: 1 } };
  const resolveIdentity = (_point, id) => [securityId, 'OLDTICKER'].includes(id) ? { id: securityId, ...listing } : null;
  const get = (subject, query = {}, context = {}) => route({ method: 'GET', query: { ...subject, ...query },
    resolvePoint: () => ({ ...point, ...context }), resolveIdentity }).data.notes;
  const put = (subject, body, context = {}, query) => route({ method: 'PUT', query,
    body: { ...subject, date: friday, markdown: 'A note', expectedVersion: 0, ...body },
    resolvePoint: () => ({ ...point, ...context }), resolveIdentity }).data;
  return { db, get, put, route };
}

test('stock notes preserve every legacy row and timestamp and append with the original stock/day key', (t) => {
  const { db, get, put } = fixture(t);
  const key = stockNoteKey(thursday);
  const insert = db.prepare("INSERT INTO workspace VALUES ('chartbook-note',?,?,?,?,?,?,0)");
  for (const [version, markdown, timestamp] of [[1, 'Original', created], [2, 'First edit', updated]]) {
    insert.run(key, version, thursday, JSON.stringify({ securityId, date: thursday, markdown }), created, timestamp);
  }
  const before = get({ ...stock, subjectId: 'OLDTICKER' });
  assert.deepEqual(before, [{
    id: key, ...stock, date: thursday, markdown: 'First edit', version: 2,
    createdAt: created, updatedAt: updated, source: 'chartbook-note', sourceContext: null,
  }]);
  assert.equal(get(stock, { from: friday }).length, 0);
  const saved = put(stock, { date: thursday, markdown: 'Second edit', expectedVersion: 2, noteId: key });
  assert.equal(saved.version, 3);
  assert.equal(saved.createdAt, created);
  assert.ok(saved.updatedAt > updated);
  assert.equal(saved.sourceContext, null);
  assert.equal(getWorkspace(db, 'chartbook-note', key, 1).definition.markdown, 'Original');
  assert.equal(getWorkspace(db, 'chartbook-note', key, 2).updated_at, updated);
  assert.equal(getWorkspace(db, 'chartbook-note', key).definition.securityId, securityId);
  assert.deepEqual(put(stock, { date: thursday, markdown: 'Second edit', expectedVersion: 3 }), saved);
  assert.throws(() => put(stock, { date: thursday, expectedVersion: 2 }), { status: 409 });
  assert.equal(get(stock, {}, { dataVersion: 47, basis: 'reconstructed', model: { id: 'custom', version: 3 } })[0].id, key);
  const newer = put(stock);
  assert.equal(newer.id, stockNoteKey(friday));
  assert.equal(newer.sourceContext.dataVersion, 19);
  assert.deepEqual(get(stock).map(({ date }) => date), [thursday, friday]);
});

test('market and industry notes use stable subject, universe, basis, and classification scope', (t) => {
  const { db, get, put } = fixture(t);
  const before = { version: dataVersion(db), preparation: analysisWorkspaceScopeHash(db), math: CALCULATION_VERSION };
  const first = put(industry);
  const broader = put(market);
  const laterPoint = { date: monday, dataVersion: 60, model: { id: 'another', version: 10 } };
  assert.deepEqual(get(industry, {}, laterPoint), [first]);
  assert.deepEqual(get(market, {}, laterPoint), [broader]);
  assert.deepEqual(get({ ...industry, subjectId: 'industry:finance' }), []);
  for (const other of [{ universe: { id: 'nasdaq', version: 2 } }, { universe: { id: 'us-core', version: 3 } },
    { basis: 'reconstructed' }, { classification: 'provider' }]) {
    assert.deepEqual(get(industry, {}, other), []);
    assert.deepEqual(get(market, {}, other), []);
    assert.throws(() => put(industry, { noteId: first.id, expectedVersion: 1 }, other), { status: 404 });
  }
  const edit = put(industry, { markdown: 'Revised', expectedVersion: 1, noteId: first.id }, laterPoint);
  assert.equal(edit.id, first.id);
  assert.equal(edit.version, 2);
  assert.equal(edit.createdAt, first.createdAt);
  assert.equal(edit.sourceContext.dataVersion, 19, 'the creation context is retained');
  assert.deepEqual({ version: dataVersion(db), preparation: analysisWorkspaceScopeHash(db), math: CALCULATION_VERSION }, before);
  assert.equal(db.prepare('SELECT count(*) AS count FROM jobs').get().count, 0);
});

test('manual journal annotations remain editable in the legacy journal and are explicitly scoped', (t) => {
  const { db, get, put } = fixture(t);
  const tables = () => db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all();
  const before = tables();
  db.exec('PRAGMA query_only=ON');
  assert.deepEqual(get(journal), []);
  assert.deepEqual(tables(), before);
  db.exec(`PRAGMA query_only=OFF;
    CREATE TABLE journal_notes(as_of_date TEXT,version INTEGER,markdown TEXT,updated_at TEXT,PRIMARY KEY(as_of_date,version)) WITHOUT ROWID;
    CREATE TABLE journal_entries(as_of_date TEXT,markdown TEXT)`);
  const insert = db.prepare('INSERT INTO journal_notes VALUES (?,?,?,?)');
  insert.run(friday, 1, 'Original journal', created);
  insert.run(friday, 2, 'Second journal', updated);
  db.prepare('INSERT INTO journal_entries VALUES (?,?)').run(friday, 'Generated journal');
  db.exec('PRAGMA query_only=ON');
  const [note] = get(journal);
  assert.deepEqual(note, { id: `journal:${friday}`, ...journal, date: friday, markdown: 'Second journal', version: 2,
    createdAt: created, updatedAt: updated, source: 'journal-note', sourceContext: null });
  for (const subject of [stock, market, industry]) assert.deepEqual(get(subject), []);
  db.exec('PRAGMA query_only=OFF');
  const edit = put(journal, { noteId: note.id, expectedVersion: 2, markdown: 'Human edit' });
  const typed = put(journal, { markdown: 'Separate scoped note' });
  assert.equal(edit.version, 3);
  assert.equal(edit.createdAt, created);
  assert.equal(edit.source, note.source);
  assert.deepEqual(get(journal), [edit, typed]);
  assert.deepEqual(get(journal, {}, { classification: 'provider' }), [edit]);
  assert.throws(() => put(journal, { noteId: note.id, expectedVersion: 2 }), { status: 409 });
  assert.deepEqual(db.prepare('SELECT version,markdown FROM journal_notes ORDER BY version').all().map((row) => [...Object.values(row)]),
    [[1, 'Original journal'], [2, 'Second journal'], [3, 'Human edit']]);
});

test('existing manual journal edits retain the original 40,000-character allowance', (t) => {
  const { db, get, put } = fixture(t);
  const markdown = 'A'.repeat(25_000);
  saveJournalNote(db, { date: friday, markdown }, { now: () => new Date(created) });
  const [legacy] = get(journal);
  const revised = markdown + '!';
  const edit = put(journal, { noteId: legacy.id, expectedVersion: 1, markdown: revised });
  assert.equal(edit.markdown, revised);
  assert.equal(edit.createdAt, created);
  assert.equal(edit.version, 2);
  assert.equal(db.prepare('SELECT markdown FROM journal_notes WHERE version=1').get().markdown, markdown);
  assert.throws(() => put(journal, { noteId: legacy.id, expectedVersion: 2, markdown: 'x'.repeat(40_001) }), /40,000/);
  assert.throws(() => put(journal, { markdown: revised }), /20,000/);
  assert.throws(() => put(industry, { markdown: revised }), /20,000/);
});

test('new notes respect source and listing bounds while older legacy annotations remain editable', (t) => {
  const { db, get, put } = fixture(t, { listing_date: thursday, delisting_date: friday });
  const beforeSource = '2025-05-27';
  const beforeListing = '2025-05-28';
  const cutoff = { date: monday, earliestDate: beforeListing };
  assert.throws(() => put(market, { date: beforeSource }, cutoff), { status: 400 });
  assert.throws(() => put(stock, { date: beforeListing }, cutoff), { status: 400 });
  assert.throws(() => put(stock, { date: monday }, cutoff), { status: 400 });
  assert.equal(put(stock, { date: thursday }, cutoff).date, thursday);
  const key = stockNoteKey(beforeSource);
  db.prepare("INSERT INTO workspace VALUES ('chartbook-note',?,1,?,?,?, ?,0)")
    .run(key, beforeSource, JSON.stringify({ securityId, date: beforeSource, markdown: 'Legacy observation' }), created, created);
  assert.equal(get(stock, {}, cutoff)[0].id, key);
  const edit = put(stock, { date: beforeSource, noteId: key, expectedVersion: 1, markdown: 'Revised legacy observation' }, cutoff);
  assert.equal(edit.createdAt, created);
  assert.equal(edit.version, 2);
});

test('notes reject invalid subjects, market sessions, versions, and text and obey the pinned source cutoff', (t) => {
  const { db, get, put, route } = fixture(t);
  assert.equal(route({ method: 'POST' }), null);
  assert.equal(route({ method: 'GET', item: 'unknown' }), null);
  for (const subject of [{ ...market, subjectType: 'sector' }, { ...market, subjectId: '' }, { ...market, subjectId: 'bad\nkey' }]) {
    assert.throws(() => get(subject), { status: 400 });
  }
  assert.throws(() => get({ ...stock, subjectId: 'not-a-security' }), { status: 404 });
  for (const date of ['2025-02-29', '2025-05-31', '2025-05-26', monday]) {
    assert.throws(() => put(stock, { date }), { status: 400 });
  }
  for (const markdown of [12, undefined, 'x'.repeat(20_001)]) assert.throws(() => put(stock, { markdown }), { status: 400 });
  for (const expectedVersion of [null, -1, 0.5, '0']) assert.throws(() => put(stock, { expectedVersion }), { status: 400 });
  assert.throws(() => get(stock, { from: '2025-02-30' }), { status: 400 });
  assert.throws(() => get(stock, { from: friday, to: thursday }), { status: 400 });
  assert.throws(() => get(stock, { date: '2025-05-31' }), { status: 400 });
  assert.throws(() => get(stock, { date: monday }), { status: 400 });
  assert.equal(db.prepare("SELECT count(*) AS count FROM workspace WHERE kind IN ('chartbook-note','research-note')").get().count, 0);
  put(stock, { date: monday }, { date: monday });
  put(stock, { date: thursday, markdown: 'x'.repeat(20_000) });
  assert.deepEqual(get(stock, { to: monday }).map(({ date }) => date), [thursday]);
  assert.deepEqual(get(stock, { from: monday, to: monday }), []);
  assert.deepEqual(get(stock, {}, { date: monday, latestDate: friday }).map(({ date }) => date), [thursday]);
});
