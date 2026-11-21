import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { dataVersion, importDataset, isoDate, openDatabase } from '../backend/database.mjs';
import { shiftDate } from '../backend/calendar.mjs';

export const CORRECTION_SOURCE = 'sec-filing-correction';

export function verifiedCorrectionSymbols(db) {
  return new Set(db.prepare(`SELECT DISTINCT symbol FROM identifiers i
    WHERE EXISTS (SELECT 1 FROM reference_revisions r WHERE r.security_id=i.security_id AND r.source=?)`)
    .all(CORRECTION_SOURCE).map(({ symbol }) => symbol));
}

function recordArchiveBoundary(db, run) {
  const detail = JSON.parse(run.detail);
  const proof = detail.warnings.find((warning) => warning.startsWith('Earliest affected warehouse session: '));
  const boundary = proof?.split(': ').at(-1);
  if (!isoDate(boundary)) throw new Error('The correction has no verified historical boundary');
  if (detail.archiveImpactFrom !== boundary) {
    db.prepare("UPDATE ingestion_runs SET detail=json_set(detail,'$.archiveImpactFrom',?) WHERE id=?").run(boundary, run.id);
  }
  return boundary;
}

function verifiedSource(url) {
  return /^https:\/\/(?:www\.sec\.gov\/Archives\/edgar\/data\/|www\.nasdaqtrader\.com\/|www\.globenewswire\.com\/news-release\/)/.test(url || '');
}

