import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createResearchAccess } from '../backend/ai-access.mjs';

try {
  try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { positionals: [command, id], values } = parseArgs({ allowPositionals: true, options: {
    name: { type: 'string' }, scope: { type: 'string', multiple: true },
  } });
  if (!['list', 'create', 'revoke'].includes(command)) {
    throw new Error('Use research:access -- list, create --name NAME [--scope SCOPE], or revoke ID');
  }
  const file = resolve(process.env.MARKET_DB || 'data/market.sqlite');
  const access = createResearchAccess({ filename: `${file}.research-access.sqlite` });
  const result = command === 'list' ? access.list()
    : command === 'create' ? access.create({ name: values.name, scopes: values.scope })
      : access.revoke(id);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.code ? 'Research credential storage could not be opened.' : error.message);
  process.exitCode = 1;
}
