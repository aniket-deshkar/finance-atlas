# Deployment

## Purpose

Describe the checked-in web, service, and Windows deployment topology.

## Requirements

### Requirement: Static frontend and separate API

The web build SHALL produce static assets for Firebase Hosting. Hosting SHALL route the public health probe and API paths to the configured Cloud Run service.

#### Scenario: Request arrives at Firebase Hosting

- **WHEN** the client requests `/v1/` API resources
- **THEN** Hosting forwards the request to the Fastify API in `asia-south1`
- **AND** the API applies owner authorization to protected routes

### Requirement: Private data access and worker invocation

The cloud deployment SHALL deny direct client access to Firestore and SHALL use a private Cloud Run worker invoked by the API's runtime identity.

#### Scenario: AI stays disabled during sync setup

- **WHEN** the API is deployed with AI disabled and a sync bucket configured
- **THEN** owner-authorized sync remains available
- **AND** the API advertises that cloud AI is disabled

### Requirement: Bundled Windows workspace

The Windows installer SHALL embed the static frontend and use the local Tauri capabilities configuration and native commands for supported desktop operations.

#### Scenario: Launch the installed application

- **WHEN** the user launches the Windows bundle
- **THEN** its shared UI loads from the bundled assets without a development server
