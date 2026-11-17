# Instance Connection Specification

## Purpose
How the bridge talks to one Fluxer instance: discovering its endpoints, calling its REST API
and holding a Gateway session open. Implemented by `FluxerClient` in `src/client.js`.

## Requirements

### Requirement: Endpoint discovery
The system SHALL fetch `<origin>/.well-known/fluxer` and use `endpoints.api_public` (falling back to
`endpoints.api`) with a `/v1` suffix as the REST base, and `endpoints.gateway` as the Gateway URL.

#### Scenario: Custom instance
- **WHEN** an instance origin is `https://chat.example.com` and its discovery document lists a different API host
- **THEN** REST calls go to the discovered API host, not the origin

#### Scenario: Discovery fails
- **WHEN** the discovery request returns a non-2xx status
- **THEN** startup fails with an error naming the origin and the process exits non-zero

### Requirement: Bot authentication
The system SHALL send `Authorization: Bot <token>` on REST calls, except webhook-token routes,
which SHALL be sent without an `Authorization` header.

#### Scenario: Webhook execution
- **WHEN** a message is posted through a webhook
- **THEN** the request carries no `Authorization` header

#### Scenario: Gateway identify
- **WHEN** the Gateway session is identified
- **THEN** the raw token (no `Bot ` prefix) is sent in the Identify payload

### Requirement: Rate limit handling
The system SHALL, on HTTP 429, wait `retry_after` seconds from the response body (plus a small margin)
and retry, up to 6 retries. When the response is `global`, the system SHALL delay every
subsequent request on that client until the global window has passed.

#### Scenario: Route rate limit
- **WHEN** a request receives 429 with `retry_after: 0.5`
- **THEN** the request is retried after about 0.5 s and its result is returned to the caller

#### Scenario: Global rate limit
- **WHEN** a request receives 429 with `global: true`
- **THEN** other requests on the same client wait for the window before being sent

#### Scenario: Persistent rate limit
- **WHEN** a request is still rate limited after 6 retries
- **THEN** the call fails with an error carrying status 429

### Requirement: Transient and permanent errors
The system SHALL retry HTTP 5xx responses up to 3 times with exponential backoff, SHALL NOT retry
other 4xx responses, and SHALL surface failures as errors carrying `status` and the API `code`.

#### Scenario: Server error then success
- **WHEN** a request gets a 500 followed by a 200
- **THEN** the caller receives the 200 result

#### Scenario: Client error
- **WHEN** a request gets 404 `UNKNOWN_WEBHOOK`
- **THEN** it is not retried and the error has `status` 404 and `code` `UNKNOWN_WEBHOOK`

### Requirement: Gateway session lifecycle
The system SHALL connect with `v=1&encoding=json`, wait for Hello, heartbeat at the given interval
with the last sequence number, identify, record `session_id` and the bot user from READY, and
re-emit every Dispatch as an event named after its type.

#### Scenario: Normal start
- **WHEN** the Gateway sends Hello and then READY
- **THEN** the client has identified, has `user` and `sessionId` set, and has emitted `READY`

#### Scenario: Dispatch forwarding
- **WHEN** a `MESSAGE_CREATE` Dispatch arrives
- **THEN** a `MESSAGE_CREATE` event is emitted with its payload

### Requirement: Heartbeat liveness
The system SHALL answer a server heartbeat request immediately, and SHALL close the socket with a
non-1000 code and reconnect when a heartbeat is not acknowledged before the next one is due.

#### Scenario: Missed acknowledgement
- **WHEN** the server stops sending Heartbeat ACK
- **THEN** the client closes the socket and reconnects

### Requirement: Resume and reconnect
The system SHALL reconnect after any non-fatal close using exponential backoff with jitter
(capped at 30 s) and SHALL attempt to Resume with the stored `session_id` and last sequence.
On Invalid Session it SHALL discard the session and Identify again after a short random delay.
On Reconnect (opcode 7) it SHALL close with a non-1000 code so the session stays resumable.

#### Scenario: Dropped connection
- **WHEN** the socket closes with code 1006 after READY
- **THEN** the client reconnects and sends Resume with its `session_id` and sequence

#### Scenario: Session rejected
- **WHEN** the server answers Resume with Invalid Session
- **THEN** the client sends a fresh Identify

### Requirement: Fatal close codes
The system SHALL NOT reconnect after close codes 4004, 4010, 4011 or 4012, and SHALL emit a
`fatal` event; the process SHALL exit non-zero.

#### Scenario: Bad token
- **WHEN** the Gateway closes with 4004
- **THEN** no reconnect is attempted and `fatal` is emitted

### Requirement: Graceful stop
The system SHALL stop heartbeating and SHALL NOT reconnect after `stop()` is called.

#### Scenario: Shutdown
- **WHEN** `stop()` is called and the socket closes
- **THEN** no new connection is opened
