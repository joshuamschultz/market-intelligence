# External AI connections

The checked-out source includes a read-only research API/MCP surface and a Settings → AI connections page for managing its scoped tokens. The MCP implementation uses the official SDK and its stdio and HTTP protocol tests pass; the Settings UI tests pass. **No OpenAI, Claude MCP/API, or Grok provider account has been connected to this workspace, and no external model call has been verified.** Use `/api/v1/build` to confirm that the active immutable release includes these routes before following connection steps. The existing Market Journal's optional Anthropic generation is a separate feature; it does not mean that an external research client is connected.

## One research surface, two transports

The implementation exposes one bounded tool catalog to JSON API clients and MCP clients. Confirm the active build before relying on these routes:

| Route | Purpose |
| --- | --- |
| `GET /research/v1/tools` | Discover tool names, descriptions, input schemas, and scopes. |
| `POST /research/v1/tools/{name}` | Run one typed, read-only research tool. |
| `GET /research/v1/openapi.json` | Read the matching REST/OpenAPI contract. |
| `GET /api/v1/research-access` | List integration records, connection endpoints, and available scopes; requires normal workspace authentication. |
| `POST /api/v1/research-access` | Create a scoped integration and return its secret once; requires normal workspace authentication. |
| `DELETE /api/v1/research-access/{id}` | Revoke an integration; requires normal workspace authentication. |
| `/mcp` | Streamable HTTP MCP transport over the same catalog. |
| `node scripts/research-mcp.mjs` | Local stdio MCP server for a client running on this computer. |

HTTP research calls use a dedicated integration bearer token, separate from the workspace login and provider credentials. The scopes are `research:read`, `research:notes`, and `research:journals`; every token includes `research:read`, while notes and journals are optional additional scopes. The source implementation stores only a token hash in a private mode-0600 SQLite sidecar next to the selected warehouse and supports revocation. The plaintext token is shown at creation; save it in a secret manager. Do not paste it into prompts or check it into source control. The research tools cannot read provider keys or secret settings, alter saved data, enqueue work, change calculation scopes, or issue arbitrary SQL, shell commands, or network fetches.

Use **Settings → AI connections** to see the current endpoint URLs, create a token, select optional private-note/journal scopes, copy client setup details, and revoke individual tokens. The same operations are available from the project CLI:

```sh
npm run research:access -- list
npm run research:access -- create --name "Read-only research"
npm run research:access -- create --name "Research with private notes" --scope research:notes
npm run research:access -- create --name "Research with journals" --scope research:journals
npm run research:access -- revoke INTEGRATION_ID
```

The create command and Settings UI display the secret once. Keep it in the target client's secret store. The sidecar follows the configured `MARKET_DB`; it is separate from provider and Market Journal credential stores. These credentials authorize research-tool access; they are not an OpenAI, Anthropic, or xAI provider key.

The service is designed to bind to loopback by default, honors the configured `HOST` and `PORT`, and checks a request's `Origin` when one is supplied. The HTTP API and Streamable HTTP MCP transport require the dedicated bearer token; REST tool calls use `POST /research/v1/tools/{name}` and catalog/OpenAPI support `GET` and `HEAD`. The MCP server also supports the SDK's stateless compatibility mode. A loopback server is reachable only from this computer; it is not a public endpoint. Do not open a firewall port or start a tunnel as part of setup. Hosted AI products have different network paths, so choose the connection method below only after the MCP/API surface is in a released build and reviewed.

## Connect a client

### Local MCP client

Use the stdio transport when the MCP client runs on the same computer as Market Intelligence. Settings → AI connections generates a Claude Desktop configuration using the machine's active project paths and warehouse. The launched process is `node scripts/research-mcp.mjs` with `MARKET_DB` and `MARKET_RESEARCH_TOKEN` supplied through the client's private environment. The same process can be configured in other stdio-capable MCP clients. Its protocol messages use stdout; diagnostics use stderr.

