# History Backfill Specification

## Purpose
How history that the bridge did not see live is relayed: a first backfill when a link is created, and
catch-up after downtime. Implemented by `Bridge.catchUp`, `Bridge.holdForCatchUp`, the `watermarks`
table in `src/store.js` and the `--backfill` mode of `src/index.js`.

## Requirements

### Requirement: Backfill request
The system SHALL, for a link with `backfill` configured and no watermark, fetch the history of each
origin channel and relay each bridgeable message that has no mapping, oldest first. `backfill.since`
SHALL select messages posted at or after a date and `backfill.limit` the most recent N messages. It
SHALL NOT fetch history for a link that has neither `backfill` nor a watermark.

#### Scenario: Since a date
- **WHEN** a link has `backfill: { since: <5 days ago> }` and the origin has messages 10, 4, 3 and 1 days old
- **THEN** the last three are delivered, oldest first

#### Scenario: Limit
- **WHEN** a link has `backfill: { limit: 2 }` and the origin has four messages
- **THEN** the two most recent are delivered, oldest first

#### Scenario: Long history
- **WHEN** the limit is 150 and the origin has 230 messages
- **THEN** 150 messages are delivered across several history pages

#### Scenario: Not configured
- **WHEN** a link without a watermark has no `backfill` configuration
- **THEN** no history is fetched

### Requirement: Idempotence
The system SHALL skip a message that already has a mapping for a destination, so a repeated or
interrupted backfill creates no duplicates, and SHALL still deliver to destinations that lack a copy.

#### Scenario: Re-run
- **WHEN** a backfill is run twice over the same history
- **THEN** each message is delivered once

#### Scenario: Existing copy
- **WHEN** one of two history messages already has a copy
- **THEN** only the other is delivered

#### Scenario: Echoed copies
- **WHEN** the history contains messages posted by the bridge's own webhooks
- **THEN** they are not relayed

### Requirement: Watermark and gap catch-up
The system SHALL store, per channel, the ID of the newest message it delivered, and when it starts
SHALL relay messages posted after it. The watermark SHALL NOT advance past a message that failed to deliver.

#### Scenario: Downtime
- **WHEN** the bridge was stopped while four messages were posted
- **THEN** after it starts, those four are delivered in order

#### Scenario: Crash mid-backfill
- **WHEN** a backfill stops after the message with ID 120 of 101 to 130
- **THEN** the next run delivers 121 to 130 and the watermark is 130

#### Scenario: Delivery failure
- **WHEN** the first of three messages fails to deliver
- **THEN** the other two are delivered, the watermark stays unset and the failure is logged

### Requirement: Original time
The system SHALL prefix a backfilled message's content with its original UTC time as
`*YYYY-MM-DD HH:MM UTC*` on its own line, since the destination assigns its own timestamp.

#### Scenario: Prefix
- **WHEN** a message from 2026-01-02 15:04 UTC is backfilled
- **THEN** its content starts with `*2026-01-02 15:04 UTC*` followed by a newline

### Requirement: Order with live traffic
The system SHALL hold live messages for a channel being caught up until its catch-up finishes, then
deliver them in the order received, after the backfilled messages.

#### Scenario: Message during backfill
- **WHEN** a live message arrives while history is being delivered
- **THEN** it reaches the destination after the last backfilled message

### Requirement: Rate limits and failure isolation
The system SHALL deliver backfilled messages one at a time through the destination queue, honouring rate
limits, and SHALL log and skip a message that fails without aborting the rest. A history read that fails
SHALL be logged, make the run report failure, and leave the other channels to proceed.

#### Scenario: Rate limited
- **WHEN** the destination answers 429 during a backfill
- **THEN** the bridge waits as instructed and the message is delivered once

#### Scenario: Unreadable message
- **WHEN** one message cannot be delivered
- **THEN** the error is logged and later messages are still delivered

#### Scenario: Unreadable channel
- **WHEN** the origin channel's history returns 403
- **THEN** the failure is logged and the run reports failure

### Requirement: Link scope
The system SHALL backfill only from the instance allowed by `oneWayFrom`, and SHALL restrict a run to
the named link when one is given.

#### Scenario: One-way link
- **WHEN** a one-way link has `backfill` configured
- **THEN** history is fetched only from the origin side

#### Scenario: Named link
- **WHEN** a run names one of two links
- **THEN** only that link is processed

### Requirement: One-shot mode
The system SHALL provide `--backfill [--link <name>]`, which relays history without opening a Gateway
connection, logs `backfill finished`, and exits 0 on success and 1 on failure or an unknown link name.

#### Scenario: Run
- **WHEN** run with `--backfill`
- **THEN** history is relayed, no Gateway connection is made and the process exits 0

#### Scenario: Unknown link
- **WHEN** run with `--link nope` and no such link
- **THEN** the process exits 1 naming the link

#### Scenario: Failure
- **WHEN** the origin channel cannot be read
- **THEN** the process exits 1 with the cause logged
