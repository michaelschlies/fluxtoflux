# Message Sync Specification

## Purpose
How edits and deletions on the source side follow through to mirrored copies. Implemented by
`Bridge.onUpdate`, `Bridge.onDelete` and `src/store.js`.

## Requirements

### Requirement: Mirror mapping
The system SHALL record, for every mirrored message, the source instance and message ID, the
destination instance, channel and message IDs, and a hash of the source text, in a SQLite database
at `<dataDir>/bridge.sqlite`. Records older than 90 days SHALL be purged at startup. The mapping
SHALL survive restarts.

#### Scenario: Restart
- **WHEN** the process restarts after mirroring a message
- **THEN** a later edit of that message is still propagated

#### Scenario: Old records
- **WHEN** the database holds a record created 100 days ago
- **THEN** it is removed when the store opens

### Requirement: Edit propagation
The system SHALL, on `MESSAGE_UPDATE` for a mapped message whose raw text hash differs from the stored
hash, PATCH each mirrored copy through its webhook with the re-rendered content and update the stored hash.

#### Scenario: Text edited
- **WHEN** alice edits "hello" to "hello world"
- **THEN** every mirrored copy is PATCHed to "hello world"

#### Scenario: Non-text update
- **WHEN** an update arrives with unchanged text (such as an embed unfurl)
- **THEN** no PATCH is sent

#### Scenario: Message with a fallback link
- **WHEN** a message whose attachment fell back to a link receives an update with unchanged text
- **THEN** the mirrored copy is not modified, so the link is not lost

#### Scenario: Unmapped message
- **WHEN** an update arrives for a message the bridge never mirrored
- **THEN** nothing is sent

#### Scenario: Repeated edit
- **WHEN** the same edited text arrives twice
- **THEN** only one PATCH is sent

### Requirement: Delete propagation
The system SHALL, on `MESSAGE_DELETE` or `MESSAGE_DELETE_BULK` for mapped messages, delete each
mirrored copy through its webhook and remove the mapping. A 404 on the destination SHALL be treated
as already deleted.

#### Scenario: Single delete
- **WHEN** a mapped message is deleted
- **THEN** its copies are deleted and its mapping is removed

#### Scenario: Bulk delete
- **WHEN** a bulk delete lists three message IDs, two of them mapped
- **THEN** the two copies are deleted and the unmapped one is ignored

#### Scenario: Copy already gone
- **WHEN** the destination copy was deleted by a moderator
- **THEN** the 404 is ignored and no error is logged as a failure

### Requirement: Embed edit propagation
The system SHALL, when the rich embeds of a mapped bot or webhook message change, PATCH each mirrored copy
with the re-rendered `embeds`. The stored hash SHALL cover the raw text and the rich embeds, so an update
that only adds or changes link previews does not modify the copy.

#### Scenario: Bot edits its embed
- **WHEN** a bot changes an embed's description from "running" to "done"
- **THEN** every mirrored copy is PATCHed with the new embed

#### Scenario: Preview arrives later
- **WHEN** an update adds a link-preview embed and the rich embeds are unchanged
- **THEN** no PATCH is sent

#### Scenario: Embed removed
- **WHEN** an edit removes the only rich embed and the text is non-empty
- **THEN** the copy is PATCHed with an empty `embeds` list

#### Scenario: Human message
- **WHEN** a human's message is edited
- **THEN** the PATCH has no `embeds` field

### Requirement: Out of scope
Custom-emoji reactions, private threads, forum and media channel posts, and link-preview embeds (which the
destination regenerates itself) are NOT synchronised.

#### Scenario: Custom emoji reaction
- **WHEN** someone reacts to a mirrored message with a custom emoji
- **THEN** no reaction appears on the copy
