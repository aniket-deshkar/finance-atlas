# Finance Atlas

A Next.js personal finance workspace with an encrypted local vault. The financial workflows were ported from Finance_Atlas_v10.html into shared TypeScript calculations and dedicated React screens.

The homepage follows v10's liquid-balance hero, income/spending/savings summaries, cash-flow chart, spending mix, budget, EMI and card dues, recent activity and goals. Each card links to its detailed screen. A shared light/dark palette covers navigation, forms, menus and reports; change it in Data & settings. A Back button returns to the previous section, and the sidebar can be collapsed with its arrow or in navigation settings. The nonfinancial theme preference is remembered for the lock screen. Consistent entrance, hover and chart effects respect reduced-motion preferences and the Reduce animations setting. Decorative finance graphics move with page scrolling in browsers that support scroll-driven animations, with a static fallback.

The [product, Firebase, connector and AI implementation plan](docs/PRODUCT-AND-CLOUD-PLAN.md) records the proposed stages, public-demo privacy model, Gmail/SMS constraints and current gaps. Creating the registered Firebase web app has not connected those services to the local app.

## Run locally

Use Node 24. In this directory on Windows, run `npm.cmd ci` and `npm.cmd run dev`, then open http://localhost:3000. Create or unlock the browser vault with your passphrase. The `npm.cmd` form also works when PowerShell script execution is restricted.

For the dedicated Windows app, run `npm.cmd run desktop:build`, then `npm.cmd run desktop:open`, or install the generated setup executable. The desktop embeds the frontend and runs without a development server. See [Desktop setup, migration and storage](docs/DESKTOP.md). Browser and desktop vaults are separate; migrate through the existing backup/import flow.

Run `npm run eval` for the unit, browser and API-to-ADK checks. The [QA and evaluation report](docs/QA-EVALUATION.md) documents prerequisites, coverage and release criteria.

## Workflows

| Area | Available workflows |
|---|---|
| Transactions | Income, expenses, refunds, transfers, card repayments, scheduled entries, actual posting confirmation, split payments, templates, tags, search, account/type filters and pagination |
| Accounts and cards | Account creation, metadata edits, dated balance confirmations, card cycles and limits, statement navigation, estimated EMI limit reservations and removal of unused zero-opening accounts |
| Card statements | Create and edit statements, grid/list views, period totals, partial or pending payments, link existing repayments, immutable settled history, reversals, confirmed EMI breakdowns and correction records |
| Bills and policies | Monthly, quarterly, yearly, 28/56/84-day and one-time schedules; subscriptions, utilities and insurance; policy coverage details; archive/restore plans; pending/cleared payments; link existing debits and match unique recorded auto-debits |
| EMIs and lending | Bank and card installments, schedules, historical progress, personal EMI totals, Money Given plans, separate recoveries, preserved original payment amounts and removal of unused plans |
| Budgets | Category income/spending plans, prior-period copy, rollover, actual cash inflow/outflow, expected outflow, EMI paid/remaining totals and proportional card EMI settlements from confirmed statement portions |
| Calendar and daily hub | Cycle-limited upcoming payments, bill-type/status filters, interactive day agenda, day-grouped timeline, sorting and spending-room calculations |
| Salary and transfers | Expected and actual salary, weekend dates, linked bank/card payment accounts, buffers, existing-balance preferences, overdue and issued-statement reservations, funding shortfall and explicitly recorded transfers |
| Planning and insights | Savings goals and allocations, twelve-month cash-flow forecasts, category and merchant spending, event tags, recurring-payment monthly equivalents, card credit assets, debt principal and fixed-rate payoff simulations |
| Reconciliation | Bank and card statement upload, column mapping, category suggestions, transfer and repayment matching, duplicate checks and encrypted originals |
| Receipts and reports | Encrypted image/PDF attachments, full data-and-receipts ZIP archives, monthly printable report, CSV exports and an audit XLSX workbook |
| Documents | Local CSV and PDF extraction, password prompts, encrypted originals, statement matching and opt-in verified bank CSV posting |
| Tax, investments and vehicles | Salary and interest tax estimates, portfolio activity and dated valuations, scheme comparison, vehicle expense links and renewal reminders |
| Assistant | Floating and full-page conversation, contextual figures, local history, per-turn approval and optional Vertex models |
| Settings | Appearance and navigation, finance and automation, AI models and usage, and data and backup |

Recorded transactions and settled payment history use reversal records for financial corrections. A plan's changed EMI amount applies to future installments. Its schedule continues to show each recorded installment's original value. Money Given plans are excluded from personal debt and EMI totals. Their real bank debits and charges on your cards still affect those accounts.

Reporting mode controls the period used by transactions, budgets, EMI totals and reports. Salary reporting applies the configured weekend adjustment when its start day matches the salary schedule. The current dashboard and payment calendar can show the active salary cycle. Each view displays its dates. Card spending and bank repayments are separate measures, so repayment does not add a second expense.

