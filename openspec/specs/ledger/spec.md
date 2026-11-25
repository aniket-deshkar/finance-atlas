# Ledger

## Purpose

Define the current behavior of the local ledger, payment history, and period calculations.

## Requirements

### Requirement: Consistent transaction accounting

The workspace SHALL validate dates, account relationships, and amounts in integer paise. It SHALL distinguish transfers and card repayments from income and expenses.

#### Scenario: Payment of a recorded card balance

- **WHEN** the user records a cleared repayment against an existing card balance
- **THEN** the linked bank and card balances reflect the repayment once
- **AND** period spending does not increase

#### Scenario: Scheduled transaction

- **WHEN** an entry is scheduled after the reporting date
- **THEN** the workspace excludes it from actuals until it is eligible as a recorded entry

### Requirement: Preserve settled history

The workspace SHALL retain original posted entries and settled payment amounts when making financial corrections.

#### Scenario: Correction of an existing payment

- **WHEN** the user reverses a cleared payment
- **THEN** the workspace retains its original record and records a linked reversal
- **AND** the corrected payment can be entered separately

### Requirement: Reviewed statement import

The workspace SHALL read supported delimited exports and text PDF layouts on the device. It SHALL wait for the user to approve the import before creating ledger entries.

#### Scenario: A statement contains an unreadable row

- **WHEN** the workspace can map the statement and some rows cannot be validated
- **THEN** it shows the valid rows in the review and lists the skipped rows with their errors
- **AND** the skipped rows are excluded from import

#### Scenario: An existing transaction posted one day apart

- **WHEN** the statement account and signed amount match an existing transaction within one day
- **THEN** the workspace offers the transaction as a possible match
- **AND** it leaves the row for review if the dates differ

### Requirement: Reporting period

The workspace SHALL apply the configured calendar month or salary cycle when deriving period totals.

#### Scenario: Salary cycle spans two months

- **WHEN** the configured salary start date moves for a weekend
- **THEN** adjacent reporting cycles remain contiguous and the view shows the applicable dates
