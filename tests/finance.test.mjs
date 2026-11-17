import {test} from "node:test";
import assert from "node:assert/strict";
import {blank, addEntry, addStatement, balance, currentMonth, minor, reportPeriod, statementAmounts, totals} from "../lib/ledger.ts";
import {
  addMonths, billRows, cardUsage, cashMetrics, categoryActual, confirmScheduled, confirmStatementEmi, datesFor, debtRows,
  enforceHistory, loans, matchRecordedBills, migrateLegacyBills, netPosition, obligations, personal, receivables, recordBill, recordEmi,
  recordPendingCard, recordRecovery, removeUnusedAccount, removeUnusedLoan, removeUnsettledStatement, reverseEntry, salaryFunding, saveBudget, saveTransaction, schedule, splitPayment,
  upsertLoan, upsertService, validateFinance
} from "../lib/finance.ts";
import {csvEncode, csvParse, parseStatement, importStatement as importCsv, attachReceipt, readLegacyArchive, receiptArchive, base64} from "../lib/files.ts";
import {deriveKey, openEncryptedBackup, serializeEnvelope} from "../lib/vault.ts";
import {auditWorkbook} from "../lib/reports.ts";

const now = "2026-11-10";
const payment = (amount, accountId = "bank", extra = {}) => ({date: now, initiatedDate: now, amount, accountId, mode: "Other", reference: "", ...extra});
const bank = {id: "bank", name: "Salary bank", type: "bank", opening: 100000, openingDate: "2026-01-01"};
const target = {...bank, id: "target", name: "EMI bank", opening: 0};
const card = {...bank, id: "card", name: "My card", type: "credit", opening: 0, limit: 50000, statementDay: 15, dueDay: 5, dueOffset: 1};
const service = {id: "bill", name: "Internet", kind: "wifi", amount: 250, category: "Utilities", accountId: "bank", dueDate: now, frequency: "monthly", active: true};
const loan = {id: "loan", title: "Bank loan", kind: "bank", emi: 21700, financed: 200000, installments: 12, previouslyPaid: 0,
  firstDue: "2026-11-10", category: "Debt", bankId: "target", cardId: ""};
const statement = {id: "statement", cardId: "card", statementDate: "2026-11-05", dueDate: "2026-11-20", billAmount: 2000, minimumDue: 100, reference: ""};
function fixture() {return validateFinance({...blank(), accounts: [structuredClone(bank), structuredClone(target), structuredClone(card)]}, now);}

test("legacy monthly plans migrate without changing payment history or short-month due days", () => {
  let s = fixture();
  const rule = {id: "old", name: "Utility", amount: 250, dueDay: 31, startMonth: "2026-02", category: "Utilities", accountId: "bank", active: true, extension: {keep: true}};
  s.settings.billRules = [rule];
  s.transactions.push({id: "old-payment", type: "expense", date: "2026-03-31", accountId: "bank", amount: 250, category: "Utilities", note: "Utility", billId: "old", billMonth: "2026-03"});
  s.transactions.push({id: "scheduled", type: "expense", date: "2026-12-31", accountId: "bank", amount: 250, category: "Utilities", note: "Utility", billId: "old", billMonth: "2026-12"});
  s = validateFinance(s, now);
  const before = structuredClone(s), originalBalance = balance(s, bank, now);
  assert.equal(billRows(s, "2026-03-01", "2026-03-31", now)[0].paid, true);
  const migrated = migrateLegacyBills(s, now);
  assert.deepEqual(migrated.transactions, before.transactions);
  assert.deepEqual(migrated.settings.legacyBillRulesArchive, [rule]);
  assert.equal(balance(migrated, bank, now), originalBalance);
  assert.equal(migrated.settings.servicePayments[0].transactionId, "old-payment");
  assert.deepEqual(datesFor(migrated.settings.servicePlans[0], "2026-02-01", "2026-04-30"), ["2026-02-28", "2026-03-31", "2026-04-30"]);
  assert.equal(billRows(migrated, "2026-03-01", "2026-03-31", now)[0].paid, true);
  assert.doesNotThrow(() => enforceHistory(before, migrated, now));
  const confirmed = confirmScheduled(migrated, "scheduled", now, now);
  assert.equal(confirmed.transactions.filter(t => t.id === "scheduled").length, 1);
  assert.equal(confirmed.settings.servicePayments.find(p => p.transactionId === "scheduled").dueDate, "2026-12-31");
  assert.deepEqual(migrateLegacyBills(confirmed, now), confirmed);
});

