import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { prepareBatchedSnapshots, preparationSeedKey } from './batch-preparation.mjs';
import { openDatabase } from './database.mjs';
import { createEngine } from './engine.mjs';
import { checksumPreparationShard, preparationSeedSeal, preparationShardFormat, preparationShardInventory, preparationSourcePin } from './pipeline-shards.mjs';

function stageLineage(source, destination, revision) {
  const add = destination.prepare(`INSERT INTO ingestion_runs
    (id,provider,dataset,scope,status,started_at,finished_at,detail,fingerprint,version)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const rows = source.prepare(`SELECT id,provider,dataset,scope,status,started_at,finished_at,
    json_object('archiveImpactTracked',json_extract(detail,'$.archiveImpactTracked'),
      'archiveImpactFrom',json_extract(detail,'$.archiveImpactFrom')) AS detail,fingerprint,version
    FROM ingestion_runs WHERE status='complete' AND version<=? ORDER BY version,id`);
  destination.exec('BEGIN IMMEDIATE');
  try {
    destination.prepare("INSERT INTO meta (key,value) VALUES ('data_version',?)").run(String(revision));
    for (const row of rows.iterate(revision)) {
      add.run(row.id, row.provider, row.dataset, row.scope, row.status, row.started_at, row.finished_at, row.detail, row.fingerprint, row.version);
    }
    destination.exec('COMMIT');
  } catch (error) {
    if (destination.isTransaction) destination.exec('ROLLBACK');
    throw error;
  }
}

export async function runPreparationShard(request, onProgress) {
  if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1024 ** 2) throw new RangeError('Invalid shard byte limit');
  const seeds = request.dependencySeeds;
  const seedHash = preparationSeedSeal(seeds);
  if (seedHash !== (request.seedHash ?? null)) throw new Error('Child preparation seed checksum differs from the dispatch');
  const source = new DatabaseSync(request.sourcePath, { readOnly: true });
  let destination;
  let inventory;
  let totals;
  try {
    const pin = preparationSourcePin(source, request.sourcePath, request.configurations);
    if (JSON.stringify(pin) !== JSON.stringify(request.pin)) throw new Error('Child source or resolved-context pin differs from the dispatch');
    writeFileSync(request.sidecarPath, '', { flag: 'wx', mode: 0o600 });
    destination = openDatabase(request.sidecarPath);
    // An interrupted private sidecar is never publishable. Roll back normal
    // statement failures without reserving a second sidecar's worth of disk.
    destination.exec('PRAGMA journal_mode=MEMORY');
    const { page_size: pageSize } = destination.prepare('PRAGMA page_size').get();
    destination.exec(`PRAGMA max_page_count=${Math.floor(request.maxBytes / pageSize)}`);
    stageLineage(source, destination, pin.dataVersion);

    const engine = createEngine(source);
    totals = prepareBatchedSnapshots(destination, engine, request.configurations, {
      dates: request.dates, tileSize: request.tileSize, codec: request.codec, onProgress,
      dependencyProvider: seeds ? ({ config, kind, date }) => seeds.get(preparationSeedKey(engine, config, kind, date)) : undefined,
      requireDependencySeeds: seeds != null,
    });
    inventory = preparationShardInventory(destination, request);
  } finally {
    if (destination?.isOpen) destination.close();
    source.close();
  }
  const seal = await checksumPreparationShard(request.sidecarPath);
  if (seal.bytes > request.maxBytes) throw new Error('Completed shard exceeds its assigned disk budget');
  return { format: preparationShardFormat, pin: request.pin, dates: request.dates, seedHash, inventory, seal, totals,
    peakRssBytes: process.resourceUsage().maxRSS * 1024 };
}

if (!isMainThread) {
  try {
    const manifest = await runPreparationShard(workerData, (event) => parentPort.postMessage({ type: 'progress', event }));
    parentPort.postMessage({ type: 'result', manifest });
  } catch (error) {
    parentPort.postMessage({ type: 'failure', error: error.message });
    process.exitCode = 1;
  }
}
