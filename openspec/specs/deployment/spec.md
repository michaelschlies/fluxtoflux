# Deployment Specification

## Purpose
How the bridge is packaged, published and deployed: Docker image, Helm chart and GitHub Actions.

## Requirements

### Requirement: Container image
The system SHALL ship a `node:24-alpine` image that runs as a non-root user, reads its config from
`/config/config.json` (`BRIDGE_CONFIG`) and keeps its database under `/data`.

#### Scenario: Run
- **WHEN** the image is started with a config mounted at `/config/config.json`
- **THEN** it starts the bridge as the `node` user with no install step

### Requirement: Helm chart
The chart SHALL render a Deployment with exactly one replica and the `Recreate` strategy, a
ConfigMap holding the generated `config.json` (without tokens and with `dataDir` forced to `/data`),
and bot tokens as `FLUXER_TOKEN_<KEY>` environment variables from a Secret.

#### Scenario: Single replica
- **WHEN** the chart is rendered with any values
- **THEN** the Deployment has `replicas: 1` and `strategy.type: Recreate`

#### Scenario: Tokens required
- **WHEN** neither `tokens` nor `existingSecret` is set
- **THEN** rendering fails with a message saying so

#### Scenario: Existing secret
- **WHEN** `existingSecret` is set
- **THEN** no Secret is created and the pod loads environment from the named Secret

#### Scenario: Config change
- **WHEN** `config` values change
- **THEN** the pod template checksum annotation changes so the pod restarts

### Requirement: Hardened pod
The pod SHALL run non-root with a read-only root filesystem, dropped capabilities and no privilege escalation.

#### Scenario: Writable paths
- **WHEN** the pod runs
- **THEN** only `/data` is writable

### Requirement: Persistence
The chart SHALL by default create a PersistentVolumeClaim for `/data`, and SHALL fall back to an
`emptyDir` when persistence is disabled, warning in the install notes that edit and delete
tracking is lost on restart.

#### Scenario: Persistence disabled
- **WHEN** `persistence.enabled` is false
- **THEN** `/data` is an `emptyDir` and the notes contain a warning

### Requirement: Publishing pipeline
The GitHub Actions workflow SHALL run tests and chart lint on every push and pull request, build
and push a multi-arch (amd64, arm64) image to `ghcr.io/<owner>/<repo>` from `main` and `v*` tags
(never from pull requests), and push the chart to `oci://ghcr.io/<owner>/charts` on `v*` tags only.

#### Scenario: Pull request
- **WHEN** a pull request is opened
- **THEN** tests run and the image is built but not pushed

#### Scenario: Release tag
- **WHEN** tag `v1.2.3` is pushed
- **THEN** the image is tagged `1.2.3` and `1.2`, and chart version 1.2.3 is pushed
