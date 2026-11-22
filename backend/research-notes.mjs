import { createHash } from 'node:crypto';
import { isMarketSession } from './calendar.mjs';
import { getWorkspace, isoDate, marketDay, storeWorkspace } from './database.mjs';

const stockKind = 'chartbook-note';
const scopedKind = 'research-note';
const maximumLength = 20_000;
const journalMaximumLength = 40_000;
const subjectTypes = new Set(['stock', 'market', 'industry']);
const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 180 &&
  id.trim() === id && !/[\u0000-\u001f\u007f]/u.test(id);
const validSession = (date) => isoDate(date) && date >= '1900-01-01' && isMarketSession(date);
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isJournal = ({ type, id }) => type === 'market' && id === 'journal';
const journalId = (date) => `journal:${date}`;

function contextFor(point) {
  return {
    date: point.date, dataVersion: point.dataVersion, basis: point.basis, classification: point.classification,
    universe: point.universe?.id, universeVersion: point.universe?.version,
  };
}

function scopeFor(subject) {
  const { universe, universeVersion, basis, classification } = subject.context;
  return digest([universe, universeVersion, basis, classification]);
}

function noteId(subject, date) {
  return subject.type === 'stock' ? digest([subject.id, date]) : digest([subject.type, subject.id, scopeFor(subject), date]);
}

function workspaceNote(subject, date, row) {
  return {
    id: row?.id ?? noteId(subject, date), subjectType: subject.type, subjectId: subject.id, date,
    markdown: row?.definition.markdown ?? '', createdAt: row?.created_at ?? null, updatedAt: row?.updated_at ?? null,
    version: row?.version ?? 0, source: subject.type === 'stock' ? stockKind : scopedKind,
    sourceContext: row?.definition.sourceContext ?? null,
  };
}

function workspaceNotes(db, subject, from, to) {
  const stock = subject.type === 'stock';
  const filter = stock
    ? "json_extract(a.definition,'$.securityId')=?"
    : "json_extract(a.definition,'$.subjectType')=? AND json_extract(a.definition,'$.subjectId')=? AND json_extract(a.definition,'$.scope')=?";
  const identity = stock ? [subject.id] : [subject.type, subject.id, scopeFor(subject)];
  return db.prepare(`SELECT a.* FROM workspace a
    WHERE a.kind=? AND a.name BETWEEN ? AND ? AND a.deleted=0 AND ${filter}
      AND a.version=(SELECT max(b.version) FROM workspace b WHERE b.kind=a.kind AND b.id=a.id)
    ORDER BY a.name, a.created_at, a.id`)
    .all(stock ? stockKind : scopedKind, from, to, ...identity)
    .map((row) => workspaceNote(subject, row.name, { ...row, definition: JSON.parse(row.definition) }));
}

