# Tasks

## 1. Production changes for testability and the defects above
- [x] 1.1 Validate instance keys, channel ID type and duplicate channels in `src/config.js`
- [x] 1.2 Hash raw source text for edit comparison; restate only oversize links on edit
- [x] 1.3 Add `retryBaseMs`, `reconnectBaseMs`, `invalidSessionDelay` to `FluxerClient`
- [x] 1.4 Add `Bridge.idle()`
- [x] 1.5 Fix heartbeat timer leak: the initial jitter timeout was never cleared, so a reconnect or `stop()` left an orphaned interval running (found while writing the `stop` tests)

## 2. Test infrastructure
- [x] 2.1 `ws` dev dependency, `npm test` and `npm run coverage` scripts
- [x] 2.2 `test/helpers/mock-instance.js` with fault injection
- [x] 2.3 CI runs `npm ci && npm run coverage`

## 3. Tests (one file per spec)
- [x] 3.1 `config.test.js`: channel-linking config scenarios
- [x] 3.2 `store.test.js`: message-sync mapping scenarios
- [x] 3.3 `client.test.js`: instance-connection scenarios
- [x] 3.4 `relay.test.js`: message-relay scenarios and webhook provisioning
- [x] 3.5 `attachments.test.js`: attachments scenarios
- [x] 3.6 `sync.test.js`: message-sync edit and delete scenarios
- [x] 3.7 `e2e.test.js`: real process, `--check`, fatal gateway close, startup failures

## 4. Verification
- [x] 4.1 All 155 tests pass on Node 24, stable across 5 consecutive runs
- [x] 4.2 Coverage reviewed: 99.5% lines, 95.3% branches. Uncovered: the SIGINT/SIGTERM shutdown handler in `src/index.js` (signals cannot be delivered portably on Windows) and the `ws.onerror` logger
- [x] 4.3 Regression tests verified to fail when their fix is reverted (edit-hash bug, heartbeat timer leak)
- [ ] 4.4 Render the Helm chart with `helm template` and check it against `specs/deployment` (helm not installed locally; CI's `test` job runs `helm lint` and `helm template`)
- [ ] 4.5 Build the Docker image (docker not installed locally)
- [ ] 4.6 Run `--check` and a live relay against a real Fluxer instance
