# Reactions Specification

## Purpose
How reactions on a bridged message follow to its copies. Implemented by `Bridge.onReaction` in
`src/bridge.js` and `Store.getByCopy`. Webhooks cannot react, so the destination bot user adds the
reaction; this needs the Add Reactions permission on the destination channel.

## Requirements

### Requirement: Mirror reactions
The system SHALL, on `MESSAGE_REACTION_ADD` for a mapped message with a unicode emoji, add the same
emoji as the destination bot user to every mirrored copy, and for a mirrored copy to its source message
and the source's other copies. A reaction on a message inside a paired thread SHALL be added to the
copy in the paired thread.

#### Scenario: Reaction on source
- **WHEN** a user reacts with 👍 to a bridged message
- **THEN** the bot adds 👍 to each copy

#### Scenario: Reaction on a copy
- **WHEN** a user on the destination side reacts with ❤️ to a mirrored copy
- **THEN** the bot adds ❤️ to the source message

#### Scenario: Three instances
- **WHEN** a link has channels on `a`, `b` and `c` and a user on `b` reacts to a copy
- **THEN** the bot adds the reaction on the source on `a` and on the copy on `c`

#### Scenario: Message in a thread
- **WHEN** a user reacts to a message in a paired thread
- **THEN** the bot reacts to the copy in the paired thread

#### Scenario: Unmapped message
- **WHEN** a user reacts to a message the bridge never mirrored
- **THEN** nothing is sent

### Requirement: Custom emoji
The system SHALL NOT mirror custom emoji, because their IDs differ between instances.

#### Scenario: Custom emoji reaction
- **WHEN** a user reacts with a guild's custom emoji
- **THEN** no reaction is added to the copy and nothing is logged as an error

### Requirement: Reaction removal
The system SHALL, on `MESSAGE_REACTION_REMOVE`, list the users who still have that emoji on the origin
message and SHALL remove its mirrored reaction only when none of them is the bridge's own bot user.

#### Scenario: Last reactor leaves
- **WHEN** the only user with 👍 removes it
- **THEN** the bot removes 👍 from each copy

#### Scenario: Other reactors remain
- **WHEN** two users reacted with 👍 and one removes it
- **THEN** the copy keeps the bot's 👍

#### Scenario: Only the bot's own reaction remains
- **WHEN** the only remaining reaction on the origin is the bot's own mirrored one
- **THEN** the mirrored reaction is removed from the copies

### Requirement: Counts are not preserved
The bot SHALL react once per emoji, so a reaction made by several users appears on the copy with a
count of one.

#### Scenario: Two reactors
- **WHEN** two users react with 👍 on the source
- **THEN** the copy has one 👍 from the bot

### Requirement: Echo prevention
The system SHALL ignore reaction events caused by its own bot users.

#### Scenario: Mirrored reaction event
- **WHEN** the gateway reports the bot's own mirrored reaction
- **THEN** it is not mirrored back

### Requirement: One-way links and opt-out
The system SHALL honour `oneWayFrom`, and SHALL NOT mirror any reactions when `options.bridgeReactions` is false.

#### Scenario: Reverse direction on a one-way link
- **WHEN** a user reacts on the destination side of a one-way link
- **THEN** nothing is sent

#### Scenario: Disabled
- **WHEN** `bridgeReactions` is false
- **THEN** no reaction events are mirrored

### Requirement: Failure isolation
A failure adding or removing a reaction SHALL be logged and SHALL NOT affect message mirroring. A 404
(the copy was deleted) SHALL be ignored silently.

#### Scenario: Missing permission
- **WHEN** the destination returns 403 for the reaction
- **THEN** a warning is logged and later messages still mirror

#### Scenario: Copy deleted
- **WHEN** the destination returns 404 for the reaction
- **THEN** nothing is logged as a warning