function applySourceFacts(db, input, dryRun) {
  const { id, reviewedAt, securityId, venue, overrides = [], corporateActions = [], evidence = [] } = input;
  if (!/^[a-z0-9-]+$/.test(id) || !isoDate(reviewedAt) || !evidence.length
      || evidence.some(({ url, fact }) => !verifiedSource(url) || !fact) || !overrides.every((row) => verifiedSource(row.evidenceUrl))) {
    throw new Error('Supply reviewed issuer or exchange evidence');
  }
  const dataset = `verified-correction:${id}`;
  const manifestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const existing = db.prepare("SELECT id,version,detail FROM ingestion_runs WHERE provider=? AND dataset=? AND status='complete'").get(CORRECTION_SOURCE, dataset);
  if (existing) {
    if (!JSON.parse(existing.detail).warnings.includes(`Correction manifest SHA256 ${manifestHash}`)) throw new Error('A different correction already uses this ID');
    return { id, dataset, version: existing.version, earliestAffectedDate: dryRun ? JSON.parse(existing.detail).archiveImpactFrom
      : recordArchiveBoundary(db, existing), duplicate: true, dryRun };
  }
  const stock = db.prepare("SELECT * FROM securities WHERE id=? AND provider='eodhd'").get(securityId);
  if (!stock) throw new Error('The reviewed security is absent from the warehouse');
  const securities = [];
  const affected = overrides.filter((row) => row.kind !== 'notice').map((row) => row.from);
  if (venue) {
    const old = db.prepare('SELECT * FROM identifiers WHERE security_id=? AND symbol=? AND exchange=? AND valid_to IS NULL')
      .all(securityId, venue.expectedSymbol, venue.exchange);
    if (old.length !== 1 || !isoDate(venue.through) || venue.through < old[0].valid_from || venue.through >= reviewedAt
      || venue.before && (!isoDate(venue.before.from) || venue.before.from !== old[0].valid_from || venue.next)
      || venue.next && (!isoDate(venue.next.from) || venue.next.from <= venue.through)
      || venue.terminal && (venue.next || venue.before)) throw new Error('The reviewed alias interval no longer matches the warehouse');
    const original = old[0];
    const declaration = { securityId, symbol: original.symbol, knownAt: reviewedAt, identifiers: [] };
    if (venue.before) {
      // The original symbol was applied to the entire history by the feed. Retire its synthetic span.
      declaration.identifiers.push({ symbol: original.symbol, providerSymbol: original.provider_symbol,
        exchange: original.exchange, validFrom: original.valid_from, validTo: original.valid_from },
      { symbol: venue.before.symbol, exchange: original.exchange, validFrom: venue.before.from, validTo: venue.through },
      { symbol: original.symbol, providerSymbol: original.provider_symbol, exchange: original.exchange, validFrom: shiftDate(venue.through, 1) });
      affected.push(stock.listing_date || stock.first_seen);
    } else {
      declaration.identifiers.push({ symbol: original.symbol, providerSymbol: original.provider_symbol, exchange: original.exchange,
        validFrom: original.valid_from, validTo: venue.through });
      if (venue.next) declaration.identifiers.push({ symbol: venue.next.symbol, exchange: venue.next.exchange, validFrom: venue.next.from });
      if (venue.terminal) declaration.status = 'delisted';
      affected.push(shiftDate(venue.through, 1));
    }
    securities.push(declaration);
  }
  for (const row of corporateActions) {
    if (row.type !== 'split' || !isoDate(row.date) || !isoDate(row.knownAt) || !(row.factor > 0)) throw new Error('Invalid reviewed split correction');
    const existingSplit = db.prepare("SELECT factor FROM corporate_actions WHERE security_id=? AND date=? AND type='split' ORDER BY version DESC LIMIT 1")
      .get(securityId, row.replaces);
    if (!existingSplit || Math.abs(existingSplit.factor - row.factor) > 1e-10
        || !overrides.some((override) => override.kind === 'split' && override.from === row.replaces)) {
      throw new Error('The replaced vendor split differs from the reviewed action');
    }
    const earlyBasis = db.prepare(`SELECT date FROM daily_prices WHERE security_id=? AND date<?
      AND (volume_adjusted=1 OR split_close IS NOT NULL) AND coalesce(volume_basis,known_at)>=? ORDER BY date LIMIT 1`)
      .get(securityId, row.replaces, row.replaces);
    affected.push(earlyBasis?.date || row.replaces);
  }
  const earliestAffectedDate = affected.filter(isoDate).sort()[0];
  if (!earliestAffectedDate) throw new Error('No market-data correction is specified');
  const report = { id, dataset, securityId, previousVersion: dataVersion(db), earliestAffectedDate,
    overrides: overrides.length, corporateActions: corporateActions.length, dryRun };
  if (dryRun) return report;
  const imported = importDataset(db, { provider: CORRECTION_SOURCE, dataset, catalogDate: reviewedAt, securities,
    qualityOverrides: overrides.map((row) => ({ ...row, securityId, knownAt: row.knownAt ?? reviewedAt })),
    corporateActions: corporateActions.map((row) => ({ ...row, securityId })),
    warnings: [`Correction manifest SHA256 ${manifestHash}`, `Earliest affected warehouse session: ${earliestAffectedDate}`,
      ...evidence.map(({ url, fact }) => `${url} ${fact}`)],
  });
  recordArchiveBoundary(db, db.prepare('SELECT id,detail FROM ingestion_runs WHERE id=?').get(imported.id));
  return { ...report, version: imported.version };
}

