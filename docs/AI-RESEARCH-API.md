# AI research API and workspace creation

The research API/MCP catalog provides prepared-data reads and two narrowly scoped creation tools. Reads do not modify data. `create_watchlist` and `create_screen` can add saved workspace items only when the integration has the optional `research:workspace:create` permission and the user has explicitly requested the creation.

Check `/api/v1/build` to confirm the active release exposes the tools. The REST API and MCP use the same catalog: list tool schemas with `GET /research/v1/tools`, then call a named tool through `POST /research/v1/tools/{name}` or the MCP tool of the same name. Research requests require the integration's dedicated bearer token.

## Permissions

Every integration includes `research:read`. Workspace creation is a separate optional permission, `research:workspace:create`; it allows only `create_watchlist` and `create_screen`. Existing tokens do not receive the new permission automatically. In **Settings → AI connections**, edit that token's permissions, select **Create watchlists and saved screens**, and save. Reconnect the MCP client so it refreshes its available tool list. A token without the permission cannot invoke the creation tools.

Private-note and journal permissions remain separate. This permission cannot edit or delete existing items, change settings, write notes, import data, fetch provider data, or place orders.

## `create_watchlist`

Creates a manual watchlist that can be selected as a normal workspace and ChartBook source. Its inputs are:

| Field | Contract |
| --- | --- |
| `name` | Required string, 1–100 characters after trimming. |
| `idempotencyKey` | Required stable key, 1–128 characters, starting with a letter or digit and continuing with letters, digits, `.`, `_`, `:`, or `-`. Reuse it for a retry of the same creation. |
| `members` | Required array of up to 200 ticker symbols or permanent security IDs. Each entry is a printable string up to 180 characters. |

The server resolves tickers against the current market date and selected local identity records. Every supplied member must resolve to exactly one security; unknown or ambiguous names reject the whole request. It does not partially create a list. Permanent security IDs avoid ticker ambiguity.

## `create_screen`

Creates a saved screen that evaluates supported prepared fields for the latest completed session. It can be used from Saved Screens and as a ChartBook source. Inputs are:

| Field | Contract |
| --- | --- |
| `name` | Required string, 1–100 characters after trimming. |
| `idempotencyKey` | Required stable key, with the same character rules and retry behavior as `create_watchlist`. |
| `filters` | Optional array of at most 12 typed conditions on allowlisted prepared fields. |
| `combine` | Optional `and` or `or`; defaults to `and`. |
| `sort` | Optional array of 1–4 allowlisted fields and `asc`/`desc` directions; defaults to RS rank ascending. |
| `fields` | Optional array of 1–20 prepared fields to display. |
| `q` | Optional text search, up to 100 characters. |
| `includeUntraded` | Optional boolean; defaults to `false`. |

Conditions use typed operators: equality/inequality, numeric or date comparisons, `in`, text `contains`, numeric/date `between`, and missing/present or boolean checks. The active tool schema is authoritative for exact field names and value types. Unsupported fields, formulas, custom history windows, and definitions requiring new calculations are rejected. Saving a screen does not compute historical results or create a calculation requirement. The saved definition follows latest prepared data when evaluated.

## Retries and results

Each creation requires an idempotency key. Repeating the same request with the same key and integration returns the original saved item. Reusing that key with a changed request returns HTTP `409`; use a fresh key for a distinct item. A different key with the same name creates another item; names do not overwrite existing lists or screens.

A successful response has `state: "created"` and `data.saved` with the saved item's kind, ID, version, name, definition, timestamps, and deletion state. Permission failures return `403`; invalid inputs or unresolved members return `400`; a changed-payload key conflict returns `409`. The MCP tool reports the same error conditions through its tool result.

## Scope boundaries

Read tools remain read-only and are available under `research:read`. The optional creation permission adds only these two create operations. There is no generic workspace write, edit, delete, arbitrary SQL, new calculation, historical backfill, provider download, or mutation of raw price data. Keep the token private and grant the creation permission only to clients that need it.
