import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { expectedSessions } from '../backend/calendar.mjs';
import { importDataset, openDatabase } from '../backend/database.mjs';
import { createEngine } from '../backend/engine.mjs';
import { listJournalPrompts, saveJournalPrompt, saveJournalSettings } from '../backend/journal.mjs';
import { prepareMarketTiming, readPreparedMarketTiming } from '../backend/market-timing.mjs';
import { performJob } from '../backend/service.mjs';

const generated = { title: 'Daily review', markdown: '## Market timing\nObserved session signals.', sentiment: 'constructive',
  sentiment_score: 0.2, market_health: 6, risk_posture: 'selective', confidence: 6, factors: [] };

function journalFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'journal-timing-'));
  const db = openDatabase(join(dir, 'market.sqlite'));
  const dates = expectedSessions('2025-01-02', '2025-04-30');
  const selections = dates.slice(0, 69);
  const securities = [{ symbol: 'SPY', securityId: 'eodhd:SPY', type: 'etf', exchange: 'NYSEARCA', listingDate: dates[0], knownAt: dates[0] }];
  const price = (date, index) => ({ symbol: 'SPY', date, close: 100 + index, low: 99.5 + index, high: 101 + index,
    open: 100 + index, volume: 100_000, knownAt: date });
  importDataset(db, { provider: 'eodhd', securities, prices: selections.map(price) });
  const keyOverride = process.env.MARKET_JOURNAL_KEY_FILE;
  process.env.MARKET_JOURNAL_KEY_FILE = join(dir, '.journal-key');
  t.after(() => {
    if (keyOverride === undefined) delete process.env.MARKET_JOURNAL_KEY_FILE;
    else process.env.MARKET_JOURNAL_KEY_FILE = keyOverride;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  saveJournalSettings(db, { apiKey: 'sk-ant-test-placeholder-only', enabled: true });
  const prompt = saveJournalPrompt(db, { name: 'Personal market review', prompt: 'Use the selected market evidence to describe the session.', factors: [] });
  return { db, engine: createEngine(db), date: selections[63], latest: selections.at(-1), prompt };
}

test('a past journal receives exact prepared session evidence and keeps the existing prompt', async (t) => {
  const { db, engine, date, latest, prompt } = journalFixture(t);
  prepareMarketTiming(db, engine, engine.context({ date: latest }));
  const selected = engine.context({ date });
  const requests = [];
  const entry = await performJob(db, 'journal-generate', { asOfDate: date, context: { dataVersion: selected.dataVersion }, promptVersion: prompt.version }, {
    journalClient: async ({ system, user }) => { requests.push({ system, user }); return generated; },
  });
  const request = JSON.parse(requests[0].user);
  const prepared = readPreparedMarketTiming(db, selected, { limit: 1 });
  assert.equal(entry.asOfDate, date);
  assert.equal(entry.dataVersion, selected.dataVersion);
  assert.equal(request.market.sessionReview.state, 'ready');
  assert.equal(request.market.sessionReview.session.date, date);
  assert.equal(request.market.sessionReview.dataVersion, selected.dataVersion);
  assert.equal(request.market.sessionReview.basis, request.market.basis);
  assert.equal(request.market.sessionReview.modelVersion, prepared.modelVersion);
  assert.deepEqual(request.market.sessionReview.session, prepared.session);
  assert.equal(request.market.sessionReview.history, undefined);
  assert.equal(request.market.sessionReview.rules.references, undefined);
  assert.doesNotMatch(requests[0].user, /\bibd\b|minervini/i);
  assert.ok(requests[0].system.includes(prompt.prompt));
  assert.equal(listJournalPrompts(db).active.prompt, prompt.prompt);
});

test('journal has an explicit unavailable timing basis and still generates with missing preparation', async (t) => {
  const { db, date } = journalFixture(t);
  const reviews = [];
  const journalClient = async ({ user }) => { reviews.push(JSON.parse(user).market.sessionReview); return generated; };
  await performJob(db, 'journal-generate', { asOfDate: date }, { journalClient });
  await performJob(db, 'journal-generate', { asOfDate: date, context: { basis: 'known' } }, { journalClient });
  assert.equal(reviews[0].state, 'unprepared');
  assert.equal(reviews[0].session, null);
  assert.equal(reviews[1].state, 'unavailable');
  assert.equal(reviews[1].reason, 'unsupported-basis');
  assert.equal(reviews[1].basis, 'known');
  assert.equal(reviews[1].date, date);
});