test("legacy migration refuses conflicting IDs without changing source data", () => {
  const s = fixture();
  s.settings.billRules = [{id: "bill", name: "Old bill", amount: 10, dueDay: 1, startMonth: "2026-01", category: "Utilities", accountId: "bank"}];
  s.settings.servicePlans = [structuredClone(service)];
  const original = structuredClone(s);
  assert.throws(() => migrateLegacyBills(s, now), /IDs conflict/);
  assert.deepEqual(s, original);
});

test("statement imports reject rows whose amount and debit or credit disagree", () => {
  const s = fixture();
  assert.throws(() => parseStatement("Date,Description,Amount,Debit,Credit\n2026-11-10,Purchase,900,100,", s, "bank", now), /amount.*debit|amount.*credit/i);
  assert.throws(() => parseStatement("Date,Description,Amount,Debit,Credit,Type\n2026-11-10,Purchase,100,100,,Credit", s, "bank", now), /direction/i);
  assert.throws(() => parseStatement("Date,Description,Amount,Debit,Credit,Type\n2026-11-10,Deposit,100,,100,Debit", s, "bank", now), /direction/i);
  assert.throws(() => parseStatement("Date,Description,Amount,Debit,Credit\n2026-11-10,Deposit,100.01,,100", s, "bank", now), /amount.*credit/i);
  assert.equal(parseStatement("Date,Description,Amount,Debit,Credit,Type\n2026-11-10,Purchase,100,100,,Debit", s, "bank", now)[0].entry.amount, 100);
  assert.equal(parseStatement("Date,Description,Amount,Debit,Credit\n2026-11-10,Deposit,,,100", s, "bank", now)[0].entry.type, "income");
});

test("statement import respects selected numeric date order and dotted debit and credit labels", () => {
  const s = fixture(), csv = "Date,Description,Amount,Dr/Cr\n05/11/2026,Purchase,100,Dr.\n06/11/2026,Refund,200,Cr.";
  const dayFirst = parseStatement(csv, s, "bank", now, "day-first");
  assert.equal(dayFirst[0].entry.date, "2026-11-05");
  assert.equal(dayFirst[0].entry.type, "expense");
  assert.equal(dayFirst[1].entry.type, "income");
  const monthFirst = parseStatement(csv, s, "bank", now, "month-first");
  assert.equal(monthFirst[0].entry.date, "2026-05-11");
  assert.throws(() => parseStatement("Date,Amount\n13/11/2026,-100", s, "bank", now, "month-first"), /date/i);
});

test("a partially allocated card repayment reduces the latest statement by the full later payment", () => {
  let s = addStatement(fixture(), statement, now);
  s = saveTransaction(s, {id: "pay-partial", type: "cardPayment", date: now, accountId: "bank", toId: "card", amount: 500, category: "", note: "Repayment"}, now);
  s.settings.cardPaymentAllocations = [{id: "allocation", transactionId: "pay-partial", statementId: "statement", amount: 200}];
  s = validateFinance(s, now);
  assert.equal(statementAmounts(s, statement, now).paid, 50000);
  assert.equal(statementAmounts(s, statement, now).due, 150000);
  const reversed = reverseEntry(s, "pay-partial", now, "Correction", now);
  assert.equal(statementAmounts(reversed, statement, now).due, 200000, "A reversed repayment does not settle the statement");
  s.settings.cardPaymentAllocations.push({id: "allocation-2", transactionId: "pay-partial", statementId: "statement", amount: 100});
  s = addStatement(s, {...statement, id: "later", statementDate: "2026-12-05", dueDate: "2026-12-20", billAmount: 1500}, "2026-12-10");
  assert.equal(statementAmounts(s, statement, "2026-12-10").paid, 30000, "Historical statement keeps its explicit allocations");
  assert.equal(statementAmounts(s, s.settings.cardStatements.find(st => st.id === "later"), "2026-12-10").due, 150000, "A payment already reflected in a later snapshot is not counted twice");
});

