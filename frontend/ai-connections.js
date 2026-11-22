import { chip, dateLabel, field, notice, panelHead, pathPart, pending, safe } from './ui.js';

const endpoint = 'research-access';
const readScope = 'research:read';
const scopeDetails = {
  [readScope]: 'Read prepared market data and analysis.',
  'research:notes': 'Lets the client request private research notes.',
  'research:journals': 'Lets the client request private Market Journal entries.',
  'research:workspace:create': 'Lets the client create new watchlists and saved screens in this workspace.',
};
const tokenPlaceholder = 'PASTE_RESEARCH_TOKEN_HERE';
const guides = {
  desktop: 'https://py.sdk.modelcontextprotocol.io/get-started/real-host/#claude-desktop',
  claude: 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp',
  chatgpt: 'https://developers.openai.com/api/docs/guides/custom-mcp-server',
  openai: 'https://developers.openai.com/api/docs/guides/tools-connectors-mcp',
  grok: 'https://docs.x.ai/developers/tools/remote-mcp',
};

function loadStyles(doc) {
  if (doc.head.querySelector('[data-ai-connections-styles]')) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./ai-connections.css', import.meta.url).href;
  link.setAttribute('data-ai-connections-styles', '');
  doc.head.append(link);
}

function localUrl(origin, path) {
  return typeof path === 'string' && /^\/(?!\/)[\w./-]+$/.test(path) ? new URL(path, origin).href : '';
}

function guide(label, url) {
  return `<a class="text-link" href="${safe(url)}" target="_blank" rel="noopener noreferrer">${safe(label)}</a>`;
}

function example(id, label, value) {
  return `<pre tabindex="0" aria-label="${safe(label)}"><code id="${id}">${safe(value)}</code></pre>
    <button type="button" class="button" data-ai-copy="${id}">Copy ${safe(label)}</button>`;
}

function connectionSetup(data, origin) {
  const { command, scriptPath, database } = data.runtime ?? {};
  const desktopConfig = command && scriptPath && database ? JSON.stringify({ mcpServers: {
    'market-intelligence': { command, args: [scriptPath], env: { MARKET_DB: database, MARKET_RESEARCH_TOKEN: tokenPlaceholder } },
  } }, null, 2) : '';
  const tools = localUrl(origin, data.endpoints.tools);
  const openapi = localUrl(origin, data.endpoints.openapi);
  const mcp = localUrl(origin, data.endpoints.mcp);
  const remoteTool = JSON.stringify({ type: 'mcp', server_label: 'market_intelligence',
    server_url: 'https://YOUR_REACHABLE_HOST/mcp', authorization: tokenPlaceholder }, null, 2);

  return `<section class="panel panel-body ai-connections-setup">
    ${panelHead('Client setup', 'The workspace provided these endpoints. Check the connection in your client after setup.')}
    <dl class="ai-connections-endpoints">
      ${[['REST tool catalog', tools], ['OpenAPI', openapi], ['HTTP MCP', mcp]].map(([label, url]) => url ?
        `<div><dt>${label}</dt><dd><a class="text-link mono" href="${safe(url)}" target="_blank" rel="noopener noreferrer">${safe(url)}</a></dd></div>` : '').join('')}
    </dl>
    <p class="muted">HTTP endpoints require an <code>Authorization: Bearer &lt;token&gt;</code> header. Keep endpoints bound to localhost unless you have configured remote access.</p>
    <div class="ai-connections-guides">
      <details open><summary>Claude Desktop · local stdio</summary>
        ${desktopConfig ? `<p>On the computer running Market Intelligence, merge this entry into <code>claude_desktop_config.json</code>. Replace the placeholder with a dedicated research token, then fully quit and reopen Claude Desktop.</p>
          ${example('ai-connections-desktop', 'Claude Desktop config', desktopConfig)}` :
          '<p>Local runtime paths are unavailable. Run a workspace with a file-backed warehouse to generate the configuration.</p>'}
        <p>${guide('Claude Desktop configuration guide', guides.desktop)}</p>
      </details>
      <details><summary>Local REST API</summary>
        <p>List tools with a GET request, then send a JSON body to a named tool with <code>POST /research/v1/tools/{name}</code>. Load <code>MARKET_RESEARCH_TOKEN</code> from your client’s secret store.</p>
        ${tools ? example('ai-connections-rest', 'REST example', `curl -H "Authorization: Bearer $MARKET_RESEARCH_TOKEN" \\\n  ${tools}`) : ''}
      </details>
      <details><summary>Claude web · remote MCP</summary>
        <p>Claude connects from Anthropic’s cloud. Enter your reachable MCP URL on HTTPS port 443 in <strong>Customize → Connectors</strong>. In Request headers, set <code>Authorization</code> to <code>Bearer &lt;token&gt;</code>.</p>
        <p>${guide('Claude remote connector guide', guides.claude)}</p>
      </details>
      <details><summary>ChatGPT web · custom MCP</summary>
        <p>ChatGPT web custom MCP supports OAuth, no authentication, or a mix of both. A research bearer token cannot authenticate directly in this flow. OpenAI Secure MCP Tunnel provides private reachability. ChatGPT still needs a supported authentication method.</p>
        <p>${guide('ChatGPT custom MCP and Secure MCP Tunnel guide', guides.chatgpt)}</p>
      </details>
      <details><summary>OpenAI and Grok APIs · remote MCP</summary>
        <p>The OpenAI Responses API and Grok API accept an MCP tool definition in <code>tools</code>. Use a server URL the API can reach and set <code>authorization</code> from your research token in the client’s secret store.</p>
        ${example('ai-connections-remote', 'remote MCP example', remoteTool)}
        <p>${guide('OpenAI Responses API MCP guide', guides.openai)} · ${guide('Grok API MCP guide', guides.grok)}</p>
      </details>
    </div>
    <p class="muted" data-ai-config-status role="status"></p>
  </section>`;
}

