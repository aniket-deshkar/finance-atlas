import {budgetLimit, categoryActual, debtRows, obligations, salaryFunding} from "./finance.ts";
import {dayShift, field, money, reportPeriod, rows, type Ledger} from "./ledger.ts";
import type {View} from "./navigation.ts";
import {vehicleReminders} from "./assets.ts";

export type AttentionItem = {
  id: string; fingerprint: string; title: string; detail: string; priority: number; view: View; target?: string;
};
export type AIProposal = {ref: string; reason: string};
export type AgentResult = {specialist: string; status: string; items: AIProposal[]};
type Evidence = Omit<AttentionItem, "fingerprint"> & {actual: number; budget: number} |
  Omit<AttentionItem, "fingerprint"> & {dueDate: string; amount: number; kind: string; status: string};

export function analysisContext(s: Ledger, month: string, asOf: string) {
  const {start, end} = reportPeriod(s, month);
  const spending = s.categories.expense.map(category => ({
    category, actual: categoryActual(s, month, "expense", category, asOf), budget: budgetLimit(s, month, category, asOf)
  })).filter(item => item.budget > 0)
    .sort((a, b) => (b.actual - b.budget) - (a.actual - a.budget)).slice(0, 12);
  const upcoming = obligations(s, dayShift(asOf, -30), dayShift(asOf, 14), asOf)
    .filter(entry => entry.impact === "out" && !entry.projected && entry.amount > 0);
  const due = upcoming.slice(0, 12).map(entry => ({
    ...entry, dueDate: entry.date,
    kind: entry.statement || entry.transaction?.type === "cardPayment" ? "card" : entry.installment ? "emi" : entry.bill ? "bill" : "other",
    status: entry.pending ? "pending" : entry.date < asOf ? "overdue" : "upcoming"
  }));
  const evidence = new Map<string, Evidence>();
  const spendFacts = spending.map(({category, actual, budget}, index) => {
    const id = "spend-" + index;
    evidence.set(id, {id: "spend:" + month + ":" + category, title: "Review " + category + " spending",
      detail: money(actual) + " spent against a " + money(budget) + " budget.", priority: 2, view: "Monthly budget", actual, budget});
    return {id, actual, budget};
  });
  const dueFacts = due.map((entry, index) => {
    const id = "due-" + index;
    const view: View = entry.kind === "card" ? "Card statements" : entry.kind === "emi" ? "EMIs & recoveries" : entry.kind === "bill" ? "Bills & policies" : "Payment calendar";
    evidence.set(id, {id: "due:" + entry.id, title: "Review " + entry.name,
      detail: money(entry.amount) + " · " + entry.dueDate + " · " + entry.status, priority: entry.status === "overdue" ? 0 : 1,
      view, target: entry.cardId, dueDate: entry.dueDate, amount: entry.amount, kind: entry.kind, status: entry.status});
    return {id, dueDate: entry.dueDate, amount: entry.amount, kind: entry.kind, status: entry.status};
  });
  return {summary: {start, end, asOf, spending: spendFacts, obligations: dueFacts}, evidence, upcoming};
}

function fingerprint(item: Omit<AttentionItem, "fingerprint">): AttentionItem {
  return {...item, fingerprint: JSON.stringify([item.detail, item.priority])};
}

export function currentAttention(s: Ledger, month: string, asOf: string, context: ReturnType<typeof analysisContext>): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const entry of context.upcoming.filter(entry => entry.date < asOf).slice(0, 10)) {
    items.push(fingerprint({id: "due:" + entry.id, title: "Review " + entry.name,
      detail: money(entry.amount) + " · " + entry.date + " · " + (entry.pending ? "pending" : "overdue"),
      priority: entry.pending ? 1 : 0, view: entry.statement ? "Card statements" : "Payment calendar", target: entry.cardId}));
  }
  for (const reminder of vehicleReminders(s, dayShift(asOf,-7), dayShift(asOf,14))) {
    items.push(fingerprint({id:"vehicle:" + reminder.id,title:reminder.name,detail:reminder.date,
      priority:reminder.date < asOf ? 0 : 2,view:"Vehicles"}));
  }
  const missing = debtRows(s, asOf).filter(debt => !debt.known);
  if (missing.length) items.push(fingerprint({id: "missing-balances", title: "Confirm outstanding loan balances",
    detail: String(missing.length) + " loan principal balance(s) are missing.", priority: 1, view: "Debt & credit"}));
  if (s.accounts.length && s.settings.salary) {
    const funding = salaryFunding(s, month, asOf);
    if (funding.shortfall > 0) items.push(fingerprint({id: "salary-funding:" + month, title: "Review salary funding",
      detail: "Estimated shortfall " + money(funding.shortfall) + " through " + funding.end + ".", priority: 0, view: "Salary & transfers"}));
  }
  return items;
}

export function reviewProposals(results: AgentResult[], context: ReturnType<typeof analysisContext>): AttentionItem[] {
  const merged = new Map<string, AttentionItem>();
  for (const result of results) for (const proposal of result.items) {
    const fact = context.evidence.get(proposal.ref);
    if (!fact) continue;
    const {id, title, detail, priority, view, target} = fact;
    merged.set(id, fingerprint({id, title, detail, priority, view, target}));
  }
  return [...merged.values()];
}

export function updateReview(s: Ledger, item: AttentionItem, status: "dismissed" | "resolved"): Ledger {
  const decisions = rows(s.settings.attentionDecisions).filter(entry => field(entry, "id") !== item.id);
  return {...s, settings: {...s.settings, attentionDecisions: [...decisions, {id: item.id, fingerprint: item.fingerprint, status}].slice(-500)}};
}
