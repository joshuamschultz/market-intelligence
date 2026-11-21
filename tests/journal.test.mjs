import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../backend/database.mjs';
import {
  createAnthropicJournalClient, DEFAULT_JOURNAL_MODEL, generateJournal, getJournalDate, getJournalSettings, journalDueDate,
  journalFactorSelection, journalFactorSeries, journalNoteDates, listJournalEntries, listJournalPrompts, runJournalBacktest, saveJournalNote, saveJournalPrompt, saveJournalSettings,
} from '../backend/journal.mjs';

const key = 'sk-ant-test-placeholder-only';
const friday = '2024-05-24';
const tuesday = '2024-05-28';
const now = () => new Date('2024-05-25T01:00:00.000Z');
const market = (date = friday) => ({ date, universe: { id: 'us-core', version: 1 }, benchmark: 'SPY',
  basis: 'known', dataVersion: 1, calculationVersion: 'fixture-v1', coverage: { state: 'complete' }, breadth: { above_50d: { value: 62 } } });
const output = (extra = {}) => ({ title: 'Daily review', markdown: '## Participation\nBreadth broadened.', sentiment: 'constructive',
  sentiment_score: 0.3, market_health: 6.2, risk_posture: 'selective', confidence: 7, factors: [], ...extra });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'market-journal-'));
  const keyFile = join(directory, '.journal-key');
  const db = openDatabase(':memory:');
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  return { db, keyFile };
}

test('journal settings store a masked key encrypted with a private vault and support clearing it', async (t) => {
  const { db, keyFile } = await fixture(t);
  assert.equal(getJournalSettings(db).configured, false);
  const saved = saveJournalSettings(db, { apiKey: key, schedule: { enabled: true, after: '21:15' } }, { keyFile, now });
  assert.equal(saved.configured, true);
  assert.equal(saved.model, DEFAULT_JOURNAL_MODEL);
  assert.equal(saved.schedule.after, '21:15');
  assert.equal(saved.schedule.timezone, 'America/New_York');
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(key));
  assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
  assert.equal((await readFile(keyFile)).length, 32);
  const encrypted = db.prepare('SELECT encrypted_key FROM journal_settings').get().encrypted_key;
  assert.equal(JSON.parse(encrypted).version, 1);
  assert.doesNotMatch(encrypted, new RegExp(key));
  assert.equal(saveJournalSettings(db, { apiKey: null }, { keyFile, now }).configured, false);
  assert.throws(() => saveJournalSettings(db, { model: 'https://fake.invalid' }, { keyFile }), /Claude API model/);
});

test('prompt and human-note revisions are independent and versioned', async (t) => {
  const { db } = await fixture(t);
  const prompt = saveJournalPrompt(db, { name: 'Prepare', prompt: '## Investigate\nUse breadth and proprietary factors.', factors: [
    { key: 'risk_bias', label: 'Risk bias', minimum: -2, maximum: 2 },
  ] }, { now });
  assert.equal(prompt.version, 2);
  assert.deepEqual(listJournalPrompts(db).versions.map(({ version }) => version), [2, 1]);
  assert.throws(() => saveJournalPrompt(db, { prompt: 'x', factors: [prompt.factors[0], prompt.factors[0]] }), /unique/);
  assert.equal(saveJournalNote(db, { asOfDate: friday, markdown: 'First note' }, { now }).version, 1);
  assert.equal(saveJournalNote(db, { asOfDate: friday, markdown: 'Revised' }, { now }).version, 2);
  const detail = getJournalDate(db, friday);
  assert.equal(detail.notes.markdown, 'Revised');
  assert.deepEqual(detail.noteVersions.map(({ version }) => version), [2, 1]);
  assert.deepEqual(detail.entries, []);
  assert.deepEqual(journalNoteDates(db), [friday]);
});