function permissionFields(scopes, idPrefix) {
  return `<fieldset><legend>Permissions</legend>
    ${scopes.map(({ id, label, required }) => {
      const detailId = `${idPrefix}-${id}-detail`;
      return `<div class="ai-connections-scope">
        <label><input type="checkbox" name="scopes" value="${safe(id)}" aria-describedby="${safe(detailId)}"${required ? ' checked disabled' : ''}>
          <span>${safe(label)}${required ? ' (required)' : ''}</span></label>
        <p class="muted" id="${safe(detailId)}">${safe(scopeDetails[id])}</p></div>`;
    }).join('')}
  </fieldset>`;
}

function selectedScopes(form, retained = []) {
  return [...new Set([readScope, ...retained, ...Array.from(form.querySelectorAll('input[name="scopes"]:checked'), (input) => input.value)])];
}

function controls(scopes) {
  return `<div class="stack">
    <section class="panel panel-body" aria-labelledby="ai-connections-create">
      <header class="panel-head"><div><h2 id="ai-connections-create">Create a research token</h2>
      <p class="muted">Use a separate token for each client so you can revoke its access independently.</p></div></header>
      <form class="ai-connections-form" autocomplete="off" data-ai-create-form>
        ${field('Connection name', '<input name="name" required maxlength="100" placeholder="e.g. Claude Desktop" autocomplete="off">')}
        ${permissionFields(scopes, 'ai-create')}
        <p class="form-error" role="alert" data-ai-create-error hidden></p>
        <div><button type="submit" class="button primary">Create token</button></div>
      </form>
      <section class="ai-connections-issued" aria-labelledby="ai-connections-issued-title" data-ai-issued hidden>
        <h3 id="ai-connections-issued-title" tabindex="-1">Save your token</h3>
        <p class="muted">This is the only time the workspace displays your token. Copy it to your client’s private configuration or a secret store.</p>
        ${field('Research token', '<input type="password" class="mono" autocomplete="off" spellcheck="false" readonly>')}
        <div class="actions">
          <button type="button" class="button" data-ai-show>Show token</button>
          <button type="button" class="button" data-ai-copy-token>Copy token</button>
          <button type="button" class="button" data-ai-dismiss>Dismiss token</button>
        </div>
        <p class="muted" data-ai-token-status role="status"></p>
      </section>
    </section>
    <section class="panel panel-body" aria-labelledby="ai-connections-tokens">
      <header class="panel-head"><div><h2 id="ai-connections-tokens" tabindex="-1">Issued tokens</h2></div></header>
      <p class="muted" data-ai-list-status role="status" hidden></p>
      <div data-ai-records></div>
      <form id="ai-connections-edit" class="ai-connections-form ai-connections-edit" aria-labelledby="ai-connections-edit-title" data-ai-edit-form hidden>
        <h3 id="ai-connections-edit-title" tabindex="-1"></h3>
        ${permissionFields(scopes, 'ai-edit')}
        <p class="form-error" role="alert" data-ai-edit-error hidden></p>
        <div class="actions">
          <button type="submit" class="button primary">Save permissions</button>
          <button type="button" class="button" data-ai-edit-cancel>Cancel</button>
        </div>
      </form>
      <section class="ai-connections-revoke" aria-labelledby="ai-connections-revoke-title" data-ai-confirm hidden>
        <h3 id="ai-connections-revoke-title">Revoke token?</h3>
        <p class="muted" data-ai-revoke-detail></p>
        <p class="form-error" role="alert" data-ai-revoke-error hidden></p>
        <div class="actions">
          <button type="button" class="button danger" data-ai-revoke-confirm>Revoke token</button>
          <button type="button" class="button" data-ai-revoke-cancel>Cancel</button>
        </div>
      </section>
    </section>
  </div>`;
}