test("recurrence retains the original day across short months, quarters and day-based periods", () => {
  assert.equal(addMonths("2026-01-31", 2), "2026-03-31");
  assert.deepEqual(datesFor({...service, dueDate: "2026-01-31"}, "2026-01-01", "2026-04-30"), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  assert.deepEqual(datesFor({...service, frequency: "quarterly", dueDate: "2026-01-31"}, "2026-01-01", "2026-10-31"), ["2026-01-31", "2026-04-30", "2026-07-31", "2026-10-31"]);
  assert.deepEqual(datesFor({...service, frequency: "d28", dueDate: "2026-01-01"}, "2026-02-01", "2026-03-31"), ["2026-02-26", "2026-03-26"]);
});

test("cleared bills disappear from dues and pending bills have no cash effect", () => {
  let s = upsertService(fixture(), service, false, now);
  const bill = billRows(s, now, now, now)[0];
  s = recordBill(s, bill, payment(250, "bank", {pending: true}), now);
  assert.equal(balance(s, bank, now), 10000000);
  assert.equal(obligations(s, now, now, now).filter(item => item.bill).length, 1);
  s = recordBill(s, billRows(s, now, now, now)[0], payment(250), now);
  assert.equal(balance(s, bank, now), 9975000);
  assert.equal(obligations(s, now, now, now).filter(item => item.bill).length, 0);
  assert.equal(s.settings.servicePayments.length, 1);
  assert.equal(s.settings.servicePayments[0].amount, 250);
  assert.throws(() => recordBill(s, bill, payment(250), now), /paid/);
});

test("a reversal keeps immutable bill values and permits one corrected payment", () => {
  let s = upsertService(fixture(), service, false, now);
  s = recordBill(s, billRows(s, now, now, now)[0], payment(250), now);
  const original = structuredClone(s);
  s = reverseEntry(s, s.transactions[0].id, now, "Bank rejected debit", now);
  assert.equal(billRows(s, now, now, now)[0].paid, false);
  s = recordBill(s, billRows(s, now, now, now)[0], payment(250), now);
  assert.equal(s.settings.servicePayments.length, 2);
  assert.equal(balance(s, bank, now), 9975000);
  assert.doesNotThrow(() => enforceHistory(original, s, now));
  const corrupted = structuredClone(s);corrupted.settings.servicePayments[0].amount = 1;
  assert.throws(() => enforceHistory(original, corrupted, now), /immutable/);
});

test("auto-debit matching requires a unique actual debit and creates no extra transaction", () => {
  let s = upsertService(fixture(), {...service, autopay: true}, false, now);
  s = addEntry(s, {id: "real", type: "expense", date: now, accountId: "bank", amount: 250, category: "Utilities", note: "Bank auto debit"}, now);
  const linked = matchRecordedBills(s, now);
  assert.equal(linked.transactions.length, 1);
  assert.equal(linked.settings.servicePayments[0].transactionId, "real");
  assert.equal(obligations(linked, now, now, now).length, 0);
  const ambiguous = upsertService(s, {...service, id: "second", autopay: true}, false, now);
  assert.equal(matchRecordedBills(ambiguous, now).settings.servicePayments, undefined);
});

test("subscription tagging adds a plan once and clears its current occurrence", () => {
  let s = fixture();
  const entry = {id: "sub1", date: now, type: "expense", amount: 99, accountId: "card", category: "Subscriptions", note: "Music #subscription", subscription: true};
  s = saveTransaction(s, entry, now);
  assert.equal(s.settings.servicePlans.length, 1);
  assert.equal(billRows(s, now, now, now)[0].paid, true);
  assert.equal(s.settings.servicePayments[0].amount, 99);
  s = saveTransaction(s, {...entry, id: "sub2", date: "2026-12-10"}, "2026-12-10");
  assert.equal(s.settings.servicePlans.length, 1);
  assert.equal(s.settings.servicePayments.length, 2);
});

test("bank EMIs, card posting, recoveries and blocked credit use distinct calculations", () => {
  let s = upsertLoan(fixture(), loan, now);
  const lent = {...loan, id: "lent", title: "Purchase for a friend", kind: "credit", category: "Money Given", emi: 500, financed: 1500, installments: 3, bankId: "bank", cardId: "card"};
  s = upsertLoan(s, lent, now);
  assert.equal(cardUsage(s, card, now).reserved, 150000);
  s = recordEmi(s, loan.id, 1, now, "target", now);
  s = recordEmi(s, lent.id, 1, now, "", now);
  assert.equal(cashMetrics(s, "2026-11", now).bankEmiPaid, 2170000);
  assert.equal(cashMetrics(s, "2026-11", now).cardEmiPosted, 0);
  assert.equal(cardUsage(s, card, now).used, 150000);
  assert.equal(debtRows(s, now).filter(d => d.source === "Bank loan").length, 1);
  s = recordRecovery(s, lent.id, payment(300), now);
  assert.equal(receivables(s, now)[0].recovered, 30000);
  assert.equal(receivables(s, now)[0].remaining, 120000);
  assert.equal(balance(s, bank, now), 10030000);
  assert.throws(() => recordEmi(s, lent.id, 1, now, "", now), /recorded/);
});

test("statement-backed EMI spends once and never inflates the card snapshot", () => {
  let s = addStatement(fixture(), {...statement, statementDate: now}, now);
  const l = {...loan, id: "card-loan", kind: "credit", cardId: "card", bankId: "bank", emi: 500};
  s = upsertLoan(s, l, now);
  s = confirmStatementEmi(s, statement.id, l.id, 1, now);
  assert.equal(schedule(s, l, now)[0].recorded, true);
  assert.equal(balance(s, card, now), 200000);
  assert.equal(totals(s, "2026-11-01", "2026-11-30", now).spending, 50000);
  assert.equal(cashMetrics(s, "2026-11", now).cardEmiPosted, 50000);
  assert.equal(obligations(s, now, now, now).filter(item => item.installment).length, 0);
  assert.throws(() => recordEmi(s, l.id, 1, now, "", now), /recorded/);
});

test("pending card settlement debits once and future card charges map to the billing due date", () => {
  let s = addStatement(fixture(), statement, now);
  s = recordPendingCard(s, statement.id, payment(1000, "bank", {pending: true}), now);
  assert.equal(balance(s, bank, now), 10000000);
  const pending = s.settings.cardStatementPayments[0];
  s = recordPendingCard(s, statement.id, payment(1000), now, pending.id);
  assert.equal(s.settings.cardStatementPayments.length, 1);
  assert.equal(s.settings.cardStatementPayments[0].amount, 1000);
  assert.equal(balance(s, bank, now), 9900000);
  assert.equal(obligations(s, "2026-11-01", "2026-11-30", now).filter(e => e.statement)[0].amount, 100000);
  s = upsertService(s, {...service, accountId: "card", dueDate: "2026-11-25"}, false, now);
  const due = obligations(s, "2026-11-01", "2026-12-31", now);
  assert.equal(due.find(e => e.bill)?.impact, "card");
  assert.equal(due.find(e => e.kind === "Projected card bill")?.date, "2026-12-20");
});

test("salary funding includes linked EMIs, overdue bills, pending card payments and later issued dues", () => {
  let s = fixture();
  s.settings.salary = {enabled: true, amount: 70000, day: 1, weekend: "none", startMonth: "2026-01", accountId: "bank"};
  s.settings.salaryAllocation = {cardAccounts: {card: "target"}};
  s = upsertLoan(s, loan, now);
  s = addStatement(s, {...statement, dueDate: "2026-12-05"}, now);
  s = recordPendingCard(s, statement.id, payment(500, "target", {pending: true}), now);
  s = upsertService(s, {...service, accountId: "target", dueDate: "2026-11-08"}, false, now);
  const funding = salaryFunding(s, "2026-11", now);
  assert.equal(funding.accounts.find(item => item.account.id === "target").due, (21700 + 2000 + 250) * 100);
  assert.equal(funding.unassigned.length, 0);
  assert.equal(funding.transferTotal, (21700 + 2000 + 250) * 100);
  assert.equal(s.transactions.length, 0);
});

test("budget actuals include confirmed EMI spending and exclude card repayment duplication", () => {
  let s = addStatement(fixture(), statement, now);
  s = saveBudget(s, "2026-11", {expense: {Utilities: 1000}, income: {Paycheck: 50000}}, now);
  s = upsertService(s, service, false, now);
  s = recordBill(s, billRows(s, now, now, now)[0], payment(250), now);
  s = recordPendingCard(s, statement.id, payment(500), now);
  assert.equal(categoryActual(s, "2026-11", "expense", "Utilities", now), 25000);
  const cash = cashMetrics(s, "2026-11", now);
  assert.equal(cash.spending, 25000);
  assert.equal(cash.outflow, 75000);
  assert.equal(cash.expectedOutflow, 150000);
});

test("future transactions stay out of actuals and can be confirmed once", () => {
  let s = saveTransaction(fixture(), {id: "future", type: "expense", date: "2026-11-11", amount: 100, accountId: "bank", category: "Food", note: "Scheduled dinner"}, now);
  assert.equal(balance(s, bank, now), 10000000);
  assert.equal(totals(s, "2026-11-01", "2026-11-30", now).spending, 0);
  assert.equal(obligations(s, now, "2026-11-30", now)[0].amount, 10000);
  s = confirmScheduled(s, "future", now, now);
  assert.equal(balance(s, bank, now), 9990000);
  assert.throws(() => confirmScheduled(s, "future", now, now), /scheduled entry/);
});

test("statement CSV preview rejects ambiguous dates and repeated rows, then imports atomically", () => {
  const s = fixture(), text = 'Date,Description,Debit,Credit\n10/11/2026,"Internet, home",250,\n';
  const staged = parseStatement(text, s, "bank", now);
  assert.equal(staged[0].entry.note, "Internet, home");
  const imported = importCsv(s, staged, "test.csv", text, now);
  assert.equal(imported.transactions.length, 1);
  assert.equal(imported.settings.statementArchives[0].text, text);
  assert.equal(parseStatement(text, imported, "bank", now)[0].selected, false);
  assert.throws(() => parseStatement(text + '10/11/2026,"Internet, home",250,\n', s, "bank", now), /duplicate/);
  assert.equal(parseStatement("Date,Amount\n10 Nov 2026,-10", s, "bank", now)[0].entry.date, now);
  assert.equal(parseStatement("Date,Amount\n10/11/26,-10", s, "bank", now)[0].entry.date, now);
  assert.throws(() => parseStatement("Date,Amount\n11/32/26,-10", s, "bank", now), /dates/);
});

test("split payments preserve the total and reversals never alter the original records", () => {
  const s = fixture(), parts = [{category: "Food", amount: 30, note: "Dinner"}, {category: "Clothing", amount: 70, note: "Shirt"}];
  const next = splitPayment(s, now, "bank", 100, parts, now);
  assert.equal(balance(next, bank, now), 9990000);
  assert.equal(next.transactions.length, 2);
  assert.throws(() => splitPayment(s, now, "bank", 99, parts, now), /add up/);
  assert.match(csvEncode([["=malicious", 'a,b']]), /'=malicious/);
  assert.deepEqual(csvParse('"a,b","a""b"\n'), [["a,b", 'a"b']]);
});

test("editing future EMI amounts preserves the original paid installment", () => {
  let s = upsertLoan(fixture(), loan, now);
  s = recordEmi(s, loan.id, 1, now, "target", now);
  s = upsertLoan(s, {...loan, emi: 22000}, now);
  const items = schedule(s, loans(s)[0], now);
  assert.equal(items[0].amount, 2170000);
  assert.equal(items[1].amount, 2200000);
  assert.equal(s.transactions[0].amount, 21700);
});

test("a statement-confirmed EMI's settlement portion is proportional and reverses cleanly", () => {
  let s = upsertLoan(fixture(), {...loan, kind: "credit", cardId: "card", bankId: "bank", emi: 500}, now);
  s = addStatement(s, {...statement, statementDate: now}, now);
  s = confirmStatementEmi(s, statement.id, loan.id, 1, now);
  s = recordPendingCard(s, statement.id, payment(1000), now);
  assert.equal(cashMetrics(s, "2026-11", now).cardEmiPaid, 25000);
  s = reverseEntry(s, s.transactions[0].id, now, "Rejected transfer", now);
  assert.equal(cashMetrics(s, "2026-11", now).cardEmiPaid, 0);
  assert.equal(s.settings.cardStatementPayments[0].amount, 1000);
});

test("receipt archives restore every binary byte and reject corruption", async () => {
  let s = addEntry(fixture(), {id: "purchase", type: "expense", date: now, amount: 10, accountId: "bank", category: "Food", note: "Test"}, now);
  s.customField = {preserved: true};
  const bytes = new Uint8Array([0, 1, 2, 3]);
  s = await attachReceipt(s, "purchase", new File([bytes], "test.pdf", {type: "application/pdf"}));
  const archive = receiptArchive(s);
  const restored = validateFinance(await readLegacyArchive(new File([archive], "test.zip")), now);
  assert.deepEqual(restored.customField, {preserved: true});
  assert.equal(restored.receipts[0].data, base64(bytes));
  assert.equal(restored.receipts[0].txId, "purchase");
  const corrupted = new Uint8Array(await archive.arrayBuffer());
  corrupted[60] ^= 1;
  await assert.rejects(readLegacyArchive(new File([corrupted], "broken.zip")), /integrity/);
});

test("encrypted portable snapshots round-trip with a passphrase and reject the wrong key", async () => {
  const s = fixture(), password = " secret with edge spaces ";
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12)), key = await deriveKey(password, salt);
  const ciphertext = await crypto.subtle.encrypt({name: "AES-GCM", iv, additionalData: new TextEncoder().encode("finance-atlas-web-vault-v1")}, key, new TextEncoder().encode(JSON.stringify(s)));
  const text = serializeEnvelope({version: 1, revision: crypto.randomUUID(), salt, iv, ciphertext});
  assert.equal(text.includes("Salary bank"), false);
  assert.deepEqual(await openEncryptedBackup(text, password), s);
  await assert.rejects(openEncryptedBackup(text, "different password"));
});

