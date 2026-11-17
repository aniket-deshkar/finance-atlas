import {
  addEntry, addMinor, balance, dayShift, displayPeriod, duplicateEntry, field, hasReversal, importLedger, latestStatement,
  minor, monthShift, onDay, reportPeriod, row, rows, statementAmounts, totals, validDate,
  type Account, type Entry, type Ledger, type Row
} from "./ledger.ts";

export type Loan = Row & {
  id: string; title: string; kind: "bank" | "credit"; emi: number; financed: number; installments: number;
  previouslyPaid: number; firstDue: string; category: string; bankId: string; cardId: string; autopay?: boolean;
};
export type Service = Row & {
  id: string; name: string; kind: string; amount: number; category: string; accountId: string;
  dueDate: string; frequency: string; active: boolean; autopay?: boolean;
};
export type Installment = {
  loan: Loan; number: number; date: string; amount: number; recorded: boolean; transaction?: Entry; link?: Row;
};
export type Bill = {
  key: string; plan: Row; date: string; legacy: boolean; amount: number; accountId: string;
  paid: boolean; pending?: Row; transaction?: Entry; credit: boolean;
};
export type Obligation = {
  id: string; date: string; name: string; amount: number; kind: string; impact: "out" | "in" | "card";
  accountId: string; cardId?: string; bill?: Bill; installment?: Installment; statement?: Row;
  transaction?: Entry; projected?: boolean; pending?: Row;
};
export type Save = (command: (ledger: Ledger) => Ledger, checkpoint?: boolean) => Promise<boolean>;
export type Payment = { date: string; accountId: string; amount: number; mode: string; reference: string; initiatedDate: string; pending?: boolean };
export const frequencies: Record<string, string> = {
  once: "One time", monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly", d28: "Every 28 days", d56: "Every 56 days", d84: "Every 84 days"
};
export const billKinds: Record<string, string> = {
  utility: "Utility", subscription: "Subscription", insurance: "Insurance / policy", mobile_postpaid: "Mobile postpaid",
  mobile_prepaid: "Mobile prepaid", wifi: "Broadband", dth: "DTH / TV", other: "Other bill"
};
export const paymentModes = ["UPI", "Net banking", "Debit card", "Credit card", "Bank transfer", "Auto-debit", "Cash", "Other"];
export const sum = (values: number[]) => values.reduce(addMinor, 0);
const account = (s: Ledger, id: unknown) => s.accounts.find(a => a.id === id);
const requireValue = (valid: unknown, message: string) => { if (!valid) throw new Error(message); };
const isMonth = (value: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && validDate(value + "-01");
const positive = (value: unknown) => minor(value) > 0;
const serial = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7));
const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export const loans = (s: Ledger) => s.loans as Loan[];
export const personal = (loan: Row) => loan.category !== "Money Given";
export const settingsV6 = (s: Ledger) => row(s.settings.dailyV6);
export function activeLinks(s: Ledger) {
  const voided = new Set(rows(s.settings.statementEmiLinkVoids).map(item => item.linkId));
  return rows(s.settings.statementEmiLinks).filter(link => !voided.has(link.id));
}

export function addMonths(date: string, count: number) {
  return onDay(monthShift(date.slice(0, 7), count), Number(date.slice(8)));
}

export function datesFor(plan: Row, begin: string, end: string, legacy = false): string[] {
  if (plan.active === false || begin > end) return [];
  const start = legacy ? onDay(field(plan, "startMonth"), Number(plan.dueDay)) : field(plan, "dueDate");
  if (!validDate(start) || start > end) return [];
  const frequency = legacy ? "monthly" : field(plan, "frequency");
  if (frequency === "once") return start >= begin ? [start] : [];
  const months = ({monthly: 1, quarterly: 3, yearly: 12} as Record<string, number>)[frequency];
  const days = ({d28: 28, d56: 56, d84: 84} as Record<string, number>)[frequency];
  if (!months && !days) return [];
  const distance = (Date.parse(begin) - Date.parse(start)) / 86400000;
  let index = Math.max(0, Math.floor(months ? (serial(begin) - serial(start)) / months : distance / days));
  const result: string[] = [];
  for (; index < 6000; index++) {
    const date = months ? onDay(monthShift(start.slice(0, 7), index * months),
      legacy ? Number(plan.dueDay) : Number(plan.recurrenceDay) || Number(start.slice(8))) : dayShift(start, index * days);
    if (date > end || !validDate(date)) break;
    if (date >= begin) result.push(date);
  }
  return result;
}

function scheduleIndex(s: Ledger, asOf: string) {
  const reversed = new Set(rows(s.settings.paymentReversals).filter(r => field(r, "date") <= asOf).map(r => r.transactionId));
  const transactions = new Map(s.transactions.filter(t => t.loanId && !reversed.has(t.id)).map(t => [t.loanId + "|" + t.installment, t]));
  const statements = new Set(rows(s.settings.cardStatements).filter(st => field(st, "statementDate") <= asOf).map(st => st.id));
  const links = new Map(activeLinks(s).filter(link => statements.has(link.statementId)).map(link => [link.loanId + "|" + link.installment, link]));
  return {transactions, links};
}
export function schedule(s: Ledger, loan: Loan, asOf: string, context = scheduleIndex(s, asOf)): Installment[] {
  return Array.from({length: loan.installments}, (_, index) => {
    const number = index + 1;
    const transaction = context.transactions.get(loan.id + "|" + number);
    const link = context.links.get(loan.id + "|" + number);
    return {loan, number, date: addMonths(loan.firstDue, index), amount: minor(transaction?.amount ?? link?.amount ?? loan.emi), transaction, link,
      recorded: number <= loan.previouslyPaid || Boolean(transaction && transaction.date <= asOf) || Boolean(link)};
  });
}

export function billRows(s: Ledger, begin: string, end: string, asOf: string): Bill[] {
  const result: Bill[] = [];
  for (const [collection, legacy] of [[rows(s.settings.servicePlans), false], [rows(s.settings.billRules), true]] as const)
    for (const plan of collection) for (const date of datesFor(plan, begin, end, legacy)) {
      const matches = rows(s.settings.servicePayments).filter(p => p.serviceId === plan.id && p.dueDate === date &&
        (!p.transactionId || !hasReversal(s, field(p, "transactionId"), asOf)));
      const transaction = legacy ? s.transactions.find(t => t.billId === plan.id && t.billMonth === date.slice(0, 7) &&
        !hasReversal(s, t.id, asOf)) : s.transactions.find(t =>
          matches.some(p => p.transactionId === t.id) ||
          ((t.serviceId === plan.id && t.serviceDue === date || plan.legacyRuleId === t.billId && t.billId === plan.id && t.billMonth === date.slice(0, 7)) && !hasReversal(s, t.id, asOf)));
      const pending = matches.find(p => !p.completedDate);
      const source = transaction?.accountId || field(pending ?? plan, "accountId");
      result.push({
        key: (legacy ? "legacy:" : "service:") + plan.id + "|" + date, plan, date, legacy,
        amount: minor(transaction?.amount ?? pending?.amount ?? plan.amount), accountId: source,
        credit: account(s, source)?.type === "credit", paid: Boolean(transaction && transaction.date <= asOf), pending, transaction
      });
    }
  return result.sort((a, b) => a.date.localeCompare(b.date) || field(a.plan, "name").localeCompare(field(b.plan, "name")));
}

export function cardCycle(s: Ledger, card: Account, date: string) {
  const statements = rows(s.settings.cardStatements).filter(st => st.cardId === card.id)
    .sort((a, b) => field(a, "statementDate").localeCompare(field(b, "statementDate")));
  for (let i = 0; i < statements.length; i++) {
    const st = statements[i], issued = field(st, "statementDate");
    const previous = i ? field(statements[i - 1], "statementDate") : addMonths(issued, -1);
    if (date > previous && date <= issued) return {statement: issued, due: field(st, "dueDate"), statementId: field(st, "id")};
  }
  const last = statements.filter(st => field(st, "statementDate") < date).at(-1);
  const statementDay = last ? Number(field(last, "statementDate").slice(8)) : Number(card.statementDay) || 15;
  const dueDay = last ? Number(field(last, "dueDate").slice(8)) : Number(card.dueDay) || 5;
  const offset = last ? serial(field(last, "dueDate")) - serial(field(last, "statementDate")) : Number(card.dueOffset ?? 1);
  const close = onDay(date.slice(0, 7), statementDay);
  const statement = date <= close ? close : onDay(monthShift(date.slice(0, 7), 1), statementDay);
  let due = onDay(monthShift(statement.slice(0, 7), offset), dueDay);
  if (due <= statement) due = onDay(monthShift(statement.slice(0, 7), offset + 1), dueDay);
  return {statement, due, statementId: ""};
}

export function cardBills(s: Ledger, card: Account, asOf: string) {
  const owed = Math.max(0, balance(s, card, asOf));
  if (!owed) return [];
  const st = latestStatement(s, card.id, asOf);
  const billed = st ? Math.min(owed, statementAmounts(s, st, asOf).due) : 0;
  const result: {date: string; amount: number; statement?: Row; projected: boolean}[] =
    billed && st ? [{date: field(st, "dueDate"), amount: billed, statement: st, projected: false}] : [];
  if (owed > billed) {
    const cycle = cardCycle(s, card, st && field(st, "statementDate") >= asOf ? dayShift(asOf, 1) : asOf);
    result.push({date: cycle.due, amount: owed - billed, statement: undefined, projected: true});
  }
  return result;
}

