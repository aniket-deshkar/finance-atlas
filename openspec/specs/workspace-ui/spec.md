# Workspace UI

## Purpose

Describe how a user opens a vault and navigates the shared browser and Windows UI.

## Requirements

### Requirement: Local workspace access

The workspace SHALL require the local vault passphrase to unlock an existing ledger. Core features SHALL remain available in builds without cloud configuration.

#### Scenario: Local use without a Google session

- **WHEN** the user unlocks the vault with a valid passphrase in a local build
- **THEN** the dashboard and local finance workflows are available

#### Scenario: User locks the workspace

- **WHEN** the user activates the lock action
- **THEN** the workspace returns to the unlock view and stops exposing the active ledger

#### Scenario: Connect a Google account on a new device

- **WHEN** the user connects through the welcome screen
- **THEN** the workspace shows the connection status and asks for the existing cloud vault passphrase or a new local vault passphrase

### Requirement: Reporting and navigation

The workspace SHALL show period context and provide navigation between the dashboard and the detailed finance screens.

#### Scenario: Open a dashboard detail

- **WHEN** the user opens a card statement from its dashboard summary
- **THEN** the Card statements view shows the selected card
- **AND** the in-app Back action returns to the preceding view

### Requirement: Responsive presentation

The workspace SHALL adapt its navigation and layout to the available width and support reduced motion.

#### Scenario: Narrow viewport

- **WHEN** a user opens the workspace at a narrow mobile width
- **THEN** the workspace exposes navigation through its drawer and keeps search available

#### Scenario: Manage security settings

- **WHEN** the user opens Data & security in Settings
- **THEN** the settings show the inactivity lock, encrypted backups and recovery together
- **AND** the legacy plain ledger tools remain available in their own disclosure
