import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { importDataset, openDatabase } from '../backend/database.mjs';
import { createSecDownloader, ingestSecEnrichment, parseSecSicList, parseSecSubmissions, parseSecTickerExchange, secArtifactUrl } from '../backend/sec.mjs';

const capture = '2024-06-03T20:00:00.000Z';
const catalog = (...data) => ({ fields: ['cik', 'name', 'ticker', 'exchange'], data });
const accession = (cik, index) => `${String(cik).padStart(10, '0')}-24-${String(index).padStart(6, '0')}`;
const mixedRows = (...rows) => ({ id: '2024q2', capturedAt: capture, data: [
  'adsh\tcik\tname\tsic\tform\tfiled\taccepted\tformer\tchanged', ...rows.map((row) => row.join('\t')),
].join('\n') });
const labels = parseSecSicList(`<table><tr><td>3500</td><td>Office</td><td>Machinery &amp; Equipment</td></tr>
  <tr><td>3571</td><td>Office</td><td>ELECTRONIC COMPUTERS</td></tr><tr><td>6798</td><td>Office</td><td>REITs</td></tr></table>`);

const security = (id, ticker, name, other = {}) => ({ securityId: id, symbol: ticker, name, exchange: 'NASDAQ',
  type: 'common', status: 'active', listingDate: '2018-01-02', knownAt: '2018-01-02', ...other });

function warehouse(t, ...securities) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  importDataset(db, { provider: 'fixture', catalogDate: '2018-01-02', securities });
  return db;
}

function facts(cik, name, entries) {
  return { id: 'companyfacts', capturedAt: capture, data: { cik, entityName: name, facts: { dei: {
    EntityCommonStockSharesOutstanding: { units: { shares: entries } },
    EntityPublicFloat: { units: { USD: [{ end: '2024-05-01', val: 1_000_000 }] } },
  } } } };
}

test('parsers honor named SEC catalog fields, official label cells and filing session availability', () => {
  const input = { fields: ['ticker', 'exchange', 'cik', 'name'], data: [['BRK.B', 'NYSE', 43, 'Berkshire Hathaway Inc']] };
  assert.deepEqual(parseSecTickerExchange(input), [{ cik: '0000000043', symbol: 'BRK-B', exchange: 'NYSE', name: 'Berkshire Hathaway Inc' }]);
  assert.equal(labels.get('3500'), 'Machinery & Equipment');
  const report = parseSecSubmissions(mixedRows(
    [accession(1, 1), 1, 'Sunrise INC', '3571', '10-Q', '20240524', '2024-05-24 12:00:00.0'],
    [accession(1, 2), 1, 'Sunrise INC', '3571', '10-Q', '20240524', '2024-05-24 16:05:00.0'],
    ['bad accession', 1, 'Sunrise INC', '3571', '10-Q', '20240524', '2024-05-24 12:00:00.0'],
  ).data);
  assert.equal(report.invalid, 1);
  assert.deepEqual(report.rows.map(({ knownAt }) => knownAt), ['2024-05-24', '2024-05-28']);
  assert.throws(() => parseSecSubmissions('ticker\tvalue'), /sub.txt columns/);
});