function hasJournalNotes(db) {
  return Boolean(db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='journal_notes'").get());
}

function journalNotes(db, subject, from, to) {
  if (!hasJournalNotes(db)) return [];
  return db.prepare(`SELECT a.*, (SELECT b.updated_at FROM journal_notes b WHERE b.as_of_date=a.as_of_date
      ORDER BY b.version LIMIT 1) AS created_at FROM journal_notes a
    WHERE a.as_of_date BETWEEN ? AND ?
      AND a.version=(SELECT max(b.version) FROM journal_notes b WHERE b.as_of_date=a.as_of_date)
    ORDER BY a.as_of_date`).all(from, to).map((row) => ({
    id: journalId(row.as_of_date), subjectType: subject.type, subjectId: subject.id, date: row.as_of_date,
    markdown: row.markdown, createdAt: row.created_at, updatedAt: row.updated_at, version: row.version,
    source: 'journal-note', sourceContext: null,
  }));
}

function checkVersion(previous, expected) {
  if ((previous?.version ?? 0) !== expected) {
    throw error('This note changed since it was opened. Review the latest version before saving.', 409);
  }
}

function saveWorkspaceNote(db, subject, date, markdown, expectedVersion, { from, to }) {
  const stock = subject.type === 'stock';
  const kind = stock ? stockKind : scopedKind;
  const id = noteId(subject, date);
  const previous = getWorkspace(db, kind, id);
  checkVersion(previous, expectedVersion);
  if (!previous && (date < from || date > to)) {
    throw error('A new note needs a trading session within the available source and listing history');
  }
  if (markdown === (previous?.definition.markdown ?? '')) return workspaceNote(subject, date, previous);
  const identity = stock ? { securityId: subject.id } : { subjectType: subject.type, subjectId: subject.id, scope: scopeFor(subject) };
  const definition = { ...identity, date, markdown,
    sourceContext: previous ? previous.definition.sourceContext ?? null : subject.context };
  return workspaceNote(subject, date, storeWorkspace(db, kind, { name: date, definition }, id));
}

function saveLegacyJournalNote(db, subject, date, markdown, expectedVersion) {
  const [previous] = journalNotes(db, subject, date, date);
  if (!previous) throw error('Market journal note not found', 404);
  checkVersion(previous, expectedVersion);
  if (markdown === previous.markdown) return previous;
  const updatedAt = new Date().toISOString();
  const version = previous.version + 1;
  db.prepare('INSERT INTO journal_notes(as_of_date,version,markdown,updated_at) VALUES (?,?,?,?)')
    .run(date, version, markdown, updatedAt);
  return { ...previous, markdown, updatedAt, version };
}

export function createResearchNotes(db, engine) {
  function route({ method, item, query = {}, body = {}, resolvePoint, resolveIdentity }) {
    if (item || !['GET', 'PUT'].includes(method)) return null;
    const input = method === 'GET' ? query : body ?? {};
    const { subjectType: type, subjectId: requestedId } = input;
    if (!subjectTypes.has(type) || !validId(requestedId)) throw error('Choose a valid stock, market, or industry note subject');
    if (query.date != null && !validSession(query.date)) throw error('The pinned session must be a valid market session');
    const point = resolvePoint ? resolvePoint() : engine.context(query);
    if (!validSession(point.date) || query.date != null && query.date !== point.date) {
      throw error('The pinned market session is unavailable');
    }
    const cutoff = [point.date, point.latestDate, marketDay()].filter(isoDate).sort()[0];
    if (type !== 'stock' && (!validId(point.universe?.id) || !validId(point.basis) || !validId(point.classification))) {
      throw error('The selected market or industry context is unavailable');
    }
    let id = requestedId;
    let identity;
    if (type === 'stock') {
      identity = resolveIdentity ? resolveIdentity(point, requestedId) : engine.findSecurity(point, requestedId);
      id = identity?.securityId ?? identity?.id;
      if (!validId(id)) throw error('Security is unavailable at the selected session and revision', 404);
    }
    const subject = { type, id, context: contextFor(point) };
    if (method === 'GET') {
      const { from = '1900-01-01', to = cutoff } = query;
      if (!isoDate(from) || !isoDate(to) || from > to) throw error('Research note date range is invalid');
      const end = to < cutoff ? to : cutoff;
      const notes = workspaceNotes(db, subject, from, end);
      if (isJournal(subject)) notes.push(...journalNotes(db, subject, from, end));
      notes.sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      return { data: { subject, notes } };
    }

    const { date, markdown, expectedVersion, noteId: target } = input;
    if (!validSession(date) || date > cutoff) throw error('The note date must be a market session within the pinned source history');
    const journal = isJournal(subject) && target === journalId(date);
    if (target != null && !journal && target !== noteId(subject, date)) throw error('The note does not match this subject and date', 404);
    const limit = journal ? journalMaximumLength : maximumLength;
    if (typeof markdown !== 'string' || markdown.length > limit) {
      throw error(`Use up to ${journal ? '40,000 characters for a market journal note' : '20,000 characters for a research note'}`);
    }
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw error('Provide a valid expected note version');

    const from = ['1900-01-01', point.earliestDate, identity?.listing_date].filter(isoDate).sort().at(-1);
    const to = [cutoff, identity?.delisting_date].filter(isoDate).sort()[0];
    // The version check and append share a write lock with other workspace and journal writers.
    db.exec('BEGIN IMMEDIATE');
    try {
      const note = journal ? saveLegacyJournalNote(db, subject, date, markdown, expectedVersion)
        : saveWorkspaceNote(db, subject, date, markdown, expectedVersion, { from, to });
      db.exec('COMMIT');
      return { data: note };
    } catch (problem) {
      db.exec('ROLLBACK');
      throw problem;
    }
  }
  return { route };
}
