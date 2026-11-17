import { test } from "node:test";
import assert from "node:assert/strict";
import { addAccount, addEntry, addStatement, balance, blank, displayPeriod, importLedger, reportPeriod, statementAmounts, totals } from "../lib/ledger.ts";

const date = "2026-11-10";
const account = (id, type) => ({ id, name: id, type, opening: type === "credit" ? 0 : 2000, openingDate: "2026-01-01" });
const entry = (id, type, amount, date, accountId, toId = "", note = "") => ({
  id, type, amount, date, accountId, toId, note,
  category: type === "income" ? "Paycheck" : type === "transfer" || type === "cardPayment" ? "" : "Food"
});

test("v1 import preserves extensions and rejects invalid account references", () => {
  const valid = {...blank(), accounts: [account("bank", "bank")], customExtension: { version: 7 },
    settings: { ...blank().settings, insuranceRules: [{ label: "Example" }] }};
  assert.deepEqual(importLedger({state: valid}), valid);
  assert.throws(() => importLedger({...valid, transactions: [entry("wrong", "expense", 50, date, "unknown")]}), /transaction 1/);
});

test("card repayments leave spending unchanged, and a reversed refund restores the balance", () => {
  const bank = account("bank", "bank");
  const card = account("card", "credit");
  const ledger = importLedger({
    ...blank(), accounts: [bank, card],
    transactions: [
      entry("salary", "income", 1000, "2026-11-02", bank.id),
      entry("buy", "expense", 200, "2026-11-03", card.id),
      entry("pay", "cardPayment", 100, "2026-11-05", bank.id, card.id),
      entry("refund", "refund", 20, "2026-11-06", card.id),
      entry("cash", "expense", 50, "2026-11-08", bank.id)
    ],
    settings: {
      cardStatements: [{ id: "s1", cardId: card.id, statementDate: "2026-11-04", dueDate: "2026-11-23", billAmount: 200 }],
      paymentReversals: [{ transactionId: "refund", amount: 20, date: "2026-11-07" }]
    }
  });
  assert.deepEqual(totals(ledger, "2026-11-01", "2026-11-30", date), { income: 100000, spending: 25000, savings: 75000 });
  assert.equal(balance(ledger, bank, date), 285000);
  assert.equal(balance(ledger, card, date), 10000);
});

test("salary reporting days clamp in February and an active salary cycle uses the actual pay date", () => {
  const ledger = {...blank(), settings: { reportingPeriod: { mode: "salary", day: 31 } }};
  assert.deepEqual(reportPeriod(ledger, "2026-02"), {start: "2026-02-28", end: "2026-03-30", basis: "Salary reporting period"});
  const bank = account("bank", "bank");
  const scheduled = {...blank(), accounts: [bank], settings: { salary: {enabled: true, day: 25, startMonth: "2026-01"} },
    transactions: [{ ...entry("salary", "income", 1000, "2026-10-24", bank.id), salaryMonth: "2026-10" }]};
  assert.deepEqual(displayPeriod(scheduled, "2026-11", date), {start: "2026-10-24", end: "2026-11-24", basis: "Active salary cycle"});
});

test("ordinary entries validate amount, date and account type before saving", () => {
  const ledger = addAccount(blank(), account("bank", "bank"));
  const expense = entry("expense", "expense", 37.25, date, "bank");
  const saved = addEntry(ledger, expense, date);
  assert.equal(saved.transactions.length, 1);
  assert.equal(ledger.transactions.length, 0);
  assert.throws(() => addEntry(saved, {...expense, id: "duplicate"}, date), /matching transaction/);
  assert.throws(() => addEntry(ledger, {...expense, amount: 37.251}, date), /two decimal places/);
  assert.throws(() => addEntry(ledger, {...expense, date: "2026-11-11"}, date), /no later than today/);
  assert.throws(() => addEntry(ledger, {...expense, type: "cardPayment"}, date), /transaction 1/);
});

test("a cleared repayment appends immutable history and reduces only the linked balances", () => {
  const bank = account("bank", "bank"), card = account("card", "credit");
  const statement = {id: "s1", cardId: card.id, statementDate: "2026-11-04", dueDate: "2026-11-24", billAmount: 200, minimumDue: 15, reference: ""};
  const ledger = addStatement({...blank(), accounts: [bank, card]}, statement, date);
  const repayment = {...entry("p1", "cardPayment", 80, date, bank.id, card.id), cardStatementId: statement.id};
  const saved = addEntry(ledger, repayment, date);
  assert.equal(ledger.settings.cardStatementPayments, undefined);
  assert.equal(saved.settings.cardStatementPayments[0].amount, 80);
  assert.equal(saved.settings.cardStatementPayments[0].transactionId, repayment.id);
  assert.deepEqual(statementAmounts(saved, statement, date), {billed: 20000, paid: 8000, due: 12000});
  assert.equal(balance(saved, bank, date), 192000);
  assert.equal(balance(saved, card, date), 12000);
  assert.equal(totals(saved, "2026-11-01", "2026-11-30", date).spending, 0);
  assert.throws(() => addEntry(saved, {...repayment, id: "p2", amount: 121}, date), /exceeds/);
  assert.throws(() => addEntry(ledger, {...repayment, date: "2026-11-03"}, date), /issue date/);
  assert.throws(() => addStatement(ledger, {...statement, id: "s2"}, date), /already exists/);
  const reversed = {...saved, settings: {...saved.settings, paymentReversals: [{transactionId: repayment.id, date, amount: 80}]}};
  assert.equal(statementAmounts(reversed, statement, date).paid, 0);
  assert.equal(reversed.settings.cardStatementPayments[0].amount, 80);
});
