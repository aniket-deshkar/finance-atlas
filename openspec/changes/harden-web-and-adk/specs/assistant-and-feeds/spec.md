## ADDED Requirements

### Requirement: Isolated ADK execution

Cloud AI SHALL run financial chat, attention, and public policy requests in bounded Google ADK sessions. Financial specialists SHALL NOT be given public search or financial action tools.

#### Scenario: User asks a cloud question

- **WHEN** the owner approves and sends a validated question
- **THEN** the worker answers using bounded ADK sessions and accepts references only to supplied facts
- **AND** earlier messages are included only when the user opts in for that turn
