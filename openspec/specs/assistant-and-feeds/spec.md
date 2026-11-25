# Assistant and feeds

## Purpose

Describe on-device assistance, consent for cloud calls, and external data lookups.

## Requirements

### Requirement: Local assistance without cloud access

The workspace SHALL support an on-device Assistant and locally calculated attention items without an enabled cloud worker.

#### Scenario: Cloud AI is disabled

- **WHEN** the connected deployment reports that the AI worker is disabled
- **THEN** the user can still review local figures and local attention items

### Requirement: Consent for a cloud Assistant turn

The workspace SHALL display the pending question, selected facts, and included history for the user to approve before sending a cloud Assistant turn.

#### Scenario: Reviewed content changes

- **WHEN** the user changes the question, model, or included context after approving a preview
- **THEN** the workspace requires approval of the updated preview

### Requirement: Assistant chat and model choice

The workspace SHALL offer the same conversation in the floating Assistant and the full view. Enabled models SHALL come from the authenticated deployment catalog.

#### Scenario: Use the floating Assistant on a narrow screen

- **WHEN** a user opens the Assistant from another view
- **THEN** the header and message composer remain available while the transcript scrolls
- **AND** the same conversation is available from the full Assistant view

#### Scenario: Select GPT-OSS through Model Garden

- **WHEN** the deployment has enabled GPT-OSS and the user approves the cloud message
- **THEN** the worker SHALL use its Google Cloud identity to send the approved facts to Model Garden
- **AND** the workspace SHALL show the processing location and include the run in the cloud usage budget

### Requirement: Bounded attention analysis

The API SHALL accept only the expected summary fields, enforce analysis quotas, and filter worker proposals against the submitted facts.

#### Scenario: Proposal references an unknown item

- **WHEN** the worker returns an item without a matching submitted fact
- **THEN** the API discards the item

### Requirement: Owner-only market lookup

The API SHALL accept a bounded list of instrument identifiers from the owner when the market endpoint is enabled.

#### Scenario: Provider data is unavailable

- **WHEN** a requested instrument has no valid provider response
- **THEN** the response omits that instrument's quote
