import {cashMetrics, obligations, salaryFunding} from "./finance.ts";
import {balance, displayPeriod, field, minor, money, type Ledger} from "./ledger.ts";
import {portfolio, taxFigures, financialYear, vehicleCosts, workspaceRows, yearRange} from "./assets.ts";
import type {View} from "./navigation";

export type Model = {id: string; label: string; provider: string; levels: string[]; fallback: string; enabled: boolean;
  location?: string; input?: number; output?: number; pricingDate?: string; unavailable?: string};
export type Fact = {ref: string; start: string; end: string; values: Record<string, number>};
export type Usage = {id: string; at?: string; model: string; reasoning: string; estimate: number; cost: number | null;
  input?: number; output?: number; calls?: number; search?: number; status: string; kind?: string};
export type Turn = {role: "user" | "assistant"; text: string; sources?: {ref: string; view: View; id?: string; label: string}[]};
export const usd = (micros: number) => "$" + (micros / 1_000_000).toFixed(5);

export function assistantFact(ledger: Ledger, view: View, ref: string, month: string, asOf: string, selection = ""): Fact | null {
  const {start, end} = displayPeriod(ledger, month, asOf);
  let values: Record<string, number>;
  const target = ledger.accounts.find(account => account.id === selection);
  if (view === "Accounts" && target) {
    values = {[target.type === "credit" ? "cardOutstanding" : "liquidBalance"]: balance(ledger, target, asOf)};
  } else if (view === "Accounts") {
    values = {liquidBalance: ledger.accounts.filter(x => x.type !== "credit").reduce((sum, x) => sum + balance(ledger,x,asOf), 0),
      cardOutstanding: ledger.accounts.filter(x => x.type === "credit").reduce((sum, x) => sum + balance(ledger,x,asOf), 0)};
  } else if (["Bills & policies", "Card statements", "EMIs & recoveries", "Payment calendar"].includes(view)) {
    const types: Record<string, string> = {"Bills & policies": "bill", "Card statements": "card", "EMIs & recoveries": "emi"};
    const due = obligations(ledger, start, end, asOf).filter(item =>
      (!selection || item.cardId === selection) && (!types[view] || (item.statement || item.transaction?.type === "cardPayment" ? "card" :
        item.installment ? "emi" : item.bill ? "bill" : "other") === types[view]) && (view !== "Payment calendar" || item.impact === "out"));
    values = {due: due.reduce((sum, item) => sum + item.amount, 0), count: due.length};
  } else if (view === "Salary & transfers") {
    const funding = salaryFunding(ledger, month, asOf);
    values = {shortfall: funding.shortfall};
  } else if (view === "Investments") {
    const facts = portfolio(ledger, asOf);
    values = {invested: facts.invested, marketValue: facts.marketValue, valuedCount: facts.valuedCount};
  } else if (view === "Vehicles") {
    values = {linkedCosts: workspaceRows(ledger, "vehicles").reduce((sum, item) => sum + vehicleCosts(ledger, field(item,"id"), start, end, asOf), 0)};
  } else if (view === "Tax") {
    const year = financialYear(asOf), facts = taxFigures(ledger, year, asOf);
    values = {interest: facts.interest, tds: facts.tds, ...(facts.inputs.salary !== undefined ? {salary: facts.salary} : {}),
      ...(facts.estimate ? {estimatedTaxOld: facts.estimate.old, estimatedTaxNew: facts.estimate.modern} : {})};
    return {ref, ...yearRange(year), values};
  } else if (["Overview", "Transactions", "Monthly budget", "Insights", "Monthly report", "Daily hub", "12-month plan", "Goals", "Debt & credit"].includes(view)) {
    const cash = cashMetrics(ledger, month, asOf, {start, end, basis: ""});
    values = {income: cash.income, spending: cash.spending, savings: cash.savings, cashOutflow: cash.outflow,
      expectedOutflow: cash.expectedOutflow};
  } else return null;
  return {ref, start, end, values};
}

const fieldLabels: Record<string, string> = {income: "Income", spending: "Spending", savings: "Net savings",
  liquidBalance: "Liquid balance", cardOutstanding: "Card outstanding", cashOutflow: "Exact cash outflow",
  expectedOutflow: "Expected cash outflow", due: "Outstanding dues in period", count: "Number of records", shortfall: "Funding shortfall",
  invested: "Current cost basis", marketValue: "Market value of priced holdings", valuedCount: "Priced holdings",
  linkedCosts: "Linked vehicle expenses", salary: "Confirmed gross salary", interest: "Interest", tds: "TDS",
  estimatedTaxOld: "Estimated tax, old regime", estimatedTaxNew: "Estimated tax, new regime",
  debit: "Extracted statement debits", credit: "Extracted statement credits"};
export const formatFact = (fact: Fact, privacy: boolean) => Object.entries(fact.values).map(([key, value]) =>
  (fieldLabels[key] || key) + " · " + (privacy ? "••••" : key === "count" || key === "valuedCount" ? value : money(value))).join("\n");

export function localAnswer(question: string, facts: Fact[]) {
  const rules: [RegExp, string[]][] = [
    [/saving/i, ["savings"]], [/income|salary/i, ["income","salary","shortfall"]], [/spend|expense|outflow/i, ["spending","cashOutflow","expectedOutflow","linkedCosts"]],
    [/due|bill|repay/i, ["due","count","cardOutstanding"]], [/balance/i, ["liquidBalance","cardOutstanding"]],
    [/statement|debit|credit/i, ["debit","credit","count","cardOutstanding"]],
    [/portfolio|investment/i, ["invested","marketValue","valuedCount"]], [/tax|tds/i, ["salary","interest","tds","estimatedTaxOld","estimatedTaxNew"]]
  ];
  const matching = rules.filter(([pattern]) => pattern.test(question)).flatMap(([, keys]) => keys);
  const selected = facts.map(fact => ({...fact, values: Object.fromEntries(Object.entries(fact.values).filter(([key]) => !matching.length || matching.includes(key)))}))
    .filter(fact => Object.keys(fact.values).length > 0);
  if (!selected.length) return {answer: "Attach a relevant page to see its figures on this device. Connect a cloud model in Settings for open-ended questions.", references: []};
  return {answer: selected.map(fact => fact.start + " to " + fact.end + "\n" + formatFact(fact, false)).join("\n\n"),
    references: selected.map(fact => fact.ref)};
}