test("CSV reconciliation matches both sides of transfers and card payments without duplication", () => {
  let s = addEntry(fixture(), {id: "transfer", type: "transfer", date: now, amount: 500, accountId: "bank", toId: "target", category: "", note: "Self transfer"}, now);
  const csv = "Date,Description,Amount\n2026-11-10,Self transfer,500";
  const staged = parseStatement(csv, s, "target", now);
  assert.equal(staged[0].match, "transfer");
  s = importCsv(s, staged, "incoming.csv", csv, now);
  assert.equal(s.transactions.length, 1);
  s = saveTransaction(s, {id: "repay", type: "cardPayment", date: now, amount: 100, accountId: "bank", toId: "card", category: "", note: "Card repayment"}, now);
  const cardCsv = "Date,Description,Amount\n2026-11-10,Card repayment,100";
  const preview = parseStatement(cardCsv, s, "card", now);
  assert.equal(preview[0].match, "repay");
  assert.equal(importCsv(s, preview, "card.csv", cardCsv, now).transactions.length, 2);
});

test("legacy category normalization merges budgets without losing financial allocations", () => {
  const s = fixture();
  s.categories.expense.push("Insurance / Investments", "Other");
  s.budgets["2026-11"] = {income: {}, expense: {"Insurance / Investments": 100, Insurance: 200, Other: 50, "Other Expenses": 75}};
  s.customExtension = {saved: true};
  const result = validateFinance(s, now);
  assert.equal(result.categories.expense.filter(c => c === "Insurance").length, 1);
  assert.equal(result.budgets["2026-11"].expense.Insurance, 300);
  assert.equal(result.budgets["2026-11"].expense["Other Expenses"], 125);
  assert.deepEqual(result.customExtension, {saved: true});
  assert.equal(s.budgets["2026-11"].expense["Insurance / Investments"], 100);
});

