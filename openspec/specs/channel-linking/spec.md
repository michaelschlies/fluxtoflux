# Channel Linking Specification

## Purpose
How operators declare which channels are bridged, and how the bridge validates that
configuration and provisions the webhooks it needs. Implemented by `src/config.js`,
`Bridge.setupWebhooks` and the `--check` mode of `src/index.js`.

## Requirements

### Requirement: Configuration source
The system SHALL read configuration from the path in `BRIDGE_CONFIG`, defaulting to `config.json`,
and SHALL fail with a message naming the path when it cannot be read or parsed.

#### Scenario: Missing file
- **WHEN** the configuration file does not exist
- **THEN** startup fails with an error mentioning the path and `config.example.json`

### Requirement: Instance definitions
The system SHALL require each instance to have an `origin` and a token. The token SHALL be taken from
`FLUXER_TOKEN_<KEY>` (key upper-cased) when set, otherwise from the file. A leading `Bot ` SHALL be
stripped, trailing slashes on the origin removed, and `label` SHALL default to the key.
Instance keys SHALL contain only letters, digits and underscores.

#### Scenario: Token from environment
- **WHEN** `FLUXER_TOKEN_MAIN` is set and the file also has a token for `main`
- **THEN** the environment value is used

#### Scenario: Token omitted from file
- **WHEN** the file has no token for `main` but `FLUXER_TOKEN_MAIN` is set
- **THEN** configuration loads successfully

#### Scenario: Invalid key
- **WHEN** an instance key is `my-instance`
- **THEN** loading fails because the key cannot form an environment variable name

### Requirement: Link definitions
The system SHALL require every link to name at least two channels, each on a configured instance,
with the channel ID given as a quoted numeric string. A channel SHALL NOT appear in more than one
link. `oneWayFrom`, when present, SHALL name one of the link's instances.

#### Scenario: Numeric channel ID
- **WHEN** a channel ID is written as a bare JSON number
- **THEN** loading fails, because the value would already have lost precision

#### Scenario: Channel reused
- **WHEN** the same instance and channel ID appear in two links
- **THEN** loading fails naming the channel

#### Scenario: Unknown instance
- **WHEN** a link references an instance key that is not defined
- **THEN** loading fails naming the link and the key

### Requirement: Option defaults
The system SHALL default `bridgeBots` to false, `bridgeReactions` to true, `bridgeThreads` to true,
`maxAttachmentBytes` to 25 MiB and `dataDir` to `data`.

#### Scenario: No options block
- **WHEN** the file has no `options`
- **THEN** all five defaults apply

### Requirement: Backfill configuration
The system SHALL accept `links[].backfill` with exactly one of `since` (a parseable date) or `limit`
(a positive integer), and SHALL fail loading otherwise.

#### Scenario: Valid
- **WHEN** a link has `backfill: { since: "2026-01-01" }` or `backfill: { limit: 50 }`
- **THEN** configuration loads

#### Scenario: Invalid
- **WHEN** `backfill` has both keys, neither, an unparseable date, or a limit of 0 or 1.5
- **THEN** loading fails mentioning backfill

### Requirement: Webhook provisioning
For every linked channel the system SHALL resolve a webhook before connecting to the Gateway: the
URL in `links[].webhooks.<instance>` if given, otherwise an existing webhook named `Fluxer Bridge`
that has a token, otherwise a newly created one. Any failure SHALL abort startup.

#### Scenario: First run
- **WHEN** a channel has no bridge webhook
- **THEN** one named `Fluxer Bridge` is created through the REST API

#### Scenario: Restart
- **WHEN** the channel already has a `Fluxer Bridge` webhook
- **THEN** it is reused and none is created

#### Scenario: Configured webhook URL
- **WHEN** `links[].webhooks.main` is set
- **THEN** its ID and token are used and the webhook list and create endpoints are not called

#### Scenario: Missing permission
- **WHEN** creating a webhook returns 403
- **THEN** startup fails

### Requirement: Dry-run check
`--check` SHALL verify discovery, read access to every linked channel and webhook provisioning,
print one line per result, and exit 0 only if everything passed. It SHALL NOT open Gateway
connections or create the message store.

#### Scenario: Inaccessible channel
- **WHEN** a linked channel returns 404
- **THEN** a `FAIL` line names the instance, link and channel and the exit code is 1
