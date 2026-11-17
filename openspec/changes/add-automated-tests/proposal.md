# Change: Add automated test suite

## Why
The bridge had no committed tests. It had only a throwaway smoke test, and everything involving
attachments, rate limits, Gateway recovery and failure isolation was unverified.

## What Changes
- Add a `node:test` suite in `test/` covering every requirement in `openspec/specs/`
- Add a mock Fluxer instance (`test/helpers/mock-instance.js`): discovery, REST, webhooks,
  multipart parsing, a Gateway WebSocket, and fault injection (429, 5xx, close codes, missing heartbeat ACKs)
- Add `ws` as a dev dependency (the mock only); the runtime stays dependency-free
- Run the suite and report coverage in CI
- Fix defects found while writing the specs:
  - Edit hash mixed fallback attachment links into the comparison, so an unfurl update could strip them
  - Channel IDs as bare JSON numbers were silently corrupted
  - Instance keys that cannot be env var names were accepted
  - A channel used in two links was silently overwritten
- Add timing knobs to `FluxerClient` and `Bridge.idle()` so tests are fast and deterministic

## Impact
- Affected specs: all (tests trace to scenarios); config validation additions are already reflected in `channel-linking`
- Affected code: `src/config.js`, `src/client.js`, `src/bridge.js`; no behaviour change for valid existing configs
  except that configs with bare numeric channel IDs, duplicate channels or hyphenated instance keys now fail fast
