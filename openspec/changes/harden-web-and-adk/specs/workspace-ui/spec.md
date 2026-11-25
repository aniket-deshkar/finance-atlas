## ADDED Requirements

### Requirement: Keep mobile navigation and privacy usable

The workspace SHALL contain keyboard focus while mobile navigation is open and render the dashboard without exact financial amounts when amounts are hidden.

#### Scenario: User opens mobile navigation with the keyboard

- **WHEN** the user opens the mobile navigation drawer
- **THEN** keyboard focus enters the drawer and remains there until the drawer closes

#### Scenario: User hides amounts on the dashboard

- **WHEN** the user enables Hide amounts
- **THEN** exact amounts are not rendered in dashboard text, chart markup, or accessible labels