test("salary weekends keep adjacent reporting cycles contiguous across month boundaries", () => {
  const s = fixture();
  s.settings.salary = {enabled: true, day: 1, amount: 50000, accountId: "bank", startMonth: "2026-01", weekend: "previous"};
  s.settings.reportingPeriod = {mode: "salary", day: 1};
  const october = reportPeriod(s, "2026-10"), november = reportPeriod(s, "2026-11");
  assert.equal(october.end, "2026-10-29");
  assert.equal(november.start, "2026-10-30");
  assert.equal(currentMonth(s, "2026-10-30"), "2026-11");
});

test("overpaid card balances remain assets and a repayment preserves net position", () => {
  let s = addEntry(fixture(), {id: "buy", type: "expense", date: now, accountId: "card", amount: 200, category: "Food", note: "Purchase"}, now);
  const before = netPosition(s, now);
  s = saveTransaction(s, {id: "pay", type: "cardPayment", date: now, accountId: "bank", toId: "card", amount: 250, category: "", note: "Repayment"}, now);
  assert.equal(netPosition(s, now).cardCredits, 5000);
  assert.equal(netPosition(s, now).net, before.net);
});

test("confirming a scheduled EMI preserves its ID and attachment relationship", () => {
  let s = upsertLoan(fixture(), loan, now);
  s.transactions.push({id: "scheduled-loan", type: "expense", date: "2026-11-11", amount: loan.emi, accountId: "target",
    category: "Debt", note: "Scheduled loan", loanId: loan.id, installment: 1});
  s.receipts = [{id: "receipt", txId: "scheduled-loan", type: "application/pdf", name: "invoice.pdf", data: "AA==", size: 1}];
  s = confirmScheduled(s, "scheduled-loan", now, now);
  assert.equal(s.transactions.find(t => t.id === "scheduled-loan").date, now);
  assert.equal(s.receipts[0].txId, "scheduled-loan");
});

