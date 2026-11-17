# Attachments Specification

## Purpose
How files attached to a source message reach the destination. Implemented by
`Bridge.#collectFiles` and the multipart branch of `Bridge.onCreate`.

## Requirements

### Requirement: Re-upload
The system SHALL download each attachment from its URL and upload it to the destination webhook as
`multipart/form-data`: the JSON body in `payload_json`, with `attachments` metadata (index,
filename, description) and the bytes in `files[N]`.

#### Scenario: Image with caption
- **WHEN** a message has text and one image attachment
- **THEN** the webhook request is multipart, `payload_json` has the text, and `files[0]` has the image bytes under its original filename

#### Scenario: Attachment only
- **WHEN** a message has no text and one attachment
- **THEN** it is still mirrored

### Requirement: Size cap
The system SHALL NOT download attachments larger than `maxAttachmentBytes`; instead it SHALL append the
attachment's URL to the message content.

#### Scenario: Oversized file
- **WHEN** an attachment's size exceeds `maxAttachmentBytes`
- **THEN** no download is attempted and its URL appears in the mirrored content

### Requirement: Download failure fallback
When an attachment cannot be downloaded, the system SHALL append its URL to the content and still
deliver the message and its other attachments.

#### Scenario: Expired link
- **WHEN** one of two attachments returns HTTP 404
- **THEN** the message is delivered with the other file uploaded and the failed file's URL in the content

### Requirement: Attachments untouched on edit
The system SHALL NOT re-upload or remove attachments when a message is edited.

#### Scenario: Edit of a message with files
- **WHEN** the text of a message with attachments is edited
- **THEN** the destination PATCH contains only content fields
