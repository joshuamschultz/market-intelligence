# Local Desktop quickstart

This guide is for the configured macOS preview on the user's computer. The `market-*` zsh shortcuts manage the local app and daily price capture; they do not erase or replace the SQLite history. They are defined in `~/.setup/.aliases` and call the workspace CLI in this project. If the shortcuts are not loaded in a shell, use the equivalent `npm run app` / `npm run update` commands below.

The current package version is 0.2.7. Use `market-status` or `/api/v1/build` to check which immutable build the managed service is currently running.

## Open and check the app

Open Terminal and run. In a terminal tab opened before the aliases were installed, first run `source ~/.setup/.aliases`; new terminal tabs load them automatically from zsh startup.

```sh
market-start
market-status
```

`market-start` starts or reuses the managed macOS service and opens the app at <http://127.0.0.1:4173>. `market-status` prints the active build and URL, latest source session/data revision/calculation, and separate verified, preparing, and unverified analysis status. It also reports an active pinned five-year job. The local service keeps the database under the workspace's private `data/` directory. A browser refresh updates the app UI; it does not clear the warehouse.

Equivalent direct commands:

```sh
npm run app -- start
npm run app -- status
```

For a fresh clone with no active release, use `npm run app -- start --workspace`; this runs the source workspace and does not change a release pointer. Use `--no-open` with `start` to skip opening the browser.

To stop the service without deleting data:

```sh
market-stop
```

Equivalent command: `npm run app -- stop`. This stops the managed service, not the local database.

To check the exact app build, open <http://127.0.0.1:4173/api/v1/build>. Use the app's Settings → Data Quality and job status when a screen says its requested context is unprepared or partial.

## Update daily market data

After the provider has finalized a session (the configured schedule is 16:30 America/New_York), run:

```sh
market-update --wait-analysis
market-status
```

This asks for the newest finalized session and waits for analysis for that exact session and revision; it skips already verified capture instead of downloading the full history again. Plain `market-update` queues the daily update and returns without waiting for its analysis. To catch up a specific recent session, add its date; repeat `--date` for up to five recent sessions:

```sh
market-update --date YYYY-MM-DD
market-update --date YYYY-MM-DD --date YYYY-MM-DD
```

The equivalent direct command is `npm run update -- --date YYYY-MM-DD`. Add `--wait` to follow only daily capture/import jobs. To wait for the exact session and revision's full current-day analysis, use `market-update --wait-analysis` or `npm run update -- --wait-analysis`; this does not rebuild every historical context. The command reports daily publication separately from full-analysis readiness. Check `market-status` and the UI's readiness status before relying on the new date. When a previous capture is already verified but unpublished, the update flow can recover publication locally rather than downloading the same data again.

The update command defaults to the latest finalized exchange session at 16:30 America/New_York (or `MARKET_SYNC_AFTER`). It skips an already published date and does not download the full history again. Updates are deferred while a pinned five-year build is running. Date-specific requests are limited to five recent sessions; current-roster verification is limited to a seven-calendar-day window.

The warehouse retains prior imported rows. A normal daily update fetches only missing finalized sessions and appends calculations from stored outputs. A source correction, split change, new reference, or changed universe/model/calculation scope needs an explicit verified backfill of affected history. The five-year 1,260-session archive is published and ready; its cold rebuild took 72.6 minutes, exceeding the ten-minute target. A V8 synthetic next-session replay completed in 179.137 seconds, but used synthetic prices and uncontrolled filesystem cache, excluded external provider/transport, and left the live warehouse unchanged. Ordered multi-day catch-up and recovery paths passed 64 focused tests; a real next-trading-day run remains unobserved.

## Fresh setup and credentials

The configured aliases point to the project under `~/Projects/market-intelligence`; they can be run from another working directory. For another clone or machine, install Node.js 26 LTS (tested here; the package supports `^24.15.0 || >=26.0.0`), then install dependencies and start a workspace server:

```sh
npm ci
npm run app -- start --workspace
```

A fresh Git clone does not include the ignored `data/` warehouse or private `.env`; its UI starts without this workspace's historical market data until you import or capture data. To enable scheduled daily price imports and post-import calculations on a new machine, copy `.env.example` to `.env` and set `MARKET_SYNC=1` and `MARKET_PRECOMPUTE=1`. The schedule runs at 16:30 America/New_York by default; set `MARKET_SYNC_AFTER` to change it. Add your own `EODHD_API_KEY` for authenticated capture. Keep `.env` local and private. Do not copy private data or credentials into a public repository. The configured Desktop shortcuts use the existing local workspace and its persistent warehouse.

On other platforms, the managed service uses macOS launchd and is unavailable; use `npm start` and open the local URL yourself.

On the configured Mac, stop the managed service with `market-stop` before running `npm start` or `npm run dev` against its database. Do not run two server processes against the same `MARKET_DB`; a duplicate process can interfere with job handling. When finished with the foreground server, stop it with Ctrl+C and restore the managed preview using `market-start`.

Use `npm run dev` when actively editing and want file watching. If provider capture is needed on a new setup, copy `.env.example` to `.env` and add your own `EODHD_API_KEY` locally. Do not put keys in shell history, docs, screenshots, frontend code, or messages. If a credential has not been configured, the UI can still be used with the data already in the local warehouse, but no new provider capture should be assumed.

## If a page is not ready

1. Run `market-status` and note the active build, data version, and job state.
2. In the app, open Settings → Data Quality and the job/readiness panel. A provider receipt, warehouse import, and prepared analytics are separate milestones.
3. Wait for the matching context job to complete or ask the workspace operator to prepare it. Do not start a second full-history calculation just because one chart is still waiting.
4. If prices were added or corrected, keep the capture receipt and provenance state; no manual database edit is required.

A visible day in the calendar does not promise complete whole-market coverage on that day. Early 2015–2016 history is sparse, float is unavailable, SEC classification joins use the current catalog, and Nasdaq typed classifications are current-reference data rather than a dated historical series. See [Remaining work](REMAINING-WORK.md) for the current acceptance gaps and [Operations](OPERATIONS.md) for recovery procedures.
