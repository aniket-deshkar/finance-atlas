# Cloud access and sync

## Purpose

Describe the owner boundary, desktop pairing, and opt-in encrypted sync.

## Requirements

### Requirement: Owner authentication

The API SHALL verify a Firebase ID token and restrict protected operations to the configured owner UID.

#### Scenario: Owner setup is incomplete

- **WHEN** the owner UID is set to the setup placeholder
- **THEN** a valid sign-in still cannot access protected cloud data

### Requirement: One-time desktop pairing

The API SHALL issue a short-lived desktop ticket to the signed-in owner and SHALL require the matching original verifier before minting a custom sign-in token.

#### Scenario: Pairing is repeated

- **WHEN** a valid ticket has already been exchanged
- **THEN** subsequent exchange attempts fail

### Requirement: Compare cloud revisions

Encrypted sync SHALL upload ciphertext with metadata, verify downloaded integrity, and compare the expected cloud revision before advancing the head.

#### Scenario: Two devices diverge

- **WHEN** the local and cloud revisions both differ from the last synced base
- **THEN** the workspace asks the user which copy to keep
- **AND** it saves both encrypted copies in local recovery before applying the choice

#### Scenario: Install a copy with a different vault salt

- **WHEN** the user chooses a cloud copy whose salt differs from the local vault
- **THEN** the workspace requires the cloud vault passphrase to decrypt the copy before installing it
