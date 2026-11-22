import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createAnthropicJournalClient, DEFAULT_JOURNAL_MODEL, journalOutputSchema } from '../backend/journal.mjs';

const request = { apiKey: 'sk-ant-private-fixture', model: DEFAULT_JOURNAL_MODEL, system: 'Private fixture prompt',
  user: 'Private fixture context', schema: journalOutputSchema() };
const privateDetails = `${request.apiKey} / ${request.system} / ${request.user}`;
const networkError = (cause) => new TypeError(privateDetails, { cause });
const connectionError = (code) => Object.assign(new Error(privateDetails), { code, syscall: 'connect' });
const output = { title: 'Daily review' };

function claudeResponse(body = {}) {
  return Response.json({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: privateDetails },
    { type: 'text', text: JSON.stringify(output) }], ...body }, { headers: { 'request-id': 'req_fixture' } });
}

function sanitizedError(pattern, status) {
  return (error) => {
    assert.match(error.message, pattern);
    for (const detail of [request.apiKey, request.system, request.user]) assert.equal(error.message.includes(detail), false);
    assert.equal(error.cause, undefined);
    assert.equal(error.status, status);
    return true;
  };
}

test('journal gives Sonnet 5.5 more output room and medium effort while retaining other model settings', async () => {
  const bodies = [];
  const client = createAnthropicJournalClient({ fetcher: async (url, { body }) => {
    bodies.push(JSON.parse(body));
    return claudeResponse();
  } });
  await client(request);
  await client({ ...request, model: 'claude-haiku-4-5-20251001' });
  assert.equal(bodies[0].max_tokens, 12_000);
  assert.equal(bodies[0].output_config.effort, 'medium');
  assert.deepEqual(bodies[0].output_config.format, { type: 'json_schema', schema: request.schema });
  assert.equal(bodies[0].thinking, undefined);
  assert.equal(bodies[1].max_tokens, 6500);
  assert.equal(bodies[1].output_config.effort, undefined);
});

test('journal retries a pre-connect failure once using the original request and deadline', async () => {
  const attempts = [];
  const client = createAnthropicJournalClient({ fetcher: async (url, init) => {
    attempts.push({ url, init });
    if (attempts.length === 1) throw networkError({ code: 'EAI_AGAIN', message: privateDetails });
    return claudeResponse();
  } });
  assert.deepEqual(await client(request), { output, model: request.model, responseId: 'req_fixture' });
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].url, attempts[1].url);
  assert.equal(attempts[0].init.body, attempts[1].init.body);
  assert.equal(attempts[0].init.signal, attempts[1].init.signal);
  assert.equal(attempts[1].init.redirect, 'error');
});

test('journal stops after its second pre-connect failure, including aggregate connection errors', async () => {
  let attempts = 0;
  const cause = new AggregateError([connectionError('ECONNREFUSED'), connectionError('ETIMEDOUT')], privateDetails);
  const client = createAnthropicJournalClient({ fetcher: async () => { attempts++; throw networkError(cause); } });
  await assert.rejects(client(request), sanitizedError(/timed out/));
  assert.equal(attempts, 2);
});

test('journal sanitizes DNS, TLS and ambiguous transport failures without replaying the request', async () => {
  for (const [cause, message] of [
    [{ code: 'ENOTFOUND' }, /DNS could not resolve/],
    [{ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }, /secure connection.*trusted certificates/],
    [{ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, /secure connection.*trusted certificates/],
    [{ code: 'UND_ERR_HEADERS_TIMEOUT' }, /timed out/],
    [{ code: 'ECONNRESET', syscall: 'read' }, /could not be reached.*network and proxy/],
    [new AggregateError([connectionError('ECONNREFUSED'), { code: 'UND_ERR_SOCKET' }]), /could not be reached/],
    [{ code: privateDetails }, /could not be reached/],
  ]) {
    let attempts = 0;
    const client = createAnthropicJournalClient({ fetcher: async () => { attempts++; throw networkError(cause); } });
    await assert.rejects(client(request), sanitizedError(message));
    assert.equal(attempts, 1);
  }
});

test('journal returns actionable HTTP errors and discards the provider error body', async () => {
  for (const [status, message] of [[400, /selected model and Claude workspace limits/], [401, /saved Anthropic API key/],
    [402, /billing details/], [403, /workspace and API key can access/], [404, /model is available/],
    [413, /request size/], [429, /rate and spend limits/], [500, /Try generating/],
    [504, /timed out while generating/], [529, /temporarily overloaded/]]) {
    let attempts = 0;
    let cancelled = false;
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(privateDetails)); },
      cancel() { cancelled = true; } });
    const response = new Response(body, { status });
    const client = createAnthropicJournalClient({ fetcher: async () => { attempts++; return response; } });
    await assert.rejects(client(request), sanitizedError(message, status));
    assert.equal(attempts, 1);
    assert.equal(cancelled, true);
  }
});

test('journal respects caller cancellation before the request and during a retry delay', async () => {
  let attempts = 0;
  const reason = new Error('Cancelled by the caller');
  const controller = new AbortController();
  const client = createAnthropicJournalClient({ fetcher: async () => {
    attempts++;
    setImmediate(() => controller.abort(reason));
    throw networkError(connectionError('ECONNREFUSED'));
  } });
  await assert.rejects(client({ ...request, signal: AbortSignal.abort(reason) }), (error) => error === reason);
  assert.equal(attempts, 0);
  await assert.rejects(client({ ...request, signal: controller.signal }), (error) => error === reason);
  assert.equal(attempts, 1);
});

test('journal enforces its overall timeout during retry backoff and body consumption', async () => {
  let attempts = 0;
  const connectClient = createAnthropicJournalClient({ timeoutMs: 5, fetcher: async () => {
    attempts++;
    throw networkError({ code: 'UND_ERR_CONNECT_TIMEOUT' });
  } });
  await assert.rejects(connectClient(request), sanitizedError(/timed out/));
  assert.equal(attempts, 1);

  const bodyClient = createAnthropicJournalClient({ timeoutMs: 5, fetcher: async (url, { signal }) => {
    attempts++;
    return { ok: true, json: () => delay(500, undefined, { signal }) };
  } });
  await assert.rejects(bodyClient(request), sanitizedError(/timed out/));
  assert.equal(attempts, 2);
});

test('journal rejects interrupted, malformed and incomplete responses without exposing their content', async () => {
  for (const [response, message] of [
    [{ ok: true, json: async () => { throw networkError({ code: 'UND_ERR_SOCKET' }); } }, /response was interrupted/],
    [new Response(privateDetails), /invalid API response/],
    [Response.json(null), /invalid API response/],
    [claudeResponse({ content: { text: privateDetails } }), /invalid API response/],
    [claudeResponse({ content: [null, { type: 'text', text: privateDetails }] }), /structured journal document/],
    [claudeResponse({ stop_reason: 'max_tokens' }), /output token limit/],
    [claudeResponse({ stop_reason: 'refusal', stop_details: { explanation: privateDetails } }), /declined/],
    [claudeResponse({ stop_reason: 'model_context_window_exceeded' }), /context limit/],
  ]) {
    let attempts = 0;
    const client = createAnthropicJournalClient({ fetcher: async () => { attempts++; return response; } });
    await assert.rejects(client(request), sanitizedError(message));
    assert.equal(attempts, 1);
  }
});
