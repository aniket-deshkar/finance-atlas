## ADDED Requirements

### Requirement: Reproducible web release

The release workflow SHALL produce build identity and a tested Firebase Hosting configuration from the static export.

#### Scenario: A staging release is checked

- **WHEN** a build is prepared for Firebase Hosting
- **THEN** the release manifest identifies its source revision, and verification checks the expected response headers, health, and anonymous access handling