test('official Messages request uses structured outputs, keeps notes private by default, and persists immutable revisions', async (t) => {
  const { db, keyFile } = await fixture(t);
  saveJournalSettings(db, { apiKey: key, enabled: true }, { keyFile, now });
  saveJournalNote(db, { asOfDate: friday, markdown: 'Personal views and private text' }, { now });
  const requests = [];
  const client = createAnthropicJournalClient({ fetcher: async (url, init) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init.headers['x-api-key'], key);
    assert.equal(init.headers['anthropic-version'], '2023-06-01');
    const body = JSON.parse(init.body);
    requests.push(body);
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.equal(body.output_config.format.schema.additionalProperties, false);
    assert.equal(body.output_config.format.schema.properties.market_health.maximum, undefined);
    assert.equal(body.tools, undefined);
    assert.doesNotMatch(init.body, new RegExp(key));
    return new Response(JSON.stringify({ id: 'msg_test', model: DEFAULT_JOURNAL_MODEL,
      content: [{ type: 'thinking', thinking: 'fixture' }, { type: 'text', text: JSON.stringify(output()) }], stop_reason: 'end_turn' }));
  } });
  const input = { asOfDate: friday, context: { ...market(), apiKey: key }, keyFile, client, now };
  const first = await generateJournal(db, input);
  assert.equal(first.revision, 1);
  assert.equal(first.dataVersion, 1);
  assert.equal(first.tradableDate, tuesday);
  assert.equal(first.retrospective, false);
  assert.equal(first.availableAt, now().toISOString());
  assert.equal(first.noteVersion, null);
  assert.equal(JSON.parse(requests[0].messages[0].content).humanNotes, undefined);
  assert.equal((await generateJournal(db, input)).id, first.id);
  assert.equal(requests.length, 1);
  const second = await generateJournal(db, { ...input, includeNotes: true });
  assert.equal(second.revision, 2);
  assert.equal(second.noteVersion, 1);
  assert.equal(JSON.parse(requests[1].messages[0].content).humanNotes, 'Personal views and private text');
  assert.deepEqual(getJournalDate(db, friday).entries.map(({ revision }) => revision), [2, 1]);
  assert.equal(journalDueDate(db, { publishedDate: friday, now: now() }), null);
});

test('invalid output and malformed custom factor values never publish a journal', async (t) => {
  const { db, keyFile } = await fixture(t);
  saveJournalSettings(db, { apiKey: key }, { keyFile, now });
  saveJournalPrompt(db, { prompt: 'Review market breadth.', factors: [{ key: 'thrust', label: 'Thrust', minimum: 0, maximum: 4 }] }, { now });
  const input = { asOfDate: friday, context: market(), keyFile, now };
  await assert.rejects(generateJournal(db, { ...input, client: async () => output({ market_health: 11 }) }), /required output schema/);
  await assert.rejects(generateJournal(db, { ...input, client: async () => output({ factors: [{ key: 'thrust', label: 'Thrust', value: 5 }] }) }), /out-of-range/);
  assert.deepEqual(listJournalEntries(db), []);
  const valid = await generateJournal(db, { ...input, client: async () => output({ factors: [{ key: 'thrust', label: 'Alternate label', value: 3 }] }) });
  assert.deepEqual(valid.output.factors, [{ key: 'thrust', label: 'Thrust', value: 3 }]);
});

