## ADDED Requirements

### Requirement: Portable encrypted device records

The workspace SHALL support separately exporting and recovering encrypted device records without overwriting records or the existing destination ledger.

#### Scenario: Restore from a prior vault

- **WHEN** the user opens a device archive using the original vault passphrase and the destination device library is empty
- **THEN** the workspace seals recovered records under the destination vault key and installs them together
