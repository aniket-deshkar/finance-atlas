# Vault and recovery

## Purpose

Describe the local persistence, import, and backup boundaries.

## Requirements

### Requirement: Encrypted, revisioned ledger

The workspace SHALL encrypt the ledger and embedded receipts before saving them to IndexedDB. A save SHALL compare the expected local revision.

#### Scenario: Stale tab attempts to save

- **WHEN** another tab commits a newer vault revision before this tab saves
- **THEN** the stale save fails without overwriting the newer ledger

### Requirement: Review before replacement

The workspace SHALL preview a supported backup before replacing the local ledger and take an encrypted recovery snapshot before the replacement.

#### Scenario: Restore an encrypted ledger backup

- **WHEN** the user enters the backup's passphrase and confirms its preview
- **THEN** the workspace validates and installs the restored ledger
- **AND** an encrypted copy of the preceding ledger is available in recovery

### Requirement: Device-only document and chat storage

The workspace SHALL store document originals, extracted text, review results, and Assistant history in a separate encrypted device store.

#### Scenario: Export a ledger backup

- **WHEN** the user exports the encrypted ledger
- **THEN** the snapshot includes the ledger and embedded receipts
- **AND** it excludes the separate document library and Assistant history
