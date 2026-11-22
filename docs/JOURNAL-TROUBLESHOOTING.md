# Market Journal connection troubleshooting

Market Journal generation sends the selected market context, active prompt, and—only when explicitly selected—the dated personal note to Anthropic. A failed provider request does not create a journal entry. The job details show the returned status or a short transport message.

The Market Journal API key in **Settings → Journal** is separate from the bearer token used by external AI research clients. Journal errors concern Anthropic Messages API access, model availability, request limits, or network transport; changing an MCP research token will not fix them.

## Diagnose the error

| Error | What to check |
| --- | --- |
| HTTP 401 | Replace or correct the Anthropic API key in Market Journal settings. |
| HTTP 403 | Confirm the Anthropic account and key can use the selected model. |
| HTTP 400 | Check the selected model and Claude workspace request limits. |
| HTTP 402 | Check billing in the Claude Console. |
| HTTP 404 | Confirm the selected Claude model is available to the account. |
| HTTP 429 | Check rate and spend limits before retrying. |
| HTTP 504 or a request timeout | The request exceeded the shared 120-second deadline; try again when the connection is stable. |
| Output-token limit | Claude stopped before completing the structured journal. Shorten the saved prompt or reduce the requested detail before retrying. |
| Context-window limit | Reduce the amount of market context or prior journal material in the request. |
| Refusal | Review the saved prompt and any personal note explicitly included in the request. |
| DNS error | Check that system DNS can resolve the Claude API host. |
| TLS/certificate error | Check the system clock and trusted certificates. Do not disable TLS verification. |
| Network unreachable or refused | Check the network and proxy configuration, then retry. |
| Interrupted response or malformed provider response | The response was incomplete or invalid. Retry after checking connectivity; the tool does not automatically replay an ambiguous request. |

The client makes at most one automatic retry, after a short delay, only for unambiguous connection failures before request transmission: temporary DNS resolution, connection timeout, or selected connect-stage reachability errors. Both attempts share the same 120-second deadline. It does not automatically retry HTTP responses, TLS failures, socket resets, or interrupted response bodies. This avoids replaying a request when it is unclear whether the provider received it.

## Preserve the journal setup

Correct the indicated cause in **Settings → Journal**, then submit the same date and context again. Transport failures do not replace the saved model, prompt, personal note, or encrypted API key. The API key is stored in the local journal vault; do not copy it into a job description, prompt, note, log, or support message. Error messages are sanitized so credential text is not surfaced. Never bypass TLS checks to make a connection succeed.

Repeated identical generation requests are keyed to their market context, model, prompt version, and note selection/version. A queued or running duplicate reuses the existing job; once an entry has been saved, the same inputs return that entry rather than adding a duplicate. An intentional **Force regenerate** creates a new revision. A manual retry after an interrupted network response may issue a new provider request if the earlier response was lost; local entry de-duplication does not prove the provider made no charge.

If the error persists, record the job ID, HTTP status or sanitized transport message, model ID, prompt version, and analysis date. Do not include the API key, private note text, or full prompt.