function recordList(records, scopeLabels, editingId) {
  if (!records.length) return '<p class="muted">No tokens issued yet.</p>';
  return `<ul class="ai-connections-records">${records.map((record) => {
    const { id, name, createdAt, revokedAt, scopes } = record;
    return `<li><div class="ai-connections-record"><div>
      <h3>${safe(name)}</h3>
      <p class="muted">Created <time datetime="${safe(createdAt)}">${dateLabel(createdAt)}</time>${revokedAt ?
        ` · Revoked <time datetime="${safe(revokedAt)}">${dateLabel(revokedAt)}</time>` : ''}</p>
      <p class="muted">${safe(scopes.map((scope) => scopeLabels.get(scope) ?? scope).join(' · '))}</p>
      </div><div class="actions">${chip(revokedAt ? 'Revoked' : 'Active token', revokedAt ? '' : 'accent')}
        ${revokedAt ? '' : `<button type="button" class="button" aria-label="${safe(`Edit permissions for ${name}`)}" aria-controls="ai-connections-edit"
          aria-expanded="${editingId === id}" data-ai-edit="${safe(id)}">Edit permissions</button>
          <button type="button" class="button danger" aria-label="${safe(`Revoke ${name}`)}" data-ai-revoke="${safe(id)}">Revoke</button>`}
      </div></div></li>`;
  }).join('')}</ul>`;
}

function setMessage(element, message = '') {
  element.textContent = message;
  element.hidden = !message;
}

