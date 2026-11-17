# Legacy gap remediation status

This review concerns the Next.js/Tauri workspace. The older `Finance_Atlas_v10.html` is a separate application and remains unchanged. Importing its data is an explicit, previewed operation; opening this workspace does not migrate the old browser storage automatically.

| Gap | Current state | Work still required before connected release |
| --- | --- | --- |
| ARCH-01 | React views and domain functions replace the old HTML's script override chain. | Continue splitting the large page and finance modules; verify parity against realistic, anonymized backups. |
| ARCH-02 | The main ledger is encrypted in IndexedDB, not the legacy localStorage blob. Matching bills now reuses same-day calculations. | The ledger and inline receipts are still one encrypted snapshot; cloning and serialization occur on the UI thread. Measure realistic large datasets, then move encryption/serialization off-thread and introduce versioned entity/attachment stores, quota handling and atomic migrations. Do not claim the old record limits are practical. |
| ARCH-03 | Current encrypted backups include the ledger and its inline receipts; import previews and local snapshots exist. | Old JSON exports may omit separately stored receipts; import the corresponding legacy receipt ZIP when needed. Verify all relevant legacy preferences and recovery sources in a migration report; portable backups and retention need restore drills. |
| DATA-01 | New plans use the current recurring model. A user-initiated conversion archives original rules, creates payment records for posted transactions, preserves transaction IDs and takes a recovery snapshot. | Legacy support remains for unconverted imports. Test more real anonymized variants and reversals before eventually retiring it; ambiguous links block conversion. Heuristic matching remains deliberately conservative. |
| DATA-02 | The new local vault uses AES-GCM and a passphrase-derived key. | This does not encrypt the old HTML storage. Protect the Windows account and device; encrypted data is accessible while unlocked, weak passphrases remain vulnerable to guessing, and malware can access a running session. Plain JSON/CSV exports are not encrypted. |
| DATA-03 | Local writes check the vault revision and reject stale writes. | No cross-device sync or entity merge exists. Design a versioned change log, server-side authorization, idempotency, tombstones, conflict preview and explicit resolution; test offline edits and recovery before enabling sync. |
| DATA-04 | Fresh workspaces contain no hardcoded financial accounts and the backup folder is selected by the user. | Verify imported profiles and paths are not treated as shared defaults; avoid personal data in demo builds. |
| MOB-01 | Local file import/export and desktop backup workflows exist. | Exercise browser-specific download/upload behavior and Android document-provider integration. No unattended mobile directory backup or cloud sync is provided. |
| MOB-02 | Reminders run while the workspace is open and unlocked. | Add native scheduled notifications on Android/desktop and evaluate push for connected web separately; define time zone, consent and private lock-screen text. |
| MOB-03 | A paste-and-review flow extracts a few fields locally using conservative rules; no message is saved or posted automatically. | It is not AI, automated SMS access or an Android integration. Add explicit opt-in import, fixtures across banks, reconciliation and duplicate detection, then evaluate Android share intents and policy-compliant notification access. Never ingest OTPs or claim a measured accuracy without evaluation. |

## Suggested sequence

1. Export and independently verify an encrypted backup of the current workspace and any old separate receipt archive. Test recovery using a disposable profile.
2. Create synthetic regression fixtures for balances, statement payments, loans, recurring schedules, reversals, and migration; add property and performance tests. Reconcile representative sanitized legacy datasets before changing financial logic.
3. Design the versioned entity model and atomic local migrations, separating encrypted attachments. Introduce a worker for heavy processing and demonstrate quota, crash and restore behavior with realistic data volumes.
4. Design conflict handling and a threat model before enabling any external sync. Plan authentication, per-user authorization, key management, deletion and recovery. A server and cloud synchronization necessarily send data to the service; this requires a separate explicit privacy decision.
5. Build mobile file access and notifications, then consent-based ingestion with human review. Integrate model providers only after an explicit decision about data sharing, credentials, cost controls and retention.
6. Only after these gates, provision a separate test project and deploy with test data. Test access isolation, backup recovery, billing alerts and incident handling before real data or public testers.

No cloud services are created or enabled by these changes. Browser and Tauri storage are different origins; a backup must be imported to move data between them. Browser site-data clearing can erase the vault and local recovery snapshots, so retain independent encrypted backups and the passphrase.
