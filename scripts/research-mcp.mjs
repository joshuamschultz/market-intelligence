import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createResearchAccess } from '../backend/ai-access.mjs';
import { createResearchMcpServer } from '../backend/ai-mcp.mjs';
import { createResearchEngine } from '../backend/ai-research.mjs';
import { createResearchWorkspaceWriter } from '../backend/ai-workspace-writes.mjs';

try {
  try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const filename = resolve(process.env.MARKET_DB || 'data/market.sqlite');
  const access = createResearchAccess({ filename: `${filename}.research-access.sqlite` });
  const token = process.env.MARKET_RESEARCH_TOKEN;
  const authenticate = () => access.authenticate(token);
  const principal = authenticate();
  if (!principal) throw new Error('Set MARKET_RESEARCH_TOKEN to an active dedicated integration token.');
  const db = new DatabaseSync(filename, { readOnly: true });
  db.exec('PRAGMA busy_timeout=5000');
  const research = createResearchEngine(db, { workspaceWriter: createResearchWorkspaceWriter(filename) });
  serveStdio(() => createResearchMcpServer(research, authenticate(), authenticate), {
    onerror: () => console.error('Market Intelligence research MCP transport reported an error.'),
  });
} catch (error) {
  console.error(error.code ? 'The Market Intelligence research runtime could not be opened.' : error.message);
  process.exitCode = 1;
}
