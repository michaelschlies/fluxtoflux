# Message Relay Specification

## Purpose
How new messages in a linked channel are mirrored to the other channels in the link.
Implemented by `Bridge.onCreate` in `src/bridge.js`.

## Requirements

### Requirement: Mirror new messages
The system SHALL, for each `MESSAGE_CREATE` of type DEFAULT (0) or REPLY (19) in a linked channel,
execute the destination channel's webhook with `wait=true`, using the message text as `content`,
`username` of the form `<display name> · <instance label>` (at most 80 characters) and, when the
author has an avatar, `avatar_url` = `<media>/avatars/<user id>/<hash>.png`.

#### Scenario: Plain text
- **WHEN** alice posts "hello" in a linked channel on instance `main` labelled `fluxer.app`
- **THEN** the destination webhook receives content "hello" and username `alice · fluxer.app`

#### Scenario: Display name precedence
- **WHEN** the author has a guild nickname, a global name and a username
- **THEN** the nickname is used, then the global name, then the username

#### Scenario: No avatar
- **WHEN** the author has no avatar
- **THEN** `avatar_url` is omitted

### Requirement: Fan-out
The system SHALL mirror to every other channel in the link. A failure delivering to one destination
SHALL NOT prevent delivery to the others.

#### Scenario: Three instances
- **WHEN** a link has channels on `a`, `b` and `c` and a message is posted on `a`
- **THEN** it is delivered to `b` and `c`

#### Scenario: One destination broken
- **WHEN** the webhook on `b` has been deleted (404) and a message is posted on `a`
- **THEN** it is still delivered to `c` and the error is logged

### Requirement: One-way links
When `oneWayFrom` is set, the system SHALL mirror only messages originating on that instance.

#### Scenario: Reverse direction
- **WHEN** a message is posted on the destination side of a one-way link
- **THEN** nothing is sent

### Requirement: Ordering
The system SHALL deliver messages to a given destination channel in the order they were received,
even when earlier deliveries are slow.

#### Scenario: Slow first delivery
- **WHEN** five messages arrive in quick succession and the first webhook call is delayed
- **THEN** the destination receives them in the original order

### Requirement: Loop prevention
The system SHALL ignore messages sent by its own webhooks or its own bot user. It SHALL also ignore
messages from other bots and webhooks unless `bridgeBots` is true.

#### Scenario: Echo of a mirrored message
- **WHEN** a message arrives whose `webhook_id` is one the bridge manages on that instance
- **THEN** it is not mirrored back

#### Scenario: Third-party bot
- **WHEN** a bot other than the bridge posts and `bridgeBots` is false
- **THEN** the message is not mirrored

#### Scenario: Third-party bot allowed
- **WHEN** `bridgeBots` is true
- **THEN** other bots' messages are mirrored, but the bridge's own echoes are still ignored

### Requirement: No notifications
The system SHALL send `allowed_mentions` with an empty `parse` list so a mirrored message never pings anyone.

#### Scenario: Everyone mention
- **WHEN** a message contains `@everyone`
- **THEN** the mirrored message cannot notify anyone

### Requirement: Mention rendering
The system SHALL replace `<@id>` and `<@!id>` with `@<name>` using the message's mention data,
`<@&id>` with `@role` and `<#id>` with `#<channel name>`, since IDs differ between instances.

#### Scenario: User mention
- **WHEN** the text is `hi <@5>` and user 5 is alice
- **THEN** the mirrored content is `hi @alice`

### Requirement: Reply rendering
The system SHALL prefix a reply with a quote line `> ↪ **<name>**: <snippet>` using the referenced
message, with the snippet collapsed to one line and limited to 80 characters; an attachment-only
referenced message SHALL show `(attachment)`.

#### Scenario: Reply
- **WHEN** a REPLY references a message by carol saying "orig"
- **THEN** the mirrored content starts with `> ↪ **carol**: orig`

### Requirement: Length limit
The system SHALL truncate mirrored content to 4,000 characters, ending with an ellipsis.

#### Scenario: Very long message
- **WHEN** content is 5,000 characters
- **THEN** the mirrored content is exactly 4,000 characters and ends with `…`

### Requirement: Skipped messages
The system SHALL NOT mirror messages in unlinked channels, messages of other types (joins, pins,
calls and so on), or messages with no text and no attachment (for example sticker-only).

#### Scenario: System message
- **WHEN** a USER_JOIN message appears in a linked channel
- **THEN** nothing is sent
