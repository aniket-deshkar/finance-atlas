import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import {balance, blank, totals} from "../lib/ledger.ts";
import {schedule, validateFinance} from "../lib/finance.ts";

const referencePath = process.env.ATLAS_LEGACY_HTML;

test("ordinary account balances and savings agree with the supplied legacy app", {skip: !referencePath}, () => {
  const html = readFileSync(referencePath, "utf8");
  const start = html.indexOf("const APP='Finance Atlas'"), end = html.indexOf("const $=id=>", start);
  assert.ok(start > 0 && end > start, "The legacy pure-function module was found.");
  const context = vm.createContext({module: {exports: {}}, crypto, SEED: {accounts: []}}, {codeGeneration: {strings: false, wasm: false}});
  vm.runInContext(html.slice(start, end), context, {timeout: 3000});
  const reference = context.module.exports;
  const bank = {id: "bank", name: "Bank", type: "bank", opening: 1000, openingDate: "2026-01-01"};
  const card = {...bank, id: "card", name: "Card", type: "credit", opening: 0, limit: 50000, statementDay: 15, dueDay: 5, dueOffset: 1};
  const cash = {...bank, id: "cash", name: "Cash", type: "cash", opening: 300};
  const ledger = {...blank(), accounts: [bank, card, cash]};
  const types = ["income", "expense", "refund", "transfer", "cardPayment"];
  for (let i = 0; i < 100; i++) {
    const type = types[i % types.length];
    ledger.transactions.push({id: "t-" + i, type, date: "2026-11-" + String(i % 10 + 1).padStart(2, "0"),
      amount: (i * 137 + 101) / 100, accountId: type === "income" || type === "transfer" || type === "cardPayment" ? "bank" : i % 2 ? "card" : "cash",
      toId: type === "transfer" ? "cash" : type === "cardPayment" ? "card" : "", category: type === "income" ? "Paycheck" : type === "transfer" || type === "cardPayment" ? "" : "Food", note: "Synthetic entry " + i});
  }
  const old = reference.validate(structuredClone(ledger));
  const modern = validateFinance(ledger, "2026-11-10");
  for (const account of ledger.accounts) assert.equal(balance(modern, account, "2026-11-10"), Math.round(reference.balance(old, account.id, "2026-11-10") * 100), account.name);
  const expected = reference.monthStats(old, "2026-11", "2026-11-10"), actual = totals(modern, "2026-11-01", "2026-11-30", "2026-11-10");
  assert.equal(actual.income, Math.round(expected.income * 100));
  assert.equal(actual.spending, Math.round(expected.expenses * 100));
  assert.equal(actual.savings, Math.round(expected.savings * 100));
});

test("legacy and new EMI schedules agree on tenure, short months and historical progress", {skip: !referencePath}, () => {
  const html = readFileSync(referencePath, "utf8"), start = html.indexOf("const APP='Finance Atlas'"), end = html.indexOf("const $=id=>", start);
  const context = vm.createContext({module: {exports: {}}, crypto, SEED: {accounts: []}}, {codeGeneration: {strings: false, wasm: false}});
  vm.runInContext(html.slice(start, end), context, {timeout: 3000});
  const loan = {id: "loan", title: "Test", kind: "bank", firstDue: "2026-01-31", emi: 500, financed: 5000, installments: 12, previouslyPaid: 2, bankId: "", cardId: "", category: "Debt"};
  const ledger = {...blank(), loans: [loan]};
  const old = context.module.exports.schedule(ledger, loan), modern = schedule(ledger, loan, "2026-11-10");
  assert.deepEqual(modern.map(item => ({number: item.number, date: item.date, amount: item.amount, recorded: item.recorded})),
    JSON.parse(JSON.stringify(old.map(item => ({number: item.installment, date: item.date, amount: Math.round(item.amount * 100), recorded: item.recorded})))));
});