Use the active release's tool listing and schemas rather than copying an old tool definition into the client.

### OpenAI API / Responses API

For an API-driven OpenAI client, the Responses API can call a remote MCP server by `server_url`, or a private/local server through OpenAI Secure MCP Tunnel using a `tunnel_id`. The API request itself uses the OpenAI API key, and the MCP server uses its separate research credential where the connection supports it. The server's authorization token is passed on each request and should be loaded from a secret store, not embedded in prompts or source. See [OpenAI's MCP server guide](https://developers.openai.com/api/docs/guides/tools-connectors-mcp).

### ChatGPT on the web

In ChatGPT on the web, open **Plugins**, select **+ → Add custom MCP server**, enter a name and server URL or choose Secure MCP Tunnel, configure OAuth/no-auth, review the risk warning, create the plugin, and install it before use. ChatGPT supports OAuth, no authentication, or a mixed OAuth/no-auth configuration; it does **not** let the user supply an arbitrary customer API key as the server's custom authentication method. The current Market Intelligence HTTP MCP route requires a dedicated bearer token and does not yet implement OAuth or anonymous access, so ChatGPT web cannot authenticate to it today; a Tunnel fixes network reachability but not that auth mismatch. Do not expose the local research service publicly or weaken its authentication just to connect ChatGPT. For an API-driven OpenAI client, use the Responses API section above, which can pass the MCP authorization value. See [OpenAI's custom MCP server guide](https://developers.openai.com/api/docs/guides/custom-mcp-server).

### Claude

For Claude API use, call Anthropic's Messages API with its API credential and configure the remote MCP server in `mcp_servers`; pass the research token as `authorization_token` when required. The MCP connector is a beta feature whose supported transports and per-product availability can change; check the current [Claude MCP connector documentation](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector).

Claude web custom connectors are cloud-connected: Anthropic's service calls the connector over public HTTPS on port 443. It cannot reach a private loopback URL or a server available only on your laptop. On Pro/Max, add it under **Customize → Connectors → + Add custom connector**; enter the exact public MCP URL and authentication mode. Fixed request headers can carry a bearer/API token, but that gives the connector access associated with that shared credential. Do not create a public endpoint or share a token until that exposure is explicitly reviewed. Team/Enterprise setup also requires an organization owner to add the connector before a member connects. Claude Desktop's local stdio configuration is a separate mechanism and runs locally; remote web connectors and Desktop stdio are not interchangeable. See [Claude's custom connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

### Grok API

xAI documents remote MCP through its API/Responses-compatible interface. Its tool definition uses `server_url` and `server_label`, with optional `authorization`, extra headers, and an allowlist of tool names. The xAI API key authenticates the request to xAI; the research bearer authorizes the MCP server. xAI's documentation covers API use; this guide does not claim a Grok web custom-connector path. See [xAI's Remote MCP Tools documentation](https://docs.x.ai/developers/tools/remote-mcp).

## Data flow and privacy

The model provider receives the prompt and whichever research-tool results the client returns to it. Those results can include dated market measurements and provenance. Personal notes or Market Journal text are excluded unless the client has the corresponding scope and the user explicitly opts them into a request. Check the provider's current retention and data-handling terms before sending private research. Integration tokens stay in local secret storage and are never returned by a research tool.

No provider data are fetched by research-tool reads. The tools read the local warehouse and its verified prepared outputs; bounded study summaries operate on those stored series. If a requested context is not ready, the tool returns a structured unavailable/preparation state; it does not launch a cold archive calculation or provider job.

## Official connection references

- [OpenAI Responses API MCP tools and Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)
- [ChatGPT custom MCP servers, authentication options, and Tunnel](https://developers.openai.com/api/docs/guides/custom-mcp-server)
- [Claude web remote MCP connector setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- [Claude API MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector)
- [xAI Remote MCP Tools](https://docs.x.ai/developers/tools/remote-mcp)
