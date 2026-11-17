# fluxtoflux

Bridges channels between two (or more) Fluxer instances, e.g. `fluxer.app` and a self-hosted one.
Zero dependencies; needs Node 24+ (built-in `WebSocket`, `fetch`, `node:sqlite`).

## Setup

1. On **each** instance, create an application, add a bot, and copy its token (`APP_ID.SECRET`).
   Invite the bot to the guild with: View Channel, Read Message History, Manage Webhooks
   (or skip Manage Webhooks and supply `links[].webhooks`, see below).
2. `copy config.example.json config.json` and fill in origins, tokens and channel IDs.
   Tokens can also come from `FLUXER_TOKEN_<INSTANCEKEY>` env vars (e.g. `FLUXER_TOKEN_MAIN`).
3. `npm run check` verifies discovery, channel access and webhook creation without starting the bridge.
4. `npm start`.

Each instance's API and gateway URLs come from `/.well-known/fluxer`, so a custom instance only needs its origin.

## What syncs

| | |
|---|---|
| New messages and replies | yes, posted via a per-channel webhook so the sender's name and avatar show (`alice · fluxer.app`) |
| Edits and deletes | yes (including bulk delete), via a SQLite id map in `data/` (90 days retained) |
| Attachments | re-uploaded, up to `maxAttachmentBytes`; larger or failed ones become links |
| Mentions | rendered as plain `@name`; `allowed_mentions` is empty so the bridge never pings anyone |
| Replies | shown as a `> ↪ name: snippet` quote line |
| Reactions, stickers, embeds, threads, history backfill | not yet |

## Config notes

- `links[].channels` maps instance key to channel ID; a link can have more than two members.
- `links[].oneWayFrom: "main"` makes a link one-directional.
- `links[].webhooks: { "main": "https://.../v1/webhooks/ID/TOKEN" }` uses an existing webhook instead of auto-creating one.
- Echo loops are prevented by ignoring the bridge's own webhooks and bot user. `options.bridgeBots: true` also forwards other bots and webhooks; leave it off unless you need it.
- Messages in a channel that is linked on one side only are ignored.

## Development

```sh
npm install        # dev dependency only (ws, for the mock server); the bridge itself has none
npm test           # node:test, ~4 s
npm run coverage
```

The suite runs against an in-process mock Fluxer instance (`test/helpers/mock-instance.js`) with fault
injection for 429s, 5xx, Gateway close codes and missing heartbeat ACKs. Behaviour is specified in
`openspec/specs/*/spec.md`; each test file names the spec it covers, and test names follow the scenarios.
Proposed changes go in `openspec/changes/`.

## Docker and Kubernetes

```sh
docker build -t fluxtoflux .
docker run -v ./config.json:/config/config.json:ro -v fluxdata:/data fluxtoflux
```

`.github/workflows/publish.yml` lints the chart, then builds a multi-arch image to `ghcr.io/<owner>/<repo>` on pushes to `main` (tags `main`, `latest`, `sha-…`) and on `v*` tags (semver tags). On `v*` tags it also pushes the chart to `oci://ghcr.io/<owner>/charts`.

```sh
kubectl create secret generic fluxtoflux-tokens \
  --from-literal=FLUXER_TOKEN_MAIN=APP_ID.SECRET --from-literal=FLUXER_TOKEN_CUSTOM=APP_ID.SECRET
helm install bridge oci://ghcr.io/<owner>/charts/fluxtoflux --version 0.1.0 \
  --set image.repository=ghcr.io/<owner>/<repo> --set existingSecret=fluxtoflux-tokens \
  -f my-values.yaml   # config.instances / config.links, see charts/fluxtoflux/values.yaml
```

The chart always runs one replica (`Recreate` strategy), because a second would mirror every message twice. Instance keys must be alphanumeric, since tokens travel as `FLUXER_TOKEN_<KEY>`.

## Caveat

Written against the Fluxer docs in the `fluxerapp/fluxer` repo and tested against a mock server, not yet against live instances. Run `npm run check` first.