test('concurrent generation claims avoid duplicate provider requests and errors release the claim', async (t) => {
  const { db, keyFile } = await fixture(t);
  saveJournalSettings(db, { apiKey: key }, { keyFile, now });
  let finish;
  const client = () => new Promise((resolve) => { finish = resolve; });
  const options = { asOfDate: friday, context: market(), keyFile, client, now };
  const ongoing = generateJournal(db, options);
  await assert.rejects(generateJournal(db, options), { status: 409 });
  finish(output());
  const entry = await ongoing;
  assert.equal((await generateJournal(db, options)).id, entry.id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM journal_claims').get().n, 0);
});

test('journal generation keys cover canonical inputs, source versions and analysis provenance while equivalent retries deduplicate', async (t) => {
  const { db, keyFile } = await fixture(t);
  saveJournalSettings(db, { apiKey: key }, { keyFile, now });
  let calls = 0;
  const client = async () => { calls++; return output(); };
  const initial = { ...market(), model: { id: 'rs-a', version: 1 }, classificationSystem: 'sec-sic',
    referenceMode: 'asof', referenceDate: friday };
  const generate = (context, rest = {}) => generateJournal(db, { asOfDate: friday, context, keyFile, now, client, ...rest });
  const first = await generate(initial);
  const reordered = Object.fromEntries(Object.entries(initial).reverse());
  assert.equal((await generate(reordered)).id, first.id);
  const updates = [
    { ...initial, dataVersion: 2 },
    { ...initial, calculationVersion: 'fixture-v2' },
    { ...initial, model: { id: 'rs-a', version: 2 } },
    { ...initial, classificationSystem: 'nasdaq' },
    { ...initial, referenceMode: 'latest' },
    { ...initial, referenceDate: '2024-05-23' },
    { ...initial, breadth: { above_50d: { value: 42 } } },
  ];
  for (const [index, context] of updates.entries()) {
    const edition = await generate(context);
    assert.notEqual(edition.inputHash, first.inputHash);
    assert.equal(edition.revision, index + 2);
    assert.equal((await generate(context)).id, edition.id);
  }
  assert.equal(calls, 8);
  const forced = await generate(initial, { force: true });
  assert.equal(forced.revision, 9);
  assert.equal(forced.inputHash, first.inputHash);
  assert.equal((await generate(initial)).id, forced.id);
});

test('factor studies use next tradable availability, preserve the original live revision and exclude reconstructions', async (t) => {
  const { db, keyFile } = await fixture(t);
  saveJournalSettings(db, { apiKey: key, enabled: true }, { keyFile, now });
  assert.equal(journalDueDate(db, { publishedDate: friday, now: now() }), friday);
  const old = '2024-05-23';
  const create = (date, score, options = {}) => generateJournal(db, { asOfDate: date, context: market(date), keyFile, now,
    client: async () => output({ market_health: score }), ...options });
  const live = await create(friday, 6.2);
  const revised = await create(friday, 2, { force: true });
  const historical = await create(old, 10);
  assert.equal(historical.retrospective, true);
  assert.deepEqual(journalFactorSeries(db).map(({ marketHealth }) => marketHealth), [6.2]);
  const sessions = [old, friday, tuesday, '2024-05-29', '2024-05-30'];
  const benchmarks = { SPY: sessions.map((date, index) => ({ date, close: [100, 105, 110, 121, 123][index] })) };
  const study = runJournalBacktest(db, { sessions, benchmarks, metric: 'market_health', op: 'gt', value: 5, horizons: [1] });
  assert.deepEqual(study.events.map(({ date, journalId }) => [date, journalId]), [[tuesday, live.id]]);
  assert.notEqual(study.events[0].journalId, revised.id);
  assert.equal(study.events[0].journalAsOfDate, friday);
  assert.ok(Math.abs(study.results[0].benchmarks.SPY.mean - 10) < 1e-9);
  const asBefore = runJournalBacktest(db, { sessions, benchmarks, metric: 'market_health', op: 'gt', value: 5, horizons: [1], asOf: friday });
  assert.equal(asBefore.eventCount, 0);
  const corrected = { SPY: benchmarks.SPY.map((bar) => ({ ...bar, knownAt: '2024-05-30' })) };
  const known = runJournalBacktest(db, { sessions, benchmarks: corrected, metric: 'market_health', op: 'gt', value: 5, horizons: [1] });
  const reconstructed = runJournalBacktest(db, { sessions, benchmarks: corrected, metric: 'market_health', op: 'gt', value: 5,
    horizons: [1], priceBasis: 'reconstructed' });
  assert.equal(known.results[0].benchmarks.SPY.counts.missingEntry, 1);
  assert.ok(Math.abs(reconstructed.results[0].benchmarks.SPY.mean - 10) < 1e-9);
  assert.deepEqual(reconstructed.events, known.events);
});

test('factor charts and studies use one explicit recipe and prefer the earliest live revision over later retrospectives', async (t) => {
  const { db, keyFile } = await fixture(t);
  saveJournalSettings(db, { apiKey: key, enabled: true }, { keyFile, now });
  const primary = { ...market(), model: { id: 'rs-basic', version: 1 }, classificationSystem: 'sec-sic', referenceMode: 'asof' };
  const alternate = { ...primary, universe: { id: 'nyse', version: 2 }, model: { id: 'rs-special', version: 4 },
    classificationSystem: 'nasdaq', referenceMode: 'latest' };
  const create = (context, score, options = {}) => generateJournal(db, { asOfDate: friday, context, keyFile, now,
    client: async () => output({ market_health: score }), ...options });
  const live = await create(primary, 6.2);
  await create(primary, 2.1, { force: true });
  await create(primary, 9.5, { retrospective: true });
  const other = await create(alternate, 8.1);
  const tomorrow = { ...primary, date: tuesday };
  const later = () => new Date('2024-05-30T01:00:00.000Z');
  const nextReal = () => new Date('2024-05-29T01:00:00.000Z');
  const retro = await generateJournal(db, { asOfDate: tuesday, context: tomorrow, keyFile, now: later,
    client: async () => output({ market_health: 9.8 }) });
  const next = await generateJournal(db, { asOfDate: tuesday, context: tomorrow, keyFile, now: nextReal,
    client: async () => output({ market_health: 5.7 }) });
  assert.equal(retro.retrospective, true);
  assert.equal(next.retrospective, false);

  const sessions = [friday, tuesday, '2024-05-29', '2024-05-30', '2024-05-31'];
  const benchmarks = { SPY: sessions.map((date, index) => ({ date, close: 100 + index })) };
  const options = { includeRetrospective: true, universe: 'us-core', universeVersion: 1, rsModel: 'rs-basic',
    rsModelVersion: 1, claudeModel: DEFAULT_JOURNAL_MODEL, promptVersion: 1, basis: 'known',
    benchmark: 'SPY', classification: 'sec-sic', reference: 'asof' };
  const chart = journalFactorSelection(db, options);
  const study = runJournalBacktest(db, { ...options, sessions, benchmarks, metric: 'market_health', op: 'gt', value: 5, horizons: [1] });
  assert.equal(chart.recipe.key, live.recipeKey);
  assert.equal(study.recipe.key, live.recipeKey);
  assert.deepEqual(chart.rows.map(({ id }) => id), [live.id, next.id]);
  assert.deepEqual(study.events.map(({ journalId }) => journalId), [live.id, next.id]);
  assert.equal(chart.counts.revisionsExcluded, 3);
  assert.equal(chart.counts.retrospective, 0);
  assert.deepEqual(chart.counts, study.selectionCounts);
  assert.deepEqual(journalFactorSeries(db, { recipeKey: other.recipeKey }).map(({ id }) => id), [other.id]);
  assert.equal(journalDueDate(db, { publishedDate: friday, now: now(), scope: options }), null);
  assert.equal(journalDueDate(db, { publishedDate: friday, now: now(), scope: { ...options, rsModelVersion: 3 } }), friday);
});

test('stored notes containing the credential cannot accidentally place it in a model request', async (t) => {
  const { db, keyFile } = await fixture(t);
  saveJournalSettings(db, { apiKey: key }, { keyFile, now });
  saveJournalNote(db, { asOfDate: friday, markdown: key }, { now });
  let requests = 0;
  await assert.rejects(generateJournal(db, { asOfDate: friday, context: market(), includeNotes: true, keyFile, now,
    client: async () => { requests++; return output(); } }), /Remove credential text/);
  assert.equal(requests, 0);
  assert.equal(listJournalEntries(db).length, 0);
});
