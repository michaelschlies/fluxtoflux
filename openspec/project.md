# Project: fluxtoflux

## Purpose
A bridge that keeps channels in sync between two or more Fluxer instances, for example the
public `fluxer.app` and a self-hosted instance, so two communities can talk to each other.

## Tech stack
- Node.js 24+, ES modules, **no runtime dependencies** (built-in `fetch`, `WebSocket`, `FormData`, `node:sqlite`)
- Tests: `node:test`; `ws` is a dev-only dependency used by the mock Fluxer server
- Packaging: Docker (`node:24-alpine`), Helm chart in `charts/fluxtoflux`, GitHub Actions publishing to GHCR

## Architecture
- `src/config.js`: loads and validates `config.json` (instances, links, options)
- `src/client.js`: `FluxerClient`, one per instance: discovery, REST with rate-limit handling, Gateway session
- `src/bridge.js`: `Bridge`, the relay logic: webhook provisioning, create/edit/delete mirroring
- `src/store.js`: SQLite map from source message to its mirrored copies
- `src/index.js`: wiring, `--check` mode, shutdown

Each instance has its own bot token and Gateway connection. Messages are mirrored by executing a
per-channel webhook on the destination so the sender's name and avatar are shown.

## Conventions
- Snowflake IDs are always strings; never parse them as numbers.
- Every request or event handler error is logged and isolated; one failing destination must not
  affect others.
- Specs under `openspec/specs/` describe behaviour that exists. Proposed work lives in `openspec/changes/`.
- Requirements use SHALL; every requirement has at least one scenario, and tests are named after scenarios.

## External API reference
Fluxer API docs live in the `fluxerapp/fluxer` repository under `fluxer_docs/src/content/docs`
(the Mintlify mirrors and `docs.canary.fluxer.app` are gone). Key pages: `gateway/overview.md`,
`http-api/messages.mdx`, `http-api/webhooks.mdx`, `topics/rate-limits.md`, `http-api/instance.mdx`.

## Constraints
- The bridge must run as exactly one process per configuration; a second instance would duplicate every message.
- Fluxer has no gateway intents; bot sessions receive events for every guild they belong to.
- Webhook execution is exempt from the global rate limit but still has per-route limits.
