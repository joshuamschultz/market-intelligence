import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { readAnalysisReadiness } from '../backend/analysis-readiness.mjs';
import { CALCULATION_VERSION, dataVersion } from '../backend/database.mjs';
import { isCurrentGroupMembership, readGroupMembershipVelocity } from '../backend/group-velocity.mjs';
import { createServiceEngine, prepareWorkspaceGroupMemberships, workspaceGroupMembershipContexts } from '../backend/service.mjs';

try {
  try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { positionals: [command = 'status'], values } = parseArgs({
    allowPositionals: true, options: { db: { type: 'string' }, force: { type: 'boolean' } },
  });
  if (!['status', 'prepare'].includes(command) || command === 'status' && values.force) {
    throw new Error('Use node scripts/group-velocity.mjs status|prepare [--db FILE] [--force]');
  }
  const filename = resolve(values.db || process.env.MARKET_DB || 'data/market.sqlite');
  if (!existsSync(filename)) throw new Error('The selected warehouse does not exist.');
  const db = new DatabaseSync(filename, { readOnly: command === 'status' });
  try {
    db.exec('PRAGMA busy_timeout=10000');
    const engine = createServiceEngine(db);
    const date = db.prepare('SELECT date FROM daily_prices ORDER BY date DESC LIMIT 1').get()?.date;
    const revision = dataVersion(db);
    const config = engine.context({ date, dataVersion: revision });
    const point = { date, dataVersion: revision, calculationVersion: CALCULATION_VERSION };
    if (command === 'prepare' && readAnalysisReadiness(db, point).state !== 'ready') {
      throw new Error('Prepare and verify the current baseline before preparing current group membership.');
    }
    const result = command === 'prepare' ? prepareWorkspaceGroupMemberships(db, engine, config, { force: values.force })
      : { results: workspaceGroupMembershipContexts(db, engine, config).filter(isCurrentGroupMembership).map((scope) => {
        const { groups, ...status } = readGroupMembershipVelocity(db, scope);
        return status;
      }) };
    console.log(JSON.stringify({ ...point, ...result }, null, 2));
    if (command === 'prepare' && result.state === 'unprepared') process.exitCode = 1;
  } finally {
    db.close();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
