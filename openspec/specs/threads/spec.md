# Threads Specification

## Purpose
How threads of linked channels are mirrored. Implemented by the thread handlers and `#route`,
`#destinations` and `#ensurePaired` in `src/bridge.js`, and the `threads` table in `src/store.js`.
Only public and announcement threads (types 11 and 10) of linked text channels are mirrored.

## Requirements

### Requirement: Thread pairing
The system SHALL treat a thread whose parent is a linked channel as part of that link. On
`THREAD_CREATE` with `newly_created` it SHALL create a thread with the same name in each destination
channel and record the pairing in the store. The pairing SHALL survive restarts. A thread started from a
mirrored message SHALL be created from the copy of that message.

#### Scenario: Thread created
- **WHEN** a user starts a thread named "planning" in a linked channel
- **THEN** a thread named "planning" is created in each destination channel and the pairing is stored

#### Scenario: Thread in an unlinked channel
- **WHEN** a thread is created under a channel that is not linked
- **THEN** nothing is created

#### Scenario: Added to an existing thread
- **WHEN** `THREAD_CREATE` arrives without `newly_created`
- **THEN** no counterpart is created until a message arrives in the thread

#### Scenario: Started from a message
- **WHEN** a thread is started from a message that was mirrored
- **THEN** the counterpart is created from the copy of that message

#### Scenario: Restart
- **WHEN** the process restarts after a thread was paired
- **THEN** the pairing is still in the store

### Requirement: Private threads
The system SHALL NOT mirror private threads, so their messages never leave their members.

#### Scenario: Private thread
- **WHEN** a message is posted in a private thread of a linked channel
- **THEN** nothing is created and nothing is sent

### Requirement: Thread message relay
The system SHALL mirror messages posted in a thread to its paired thread using the existing relay rules
(identity, mentions, replies, attachments, ordering), executing the destination webhook with the thread
as its target. Thread starter system messages SHALL NOT be mirrored.

#### Scenario: Message in a thread
- **WHEN** alice posts "hello" in a paired thread
- **THEN** the paired thread receives "hello" as `alice · <label>` and the parent channel receives nothing

#### Scenario: Reply from the other side
- **WHEN** a message is posted in the paired thread on the destination instance
- **THEN** it is delivered to the origin thread

#### Scenario: Ordering inside a thread
- **WHEN** three messages arrive in a thread in quick succession and the first delivery is slow
- **THEN** they are delivered in their original order

#### Scenario: Starter message
- **WHEN** a THREAD_STARTER_MESSAGE appears in a thread
- **THEN** it is not mirrored

### Requirement: Lazy pairing
The system SHALL create the missing counterpart when a message arrives in a thread that has no pairing,
and SHALL NOT drop the message. Concurrent messages SHALL result in one counterpart.

#### Scenario: Thread created while offline
- **WHEN** a message arrives in a thread the bridge has never seen
- **THEN** a counterpart is created, the pairing stored, and the message delivered to it

#### Scenario: Simultaneous messages
- **WHEN** two messages arrive together in an unpaired thread
- **THEN** one counterpart is created and both messages are delivered to it

### Requirement: Thread edits and deletes
The system SHALL propagate edits and deletes of thread messages to the paired thread, through the thread
the copy was posted in.

#### Scenario: Edit and delete in a thread
- **WHEN** a thread message is edited and then deleted
- **THEN** its copy in the paired thread is PATCHed and then deleted

### Requirement: Thread lifecycle
The system SHALL mirror a rename and an archive or unarchive of a thread to the paired thread without
bouncing its own change back, and SHALL remove the pairing when a thread is deleted.

#### Scenario: Rename
- **WHEN** a thread is renamed
- **THEN** the paired thread is renamed and the resulting event on the paired side causes no further change

#### Scenario: Archive and unarchive
- **WHEN** a thread is archived and later unarchived
- **THEN** the paired thread is archived and later unarchived

#### Scenario: Thread deleted
- **WHEN** a paired thread is deleted
- **THEN** its pairing is removed from the store

### Requirement: Flattening fallback
When the destination thread cannot be created, the system SHALL deliver thread messages to the parent
channel with the content prefixed `[thread: <name>] `, keep that prefix on edits, and log the cause once per thread.

#### Scenario: Cannot create threads
- **WHEN** the destination rejects thread creation with 403
- **THEN** a thread message arrives in the parent channel prefixed `[thread: planning] `

#### Scenario: Logged once
- **WHEN** two messages arrive in a thread that cannot be created
- **THEN** one failure is logged and both messages are delivered flattened

#### Scenario: Edit of a flattened message
- **WHEN** a flattened message is edited
- **THEN** the copy keeps its prefix

### Requirement: One-way links and opt-out
The system SHALL honour `oneWayFrom`, and SHALL ignore all threads, without looking channels up, when
`options.bridgeThreads` is false.

#### Scenario: Reverse direction
- **WHEN** a thread message is posted on the destination side of a one-way link
- **THEN** nothing is sent

#### Scenario: Disabled
- **WHEN** `bridgeThreads` is false
- **THEN** thread messages are not mirrored and the API is not asked about unknown channels
