import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { researchTokenFromHeader } from './ai-access.mjs';
import { availableTools, invokeResearchTool, researchOpenApi, toolManifest } from './ai-tools.mjs';

export const researchRequestBytes = 64 * 1024;
const serverInfo = { name: 'market-intelligence-research', version: '1.0.0' };
const credentialsRequired = 'A valid dedicated research bearer is required';
const challenge = { 'WWW-Authenticate': 'Bearer realm="Market Intelligence Research"' };
const message = (error) => error.status >= 400 && error.status < 500 || error.status === 503
  ? error.message : 'Research request could not be completed';

export function createResearchMcpServer(research, principal, reauthenticate = () => principal) {
  const server = new McpServer(serverInfo, { capabilities: { tools: {} },
    instructions: 'Use the verified analysis pin in each result. Repeat its date and revision for subsequent queries. Respect coverage gaps and distinguish historical statistics from forecasts.' });
  for (const tool of availableTools(principal)) {
    server.registerTool(tool.name, {
      description: tool.description, inputSchema: tool.input, outputSchema: tool.output, annotations: tool.annotations,
    }, async (input) => {
      try {
        const active = reauthenticate();
        if (!active) return { isError: true, content: [{ type: 'text', text: credentialsRequired }] };
        const structuredContent = await invokeResearchTool(research, active, tool.name, input);
        return { structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: message(error) }] };
      }
    });
  }
  return server;
}

export function createResearchHttp({ access, research }) {
  const handler = createMcpHandler(({ authInfo }) => createResearchMcpServer(research, authInfo?.extra?.principal,
    () => access.authenticate(authInfo?.token)), { maxRequestBodySize: researchRequestBytes });
  const mcp = toNodeHandler(handler, { maxRequestBodySize: researchRequestBytes });

  return {
    async handle({ req, res, pathname, json, readBody }) {
      const token = researchTokenFromHeader(req.headers.authorization);
      const principal = access.authenticate(token);
      if (!principal) return json(401, { error: credentialsRequired }, challenge);
      if (req.headers.origin) {
        let trusted = false;
        try {
          const origin = new URL(req.headers.origin);
          trusted = ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host;
        } catch {}
        if (!trusted) return json(403, { error: 'Untrusted request origin' });
      }
      if (pathname === '/mcp') {
        req.auth = { token, clientId: principal.id, scopes: principal.scopes, extra: { principal } };
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return mcp(req, res);
      }
      if (pathname === '/research/v1/tools') {
        return ['GET', 'HEAD'].includes(req.method) ? json(200, { tools: toolManifest(principal) })
          : json(405, { error: 'Use GET to list research tools' }, { Allow: 'GET, HEAD' });
      }
      if (pathname === '/research/v1/openapi.json') {
        return ['GET', 'HEAD'].includes(req.method) ? json(200, researchOpenApi(principal))
          : json(405, { error: 'Use GET to read the OpenAPI document' }, { Allow: 'GET, HEAD' });
      }
      const tool = /^\/research\/v1\/tools\/([a-z][a-z0-9_]+)$/.exec(pathname)?.[1];
      if (!tool) return json(404, { error: 'Research route not found' });
      if (req.method !== 'POST') return json(405, { error: 'Use POST to run research tools' }, { Allow: 'POST' });
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
        return json(415, { error: 'Request Content-Type must be application/json' });
      }
      try {
        const input = await readBody(req, researchRequestBytes);
        const active = access.authenticate(token);
        if (!active) return json(401, { error: credentialsRequired }, challenge);
        return json(200, await invokeResearchTool(research, active, tool, input));
      } catch (error) {
        return json(error.status || 500, { error: message(error) });
      }
    },
    close: () => handler.close(),
  };
}