export function applyVerifiedCorrection(db, input, { dryRun = false } = {}) {
  if (input.operation === 'verified-source-facts') return applySourceFacts(db, input, dryRun);
  const { id, reviewedAt, securityId, issuer, cik, originalSymbol, originalVenue, lastPrimarySession, temporaryVenue,
    temporarySymbol, temporaryStart, postSplitSymbol, vendorSeriesId, duplicateIds, split, previousVolumeBasis, evidence } = input;
  if (!/^[a-z0-9-]+$/.test(id) || !/^[0-9]+$/.test(cik) || !Array.isArray(evidence) || evidence.length < 2
      || evidence.some(({ url, fact }) => !url?.startsWith(`https://www.sec.gov/Archives/edgar/data/${cik}/`) || !fact)
      || ![reviewedAt, lastPrimarySession, temporaryStart, split?.date, previousVolumeBasis].every(isoDate)
      || !(lastPrimarySession < temporaryStart && temporaryStart < split.date && split.date <= reviewedAt)
      || previousVolumeBasis !== lastPrimarySession || !(split.factor > 0 && split.factor < 1)
      || !Array.isArray(duplicateIds) || !duplicateIds.includes(vendorSeriesId) || duplicateIds.includes(securityId)) {
    throw new Error('Supply an identity correction supported by SEC evidence and a dated reverse split');
  }
  const dataset = `verified-correction:${id}`;
  const manifestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const applied = db.prepare(`SELECT id,version,rows,detail FROM ingestion_runs
    WHERE dataset=? AND provider=? AND status='complete' LIMIT 1`).get(dataset, CORRECTION_SOURCE);
  if (applied) {
    if (!JSON.parse(applied.detail).warnings.includes(`Correction manifest SHA256 ${manifestHash}`)) throw new Error('A different correction already uses this ID');
    const earliestAffectedDate = dryRun ? JSON.parse(applied.detail).archiveImpactFrom : recordArchiveBoundary(db, applied);
    return { id, dataset, version: applied.version, rows: applied.rows, earliestAffectedDate, duplicate: true, dryRun };
  }

  const security = db.prepare("SELECT * FROM securities WHERE id=? AND provider='eodhd'");
  const aliases = db.prepare('SELECT * FROM identifiers WHERE security_id=? ORDER BY valid_from');
  const canonical = security.get(securityId);
  const listed = aliases.all(securityId);
  if (!canonical || listed.length !== 1 || listed[0].symbol !== originalSymbol || listed[0].exchange !== originalVenue
      || listed[0].valid_to !== null || !canonical.first_seen || canonical.first_seen > lastPrimarySession) {
    throw new Error('The warehouse identity or its primary listing has changed since review');
  }
  const declarations = [{
    securityId, symbol: originalSymbol, name: issuer, status: 'active', knownAt: reviewedAt,
    identifiers: [
      { symbol: originalSymbol, providerSymbol: listed[0].provider_symbol, exchange: originalVenue,
        validFrom: listed[0].valid_from, validTo: lastPrimarySession },
      { symbol: temporarySymbol, exchange: temporaryVenue, validFrom: temporaryStart, validTo: shiftDate(split.date, -1) },
      { symbol: postSplitSymbol, exchange: temporaryVenue, validFrom: split.date },
    ],
  }];
  const affected = [canonical.first_seen, canonical.listing_date].filter(Boolean);
  const duplicateAliases = new Set([temporarySymbol, postSplitSymbol]);
  for (const duplicate of duplicateIds) {
    const row = security.get(duplicate);
    const records = aliases.all(duplicate);
    if (!row?.first_seen || records.length !== 1 || !duplicateAliases.delete(records[0].symbol)
      || records[0].valid_from >= row.first_seen || records[0].valid_to !== null || records[0].exchange !== originalVenue) {
      throw new Error(`The reviewed duplicate identifier changed: ${duplicate}`);
    }
    const alias = records[0];
    affected.push(...[row.first_seen, row.listing_date].filter(Boolean));
    declarations.push({ securityId: duplicate, symbol: alias.symbol, knownAt: reviewedAt,
      identifiers: [{ symbol: alias.symbol, providerSymbol: alias.provider_symbol, exchange: alias.exchange,
        validFrom: alias.valid_from, validTo: alias.valid_from }] });
  }
  if (duplicateAliases.size) throw new Error('Both vendor duplicate aliases must be verified');
  const existingAction = db.prepare("SELECT 1 FROM corporate_actions WHERE security_id=? AND type='split' AND date<=? LIMIT 1");
  if (existingAction.get(securityId, reviewedAt) || existingAction.get(vendorSeriesId, reviewedAt)) {
    throw new Error('A new split observation requires re-review of the correction');
  }
  const series = db.prepare(`SELECT * FROM daily_prices WHERE security_id=? AND date BETWEEN ? AND ? ORDER BY date`);
  const priorSeries = series.all(securityId, canonical.first_seen, lastPrimarySession);
  const otc = series.all(vendorSeriesId, temporaryStart, reviewedAt);
  const priorBar = otc.filter((bar) => bar.date < split.date).at(-1);
  const firstSplitBar = otc.find((bar) => bar.date === split.date);
  if (!priorSeries.length || priorSeries.at(-1).date !== lastPrimarySession || !priorBar || !firstSplitBar
      || priorBar.close !== split.expectedPriorClose || firstSplitBar.close !== split.expectedEventClose
      || !(firstSplitBar.close * split.factor / priorBar.close > 0.1 && firstSplitBar.close * split.factor / priorBar.close < 10)) {
    throw new Error('The upstream quote discontinuity differs from the reviewed split');
  }
  const correctionKnownAt = (bar) => bar.known_at > reviewedAt ? bar.known_at : reviewedAt;
  const base = (bar) => ({ securityId, date: bar.date, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
    knownAt: correctionKnownAt(bar) });
  const prices = [
    ...priorSeries.map((bar) => ({ ...base(bar), adjustedClose: bar.adjusted_close, splitClose: bar.split_close,
      volume: bar.volume, volumeAdjusted: false })),
    ...otc.map((bar) => ({ ...base(bar), volume: bar.volume,
      volumeAdjusted: !!bar.volume_adjusted, volumeBasis: bar.volume_basis })),
  ];
  const warnings = [
    `Correction manifest SHA256 ${manifestHash}`,
    `Earliest affected warehouse session: ${affected.sort()[0]}`,
    `SEC issuer CIK ${cik}. Dated venue and split evidence reviewed ${reviewedAt}.`,
    ...evidence.map(({ url, fact }) => `${url} ${fact}`),
    `Original EODHD primary share counts through ${previousVolumeBasis} retained as published. The subsequent OTC share consolidation was absent from this source series.`,
    `OTC OHLC recaptured from warehouse EODHD series ${vendorSeriesId}; original source rows and revisions remain available.`,
    'Pre-split OTC volume basis is unverified. A field-specific quality override preserves the price observations and withholds volume metrics.',
    'Inconsistent vendor adjusted closes in the OTC segment are unavailable. Price and total return use split-aware economic changes.',
  ];
  const report = { id, dataset, previousVersion: dataVersion(db), earliestAffectedDate: affected.sort()[0],
    securityId, primaryBars: priorSeries.length, otcBars: otc.length,
    otcPreSplitVolumeWithheld: otc.filter((bar) => bar.date < split.date).length,
    adjustedSplitGross: firstSplitBar.close * split.factor / priorBar.close, dryRun };
  if (dryRun) return report;
  const imported = importDataset(db, { provider: CORRECTION_SOURCE, dataset, catalogDate: reviewedAt,
    securities: declarations, prices, corporateActions: [{ securityId, type: 'split', date: split.date,
      factor: split.factor, knownAt: reviewedAt }],
    qualityOverrides: [
      { id: `${id}-volume`, securityId, kind: 'volume', from: temporaryStart, to: shiftDate(split.date, -1),
        knownAt: reviewedAt, reason: 'Pre-split OTC share-volume basis cannot be independently verified. Prices remain usable.', evidenceUrl: evidence[1].url },
      { id: `${id}-notice`, securityId, kind: 'notice', from: temporaryStart, to: split.date, knownAt: reviewedAt,
        reason: 'Nasdaq trading was suspended September 17. OTC symbols RITRF and RITRD are one issue. The November 12 split is 1-for-250.',
        evidenceUrl: evidence[2].url },
    ], warnings });
  recordArchiveBoundary(db, db.prepare('SELECT id,detail FROM ingestion_runs WHERE id=?').get(imported.id));
  return { ...report, version: imported.version, rows: imported.rows, revised: imported.imported };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      db: { type: 'string' }, apply: { type: 'boolean' }, help: { type: 'boolean' },
    } });
    if (values.help) console.log('Usage: node scripts/apply-verified-correction.mjs MANIFEST [--db FILE] [--apply]');
    else {
      if (positionals.length !== 1) throw new Error('Supply one reviewed correction manifest. Run with --help for usage.');
      const filename = values.db || process.env.MARKET_DB || 'data/market.sqlite';
      const db = values.apply ? openDatabase(filename) : new DatabaseSync(filename, { readOnly: true, timeout: 5000 });
      try { console.log(JSON.stringify(applyVerifiedCorrection(db, JSON.parse(readFileSync(positionals[0], 'utf8')), { dryRun: !values.apply }), null, 2)); }
      finally { db.close(); }
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