test("the audit workbook contains valid ZIP entries and treats descriptions as text", async () => {
  const s = addEntry(fixture(), {id: "purchase", type: "expense", date: now, amount: 15, accountId: "bank", category: "Food", note: "=SUM(1,2) <test> & safe"}, now);
  const bytes = new Uint8Array(await auditWorkbook(s, "2026-11", now).arrayBuffer()), view = new DataView(bytes.buffer), files = new Map();
  for (let at = 0; at + 30 < bytes.length && view.getUint32(at, true) === 0x04034b50;) {
    const size = view.getUint32(at + 18, true), nameLength = view.getUint16(at + 26, true), extra = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength)), start = at + 30 + nameLength + extra;
    files.set(name, new TextDecoder().decode(bytes.subarray(start, start + size)));at = start + size;
  }
  assert.ok(files.has("[Content_Types].xml"));
  assert.match(files.get("xl/workbook.xml"), /Card payments/);
  assert.match(files.get("xl/worksheets/sheet3.xml"), /=SUM\(1,2\) &lt;test&gt; &amp; safe/);
  assert.equal(files.get("xl/worksheets/sheet3.xml").includes("<f>"), false);
  assert.equal(files.size, 23);
});

test("recording a bill links its existing debit and preserves its reference without a second expense", () => {
  let s = upsertService(fixture(), service, false, now);
  s = addEntry(s, {id: "existing", type: "expense", date: now, amount: 250, accountId: "bank", category: "Utilities", note: "Internet bill"}, now);
  s = recordBill(s, billRows(s, now, now, now)[0], payment(250, "bank", {reference: "test-reference"}), now);
  assert.equal(s.transactions.length, 1);
  assert.equal(s.settings.servicePayments[0].transactionId, "existing");
  assert.equal(s.settings.servicePayments[0].reference, "test-reference");
  delete s.transactions[0].serviceId;delete s.transactions[0].serviceDue;delete s.transactions[0].servicePaymentId;
  s = upsertService(s, {...service, id: "other-rule", autopay: true}, false, now);
  assert.equal(matchRecordedBills(s, now).settings.servicePayments.length, 1);
});