## Import existing data

In **Settings → Data, backup & security**, preview a Finance Atlas version 1 JSON backup or a legacy full ZIP archive. Unknown extension fields are retained. Known insurance/other category aliases are consolidated and their budget allocations are combined. An EMI Control Room backup can also be previewed when this workspace has no EMI plans.

Review the preview and choose **Replace local workspace** to apply it. An encrypted local recovery snapshot is taken before replacement. Use the legacy ZIP archive when migrating receipts, because older plain JSON backups do not contain the legacy browser's attachment store.

Encrypted restore accepts this app's portable vault snapshots and the legacy `finance-atlas-enc-v1` backup format. Provide the backup's own passphrase. Restore is previewed before replacement.

Open **Transactions → Import bank or card statement**, or **Card statements → Import card transactions**. Choose the account, confirm the columns and date order, then preview the rows. Review the category and transaction type, link an existing entry, or leave the row out. Likely transfers and repayments require review. The original is stored encrypted in Documents.

CSV files support ISO, named-month and numeric dates, up to 3 MB and 5,000 rows. A numeric date such as 05/11/2026 follows the selected date order. Text PDFs up to 12 MB can be imported when the rows contain recognizable dates, descriptions and explicit debit or credit indicators. Password-protected PDFs open with the issuer’s password on the device. Use the issuer’s CSV export for scanned or unsupported layouts.

## Storage and backups

The vault uses AES-256-GCM and a passphrase-derived PBKDF2-SHA256 key with 600,000 iterations. The key stays in memory while unlocked. Ledger data and receipt bytes are encrypted together in IndexedDB. Save operations check the current vault revision to reject stale writes from another tab. Async file operations cannot unlock a workspace after it has been locked.

**Documents** keeps new originals, extracted text and
import review results in an encrypted device store. The Assistant's local
conversation history uses the same device store. Ledger backups cover your
financial records. In **Settings → Data, backup & security**, download a separate
encrypted device backup for originals, extracted records, and Assistant history.
Restore it with the original vault passphrase into an empty device library.

Finance Atlas creates local encrypted recovery copies automatically on unlock and after saves. To keep an additional copy outside app storage, open **Encrypted ledger backups → Choose backup folder** and grant folder access. Folder copies use encrypted `.atlasenc` files and are verified after writing. Copies run daily and after changes while the workspace is open and unlocked.

Encrypted browser recovery snapshots retain up to 25 local versions. Clearing site data can erase both the vault and these recovery copies. The passphrase is required for encrypted restore. Downloadable JSON, CSV, XLSX and ZIP exports are readable files. Receipt ZIP archives include binary files and a manifest. The encrypted vault is limited to 30 MB, with up to 100 receipts totalling 15 MB. Each receipt is limited to 4 MB. XLSX reports support 100,000 rows per sheet; the JSON backup retains the complete workspace.

In-app reminders show recorded/scheduled data. System reminders require explicit notification permission and run while the workspace is active. Auto-debit matching associates an actual recorded debit with one uniquely matching scheduled occurrence.

## Verification

Run `npm.cmd run check`, `npm.cmd test`, `npm.cmd run build`, then `npm.cmd run test:browser`. Set `NEXT_TELEMETRY_DISABLED=1` for test/build environments. Chrome is used with an isolated profile and fictional records. `ATLAS_CHROME` overrides its executable path.

The browser check covers all screens at desktop/mobile widths, bills and cleared payments, personal EMIs, Money Given recoveries, budget persistence, card settlement, encrypted restore, reload, wrong passphrases, stale writes and outbound request checks.

Financial corrections preserve settled records. Removing unused configuration records and receipt files creates a local recovery checkpoint first. Keyboard shortcuts include N for a new transaction, P for privacy and 1–0 for the first ten visible sections. Theme controls live in Data & settings.

To include the independent comparison with the supplied legacy app, set `ATLAS_LEGACY_HTML` to the path of Finance_Atlas_v10.html before running the tests. The comparison uses synthetic entries and the legacy pure calculation functions. Additional regressions cover short months, reversals, immutable history, auto-debit ambiguity, card cycles, salary funding, card credit assets, receipt archive integrity and workbook safety. Reconcile your authoritative bank balances and statements when reviewing your real imported ledger.

## Google Cloud pilot

See [Cloud pilot deployment and verification](docs/CLOUD-PILOT.md) for the
current walkthrough for private sync, desktop pairing, and multi-agent analysis.
Builds without cloud settings continue to show locally calculated items under
**Needs your attention**.

The Next.js static export is served by Firebase Hosting. The `api/` service
verifies the owner's Firebase identity and manages encrypted snapshot revisions.
The private `agent/` service handles cloud AI. Run `npm.cmd ci` and `npm.cmd test`
inside `api/` to test the API against its local test store.
