import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { publishPreparation } from '../backend/preparation-publication.mjs';

function bytes(value, unit) {
  return value == null ? undefined : Number(value) * unit;
}

function acceptedManifest(filename) {
  if (!filename) throw new Error('Provide an accepted full-run manifest with --manifest');
  const value = readFileSync(filename, 'utf8');
  try { return JSON.parse(value); }
  catch { throw new Error('The accepted manifest is not valid JSON'); }
}

try {
  const { values } = parseArgs({ options: {
    source: { type: 'string' }, destination: { type: 'string' }, manifest: { type: 'string' },
    'data-version': { type: 'string' }, 'calculation-version': { type: 'string' },
    'active-calculation-version': { type: 'string' }, 'partition-mib': { type: 'string' },
    'reserve-gib': { type: 'string' }, consume: { type: 'boolean' }, progress: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/publish-preparation.mjs --source FILE --destination FILE --manifest FILE\n' +
      '  --data-version N --calculation-version HASH --active-calculation-version HASH\n' +
      '  [--partition-mib 64] [--reserve-gib 1] [--progress] [--consume]\n\n' +
      'The default is a read-only plan. --consume copies, verifies and releases source partitions.\n' +
      'Use the same accepted manifest to resume. Activate the new app only after verified-awaiting-cutover.');
  } else {
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    try {
      const result = await publishPreparation({
        sourcePath: values.source,
        destinationPath: values.destination,
        manifest: acceptedManifest(values.manifest),
        dataVersion: Number(values['data-version']),
        calculationVersion: values['calculation-version'],
        activeCalculationVersion: values['active-calculation-version'],
        maxPartitionBytes: bytes(values['partition-mib'], 2 ** 20),
        reserveBytes: bytes(values['reserve-gib'], 2 ** 30),
        consume: values.consume ?? false,
        signal: controller.signal,
        onProgress: values.progress ? (event) => {
          if (event.phase === 'consumed') process.stderr.write(
            `${event.consumedPartitions}/${event.totalPartitions} partitions consumed; ${event.releasedSourceBytes} source bytes released\n`);
        } : undefined,
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
  }
} catch (error) {
  console.error(`Preparation publication stopped: ${error.message}`);
  process.exitCode = error.name === 'AbortError' ? 130 : 1;
}