test("cleanup is limited to unused records and cannot remove financial history", () => {
  let s = fixture();
  assert.equal(removeUnusedAccount(s, "target").accounts.length, 2);
  s = upsertLoan(s, loan, now);
  assert.throws(() => removeUnusedAccount(s, "target"), /without transactions/);
  assert.equal(removeUnusedLoan(s, loan.id).loans.length, 0);
  s = recordEmi(s, loan.id, 1, now, "target", now);
  assert.throws(() => removeUnusedLoan(s, loan.id), /history/);
  s = addStatement(s, statement, now);
  assert.equal(removeUnsettledStatement(s, statement.id).settings.cardStatements.length, 0);
  s = recordPendingCard(s, statement.id, payment(100), now);
  assert.throws(() => removeUnsettledStatement(s, statement.id), /history/);
  assert.equal(s.settings.cardStatementPayments[0].amount, 100);
});

test("duplicate protection permits confirmed distinct entries and distinguishes different loan plans", () => {
  let s = fixture();
  const entry = {id: "ordinary", type: "expense", date: now, amount: 50, accountId: "bank", category: "Food", note: "Same purchase"};
  s = saveTransaction(s, entry, now);
  assert.throws(() => saveTransaction(s, {...entry, id: "duplicate"}, now), /matching transaction/);
  s = saveTransaction(s, {...entry, id: "confirmed", confirmDuplicate: true}, now);
  assert.equal(s.transactions.length, 2);
  s = upsertLoan(s, loan, now);
  s = upsertLoan(s, {...loan, id: "second-loan"}, now);
  s = recordEmi(s, loan.id, 1, now, "target", now);
  s = recordEmi(s, "second-loan", 1, now, "target", now);
  assert.equal(cashMetrics(s, "2026-11", now).bankEmiPaid, 4340000);
});