export function mountAiConnections(env, target) {
  const doc = target.ownerDocument;
  const win = doc.defaultView;
  const request = new win.AbortController();
  const alive = () => !request.signal.aborted && env.isActive() && target.isConnected;
  const query = (selector) => target.querySelector(selector);
  let clearToken;
  let pageGeneration = 0;

  function hidePage() {
    pageGeneration++;
    clearToken?.(false);
  }

  function destroy() {
    if (request.signal.aborted) return;
    clearToken?.(false);
    request.abort();
    env.signal?.removeEventListener('abort', destroy);
    win.removeEventListener('pagehide', hidePage);
    target.replaceChildren();
  }

  if (!alive()) return destroy;
  env.signal?.addEventListener('abort', destroy, { once: true });
  loadStyles(doc);

  async function load(retry = false) {
    target.innerHTML = pending('Loading research access…');
    try {
      const data = await env.api(endpoint, { plain: true, signal: request.signal });
      if (!alive()) return;
      if (!Array.isArray(data.integrations) || !Array.isArray(data.scopes) || !data.endpoints) throw new Error('Research access is unavailable.');
      mountControls(data);
      if (retry) query('[name="name"]').focus();
    } catch (error) {
      if (!alive()) return;
      target.innerHTML = notice('Could not load research access', error.message,
        '<button type="button" class="button" data-ai-retry>Retry</button>', true);
      const retryButton = query('[data-ai-retry]');
      retryButton.addEventListener('click', () => load(true));
      if (retry) retryButton.focus();
    }
  }

  function mountControls(data) {
    const scopes = data.scopes.filter(({ id }) => Object.hasOwn(scopeDetails, id))
      .map((scope) => ({ ...scope, required: scope.id === readScope || scope.required }));
    const scopeLabels = new Map(data.scopes.map(({ id, label }) => [id, label]));
    const editableScopes = new Set(scopes.map(({ id }) => id));
    let records = data.integrations;
    target.innerHTML = `<div class="ai-connections">${controls(scopes)}${connectionSetup(data, win.location.origin)}</div>`;

    const form = query('[data-ai-create-form]');
    const name = form.elements.namedItem('name');
    const submit = form.querySelector('[type="submit"]');
    const createError = query('[data-ai-create-error]');
    const tokenPane = query('[data-ai-issued]');
    const token = tokenPane.querySelector('input');
    const tokenStatus = query('[data-ai-token-status]');
    const show = query('[data-ai-show]');
    const confirm = query('[data-ai-confirm]');
    const confirmButton = query('[data-ai-revoke-confirm]');
    const cancelButton = query('[data-ai-revoke-cancel]');
    const revokeError = query('[data-ai-revoke-error]');
    const editForm = query('[data-ai-edit-form]');
    const editTitle = query('#ai-connections-edit-title');
    const editFields = editForm.querySelector('fieldset');
    const editSubmit = editForm.querySelector('[type="submit"]');
    const editCancel = query('[data-ai-edit-cancel]');
    const editError = query('[data-ai-edit-error]');
    const list = query('[data-ai-records]');
    const listStatus = query('[data-ai-list-status]');
    let creating = false;
    let issuedId;
    let editing;
    let revoking;
    const drawRecords = () => { list.innerHTML = recordList(records, scopeLabels, editing?.id); };
    const recordControl = (attribute, id) => [...list.querySelectorAll(`[${attribute}]`)].find((button) => button.getAttribute(attribute) === id);

    function toggleToken(visible) {
      token.type = visible ? 'text' : 'password';
      show.textContent = visible ? 'Hide token' : 'Show token';
    }

    clearToken = (restoreFocus = true) => {
      token.value = '';
      toggleToken(false);
      setMessage(tokenStatus);
      tokenPane.hidden = true;
      submit.disabled = creating;
      issuedId = undefined;
      if (restoreFocus) name.focus();
    };

    function cancelRevoke(restoreFocus = true) {
      const id = revoking?.id;
      revoking = undefined;
      confirm.hidden = true;
      setMessage(revokeError);
      if (restoreFocus) recordControl('data-ai-revoke', id)?.focus();
    }

    function cancelEdit(restoreFocus = true) {
      const opener = recordControl('data-ai-edit', editing?.id);
      editing = undefined;
      editForm.hidden = true;
      setMessage(editError);
      opener?.setAttribute('aria-expanded', 'false');
      if (restoreFocus) opener?.focus();
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!alive() || creating || issuedId) return;
      const connectionName = name.value.trim();
      if (!connectionName || /[\u0000-\u001f\u007f]/.test(connectionName)) {
        setMessage(createError, 'Enter a connection name using printable characters.');
        name.focus();
        return;
      }
      const body = { name: connectionName, scopes: selectedScopes(form) };
      const generation = pageGeneration;
      setMessage(createError);
      creating = submit.disabled = true;
      submit.textContent = 'Creating…';
      try {
        const result = await env.api(endpoint, { method: 'POST', body, plain: true, signal: request.signal });
        if (!alive()) return;
        if (!result.integration?.id || typeof result.token !== 'string' || !result.token) throw new Error('The workspace did not return a token.');
        records = [result.integration, ...records];
        drawRecords();
        form.reset();
        if (generation !== pageGeneration) return;
        token.value = result.token;
        issuedId = result.integration.id;
        tokenPane.hidden = false;
        query('#ai-connections-issued-title').focus();
      } catch (error) {
        if (alive()) setMessage(createError, error.message || 'Could not create the token.');
      } finally {
        creating = false;
        if (alive()) {
          submit.disabled = Boolean(issuedId);
          submit.textContent = 'Create token';
        }
      }
    });

    list.addEventListener('click', (event) => {
      const opener = event.target.closest('[data-ai-edit], [data-ai-revoke]');
      if (!opener || !alive() || confirmButton.disabled || editSubmit.disabled) return;
      const record = records.find(({ id }) => id === (opener.dataset.aiEdit ?? opener.dataset.aiRevoke));
      if (!record || record.revokedAt) return;
      setMessage(listStatus);
      if (opener.hasAttribute('data-ai-edit')) {
        cancelRevoke(false);
        if (editing?.id !== record.id) {
          cancelEdit(false);
          editing = record;
          editTitle.textContent = `Edit permissions · ${record.name}`;
          for (const input of editFields.querySelectorAll('input[name="scopes"]')) {
            input.checked = input.disabled || record.scopes.includes(input.value);
          }
          editForm.hidden = false;
          opener.setAttribute('aria-expanded', 'true');
        }
        editTitle.focus();
      } else {
        cancelEdit(false);
        revoking = record;
        setMessage(revokeError);
        query('[data-ai-revoke-detail]').textContent = `Revoke access for ${record.name}? The client will need a new token to use research tools.`;
        confirm.hidden = false;
        cancelButton.focus();
      }
    });

    editCancel.addEventListener('click', () => cancelEdit());
    editForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!alive() || !editing || editSubmit.disabled) return;
      const { id, scopes: previous } = editing;
      const nextScopes = selectedScopes(editForm, previous.filter((scope) => !editableScopes.has(scope)));
      setMessage(editError);
      editFields.disabled = editCancel.disabled = editSubmit.disabled = true;
      editSubmit.textContent = 'Saving…';
      try {
        const { integration } = await env.api(`${endpoint}/${pathPart(id)}`, { method: 'PATCH', body: { scopes: nextScopes }, plain: true, signal: request.signal });
        if (!alive()) return;
        if (integration?.id !== id || integration.revokedAt || !Array.isArray(integration.scopes) || !integration.scopes.includes(readScope)) {
          throw new Error('The workspace did not confirm the permission changes.');
        }
        records = records.map((record) => record.id === id ? integration : record);
        cancelEdit(false);
        drawRecords();
        setMessage(listStatus, `Permissions saved for ${integration.name}. Reconnect your MCP client to refresh the available tools.`);
        recordControl('data-ai-edit', id)?.focus();
      } catch (error) {
        if (alive()) setMessage(editError, error.message || 'Could not save permissions.');
      } finally {
        if (alive()) {
          editFields.disabled = editCancel.disabled = editSubmit.disabled = false;
          editSubmit.textContent = 'Save permissions';
          if (editing && doc.activeElement === doc.body) editSubmit.focus();
        }
      }
    });

    cancelButton.addEventListener('click', () => cancelRevoke());
    confirmButton.addEventListener('click', async () => {
      if (!alive() || !revoking || confirmButton.disabled) return;
      const { id, name: connectionName } = revoking;
      setMessage(revokeError);
      confirmButton.disabled = cancelButton.disabled = true;
      confirmButton.textContent = 'Revoking…';
      try {
        const { integration } = await env.api(`${endpoint}/${pathPart(id)}`, { method: 'DELETE', plain: true, signal: request.signal });
        if (!alive()) return;
        if (integration?.id !== id || !integration.revokedAt) throw new Error('The workspace did not confirm revocation.');
        if (issuedId === id) clearToken(false);
        records = records.map((record) => record.id === id ? integration : record);
        drawRecords();
        cancelRevoke(false);
        setMessage(listStatus, `Revoked token for ${connectionName}.`);
        query('#ai-connections-tokens').focus();
      } catch (error) {
        if (alive()) setMessage(revokeError, error.message || 'Could not revoke the token.');
      } finally {
        if (alive()) {
          confirmButton.disabled = cancelButton.disabled = false;
          confirmButton.textContent = 'Revoke token';
          if (!confirm.hidden && doc.activeElement === doc.body) confirmButton.focus();
        }
      }
    });

    show.addEventListener('click', () => toggleToken(token.type === 'password'));
    query('[data-ai-dismiss]').addEventListener('click', () => clearToken());
    query('[data-ai-copy-token]').addEventListener('click', async () => {
      if (!alive() || !issuedId) return;
      const id = issuedId;
      try {
        await win.navigator.clipboard.writeText(token.value);
        if (alive() && issuedId === id) setMessage(tokenStatus, 'Token copied.');
      } catch {
        if (!alive() || issuedId !== id) return;
        toggleToken(true);
        token.focus();
        token.select();
        setMessage(tokenStatus, 'Clipboard unavailable. The token is selected for manual copying.');
      }
    });

    for (const button of target.querySelectorAll('[data-ai-copy]')) {
      button.addEventListener('click', async () => {
        if (!alive()) return;
        const code = doc.getElementById(button.dataset.aiCopy);
        const status = query('[data-ai-config-status]');
        try {
          await win.navigator.clipboard.writeText(code.textContent);
          if (alive()) setMessage(status, 'Example copied.');
        } catch {
          if (!alive()) return;
          const range = doc.createRange();
          range.selectNodeContents(code);
          const selection = win.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          setMessage(status, 'Clipboard unavailable. The example is selected for manual copying.');
        }
      });
    }

    target.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !alive()) return;
      if (editForm.contains(event.target) && editing) {
        if (editSubmit.disabled) return;
        cancelEdit();
      } else if (confirm.contains(event.target) && revoking) {
        if (confirmButton.disabled) return;
        cancelRevoke();
      } else if (issuedId) clearToken();
      else return;
      event.preventDefault();
      event.stopPropagation();
    }, { signal: request.signal });

    drawRecords();
  }

  win.addEventListener('pagehide', hidePage);
  load();
  return destroy;
}
