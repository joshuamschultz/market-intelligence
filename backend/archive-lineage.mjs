import { isoDate } from './database.mjs';

export function reusableArchiveVersions(db, config, candidates) {
  const target = config.dataVersion;
  const versions = [...new Set([target, ...candidates])].filter((version) => version <= target).sort((a, b) => b - a);
  const bounds = new Map([[target, null]]);
  // A former latest snapshot may have used later-observed reference facts than its historical session.
  if (versions.length < 2 || config.referenceMode === 'latest') return bounds;
  const changes = db.prepare(`
    SELECT version, json_extract(detail,'$.archiveImpactTracked') AS tracked,
      json_extract(detail,'$.archiveImpactFrom') AS impact
    FROM ingestion_runs WHERE status='complete' AND version>? AND version<=? ORDER BY version DESC
  `).all(versions.at(-1), target);
  let cursor = target;
  let earliest = null;
  let index = 0;
  for (const version of versions.slice(1)) {
    while (cursor > version) {
      const row = changes[index++];
      if (!row || row.version !== cursor || !row.tracked || (row.impact !== null && !isoDate(row.impact))) return bounds;
      if (row.impact && (!earliest || row.impact < earliest)) earliest = row.impact;
      cursor--;
    }
    bounds.set(version, earliest);
  }
  return bounds;
}

export function usableArchiveRow(bounds, row) {
  return bounds.has(row.data_version) && (bounds.get(row.data_version) == null || row.date < bounds.get(row.data_version));
}

export function referenceArchiveScopes(config, dates) {
  if (config.referenceMode !== 'latest') return [{ config, dates }];
  const historical = dates.filter((date) => date !== config.latestDate);
  const current = dates.filter((date) => date === config.latestDate);
  return [
    ...(historical.length ? [{ config: { ...config, referenceMode: 'as-of' }, dates: historical }] : []),
    ...(current.length ? [{ config, dates: current }] : []),
  ];
}
