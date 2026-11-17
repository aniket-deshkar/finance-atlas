import assert from "node:assert/strict";
import {test} from "node:test";
import {analysisContext, currentAttention, reviewProposals, updateReview} from "../lib/attention.ts";
import {blank} from "../lib/ledger.ts";

test("approved facts leave personal labels on the device and resolve proposals back to local evidence", () => {
  const ledger = blank(), month = "2026-11", asOf = "2026-11-15";
  ledger.accounts.push({id: "private-bank-id", name: "Private bank account", type: "bank", opening: 10_000, openingDate: "2026-01-01"});
  ledger.transactions.push({id: "private-entry", date: "2026-11-03", type: "expense", amount: 120,
    accountId: "private-bank-id", category: "Food", note: "Private purchase"});
  ledger.budgets[month] = {expense: {Food: 100}};
  ledger.settings.servicePlans = [{id: "private-bill", name: "Private utility", kind: "wifi", amount: 280, category: "Utilities",
    accountId: "private-bank-id", dueDate: "2026-11-10", frequency: "once", active: true}];
  const context = analysisContext(ledger, month, asOf);
  assert.deepEqual(context.summary.spending, [{id: "spend-0", actual: 12_000, budget: 10_000}]);
  assert.equal(context.summary.obligations[0].status, "overdue");
  assert.doesNotMatch(JSON.stringify(context.summary), /Private|private|Food/);
  const localAlerts = currentAttention(ledger, month, asOf, context);
  assert.match(localAlerts[0].title, /Private utility/);
  const items = reviewProposals([{specialist: "spending", status: "complete", items: [
    {ref: "spend-0", reason: "over_budget"}, {ref: "spend-99", reason: "over_budget"}
  ]}], context);
  assert.equal(items.length, 1);
  assert.match(items[0].title, /Food/);
  const reviewed = updateReview(ledger, items[0], "dismissed");
  assert.equal(reviewed.settings.attentionDecisions[0].fingerprint, items[0].fingerprint);
  assert.deepEqual(reviewed.transactions, ledger.transactions);
});