export function obligations(s: Ledger, begin: string, end: string, asOf: string): Obligation[] {
  const result: Obligation[] = [], seen = new Set<string>();
  const installments = scheduleIndex(s, asOf);
  const projected = new Map<string, Obligation>();
  const add = (item: Obligation) => { if (item.date >= begin && item.date <= end) result.push(item); };
  const project = (cardId: string, date: string, amount: number) => {
    const card = account(s, cardId);
    if (!card || card.type !== "credit") return;
    const cycle = cardCycle(s, card, date);
    if (cycle.statementId && field(rows(s.settings.cardStatements).find(st => st.id === cycle.statementId) ?? {}, "statementDate") <= asOf) return;
    const id = "projected:" + cardId + "|" + cycle.statement;
    const item = projected.get(id) ?? {id, date: cycle.due, name: card.name + " · projected bill", amount: 0, kind: "Projected card bill",
      impact: "out", accountId: "", cardId, projected: true};
    item.amount = addMinor(item.amount, amount);
    projected.set(id, item);
  };
  for (const bill of billRows(s, addMonths(begin, -2), end, asOf)) {
    if (bill.paid) continue;
    const date = bill.transaction?.date ?? bill.date;
    if (bill.transaction) seen.add(bill.transaction.id);
    add({id: bill.key, date, name: field(bill.plan, "name"), amount: bill.amount,
      kind: billKinds[field(bill.plan, "kind")] ?? "Recurring bill", impact: bill.credit ? "card" : "out",
      accountId: bill.accountId, cardId: bill.credit ? bill.accountId : undefined, bill, pending: bill.pending});
    if (bill.credit) project(bill.accountId, date, bill.amount);
  }
  for (const loan of loans(s)) for (const item of schedule(s, loan, asOf, installments)) {
    if (item.recorded) continue;
    const date = item.transaction?.date ?? item.date;
    if (item.transaction) seen.add(item.transaction.id);
    add({id: "emi:" + loan.id + "|" + item.number, date, name: loan.title + " · EMI #" + item.number, amount: item.amount,
      kind: !personal(loan) ? "Payment for others" : loan.kind === "credit" ? "Card EMI charge" : "Bank EMI",
      impact: loan.kind === "credit" ? "card" : "out", accountId: loan.kind === "credit" ? loan.cardId : loan.bankId,
      cardId: loan.kind === "credit" ? loan.cardId : undefined, installment: item});
    if (loan.kind === "credit") project(loan.cardId, date, item.amount);
  }
  for (const entry of s.transactions.filter(t => t.date > asOf && !seen.has(t.id) && !hasReversal(s, t.id, asOf))) {
    const credit = account(s, entry.accountId)?.type === "credit";
    if (entry.type === "transfer") continue;
    const impact = entry.type === "income" || entry.type === "refund" ? "in" : credit ? "card" : "out";
    add({id: "scheduled:" + entry.id, date: entry.date, name: entry.note || entry.category || entry.type, amount: minor(entry.amount),
      kind: "Scheduled " + (entry.type === "cardPayment" ? "card repayment" : entry.type), impact, accountId: entry.accountId,
      cardId: entry.type === "cardPayment" ? entry.toId : credit ? entry.accountId : undefined, transaction: entry});
    if (credit && entry.type === "expense") project(entry.accountId, entry.date, minor(entry.amount));
  }
  for (const card of s.accounts.filter(a => a.type === "credit")) {
    let scheduled = sum(s.transactions.filter(t => t.type === "cardPayment" && t.toId === card.id && t.date > asOf && t.date <= end).map(t => minor(t.amount)));
    for (const bill of cardBills(s, card, asOf)) {
      const covered = Math.min(scheduled, bill.amount);
      scheduled -= covered;
      if (bill.amount > covered) add({id: "card:" + card.id + "|" + bill.date, date: bill.date, name: card.name, amount: bill.amount - covered,
        kind: bill.statement ? "Card statement due" : "Estimated card bill", impact: "out", accountId: "", cardId: card.id,
        statement: bill.statement, projected: bill.projected});
    }
  }
  for (const item of projected.values()) add(item);
  return result.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

export function postedRows(s: Ledger, start: string, end: string, asOf: string): (Entry & {signed: number})[] {
  const through = end < asOf ? end : asOf;
  const result: (Entry & {signed: number})[] = s.transactions.filter(t => t.date >= start && t.date <= through).map(t => ({...t, signed: minor(t.amount)}));
  for (const reversal of rows(s.settings.paymentReversals)) {
    const original = s.transactions.find(t => t.id === reversal.transactionId);
    const date = field(reversal, "date");
    if (original && date >= start && date <= through) result.push({...original, id: field(reversal, "id"), date,
      amount: Number(reversal.amount), signed: -minor(reversal.amount), reversal: true, note: "Reversal · " + original.note});
  }
  const reversed = new Set(rows(s.settings.paymentReversals).filter(r => field(r, "date") <= asOf).map(r => r.transactionId));
  const activeInstallments = new Set(s.transactions.filter(t => t.loanId && t.date <= asOf && !reversed.has(t.id)).map(t => t.loanId + "|" + t.installment));
  const planIndex = new Map(loans(s).map(l => [l.id, l])), statementIndex = new Map(rows(s.settings.cardStatements).map(st => [st.id, st]));
  for (const link of activeLinks(s)) {
    const date = field(link, "chargeDate"), loan = planIndex.get(String(link.loanId));
    const st = statementIndex.get(link.statementId);
    if (!loan || !st || field(st, "statementDate") > asOf || date < start || date > through ||
        activeInstallments.has(loan.id + "|" + link.installment)) continue;
    result.push({id: "statement-emi:" + link.id, type: "expense", date, accountId: loan.cardId, amount: Number(link.amount),
      signed: minor(link.amount), category: loan.category, loanId: loan.id, installment: link.installment, statementBacked: true,
      note: loan.title + " · confirmed statement EMI"});
  }
  return result;
}

export function salaryDate(s: Ledger, month: string) {
  const salary = row(s.settings.salary);
  if (!salary.enabled || month < field(salary, "startMonth")) return "";
  const date = onDay(month, Number(salary.day) || 1);
  const weekday = new Date(date + "T12:00:00Z").getUTCDay();
  if (weekday !== 0 && weekday !== 6) return date;
  if (salary.weekend === "previous") return dayShift(date, weekday === 0 ? -2 : -1);
  if (salary.weekend === "next") return dayShift(date, weekday === 0 ? 1 : 2);
  return date;
}

export function salaryReceipt(s: Ledger, month: string, asOf: string) {
  const salary = row(s.settings.salary), date = salaryDate(s, month), next = salaryDate(s, monthShift(month, 1));
  return s.transactions.find(t => t.type === "income" && t.date <= asOf && !hasReversal(s, t.id, asOf) &&
    (t.salaryMonth === month || (!t.salaryMonth && t.accountId === salary.accountId && t.category === "Paycheck" &&
      t.amount === salary.amount && t.date >= date && (!next || t.date < next))));
}

export function cashMetrics(s: Ledger, month: string, asOf: string, period = reportPeriod(s, month)) {
  const posted = postedRows(s, period.start, period.end, asOf);
  const actual = totals(s, period.start, period.end, asOf);
  const cash = posted.filter(t => account(s, t.accountId)?.type !== "credit");
  const inflow = sum(cash.filter(t => t.type === "income" || t.type === "refund").map(t => t.signed));
  const outflow = sum(cash.filter(t => t.type === "expense" || t.type === "cardPayment").map(t => t.signed));
  const expected = obligations(s, period.start, period.end, asOf);
  const expectedOutflow = sum(expected.filter(item => item.impact === "out").map(item => item.amount));
  let expectedIncome = sum(expected.filter(item => item.impact === "in" && account(s, item.accountId)?.type !== "credit").map(item => item.amount));
  for (const offset of [-1, 0, 1]) {
    const label = monthShift(month, offset), date = salaryDate(s, label);
    if (date && date >= period.start && date <= period.end && !salaryReceipt(s, label, asOf) &&
        !s.transactions.some(t => t.type === "income" && t.salaryMonth === label && t.date > asOf))
      expectedIncome = addMinor(expectedIncome, minor(row(s.settings.salary).amount));
  }
  const emiRows = posted.filter(t => t.loanId && personal(loans(s).find(l => l.id === t.loanId) ?? {}));
  const bankEmiPaid = sum(emiRows.filter(t => loans(s).find(l => l.id === t.loanId)?.kind === "bank").map(t => t.signed));
  const cardEmiPosted = sum(emiRows.filter(t => loans(s).find(l => l.id === t.loanId)?.kind === "credit").map(t => t.signed));
  let cardEmiPaid = 0;
  for (const st of rows(s.settings.cardStatements)) {
    const portion = sum(activeLinks(s).filter(link => link.statementId === st.id && personal(loans(s).find(l => l.id === link.loanId) ?? {})).map(link => minor(link.amount)));
    if (!portion) continue;
    for (const t of posted.filter(t => t.type === "cardPayment")) {
      const id = t.reversal ? rows(s.settings.paymentReversals).find(r => r.id === t.id)?.transactionId : t.id;
      const explicit = rows(s.settings.cardStatementPayments).find(p => p.transactionId === id);
      const applied = explicit ? explicit.statementId === st.id ? minor(explicit.amount) : 0 :
        sum(rows(s.settings.cardPaymentAllocations).filter(p => p.transactionId === id && p.statementId === st.id).map(p => minor(p.amount))) ||
        (t.cardStatementId === st.id ? minor(t.amount) : 0);
      cardEmiPaid += Math.round(applied * portion / minor(st.billAmount)) * (t.signed < 0 ? -1 : 1);
    }
  }
  const expectedEmis = expected.filter(item => item.installment && personal(item.installment.loan));
  return {...period, ...actual, posted, inflow, outflow, expectedOutflow, expectedIncome, expected, bankEmiPaid, cardEmiPosted, cardEmiPaid,
    bankEmiExpected: sum(expectedEmis.filter(item => item.installment?.loan.kind === "bank").map(item => item.amount)),
    cardEmiExpected: sum(expectedEmis.filter(item => item.installment?.loan.kind === "credit").map(item => item.amount)),
    projectedCashSurplus: sum([inflow, expectedIncome, -outflow, -expectedOutflow])};
}

export function categoryActual(s: Ledger, month: string, kind: string, category: string, asOf: string) {
  const period = reportPeriod(s, month);
  return sum(postedRows(s, period.start, period.end, asOf).filter(t => t.category === category &&
    (kind === "income" ? t.type === "income" : t.type === "expense" || t.type === "refund"))
    .map(t => t.type === "refund" ? -t.signed : t.signed));
}

export function budgetLimit(s: Ledger, month: string, category: string, asOf: string) {
  const current = Number(row(row(s.budgets[month]).expense)[category] ?? 0);
  let carry = 0;
  if (settingsV6(s).rollover) {
    const months = Math.min(60, Math.max(1, Number(settingsV6(s).rolloverMonths) || 12));
    for (let i = months; i > 0; i--) {
      const label = monthShift(month, -i);
      carry += minor(Number(row(row(s.budgets[label]).expense)[category] ?? 0), 20_000_000_000) - categoryActual(s, label, "expense", category, asOf);
    }
  }
  return addMinor(minor(current, 20_000_000_000), carry);
}

export function receivables(s: Ledger, asOf: string) {
  const installments = scheduleIndex(s, asOf);
  return loans(s).filter(l => !personal(l)).map(loan => {
    const entries = s.transactions.filter(t => t.receivableLoanId === loan.id && t.type === "refund" && t.date <= asOf && !hasReversal(s, t.id, asOf));
    const expected = sum(schedule(s, loan, asOf, installments).filter(item => item.number > loan.previouslyPaid).map(item => item.amount));
    const recovered = sum(entries.map(t => minor(t.amount)));
    return {loan, entries, expected, recovered, remaining: Math.max(0, expected - recovered)};
  });
}

export function cardUsage(s: Ledger, card: Account, asOf: string) {
  const owed = Math.max(0, balance(s, card, asOf));
  let reserved = 0, thirdParty = 0;
  const installments = scheduleIndex(s, asOf);
  for (const loan of loans(s).filter(l => l.kind === "credit" && l.cardId === card.id)) {
    const remaining = schedule(s, loan, asOf, installments).filter(item => !item.recorded).length;
    const portion = Math.round(minor(loan.financed > 0 ? loan.financed : loan.emi * loan.installments) * remaining / loan.installments);
    reserved = addMinor(reserved, portion);
    if (!personal(loan)) thirdParty = addMinor(thirdParty, portion);
  }
  const used = addMinor(owed, reserved), limit = minor(Number(card.limit) || 0);
  return {owed, reserved, thirdParty, used, limit, available: Math.max(0, limit - used), utilization: limit > 0 ? used / limit * 100 : null};
}

export function debtRows(s: Ledger, asOf: string) {
  const principal = row(settingsV6(s).loanPrincipal), used = new Set<unknown>();
  const manual = rows(s.debts), result: Row[] = [];
  for (const card of s.accounts.filter(a => a.type === "credit")) {
    const extra = manual.find(d => d.accountId === card.id || (!d.accountId && !d.loanId && normalize(field(d, "name")) === normalize(card.name)));
    if (extra) used.add(extra.id);
    result.push({id: "card:" + card.id, name: card.name, balance: cardUsage(s, card, asOf).owed, known: true, source: "Credit card",
      accountId: card.id, usage: cardUsage(s, card, asOf), apr: null});
  }
  for (const loan of loans(s)) {
    const extra = manual.find(d => d.loanId === loan.id || (!d.accountId && !d.loanId && normalize(field(d, "name")) === normalize(loan.title)));
    if (extra) used.add(extra.id);
    if (loan.kind !== "bank" || !personal(loan)) continue;
    const known = typeof principal[loan.id] === "number";
    result.push({id: "loan:" + loan.id, name: loan.title, source: "Bank loan", loanId: loan.id, known,
      balance: known ? minor(principal[loan.id]) : null, apr: extra?.apr ?? null, minPay: loan.emi,
      remainingInstallments: sum(schedule(s, loan, asOf).filter(item => !item.recorded).map(item => item.amount))});
  }
  for (const debt of manual.filter(d => !used.has(d.id) && !d.accountId && !d.loanId))
    result.push({...debt, source: "Manual debt", balance: minor(debt.balance), known: true});
  return result;
}

export function netPosition(s: Ledger, asOf: string) {
  const cash = sum(s.accounts.filter(a => a.type !== "credit").map(a => balance(s, a, asOf)));
  const cardCredits = sum(s.accounts.filter(a => a.type === "credit").map(a => Math.max(0, -balance(s, a, asOf))));
  const debts = debtRows(s, asOf), debt = sum(debts.filter(d => d.known).map(d => Number(d.balance)));
  const other = minor(Number(settingsV6(s).otherAssets) || 0);
  return {cash, debt, other, cardCredits, assets: cash + other + cardCredits, net: cash + other + cardCredits - debt, unknown: debts.filter(d => !d.known).length};
}

export function salaryFunding(s: Ledger, month: string, asOf: string) {
  const cfg = row(s.settings.salaryAllocation), salary = row(s.settings.salary);
  const receipt = salaryReceipt(s, month, asOf);
  const start = receipt?.date || salaryDate(s, month) || displayPeriod(s, month, asOf).start;
  const next = salaryDate(s, monthShift(month, 1)) || addMonths(start, 1), end = dayShift(next, -1);
  const sourceId = receipt?.accountId || field(salary, "accountId");
  const linked = row(cfg.cardAccounts);
  const oldest = [start, ...loans(s).map(l => l.firstDue), ...rows(s.settings.servicePlans).map(p => field(p, "dueDate")),
    ...rows(s.settings.billRules).map(p => field(p, "startMonth") + "-01"),
    ...s.accounts.filter(a => a.type === "credit").flatMap(a => cardBills(s, a, asOf).map(b => b.date))].filter(validDate).sort()[0];
  const issuedEnd = cfg.includeIssuedCards === false ? end : rows(s.settings.cardStatements).filter(st =>
    latestStatement(s, field(st, "cardId"), asOf)?.id === st.id && statementAmounts(s, st, asOf).due > 0)
    .map(st => field(st, "dueDate")).reduce((latest, date) => date > latest ? date : latest, end);
  const due = obligations(s, cfg.includeOverdue === false ? start : oldest, issuedEnd, asOf)
    .filter(item => item.impact === "out" && (!item.projected || item.date >= start) && (item.date <= end || item.statement || item.transaction?.type === "cardPayment"));
  const entries = due.flatMap(item => {
    let target = item.accountId;
    if (item.cardId && !target) {
      const fromLoans = [...new Set(loans(s).filter(l => l.cardId === item.cardId && l.bankId).map(l => l.bankId))];
      target = Object.hasOwn(linked, item.cardId) ? String(linked[item.cardId]) : fromLoans.length === 1 ? fromLoans[0] : "";
    }
    let remaining = item.amount;
    const portions: (Obligation & {target: string})[] = [];
    if (item.statement) for (const pending of rows(s.settings.cardStatementPayments).filter(p => p.statementId === item.statement?.id && !p.completedDate)) {
      const portion = Math.min(remaining, minor(pending.amount));
      if (portion) portions.push({...item, id: "pending:" + pending.id, amount: portion, target: field(pending, "accountId")});
      remaining -= portion;
    }
    if (remaining) portions.push({...item, amount: remaining, target});
    return portions;
  });
  const accounts = s.accounts.filter(a => a.type !== "credit").map(a => {
    const items = entries.filter(item => item.target === a.id), due = sum(items.map(item => item.amount));
    const reserve = minor(Number(row(cfg.reserves)[a.id]) || 0), current = balance(s, a, asOf);
    const credited = receipt ? cfg.useExistingBalances === false || cfg.useBalances === false ? Math.max(0, current - balance(s, a, dayShift(start, -1))) : current : 0;
    const required = Math.max(0, due + reserve - credited);
    return {account: a, items, due, reserve, available: Math.max(0, credited), required};
  });
  const transferTotal = sum(accounts.filter(item => item.account.id !== sourceId).map(item => item.required));
  const source = accounts.find(item => item.account.id === sourceId), sourcePool = receipt ? source?.available ?? 0 : minor(Number(salary.amount) || 0);
  const sourceAvailable = Math.max(0, sourcePool - (source?.due ?? 0) - (source?.reserve ?? 0));
  return {start, end, next, sourceId, receipt, accounts, entries, unassigned: entries.filter(item => !account(s, item.target) || account(s, item.target)?.type === "credit"),
    transferTotal, sourceAvailable, shortfall: Math.max(0, transferTotal - sourceAvailable)};
}

export function upsertLoan(s: Ledger, loan: Loan, asOf: string): Ledger {
  const existing = loans(s).find(l => l.id === loan.id);
  if (existing && (s.transactions.some(t => t.loanId === loan.id) || activeLinks(s).some(link => link.loanId === loan.id))) {
    requireValue(["kind", "firstDue", "cardId", "previouslyPaid", "category"].every(key => loan[key] === existing[key]),
      "Recorded installments lock the plan type, category, first due date, card and historical progress.");
    const highest = [...s.transactions.filter(t => t.loanId === loan.id), ...activeLinks(s).filter(link => link.loanId === loan.id)]
      .reduce((highest, item) => Math.max(highest, Number(item.installment)), 0);
    requireValue(loan.installments >= highest, "The term cannot exclude a recorded installment.");
  }
  const next = {...s, loans: existing ? s.loans.map(l => l.id === loan.id ? {...l, ...loan} : l) : [...s.loans, loan]};
  return validateFinance(next, asOf);
}

export function recordEmi(s: Ledger, loanId: string, number: number, date: string, bankId: string, asOf: string): Ledger {
  const loan = loans(s).find(l => l.id === loanId);
  requireValue(loan, "Choose an EMI plan.");
  const item = schedule(s, loan!, asOf).find(item => item.number === number);
  requireValue(item && !item.recorded && !item.transaction, "This installment is recorded or already scheduled.");
  const entry: Entry = {id: crypto.randomUUID(), type: "expense", date, amount: loan!.emi, category: loan!.category,
    accountId: loan!.kind === "credit" ? loan!.cardId : bankId, toId: "", loanId, installment: number, note: loan!.title + " · installment #" + number};
  return validateFinance(addEntry(s, entry, asOf), asOf);
}

export function recordRecovery(s: Ledger, loanId: string, payment: Payment, asOf: string): Ledger {
  const receivable = receivables(s, asOf).find(item => item.loan.id === loanId);
  requireValue(receivable && minor(payment.amount) <= receivable.remaining, "The recovery exceeds the remaining money lent.");
  requireValue(account(s, payment.accountId)?.type !== "credit", "Recoveries must credit a bank or cash account.");
  const entry: Entry = {id: crypto.randomUUID(), type: "refund", amount: payment.amount, date: payment.date, accountId: payment.accountId,
    category: "Money Given", note: "Recovery · " + receivable!.loan.title, receivableLoanId: loanId};
  return validateFinance(addEntry(s, entry, asOf), asOf);
}

export function upsertService(s: Ledger, plan: Row, legacy: boolean, asOf: string): Ledger {
  const key = legacy ? "billRules" : "servicePlans", old = rows(s.settings[key]);
  const existing = old.find(p => p.id === plan.id);
  const next = {...s, settings: {...s.settings, [key]: existing ? old.map(p => p.id === plan.id ? {...p, ...plan} : p) : [...old, plan]}};
  return validateFinance(next, asOf);
}

// Explicit, checkpointed migration: retain original fields and transaction links.
export function migrateLegacyBills(s: Ledger, asOf: string): Ledger {
  const legacy = rows(s.settings.billRules), plans = rows(s.settings.servicePlans);
  if (!legacy.length) return s;
  requireValue(plans.length + legacy.length <= 1000, "Too many recurring plans to migrate safely.");
  requireValue(s.settings.legacyBillRulesArchive === undefined || Array.isArray(s.settings.legacyBillRulesArchive) &&
    rows(s.settings.legacyBillRulesArchive).length === (s.settings.legacyBillRulesArchive as unknown[]).length,
  "The existing legacy-plan archive must be reviewed before migration.");
  requireValue(!legacy.some(rule => plans.some(plan => plan.id === rule.id)), "Recurring plan IDs conflict. Export a backup and review the plans before migrating.");
  const history = rows(s.settings.servicePayments).slice();
  const referenced = new Set(history.map(p => p.transactionId));
  for (const rule of legacy) for (const t of s.transactions.filter(t => t.billId === rule.id && t.date <= asOf)) {
    requireValue(t.type === "expense" && isMonth(field(t, "billMonth")) && validDate(t.date) && !referenced.has(t.id),
      "A legacy bill transaction has ambiguous or invalid payment links. Review it before migrating.");
    history.push({id: crypto.randomUUID(), serviceId: rule.id, dueDate: onDay(field(t, "billMonth"), Number(rule.dueDay)),
      amount: t.amount, initiatedDate: t.date, completedDate: t.date, accountId: t.accountId,
      mode: field(t, "paymentMode") || "Other", reference: "", validUntil: "", transactionId: t.id, origin: "legacy-migration"});
    referenced.add(t.id);
  }
  const converted = legacy.map(rule => ({...rule, legacyRuleId: rule.id, dueDate: onDay(field(rule, "startMonth"), Number(rule.dueDay)),
    recurrenceDay: Number(rule.dueDay), frequency: "monthly"}));
  const archive = [...rows(s.settings.legacyBillRulesArchive), ...structuredClone(legacy)];
  return validateFinance({...s, settings: {...s.settings, billRules: [], servicePlans: [...plans, ...converted],
    servicePayments: history, legacyBillRulesArchive: archive}}, asOf);
}

export function recordBill(s: Ledger, target: Bill, payment: Payment, asOf: string, existingId = ""): Ledger {
  const bill = billRows(s, target.date, target.date, asOf).find(item => item.key === target.key);
  requireValue(bill && !bill.paid && !bill.transaction, "This bill is paid or already has a scheduled transaction.");
  requireValue(positive(payment.amount) && validDate(payment.initiatedDate) && payment.initiatedDate <= asOf, "Check the payment amount and initiation date.");
  const previous = bill!.pending;
  requireValue(!existingId || previous?.id === existingId, "The pending payment changed. Reopen it.");
  if (payment.pending && target.legacy) throw new Error("Legacy monthly bills support recorded payments. Edit the rule to use the newer bill schedule for pending payments.");
  let next = structuredClone(s);
  let transaction: Entry | undefined;
  if (!payment.pending) {
    requireValue(validDate(payment.date) && payment.date <= asOf && payment.date >= payment.initiatedDate, "Check the settlement date.");
    const name = normalize(field(bill!.plan, "name"));
    const matches = s.transactions.filter(t => t.type === "expense" && t.date === payment.date && t.accountId === payment.accountId &&
      t.amount === payment.amount && t.category === bill!.plan.category && !t.loanId && !t.billId && !t.serviceId && !hasReversal(s, t.id, asOf) &&
      !rows(s.settings.servicePayments).some(p => p.transactionId === t.id) &&
      name.length >= 3 && (" " + normalize(t.note ?? "") + " ").includes(" " + name + " "));
    if (matches.length > 1) throw new Error("Several recorded debits match. Select the existing expense to link.");
    if (matches.length === 1) {
      const linked = linkExistingBill(s, matches[0].id, bill!.key, asOf);
      if (!bill!.legacy) linked.settings.servicePayments = rows(linked.settings.servicePayments).map(p =>
        p.transactionId === matches[0].id && p.serviceId === bill!.plan.id && p.dueDate === bill!.date ?
          {...p, mode: payment.mode, reference: payment.reference} : p);
      return validateFinance(linked, asOf);
    }
    transaction = {id: crypto.randomUUID(), type: "expense", date: payment.date, amount: payment.amount, category: field(bill!.plan, "category"),
      accountId: payment.accountId, toId: "", note: field(bill!.plan, "name") + " · " + bill!.date, paymentMode: payment.mode,
      ...(bill!.legacy ? {billId: bill!.plan.id, billMonth: bill!.date.slice(0, 7)} : {serviceId: bill!.plan.id, serviceDue: bill!.date})};
    next = addEntry(next, transaction, asOf);
  }
  if (!bill!.legacy) {
    const id = field(previous ?? {}, "id") || crypto.randomUUID();
    const receipt = {...previous, id, serviceId: bill!.plan.id, dueDate: bill!.date, amount: payment.amount,
      initiatedDate: payment.initiatedDate, completedDate: transaction?.date || "", mode: payment.mode, accountId: payment.accountId,
      reference: payment.reference, validUntil: field(previous ?? {}, "validUntil"), transactionId: transaction?.id || "", origin: "created"};
    next.settings.servicePayments = previous ? rows(next.settings.servicePayments).map(p => p.id === id ? receipt : p) : [...rows(next.settings.servicePayments), receipt];
    if (transaction) next.transactions = next.transactions.map(t => t.id === transaction.id ? {...t, servicePaymentId: id} : t);
  }
  return validateFinance(next, asOf);
}

export function reverseEntry(s: Ledger, id: string, date: string, reason: string, asOf: string): Ledger {
  const entry = s.transactions.find(t => t.id === id);
  requireValue(entry && entry.date <= asOf && !hasReversal(s, id, asOf), "Choose a recorded entry that has not been reversed.");
  requireValue(validDate(date) && date >= entry!.date && date <= asOf && reason.trim().length > 0 && reason.length <= 300, "Enter a correction date and reason.");
  return validateFinance({...s, settings: {...s.settings, paymentReversals: [...rows(s.settings.paymentReversals),
    {id: crypto.randomUUID(), transactionId: id, date, amount: entry!.amount, reason: reason.trim(), recordedAt: new Date().toISOString()}]}}, asOf);
}

function attachBill(s: Ledger, transaction: Entry, bill: Bill): Ledger {
  if (bill.legacy) return {...s, transactions: s.transactions.map(t => t.id === transaction.id ? {...t, billId: bill.plan.id, billMonth: bill.date.slice(0, 7)} : t)};
  const id = field(bill.pending ?? {}, "id") || crypto.randomUUID();
  const receipt = {...bill.pending, id, serviceId: bill.plan.id, dueDate: bill.date, amount: transaction.amount,
    initiatedDate: field(bill.pending ?? {}, "initiatedDate") || transaction.date, completedDate: transaction.date,
    mode: field(bill.pending ?? {}, "mode") || field(transaction, "paymentMode") || "Other", accountId: transaction.accountId,
    reference: field(bill.pending ?? {}, "reference") || "Matched recorded debit", validUntil: "", transactionId: transaction.id, origin: "linked"};
  return {...s, transactions: s.transactions.map(t => t.id === transaction.id ? {...t, serviceId: bill.plan.id, serviceDue: bill.date, servicePaymentId: id} : t),
    settings: {...s.settings, servicePayments: bill.pending ? rows(s.settings.servicePayments).map(p => p.id === id ? receipt : p) : [...rows(s.settings.servicePayments), receipt]}};
}

export function matchRecordedBills(s: Ledger, asOf: string): Ledger {
  let next = s;
  const candidates = new Map<string, {entry: Entry; bills: Bill[]}>();
  const counts = new Map<string, number>();
  const dayBills = new Map<string, Bill[]>();
  const linkedPayments = new Set(rows(s.settings.servicePayments).map(p => p.transactionId));
  for (const entry of s.transactions) {
    if (entry.type !== "expense" || entry.date > asOf || entry.loanId || entry.billId || entry.serviceId || linkedPayments.has(entry.id) || hasReversal(s, entry.id, asOf)) continue;
    if (!dayBills.has(entry.date)) dayBills.set(entry.date, billRows(s, dayShift(entry.date, -7), dayShift(entry.date, 7), asOf));
    const bills = dayBills.get(entry.date)!.filter(bill => {
      const name = normalize(field(bill.plan, "name"));
      const named = name.length >= 3 && (" " + normalize(entry.note ?? "") + " ").includes(" " + name + " ");
      return !bill.paid && !bill.transaction && bill.accountId === entry.accountId &&
        minor(entry.amount) === bill.amount && bill.plan.category === entry.category &&
        (!entry.subscriptionServiceId || entry.subscriptionServiceId === bill.plan.id) &&
        (named || (bill.plan.autopay === true && bill.date === entry.date)) &&
        (!bill.pending || field(bill.pending, "initiatedDate") <= entry.date);
    });
    if (bills.length) candidates.set(entry.id, {entry, bills});
    for (const bill of bills) counts.set(bill.key, (counts.get(bill.key) ?? 0) + 1);
  }
  for (const {entry, bills} of candidates.values())
    if (bills.length === 1 && counts.get(bills[0].key) === 1) next = attachBill(next, entry, bills[0]);
  return next;
}

export function saveTransaction(s: Ledger, entry: Entry, asOf: string): Ledger {
  requireValue(!entry.receivableLoanId && !entry.loanId && !entry.serviceId && !entry.billId, "Use the scheduled payment form to record a linked payment.");
  if (entry.confirmDuplicate !== true && duplicateEntry(s, entry, asOf)) throw new Error("A matching transaction already exists. Confirm a separate identical entry if both payments are real.");
  if (entry.type === "cardPayment" && entry.cardStatementId && entry.date <= asOf) {
    const pending = rows(s.settings.cardStatementPayments).filter(p => p.statementId === entry.cardStatementId && !p.completedDate &&
      p.accountId === entry.accountId && minor(p.amount) === minor(entry.amount) && field(p, "initiatedDate") <= entry.date);
    requireValue(pending.length <= 1, "Several pending payments match. Settle the specific payment in Card statements.");
    return recordPendingCard(s, String(entry.cardStatementId), {amount: entry.amount, date: entry.date, accountId: entry.accountId,
      initiatedDate: field(pending[0] ?? {}, "initiatedDate") || entry.date, mode: field(pending[0] ?? {}, "mode") || field(entry, "paymentMode") || "Other",
      reference: field(pending[0] ?? {}, "reference")}, asOf, field(pending[0] ?? {}, "id"));
  }
  let next = entry.date > asOf || entry.type === "cardPayment" ? importLedger({...s, transactions: [...s.transactions, entry]}) : addEntry(s, entry, asOf);
  const tagged = entry.type === "expense" && (entry.subscription || /^subscriptions?$/i.test(entry.category ?? "") || /#subscriptions?\b/i.test(entry.note ?? ""));
  if (tagged) {
    const name = (field(entry, "subscriptionName") || (entry.note ?? "").replace(/#[\p{L}\p{N}_-]+/gu, "").split(/[·|]/)[0].trim()).slice(0, 100);
    requireValue(name, "Enter a subscription name in the notes.");
    const existing = [...rows(next.settings.servicePlans), ...rows(next.settings.billRules)]
      .filter(p => normalize(field(p, "name")) === normalize(name) && p.accountId === entry.accountId && p.active !== false);
    requireValue(existing.length < 2, "Several recurring plans match. Select the bill from upcoming payments.");
    if (!existing.length) {
      const plan = {id: crypto.randomUUID(), name, kind: "subscription", provider: "", reference: "", amount: entry.amount, dueDate: entry.date,
        frequency: field(entry, "subscriptionFrequency") || "monthly", category: entry.category, accountId: entry.accountId, remindDays: 3, active: true,
        subscriptionStartDate: entry.date, createdFromTransactionId: entry.id};
      next = upsertService(next, plan, false, asOf);
    }
    if (entry.date <= asOf) {
      const matches = billRows(next, dayShift(entry.date, -14), dayShift(entry.date, 14), asOf).filter(b =>
        normalize(field(b.plan, "name")) === normalize(name) && b.accountId === entry.accountId && !b.paid && !b.transaction);
      if (matches.length === 1) next = attachBill(next, entry, matches[0]);
    }
  }
  return validateFinance(matchRecordedBills(next, asOf), asOf);
}

export function linkExistingBill(s: Ledger, id: string, key: string, asOf: string): Ledger {
  const entry = s.transactions.find(t => t.id === id);
  requireValue(entry && entry.type === "expense" && entry.date <= asOf && !entry.billId && !entry.serviceId && !entry.loanId && !hasReversal(s, id, asOf),
    "Choose an unlinked recorded expense.");
  requireValue(!rows(s.settings.servicePayments).some(p => p.transactionId === id), "This debit already belongs to a bill payment history record.");
  const bill = billRows(s, dayShift(entry!.date, -32), dayShift(entry!.date, 32), asOf).find(b => b.key === key);
  requireValue(bill && !bill.paid && !bill.transaction && (!bill.pending || field(bill.pending, "initiatedDate") <= entry!.date), "Choose an unpaid occurrence.");
  return validateFinance(attachBill(s, entry!, bill!), asOf);
}

export function confirmScheduled(s: Ledger, id: string, date: string, asOf: string): Ledger {
  const entry = s.transactions.find(t => t.id === id);
  requireValue(entry && entry.date > asOf && validDate(date) && date <= asOf, "Choose a scheduled entry and an actual posting date.");
  const next = {...s, transactions: s.transactions.filter(t => t.id !== id)};
  let result: Ledger;
  if (entry!.loanId) result = recordEmi(next, String(entry!.loanId), Number(entry!.installment), date, entry!.accountId, asOf);
  else if (entry!.serviceId || entry!.billId) {
    const due = String(entry!.serviceDue || entry!.billMonth + "-01");
    const bill = billRows(next, addMonths(due, -1), addMonths(due, 1), asOf)
      .find(b => b.plan.id === (entry!.serviceId || entry!.billId) && (entry!.billId ? b.date.startsWith(String(entry!.billMonth)) : b.date === entry!.serviceDue));
    requireValue(bill, "The scheduled bill occurrence could not be found.");
    result = recordBill(next, bill!, {date, accountId: entry!.accountId, amount: entry!.amount, initiatedDate: date, mode: field(entry!, "paymentMode") || "Other", reference: ""}, asOf);
  } else result = saveTransaction(next, {...entry!, date}, asOf);
  const existingIds = new Set(next.transactions.map(t => t.id));
  const posted = result.transactions.find(t => !existingIds.has(t.id));
  if (!posted) throw new Error("The scheduled posting did not create its ledger entry.");
  result.transactions = result.transactions.map(t => t.id === posted.id ? {...entry!, ...t, id} : t);
  for (const key of ["servicePayments", "cardStatementPayments"]) {
    if (result.settings[key]) result.settings = {...result.settings, [key]: rows(result.settings[key]).map(p =>
      p.transactionId === posted.id ? {...p, transactionId: id} : p)};
  }
  return validateFinance(result, asOf);
}

export function splitPayment(s: Ledger, date: string, accountId: string, total: number, parts: {category: string; amount: number; note: string}[], asOf: string): Ledger {
  requireValue(parts.length >= 2 && parts.length <= 12 && parts.every(p => positive(p.amount)) &&
    sum(parts.map(p => minor(p.amount))) === minor(total), "Split amounts must be positive and add up to the total.");
  const group = crypto.randomUUID();
  let next = s;
  for (const part of parts) next = addEntry(next, {id: crypto.randomUUID(), type: "expense", date, accountId, amount: part.amount, category: part.category,
    note: part.note + " #split-" + group, splitGroup: group}, asOf);
  return validateFinance(next, asOf);
}

export function updateStatement(s: Ledger, statement: Row, asOf: string) {
  const old = rows(s.settings.cardStatements).find(st => st.id === statement.id);
  requireValue(old, "Statement not found.");
  const linked = rows(s.settings.cardStatementPayments).some(p => p.statementId === old!.id && p.completedDate) ||
    activeLinks(s).some(link => link.statementId === old!.id);
  requireValue(!linked || (old!.cardId === statement.cardId && old!.statementDate === statement.statementDate), "A settled statement's card and issue date are locked.");
  requireValue(minor(statement.billAmount) >= statementAmounts(s, old!, asOf).paid, "A statement cannot be smaller than its recorded settlements.");
  const next = {...s, settings: {...s.settings, cardStatements: rows(s.settings.cardStatements).map(st => st.id === statement.id ? {...st, ...statement} : st)}};
  return validateFinance(next, asOf);
}

export function recordSalary(s: Ledger, month: string, payment: Payment, asOf: string): Ledger {
  requireValue(!salaryReceipt(s, month, asOf), "Salary is already recorded for this month.");
  const category = s.categories.income.includes("Paycheck") ? "Paycheck" : s.categories.income[0];
  return validateFinance(addEntry(s, {id: crypto.randomUUID(), type: "income", date: payment.date, amount: payment.amount,
    accountId: payment.accountId, category, salaryMonth: month, note: "Salary · " + month}, asOf), asOf);
}

export function recordPendingCard(s: Ledger, statementId: string, payment: Payment, asOf: string, pendingId = "", existingTransactionId = ""): Ledger {
  const statement = rows(s.settings.cardStatements).find(st => st.id === statementId);
  requireValue(statement && field(statement, "statementDate") <= asOf, "Choose an issued statement.");
  const previous = rows(s.settings.cardStatementPayments).find(p => p.id === pendingId);
  requireValue(!pendingId || (previous && !previous.completedDate && previous.statementId === statementId), "This payment history is locked or has changed.");
  requireValue(positive(payment.amount) && account(s, payment.accountId)?.type !== "credit" && validDate(payment.initiatedDate) &&
    payment.initiatedDate <= asOf && paymentModes.includes(payment.mode), "Check the paying account, amount, initiation date and mode.");
  let next = structuredClone(s);
  let transaction = existingTransactionId ? next.transactions.find(t => t.id === existingTransactionId) : undefined;
  if (!payment.pending) {
    requireValue(payment.date >= field(statement!, "statementDate") && payment.date >= payment.initiatedDate && payment.date <= asOf && validDate(payment.date), "Check the settlement date.");
    if (existingTransactionId) requireValue(transaction && transaction.type === "cardPayment" && transaction.toId === statement!.cardId &&
      transaction.accountId === payment.accountId && minor(transaction.amount) === minor(payment.amount) && transaction.date === payment.date &&
      !hasReversal(next, transaction.id, asOf) && !rows(next.settings.cardStatementPayments).some(p => p.transactionId === transaction!.id), "Choose an unlinked matching ledger repayment.");
    const remaining = statementAmounts(next, statement!, asOf).due;
    requireValue(minor(payment.amount) <= remaining + (transaction ? minor(transaction.amount) : 0), "Payment exceeds the statement amount remaining.");
    if (!transaction) {
      transaction = {id: crypto.randomUUID(), type: "cardPayment", date: payment.date, amount: payment.amount, accountId: payment.accountId,
        toId: field(statement!, "cardId"), category: "", note: "Card statement repayment", cardStatementId: statementId, paymentMode: payment.mode};
      next = importLedger({...next, transactions: [...next.transactions, transaction]});
    }
    next.transactions = next.transactions.map(t => t.id === transaction!.id ? {...t, cardStatementId: statementId} : t);
  } else requireValue(!existingTransactionId, "Pending payments cannot link a posted transaction.");
  const record = {...previous, id: pendingId || crypto.randomUUID(), statementId, amount: payment.amount, initiatedDate: payment.initiatedDate,
    completedDate: payment.pending ? "" : payment.date, mode: payment.mode, accountId: payment.accountId, reference: payment.reference,
    transactionId: payment.pending ? "" : transaction!.id, origin: existingTransactionId ? "linked" : "created"};
  next.settings.cardStatementPayments = pendingId ? rows(next.settings.cardStatementPayments).map(p => p.id === pendingId ? record : p) : [...rows(next.settings.cardStatementPayments), record];
  return validateFinance(next, asOf);
}

export function confirmStatementEmi(s: Ledger, statementId: string, loanId: string, number: number, asOf: string): Ledger {
  const statement = rows(s.settings.cardStatements).find(st => st.id === statementId), loan = loans(s).find(l => l.id === loanId);
  requireValue(statement && loan && loan.kind === "credit" && loan.cardId === statement.cardId, "Choose a matching card EMI.");
  const item = schedule(s, loan!, asOf).find(item => item.number === number);
  const previous = rows(s.settings.cardStatements).filter(st => st.cardId === statement!.cardId && field(st, "statementDate") < field(statement!, "statementDate"))
    .sort((a, b) => field(b, "statementDate").localeCompare(field(a, "statementDate")))[0];
  const start = previous ? field(previous, "statementDate") : addMonths(field(statement!, "statementDate"), -1);
  requireValue(item && !item.recorded && !item.transaction && item.date > start && item.date <= field(statement!, "statementDate"), "This installment is outside the statement cycle or already recorded.");
  const portion = sum(activeLinks(s).filter(link => link.statementId === statementId).map(link => minor(link.amount)));
  requireValue(portion + item!.amount <= minor(statement!.billAmount), "EMI breakdown exceeds the statement total.");
  return validateFinance({...s, settings: {...s.settings, statementEmiLinks: [...rows(s.settings.statementEmiLinks),
    {id: crypto.randomUUID(), statementId, loanId, installment: number, amount: loan!.emi, chargeDate: item!.date, recordedAt: new Date().toISOString()}]}}, asOf);
}

export function reconcileBalance(s: Ledger, id: string, amount: number, date: string, asOf: string): Ledger {
  const a = account(s, id);
  requireValue(a && validDate(date) && date >= a.openingDate && date <= asOf, "Check the balance date and account.");
  const confirmed = minor(amount), current = balance(s, a!, date);
  requireValue(a!.type !== "credit" || confirmed >= 0, "Card outstanding must be nonnegative.");
  const correction = {id: crypto.randomUUID(), date, confirmedBalance: amount, delta: (confirmed - current) / 100, recordedAt: new Date().toISOString()};
  return {...s, accounts: s.accounts.map(a => a.id === id ? {...a, balanceAdjustments: [...rows(a.balanceAdjustments), correction]} : a)};
}

export function saveBudget(s: Ledger, month: string, budget: Row, asOf: string): Ledger {
  return validateFinance({...s, budgets: {...s.budgets, [month]: {...row(s.budgets[month]), ...budget}}}, asOf);
}

export function removeUnusedLoan(s: Ledger, id: string): Ledger {
  const loan = loans(s).find(l => l.id === id);
  requireValue(loan && loan.previouslyPaid === 0 && !s.transactions.some(t => t.loanId === id || t.receivableLoanId === id) &&
    !rows(s.settings.statementEmiLinks).some(link => link.loanId === id) && !rows(s.debts).some(d => d.loanId === id) &&
    !Object.hasOwn(row(settingsV6(s).loanPrincipal), id), "This plan has history or a principal balance. Keep it for audit and use reversals for payment corrections.");
  return {...s, loans: s.loans.filter(l => l.id !== id)};
}

export function removeUnusedAccount(s: Ledger, id: string): Ledger {
  const a = account(s, id), references = [
    ...loans(s).flatMap(l => [l.bankId, l.cardId]), ...rows(s.settings.cardStatements).map(st => st.cardId),
    ...rows(s.settings.cardStatementPayments).map(p => p.accountId), ...rows(s.settings.servicePlans).map(p => p.accountId),
    ...rows(s.settings.billRules).map(p => p.accountId), ...rows(s.settings.servicePayments).map(p => p.accountId),
    ...rows(s.debts).map(d => d.accountId), row(s.settings.salary).accountId,
    ...Object.values(row(row(s.settings.salaryAllocation).cardAccounts)), ...rows(settingsV6(s).merchantTemplates).map(t => t.accountId)
  ];
  requireValue(a && a.opening === 0 && rows(a.balanceAdjustments).length === 0 && !references.includes(id) &&
    !s.transactions.some(t => t.accountId === id || t.toId === id), "Only zero-opening accounts without transactions, balance confirmations or plan links can be removed.");
  return {...s, accounts: s.accounts.filter(a => a.id !== id)};
}

export function removeUnsettledStatement(s: Ledger, id: string): Ledger {
  const st = rows(s.settings.cardStatements).find(st => st.id === id);
  requireValue(st && !rows(s.settings.cardStatementPayments).some(p => p.statementId === id) &&
    !rows(s.settings.statementEmiLinks).some(link => link.statementId === id) &&
    !rows(s.settings.cardPaymentAllocations).some(p => p.statementId === id) &&
    !s.transactions.some(t => t.cardStatementId === id || (t.type === "cardPayment" && t.toId === st!.cardId && t.date >= field(st!, "statementDate"))),
  "This statement has payment or EMI history. Edit its details or add a correction.");
  return {...s, settings: {...s.settings, cardStatements: rows(s.settings.cardStatements).filter(st => st.id !== id)}};
}

export function repeatingPayments(s: Ledger, asOf: string) {
  const plans = [...rows(s.settings.servicePlans).map(p => ({p, frequency: field(p, "frequency")})), ...rows(s.settings.billRules).map(p => ({p, frequency: "monthly"}))]
    .filter(({p, frequency}) => p.active !== false && frequency !== "once");
  const factors: Record<string, number> = {monthly: 1, quarterly: 1 / 3, yearly: 1 / 12, d28: 365.2425 / 336, d56: 365.2425 / 672, d84: 365.2425 / 1008};
  const result = plans.map(({p, frequency}) => ({id: String(p.id), name: field(p, "name"), frequency, accountId: field(p, "accountId"),
    monthly: Math.round(minor(p.amount) * (factors[frequency] ?? 0)), configured: true}));
  const unlinked = new Map<string, Entry[]>();
  for (const t of s.transactions.filter(t => t.type === "expense" && t.date <= asOf && t.date >= addMonths(asOf, -6) && !t.serviceId && !t.billId && !t.loanId && !hasReversal(s, t.id, asOf))) {
    const key = normalize(t.note ?? "") + "|" + t.accountId;
    if (plans.some(({p}) => p.accountId === t.accountId && normalize(field(p, "name")) === normalize(t.note ?? ""))) continue;
    if (!unlinked.has(key)) unlinked.set(key, []);
    unlinked.get(key)!.push(t);
  }
  for (const [id, entries] of unlinked) if (new Set(entries.map(t => t.date.slice(0, 7))).size > 1) {
    const last = entries.toSorted((a, b) => b.date.localeCompare(a.date))[0];
    result.push({id, name: last.note || last.category || "Repeating payment", frequency: "detected", accountId: last.accountId, monthly: minor(last.amount), configured: false});
  }
  return result;
}

export function simulateDebt(input: Row[], extra: number, strategy: string) {
  const debts = input.filter(d => d.source !== "Credit card" && d.known && typeof d.apr === "number" && typeof d.minPay === "number" && Number(d.balance) > 0)
    .map(d => ({name: field(d, "name"), balance: Number(d.balance), apr: Number(d.apr), minimum: minor(d.minPay)}));
  const budget = sum(debts.map(d => d.minimum)) + extra;
  let interest = 0, months = 0;
  const order: {name: string; month: number}[] = [];
  for (; months < 600 && debts.some(d => d.balance > 0);) {
    months++;
    for (const d of debts) if (d.balance > 0) {
      const charge = Math.round(d.balance * d.apr / 1200); interest += charge; d.balance += charge;
    }
    let pool = budget;
    for (const d of debts) { const paid = Math.min(d.balance, d.minimum); d.balance -= paid; pool -= paid; }
    for (const d of debts.toSorted(strategy === "snowball" ? (a, b) => a.balance - b.balance : (a, b) => b.apr - a.apr)) {
      const paid = Math.min(Math.max(0, pool), d.balance); d.balance -= paid; pool -= paid;
    }
    for (const d of debts) if (d.balance === 0 && !order.some(o => o.name === d.name)) order.push({name: d.name, month: months});
  }
  return {months, interest, order, complete: debts.every(d => d.balance === 0), count: debts.length};
}

export function validateFinance(input: Ledger, asOf: string): Ledger {
  let s = importLedger(input);
  const aliases: Record<string, string> = {"Insurance / Investments": "Insurance", Other: "Other Expenses"};
  if (s.categories.expense.some(c => Object.hasOwn(aliases, c))) {
    s = structuredClone(s);
    const mapped = (c: string) => Object.hasOwn(aliases, c) ? aliases[c] : c;
    s.categories.expense = [...new Set(s.categories.expense.map(mapped))];
    for (const t of s.transactions) if (t.type !== "income" && t.category) t.category = mapped(t.category);
    for (const collection of [s.loans, rows(s.settings.servicePlans), rows(s.settings.billRules), rows(settingsV6(s).merchantTemplates)])
      for (const item of collection) if (typeof item.category === "string") item.category = mapped(item.category);
    for (const budget of Object.values(s.budgets)) {
      const expense = row(row(budget).expense);
      for (const [old, name] of Object.entries(aliases)) if (Object.hasOwn(expense, old)) {
        expense[name] = (minor(expense[old]) + minor(Number(expense[name]) || 0, 20_000_000_000)) / 100;delete expense[old];
      }
    }
  }
  const identifiers = new Set(s.accounts.map(a => a.id));
  const identify = (item: Row) => {
    const id = field(item, "id");
    requireValue(id && id.length <= 180 && !identifiers.has(id), "A financial record has a missing or duplicate ID.");
    identifiers.add(id);
  };
  for (const t of s.transactions) identify(t);
  for (const kind of ["income", "expense"] as const) {
    requireValue(s.categories[kind].length <= 110 && new Set(s.categories[kind]).size === s.categories[kind].length, "Review duplicate categories.");
    for (const category of s.categories[kind]) requireValue(category.trim() && category.length <= 80 &&
      !["__proto__", "constructor", "prototype"].includes(category.toLowerCase()), "Invalid category name.");
  }
  for (const a of s.accounts) {
    if (a.type !== "credit") continue;
    requireValue(minor(Number(a.limit) || 0) >= 0, "Credit limit cannot be negative.");
    for (const key of ["statementDay", "dueDay"]) if (a[key] !== undefined)
      requireValue(Number.isInteger(a[key]) && Number(a[key]) >= 1 && Number(a[key]) <= 31, "Card cycle days must be from 1 to 31.");
    requireValue(a.dueOffset === undefined || [0, 1].includes(Number(a.dueOffset)), "Choose a valid card due month.");
    requireValue(a.dueOffset !== 0 || Number(a.dueDay) > Number(a.statementDay), "A same-month due day must follow the statement day.");
  }
  requireValue(new Set(s.accounts.map(a => a.name.trim().toLowerCase())).size === s.accounts.length, "An account already uses that name.");
  for (const key of ["cardStatements", "cardStatementPayments", "servicePlans", "servicePayments", "billRules", "paymentReversals", "cardPaymentAllocations", "statementEmiLinks", "statementEmiLinkVoids"])
    if (s.settings[key] !== undefined) requireValue(Array.isArray(s.settings[key]) && (s.settings[key] as unknown[]).length <= 30000 &&
      rows(s.settings[key]).length === (s.settings[key] as unknown[]).length, "Review the " + key + " records.");
  for (const l of loans(s)) {
    identify(l);
    requireValue(l.title?.trim() && l.title.length <= 120 && ["bank", "credit"].includes(l.kind) && positive(l.emi) && minor(l.financed) >= 0 &&
      Number.isInteger(l.installments) && l.installments > 0 && l.installments <= 600 && Number.isInteger(l.previouslyPaid) &&
      l.previouslyPaid >= 0 && l.previouslyPaid <= l.installments && validDate(l.firstDue) && s.categories.expense.includes(l.category), "Review the EMI plan details.");
    requireValue(!l.bankId || (account(s, l.bankId) && account(s, l.bankId)?.type !== "credit"), "An EMI payment account is missing.");
    if (l.kind === "credit") requireValue(account(s, l.cardId)?.type === "credit", "A card EMI must link to your credit card.");
  }
  for (const [collection, legacy] of [[rows(s.settings.servicePlans), false], [rows(s.settings.billRules), true]] as const) {
    requireValue(collection.length <= 1000, "Too many recurring plans.");
    for (const p of collection) {
      identify(p);
      requireValue(field(p, "name").trim() && field(p, "name").length <= 110 && positive(p.amount) && account(s, p.accountId) &&
        s.categories.expense.includes(field(p, "category")), "Review a recurring bill's name, amount, account and category.");
      requireValue(legacy ? isMonth(field(p, "startMonth")) && Number.isInteger(p.dueDay) && Number(p.dueDay) >= 1 && Number(p.dueDay) <= 31
        : validDate(field(p, "dueDate")) && Object.hasOwn(frequencies, field(p, "frequency")), "Review the bill recurrence dates.");
      if (!legacy && p.recurrenceDay !== undefined) requireValue(Number.isInteger(p.recurrenceDay) && Number(p.recurrenceDay) >= 1 && Number(p.recurrenceDay) <= 31, "Review the recurring day of month.");
      if (p.kind === "insurance") {
        if (p.coverageAmount !== undefined) requireValue(minor(p.coverageAmount, 1_000_000_000_000) >= 0, "Review policy coverage amount.");
        if (p.policyStartDate) requireValue(validDate(field(p, "policyStartDate")), "Review policy start date.");
        if (p.policyEndDate) requireValue(validDate(field(p, "policyEndDate")) && (!p.policyStartDate || field(p, "policyEndDate") >= field(p, "policyStartDate")), "Review policy end date.");
      }
    }
  }
  for (const [month, item] of Object.entries(s.budgets)) {
    requireValue(isMonth(month), "Review a budget month.");
    for (const kind of ["income", "expense"] as const) for (const [category, amount] of Object.entries(row(row(item)[kind]))) {
      const maximum = kind === "expense" && ["Insurance", "Other Expenses"].includes(category) ? 20_000_000_000 : 10_000_000_000;
      requireValue(s.categories[kind].includes(category) && minor(amount, maximum) >= 0, "Review budget categories and amounts.");
    }
  }
  const reversed = new Set<unknown>();
  for (const r of rows(s.settings.paymentReversals)) {
    identify(r);
    const t = s.transactions.find(t => t.id === r.transactionId);
    requireValue(t && !reversed.has(r.transactionId) && validDate(field(r, "date")) && field(r, "date") >= t.date &&
      field(r, "date") <= asOf && minor(r.amount) === minor(t.amount), "Invalid or duplicate reversal.");
    reversed.add(r.transactionId);
  }
  const scheduledEmis = new Set<string>();
  for (const t of s.transactions) {
    if (t.loanId) {
      const l = loans(s).find(l => l.id === t.loanId), key = t.loanId + "|" + t.installment;
      requireValue(l && t.type === "expense" && Number.isInteger(t.installment) && Number(t.installment) > l.previouslyPaid &&
        Number(t.installment) <= l.installments && (l.kind !== "credit" || t.accountId === l.cardId), "An EMI payment has invalid plan links.");
      if (!hasReversal(s, t.id, asOf)) { requireValue(!scheduledEmis.has(key), "Duplicate EMI installment."); scheduledEmis.add(key); }
    }
    if (t.receivableLoanId) requireValue(t.type === "refund" && t.category === "Money Given" && account(s, t.accountId)?.type !== "credit" &&
      loans(s).some(l => l.id === t.receivableLoanId && !personal(l)), "A recovery must link to money lent and credit bank or cash.");
  }
  const paidBills = new Set<string>(), paymentTransactions = new Set<unknown>();
  for (const key of ["cardStatementPayments", "servicePayments"]) for (const p of rows(s.settings[key])) {
    identify(p);
    requireValue(positive(p.amount) && account(s, p.accountId) && validDate(field(p, "initiatedDate")), "Review payment history.");
    requireValue(key !== "cardStatementPayments" || (account(s, p.accountId)?.type !== "credit" &&
      rows(s.settings.cardStatements).some(st => st.id === p.statementId)), "A pending repayment needs its statement and bank account.");
    if (key === "servicePayments") {
      requireValue(rows(s.settings.servicePlans).some(plan => plan.id === p.serviceId) && validDate(field(p, "dueDate")), "A bill payment needs its plan and due date.");
      if (!hasReversal(s, field(p, "transactionId"), asOf)) {
        const occurrence = p.serviceId + "|" + p.dueDate;
        requireValue(!paidBills.has(occurrence), "Duplicate bill payment occurrence.");paidBills.add(occurrence);
      }
    }
    if (!p.completedDate) { requireValue(!p.transactionId, "Pending payments cannot have a posted transaction."); continue; }
    const t = s.transactions.find(t => t.id === p.transactionId);
    requireValue(t && t.accountId === p.accountId && t.date === p.completedDate && minor(t.amount) === minor(p.amount) &&
      field(p, "completedDate") >= field(p, "initiatedDate"), "Payment history and its ledger entry do not agree.");
    requireValue(!paymentTransactions.has(p.transactionId), "One ledger movement cannot settle two payment history records.");
    paymentTransactions.add(p.transactionId);
    if (key === "cardStatementPayments") requireValue(t!.type === "cardPayment" &&
      rows(s.settings.cardStatements).some(st => st.id === p.statementId && st.cardId === t!.toId), "A repayment has a missing card statement.");
    else requireValue(t!.type === "expense" && rows(s.settings.servicePlans).some(plan => plan.id === p.serviceId), "A bill payment has a missing plan.");
  }
  const linked = new Set<string>(), linkIds = new Set(activeLinks(s).map(link => link.id));
  for (const link of rows(s.settings.statementEmiLinks)) {
    identify(link);
    const l = loans(s).find(l => l.id === link.loanId), st = rows(s.settings.cardStatements).find(st => st.id === link.statementId);
    requireValue(l && st && l.kind === "credit" && st.cardId === l.cardId && Number.isInteger(link.installment) && Number(link.installment) > l.previouslyPaid &&
      Number(link.installment) <= l.installments && positive(link.amount) && validDate(field(link, "chargeDate")) &&
      field(link, "chargeDate") <= field(st, "statementDate"), "Invalid statement EMI breakdown.");
    if (linkIds.has(link.id)) {
      const key = link.loanId + "|" + link.installment;
      requireValue(!linked.has(key), "Duplicate statement EMI breakdown.");
      linked.add(key);
    }
  }
  const voided = new Set<unknown>();
  for (const correction of rows(s.settings.statementEmiLinkVoids)) {
    identify(correction);
    requireValue(rows(s.settings.statementEmiLinks).some(link => link.id === correction.linkId) && !voided.has(correction.linkId) &&
      validDate(field(correction, "date")) && field(correction, "date") <= asOf && field(correction, "reason").trim() &&
      field(correction, "reason").length <= 300, "Review a statement EMI correction.");
    voided.add(correction.linkId);
  }
  const allocations = new Map<string, number>();
  for (const allocation of rows(s.settings.cardPaymentAllocations)) {
    identify(allocation);
    const t = s.transactions.find(t => t.id === allocation.transactionId), st = rows(s.settings.cardStatements).find(st => st.id === allocation.statementId);
    requireValue(t && st && t.type === "cardPayment" && t.toId === st.cardId && positive(allocation.amount), "Review a card repayment allocation.");
    const applied = addMinor(allocations.get(t!.id) ?? 0, minor(allocation.amount));
    requireValue(applied <= minor(t!.amount), "Allocations exceed the original repayment.");
    allocations.set(t!.id, applied);
  }
  for (const st of rows(s.settings.cardStatements)) {
    identify(st);
    requireValue(account(s, st.cardId)?.type === "credit" && validDate(field(st, "statementDate")) && validDate(field(st, "dueDate")) &&
      field(st, "dueDate") >= field(st, "statementDate") && positive(st.billAmount), "Review a card statement.");
    requireValue(sum(activeLinks(s).filter(link => link.statementId === st.id).map(link => minor(link.amount))) <= minor(st.billAmount), "EMI breakdown exceeds the statement total.");
  }
  const cfg = row(s.settings.reportingPeriod);
  if (cfg.mode !== undefined) requireValue(["calendar", "salary"].includes(field(cfg, "mode")) && Number.isInteger(cfg.day) && Number(cfg.day) >= 1 && Number(cfg.day) <= 31, "Review reporting calendar.");
  const salary = row(s.settings.salary);
  if (Object.keys(salary).length) {
    requireValue(typeof salary.enabled === "boolean" && minor(salary.amount) >= 0 && Number.isInteger(salary.day) && Number(salary.day) >= 1 &&
      Number(salary.day) <= 31 && isMonth(field(salary, "startMonth")) && ["none", "previous", "next"].includes(field(salary, "weekend")) &&
      (!salary.accountId || (account(s, salary.accountId) && account(s, salary.accountId)?.type !== "credit")), "Review salary settings.");
    if (salary.enabled) requireValue(positive(salary.amount) && account(s, salary.accountId), "An enabled salary schedule needs an amount and receiving account.");
  }
  for (const goal of rows(s.goals)) {
    identify(goal);
    requireValue(field(goal, "name").trim() && positive(goal.target) && minor(goal.saved) >= 0 && (!goal.deadline || isMonth(field(goal, "deadline"))), "Review savings goal.");
  }
  for (const amount of [settingsV6(s).reservedCash, settingsV6(s).otherAssets, s.settings.emiBudget, s.settings.debtExtra,
    ...Object.values(row(settingsV6(s).loanPrincipal))])
    if (amount !== undefined) requireValue(minor(amount) >= 0, "Review asset, reserve, EMI budget and loan principal amounts.");
  for (const debt of rows(s.debts)) {
    requireValue(field(debt, "id") && field(debt, "name").trim() && minor(debt.balance) >= 0 &&
      typeof debt.apr === "number" && debt.apr >= 0 && debt.apr <= 100 && minor(debt.minPay) >= 0, "Review manual debt details.");
  }
  const receiptIds = new Set<string>();
  for (const receipt of rows(s.receipts)) {
    const id = field(receipt, "id");
    requireValue(id && !receiptIds.has(id) && field(receipt, "txId") &&
      ["image/png", "image/jpeg", "image/webp", "application/pdf"].includes(field(receipt, "type")) &&
      typeof receipt.data === "string" && receipt.data.length <= 5_333_336 && Number(receipt.size) >= 0 && Number(receipt.size) <= 4_000_000,
    "Review receipt metadata or size.");
    const data = field(receipt, "data"), padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    requireValue(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data) &&
      Number.isInteger(receipt.size) && data.length / 4 * 3 - padding === receipt.size, "Receipt data and size do not agree.");
    receiptIds.add(id);
  }
  requireValue(rows(s.receipts).length <= 100 && sum(rows(s.receipts).map(r => Number(r.size))) <= 15_000_000, "Receipt storage exceeds 15 MB or 100 files.");
  return s;
}

export function enforceHistory(previous: Ledger, next: Ledger, asOf: string) {
  for (const key of ["cardStatementPayments", "servicePayments", "paymentReversals", "cardPaymentAllocations", "statementEmiLinks", "statementEmiLinkVoids"])
    for (const old of rows(previous.settings[key])) {
      if ((key === "cardStatementPayments" || key === "servicePayments") && !old.completedDate) continue;
      const candidate = rows(next.settings[key]).find(p => p.id === old.id);
      requireValue(candidate && JSON.stringify(candidate) === JSON.stringify(old), "Settled payment and audit history is immutable. Use a reversal or correction.");
    }
  for (const t of previous.transactions.filter(t => t.date <= asOf)) {
    const candidate = next.transactions.find(x => x.id === t.id);
    requireValue(candidate && ["amount", "date", "type", "accountId", "toId", "loanId", "installment", "billId", "billMonth", "serviceId", "serviceDue", "receivableLoanId"]
      .every(key => t[key] === undefined || candidate[key] === t[key]), "Recorded ledger values are locked. Add a reversal and a corrected entry.");
  }
}