test('SEC filing enrichment preserves evidence, classification clocks and idempotence', (t) => {
  const db = warehouse(t, security('issue:one', 'EMB', 'Ember Technologies Inc Class A'));
  const filings = mixedRows(
    [accession(41, 1), 41, 'EMBER TECHNOLOGIES CORP /DE/', '3571', '10-Q', '20240524', '2024-05-24 16:05:00.0'],
    [accession(41, 2), 41, 'EMBER TECHNOLOGIES CORP', '6798', '10-K', '20240530', '2024-05-30 11:05:00.0'],
  );
  const input = { catalog: catalog([41, 'Ember Technologies, Inc.', 'EMB', 'Nasdaq']), submissions: [filings], labels, capturedAt: capture };
  const dry = ingestSecEnrichment(db, { ...input, dryRun: true });
  assert.equal(dry.records.classifications, 2);
  assert.equal(dry.currentReitCandidates, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM classifications').get().n, 0);
  const result = ingestSecEnrichment(db, input);
  const rows = db.prepare('SELECT security_id,system,effective_from,known_at,source,industry,subindustry FROM classifications ORDER BY effective_from').all();
  assert.equal(rows[0].security_id, 'issue:one');
  assert.equal(rows[0].system, 'sec-sic');
  assert.equal(rows[0].source, 'sec');
  assert.equal(rows[0].known_at, '2024-05-28');
  assert.equal(rows[0].effective_from, '2024-05-28');
  assert.equal(rows[0].industry, 'SIC 35 · Machinery & Equipment');
  assert.equal(rows[0].subindustry, 'SIC 3571 · ELECTRONIC COMPUTERS');
  assert.equal(db.prepare('SELECT type FROM securities').get().type, 'common');
  const audit = JSON.parse(db.prepare('SELECT evidence FROM sec_enrichment_evidence WHERE accession=?').get(accession(41, 1)).evidence);
  assert.equal(audit.source.capturedAt, capture);
  assert.equal(audit.filed, '2024-05-24');
  assert.equal(audit.acceptedAt, '2024-05-24 16:05:00.0');
  assert.equal(ingestSecEnrichment(db, input).duplicate, true);
  assert.equal(ingestSecEnrichment(db, input).dataVersion, result.dataVersion);
  assert.equal(db.prepare('SELECT count(*) AS n FROM classifications').get().n, 2);
});

test('same-symbol reuse, historical identity dates and issuer mismatches cannot attach facts to the current issue', (t) => {
  const db = warehouse(t,
    security('issue:old', 'ABC', 'Old Name Corporation', { listingDate: '2012-01-01', delistingDate: '2020-01-01', status: 'delisted' }),
    security('issue:new', 'ABC', 'Current Name Inc', { listingDate: '2023-01-03' }),
    security('issue:other', 'XYZ', 'Different Legal Entity Inc'));
  const report = ingestSecEnrichment(db, {
    catalog: catalog([7, 'Current Name Inc', 'ABC', 'Nasdaq'], [8, 'Unrelated Registrant Corp', 'XYZ', 'Nasdaq']), capturedAt: capture,
    submissions: [mixedRows(
      [accession(7, 1), 7, 'Current Name Inc', '3571', '10-Q', '20210104', '2021-01-04 11:05:00.0'],
      [accession(7, 2), 7, 'Old Name Corp', '3571', '10-Q', '20240523', '2024-05-23 11:05:00.0'],
      [accession(7, 3), 7, 'Current Name Corp', '3571', '10-Q', '20240524', '2024-05-24 11:05:00.0'],
    )],
  });
  assert.equal(report.records.classifications, 1);
  assert.equal(report.identity.quarantine.nameMismatch, 1);
  assert.equal(report.quality.oldOrAmbiguousIdentity, 1);
  assert.equal(report.quality.nameMismatch, 1);
  assert.equal(db.prepare('SELECT security_id FROM classifications').get().security_id, 'issue:new');
});

test('a dated SEC former name links historical filings while same-day SIC conflicts remain quarantined', (t) => {
  const db = warehouse(t, security('issue:one', 'EMB', 'Ember Technologies Inc'));
  const report = ingestSecEnrichment(db, { catalog: catalog([41, 'Ember Technologies, Inc.', 'EMB', 'Nasdaq']), labels, capturedAt: capture,
    submissions: [mixedRows(
      [accession(41, 1), 41, 'Ember Hardware Inc', '3571', '10-Q', '20240520', '2024-05-20 11:05:00.0'],
      [accession(41, 2), 41, 'Ember Technologies Inc', '3571', '10-Q', '20240523', '2024-05-23 11:05:00.0', 'Ember Hardware Inc', '20240522'],
      [accession(41, 3), 41, 'Ember Technologies Inc', '3571', '10-Q', '20240524', '2024-05-24 11:05:00.0'],
      [accession(41, 4), 41, 'Ember Technologies Inc', '6798', '10-Q', '20240524', '2024-05-24 12:05:00.0'],
    )],
  });
  assert.equal(report.quality.conflict, 1);
  assert.deepEqual(db.prepare('SELECT effective_from FROM classifications ORDER BY effective_from').all().map((row) => row.effective_from),
    ['2024-05-20', '2024-05-23']);
});

test('only unambiguous common share counts enter fundamentals and USD public float remains unset', (t) => {
  const db = warehouse(t, security('issue:one', 'EMB', 'Ember Technologies Inc'), security('issue:multiple', 'RCA', 'RCA Industries Inc'));
  const disclosed = { end: '2024-05-01', filed: '2024-05-24', val: 1500, form: '10-Q', accn: accession(41, 1) };
  const report = ingestSecEnrichment(db, { catalog: catalog([41, 'Ember Technologies Inc', 'EMB', 'Nasdaq'],
    [51, 'RCA Industries Inc', 'RCA', 'Nasdaq'], [51, 'RCA Industries Inc', 'RCB', 'Nasdaq']), capturedAt: capture,
    companyFacts: [facts(41, 'Ember Technologies Inc', [disclosed, { ...disclosed, val: 1.5 }]), facts(51, 'RCA Industries Inc', [disclosed])],
  });
  assert.equal(report.records.shares, 1);
  assert.equal(report.records.float, 0);
  assert.equal(report.quality.sharesRestricted, 1);
  const row = db.prepare('SELECT effective_date,known_at,source,float,shares FROM fundamentals').get();
  assert.equal(row.effective_date, '2024-05-01');
  assert.equal(row.known_at, '2024-05-28');
  assert.equal(row.source, 'sec');
  assert.equal(row.float, null);
  assert.equal(row.shares, 1500);
});

test('download resumes completed files, paces retries and stops a run on HTTP 403', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'market-intelligence-sec-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statuses = [429, 200, 403];
  const starts = [];
  let time = 0;
  const download = createSecDownloader({ userAgent: 'Market Intelligence contact@example.test', clock: () => time,
    sleep: async (milliseconds) => { time += milliseconds; }, fetcher: async (_url, init) => {
      const status = statuses.shift();
      starts.push(time);
      assert.equal(init.headers['User-Agent'], 'Market Intelligence contact@example.test');
      return new Response(status === 200 ? 'realistic fixture body' : 'busy', { status, headers: status === 429 ? { 'retry-after': '1' } : {} });
    },
  });
  const filename = join(dir, 'catalog.json');
  const result = await download(secArtifactUrl('catalog'), filename);
  assert.equal(result.skipped, false);
  assert.equal(await readFile(filename, 'utf8'), 'realistic fixture body');
  assert.equal((await download(secArtifactUrl('catalog'), filename)).skipped, true);
  assert.deepEqual(starts, [0, 1000]);
  await assert.rejects(download(secArtifactUrl('sic'), join(dir, 'sic.html')), { status: 403 });
  await assert.rejects(download(secArtifactUrl('quarter', '2024q2'), join(dir, 'quarter.zip')), { status: 403 });
  assert.equal(starts[2], 1167);
  assert.equal(starts.length, 3);
  assert.deepEqual(await readdir(dir), ['catalog.json']);
  await assert.rejects(download('https://other.example/evil', join(dir, 'evil.json')), /official SEC artifacts/);
});
