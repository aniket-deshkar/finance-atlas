export type Row = Record<string, unknown>;
export type Account = Row & { id: string; name: string; type: "bank" | "cash" | "credit"; opening: number; openingDate: string };
export type EntryKind = "income" | "expense" | "refund" | "transfer" | "cardPayment";
export type Entry = Row & { id: string; date: string; type: EntryKind; amount: number; accountId: string; toId?: string; note?: string; category?: string };
export type Ledger = Row & {
  app: "Finance Atlas";
  version: 1;
  accounts: Account[];
  transactions: Entry[];
  loans: Row[];
  categories: { expense: string[]; income: string[] };
  budgets: Row;
  settings: Row;
};

export const kinds: Record<EntryKind, string> = {
  income: "Income", expense: "Expense", refund: "Refund", transfer: "Transfer", cardPayment: "Card repayment"
};

export function row(value: unknown): Row {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : {};
}

export function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter(item => typeof item === "object" && item && !Array.isArray(item)) as Row[] : [];
}

export function field(item: Row, key: string): string {
  const value = item[key];
  return typeof value === "string" ? value : "";
}

export function minor(value: unknown, maximum = 10_000_000_000): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > maximum)
    throw new Error("Invalid monetary amount.");
  const rounded = Math.round(value * 100);
  if (Math.abs(value * 100 - rounded) > 0.001) throw new Error("Amounts must use no more than two decimal places.");
  return rounded;
}

export function money(value: number): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(value / 100);
}

export function addMinor(total: number, delta: number) {
  const sum = total + delta;
  if (!Number.isSafeInteger(sum)) throw new Error("The ledger total exceeds the supported monetary range.");
  return sum;
}

export function validDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < "1900-01-01" || date > "2200-12-31") return false;
  const d = new Date(date + "T12:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

export function today(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"})
    .formatToParts();
  return ["year", "month", "day"].map(key => parts.find(part => part.type === key)?.value).join("-");
}

export function dayShift(date: string, days: number): string {
  const point = new Date(date + "T12:00:00Z");
  point.setUTCDate(point.getUTCDate() + days);
  return point.toISOString().slice(0, 10);
}

export function monthShift(month: string, offset: number): string {
  const date = new Date(month + "-01T12:00:00Z");
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}

export function monthLabel(month: string): string {
  return new Intl.DateTimeFormat("en-IN", {year: "numeric", month: "long", timeZone: "UTC"})
    .format(new Date(month + "-01T12:00:00Z"));
}

export function onDay(month: string, day: number): string {
  const last = Number(dayShift(monthShift(month, 1) + "-01", -1).slice(8));
  return month + "-" + String(Math.max(1, Math.min(last, Math.trunc(day)))).padStart(2, "0");
}

export function reportPeriod(ledger: Ledger, month: string) {
  const cfg = row(ledger.settings.reportingPeriod);
  const salary = row(ledger.settings.salary);
  const day = cfg.mode === "salary" ? Number(cfg.day) || Number(salary.day) || 1 : 1;
  const boundary = (label: string) => {
    const date = onDay(label, day);
    if (cfg.mode !== "salary" || salary.enabled !== true || day !== Number(salary.day)) return date;
    const weekday = new Date(date + "T12:00:00Z").getUTCDay();
    if (weekday !== 0 && weekday !== 6) return date;
    if (salary.weekend === "previous") return dayShift(date, weekday === 0 ? -2 : -1);
    if (salary.weekend === "next") return dayShift(date, weekday === 0 ? 1 : 2);
    return date;
  };
  return { start: boundary(month), end: dayShift(boundary(monthShift(month, 1)), -1),
    basis: cfg.mode === "salary" ? "Salary reporting period" : "Calendar month" };
}

export function currentMonth(ledger: Ledger, date: string): string {
  const month = date.slice(0, 7);
  return [month, monthShift(month, -1), monthShift(month, 1)].find(label => {
    const period = reportPeriod(ledger, label);
    return period.start <= date && date <= period.end;
  }) ?? month;
}

export function displayPeriod(ledger: Ledger, month: string, date: string) {
  const configured = reportPeriod(ledger, month);
  const salary = row(ledger.settings.salary);
  if (configured.basis !== "Calendar month" || salary.enabled !== true || month !== currentMonth(ledger, date))
    return configured;
  const scheduled = (label: string) => {
    if (label < field(salary, "startMonth")) return "";
    const payday = onDay(label, Number(salary.day) || 1);
    const weekday = new Date(payday + "T12:00:00Z").getUTCDay();
    if (weekday !== 0 && weekday !== 6) return payday;
    if (salary.weekend === "previous") return dayShift(payday, weekday === 0 ? -2 : -1);
    if (salary.weekend === "next") return dayShift(payday, weekday === 0 ? 1 : 2);
    return payday;
  };
  for (const label of [month, monthShift(month, -1), monthShift(month, 1)]) {
    const actual = ledger.transactions.find(entry => entry.type === "income" && entry.salaryMonth === label && entry.date <= date);
    const start = actual?.date || scheduled(label);
    if (!start || start > date) continue;
    const next = Array.from({length: 14}, (_, index) => scheduled(monthShift(label, index + 1)))
      .find(payday => payday > start) ?? onDay(monthShift(start.slice(0, 7), 1), Number(start.slice(8)));
    if (date < next) return { start, end: dayShift(next, -1), basis: "Active salary cycle" };
  }
  return configured;
}

export function blank(): Ledger {
  return { app: "Finance Atlas", version: 1, revision: 0, accounts: [], transactions: [], loans: [],
    categories: {
      expense: ["Food", "Gifts", "Health/medical", "Home", "Transportation", "Personal", "Clothing", "Utilities", "Travel", "Debt", "Other Expenses", "Subscriptions", "Insurance", "Money Given"],
      income: ["Savings", "Paycheck", "Bonus", "Interest", "Other"]
    }, budgets: {}, settings: { emiBudget: 0 }, meta: { created: today(), lastBackup: null } };
}

export function importLedger(input: unknown): Ledger {
  const envelope = row(input);
  const candidate = row(envelope.state ?? envelope);
  const categories = row(candidate.categories);
  if (candidate.app !== "Finance Atlas" || candidate.version !== 1 ||
      !Array.isArray(candidate.accounts) || !Array.isArray(candidate.transactions) || !Array.isArray(candidate.loans) ||
      !candidate.settings || row(candidate.settings) !== candidate.settings || !candidate.budgets || row(candidate.budgets) !== candidate.budgets ||
      ![categories.expense, categories.income].every(values => Array.isArray(values) && values.every(item => typeof item === "string")))
    throw new Error("Choose a Finance Atlas version 1 JSON backup.");
  if (candidate.accounts.length > 300 || candidate.transactions.length > 100000 || candidate.loans.length > 1000)
    throw new Error("The ledger exceeds the supported account, transaction or loan limit.");
  const accounts = new Map<string, Row>();
  const transactionIds = new Set<string>();
  for (const [i, item] of candidate.accounts.entries()) {
    const account = row(item);
    const id = field(account, "id");
    if (!id || accounts.has(id) || !field(account, "name").trim() || !["bank", "cash", "credit"].includes(field(account, "type")) ||
        !validDate(field(account, "openingDate")))
      throw new Error("Review the ID, name, type and opening date of account " + (i + 1) + ".");
    minor(account.opening);
    accounts.set(id, account);
  }
  for (const [i, item] of candidate.transactions.entries()) {
    const entry = row(item);
    const id = field(entry, "id");
    const type = field(entry, "type");
    const source = accounts.get(field(entry, "accountId"));
    const destination = accounts.get(field(entry, "toId"));
    const date = field(entry, "date");
    const invalidDestination = !destination || source === destination || date < field(destination, "openingDate");
    if (!id || transactionIds.has(id) || !Object.hasOwn(kinds, type) || !validDate(date) || !source ||
        ["note", "category", "toId"].some(key => entry[key] !== undefined && typeof entry[key] !== "string") ||
        date < field(source, "openingDate") || minor(entry.amount) <= 0 ||
        (type === "income" && source.type === "credit") ||
        (type === "transfer" && (invalidDestination || source.type === "credit" || destination?.type === "credit")) ||
        (type === "cardPayment" && (invalidDestination || source.type === "credit" || destination?.type !== "credit")))
      throw new Error("Review the type, amount, date and account links on transaction " + (i + 1) + ".");
    transactionIds.add(id);
  }
  return candidate as Ledger;
}

export function hasReversal(ledger: Ledger, id: string, asOf: string): boolean {
  return rows(ledger.settings.paymentReversals).some(item => item.transactionId === id && field(item, "date") <= asOf);
}

function emiCharges(ledger: Ledger, through: string, actualDate: string) {
  const voided = new Set(rows(ledger.settings.statementEmiLinkVoids).map(item => item.linkId));
  const statements = new Map(rows(ledger.settings.cardStatements).map(item => [item.id, item]));
  const loans = new Map(ledger.loans.map(loan => [loan.id, loan]));
  const reversed = new Set(rows(ledger.settings.paymentReversals).filter(item => field(item, "date") <= through).map(item => item.transactionId));
  const active = new Set(ledger.transactions.filter(entry => entry.loanId && entry.date <= through && !reversed.has(entry.id))
    .map(entry => JSON.stringify([entry.loanId, entry.installment])));
  return rows(ledger.settings.statementEmiLinks).filter(link => {
    const statement = statements.get(link.statementId);
    const date = field(link, "chargeDate");
    return !voided.has(link.id) && validDate(date) && date <= through &&
      statement && field(statement, "statementDate") <= actualDate && loans.has(link.loanId) &&
      !active.has(JSON.stringify([link.loanId, link.installment]));
  });
}

export function totals(ledger: Ledger, start: string, end: string, asOf: string) {
  const through = end < asOf ? end : asOf;
  let income = 0, spending = 0;
  function accumulate(type: EntryKind, amount: number) {
    if (type === "income") income = addMinor(income, amount);
    if (type === "expense") spending = addMinor(spending, amount);
    if (type === "refund") spending = addMinor(spending, -amount);
  }
  for (const entry of ledger.transactions)
    if (entry.date >= start && entry.date <= through) accumulate(entry.type, minor(entry.amount));
  const originals = new Map(ledger.transactions.map(entry => [entry.id, entry]));
  for (const reversal of rows(ledger.settings.paymentReversals)) {
    const date = field(reversal, "date");
    const original = originals.get(field(reversal, "transactionId"));
    if (original && date >= start && date <= through) accumulate(original.type, -minor(reversal.amount));
  }
  for (const link of emiCharges(ledger, through, asOf))
    if (field(link, "chargeDate") >= start) spending = addMinor(spending, minor(link.amount));
  return { income, spending, savings: addMinor(income, -spending) };
}

export function latestStatement(ledger: Ledger, accountId: string, asOf: string): Row | undefined {
  return rows(ledger.settings.cardStatements).filter(statement =>
    statement.cardId === accountId && validDate(field(statement, "statementDate")) && field(statement, "statementDate") <= asOf)
    .sort((a, b) => field(b, "statementDate").localeCompare(field(a, "statementDate")))[0];
}

export function statementAmounts(ledger: Ledger, statement: Row, asOf: string) {
  const billed = minor(statement.billAmount);
  if (field(statement, "statementDate") > asOf) return { billed, paid: 0, due: billed };
  const transactions = new Map(ledger.transactions.filter(entry =>
    entry.type === "cardPayment" && entry.toId === statement.cardId && entry.date <= asOf
  ).map(entry => [entry.id, entry]));
  const reversed = new Set(rows(ledger.settings.paymentReversals).filter(item =>
    validDate(field(item, "date")) && field(item, "date") <= asOf
  ).map(item => field(item, "transactionId")));
  const applied = new Map<string, number>();
  for (const item of rows(ledger.settings.cardStatementPayments)) {
    const id = field(item, "transactionId");
    const entry = transactions.get(id);
    const cleared = field(item, "completedDate");
    if (item.statementId === statement.id && entry && cleared === entry.date && !reversed.has(id))
      applied.set(id, Math.min(minor(entry.amount), minor(item.amount)));
  }
  const allocated = new Map<string, number>();
  for (const item of rows(ledger.settings.cardPaymentAllocations)) {
    const id = field(item, "transactionId");
    const entry = transactions.get(id);
    if (item.statementId === statement.id && entry && !reversed.has(id) && !applied.has(id))
      allocated.set(id, Math.min(minor(entry.amount), addMinor(allocated.get(id) ?? 0, minor(item.amount))));
  }
  for (const [id, value] of allocated) applied.set(id, value);
  // The latest snapshot includes prior unpaid balances. Subsequent repayments reduce it.
  if (latestStatement(ledger, field(statement, "cardId"), asOf)?.id === statement.id) {
    for (const [id, entry] of transactions)
      if (entry.date >= field(statement, "statementDate") && !reversed.has(id))
        applied.set(id, minor(entry.amount));
  }
  const paid = [...applied.values()].reduce((sum, value) => addMinor(sum, value), 0);
  return { billed, paid, due: Math.max(0, billed - paid) };
}

function movement(entry: Entry, account: Account) {
  const amount = minor(entry.amount);
  const source = entry.accountId === account.id;
  const destination = entry.toId === account.id;
  if (account.type === "credit") {
    if (destination && entry.type === "cardPayment") return -amount;
    if (source && entry.type === "expense") return amount;
    if (source && entry.type === "refund") return -amount;
  } else {
    if (destination && entry.type === "transfer") return amount;
    if (source) return entry.type === "income" || entry.type === "refund" ? amount : -amount;
  }
  return 0;
}

export function balance(ledger: Ledger, account: Account, asOf: string) {
  if (asOf < account.openingDate) return 0;
  const credit = account.type === "credit";
  const corrections = rows(account.balanceAdjustments).filter(item => field(item, "date") <= asOf)
    .sort((a, b) => field(b, "date").localeCompare(field(a, "date")) || field(b, "recordedAt").localeCompare(field(a, "recordedAt")));
  const statement = credit ? latestStatement(ledger, account.id, asOf) : undefined;
  const confirmation = credit && corrections[0] && (!statement || field(corrections[0], "date") >= field(statement, "statementDate"))
    ? corrections[0] : undefined;
  const statementAnchor = statement && !confirmation ? statement : undefined;
  const anchor = confirmation ? field(confirmation, "date") : statementAnchor ? field(statementAnchor, "statementDate") : "";
  let result = confirmation ? minor(confirmation.confirmedBalance) : statementAnchor ? minor(statementAnchor.billAmount) :
    corrections.filter(item => field(item, "date") >= account.openingDate)
      .reduce((sum, item) => addMinor(sum, minor(item.delta)), minor(account.opening));
  const afterAnchor = (date: string, entry: Entry) => date > anchor || Boolean(statementAnchor && date === anchor && entry.type === "cardPayment");
  for (const entry of ledger.transactions)
    if (entry.date <= asOf && (anchor ? afterAnchor(entry.date, entry) : entry.date >= account.openingDate))
      result = addMinor(result, movement(entry, account));
  const originals = new Map(ledger.transactions.map(entry => [entry.id, entry]));
  for (const reversal of rows(ledger.settings.paymentReversals)) {
    const date = field(reversal, "date");
    const original = originals.get(field(reversal, "transactionId"));
    if (original && date <= asOf && afterAnchor(date, original)) result = addMinor(result, -movement(original, account));
  }
  if (credit) {
    const cardLoans = new Set(ledger.loans.filter(loan => loan.cardId === account.id).map(loan => loan.id));
    for (const link of emiCharges(ledger, asOf, asOf))
      if (cardLoans.has(link.loanId) && field(link, "chargeDate") > anchor) result = addMinor(result, minor(link.amount));
  }
  return result;
}

export function amountFromInput(input: string, maximum = 10_000_000_000): number {
  if (!/^-?\d{1,13}(\.\d{1,2})?$/.test(input)) throw new Error("Enter an amount with up to two decimal places.");
  return minor(Number(input), maximum) / 100;
}

export function addAccount(ledger: Ledger, account: Account): Ledger {
  if (ledger.accounts.some(item => item.name.trim().toLowerCase() === account.name.trim().toLowerCase()))
    throw new Error("An account already uses that name.");
  if (account.type === "credit" && account.opening < 0) throw new Error("Enter a nonnegative opening card balance.");
  return importLedger({ ...ledger, accounts: [...ledger.accounts, account] });
}

export function addEntry(ledger: Ledger, entry: Entry, asOf: string): Ledger {
  if (entry.date > asOf) throw new Error("Choose a recorded date no later than today.");
  const categories = entry.type === "income" ? ledger.categories.income : ledger.categories.expense;
  if (entry.type !== "transfer" && entry.type !== "cardPayment" && !categories.includes(entry.category ?? "")) throw new Error("Choose a category.");
  if (entry.confirmDuplicate !== true && duplicateEntry(ledger, entry, asOf))
    throw new Error("A matching transaction already exists. Confirm a separate identical entry if both payments are real.");
  const next = importLedger({ ...ledger, transactions: [...ledger.transactions, entry] });
  if (entry.type !== "cardPayment") return next;
  const statement = latestStatement(ledger, entry.toId ?? "", asOf);
  if (!statement || statement.id !== entry.cardStatementId ||
      field(statement, "statementDate") > entry.date)
    throw new Error("Choose the latest issued statement and a payment date on or after its issue date.");
  if (minor(entry.amount) > statementAmounts(ledger, statement, asOf).due)
    throw new Error("This repayment exceeds the outstanding statement amount.");
  const payment = {
    id: entry.id + "-statement-payment", statementId: statement.id, amount: entry.amount, initiatedDate: entry.date,
    completedDate: entry.date, mode: "Other", accountId: entry.accountId, reference: "", transactionId: entry.id, origin: "created"
  };
  return { ...next, settings: {
    ...ledger.settings, cardStatementPayments: [...rows(ledger.settings.cardStatementPayments), payment]
  } };
}

export function duplicateEntry(ledger: Ledger, entry: Entry, asOf: string) {
  return ledger.transactions.some(item => !hasReversal(ledger, item.id, asOf) && item.date === entry.date && item.type === entry.type && item.amount === entry.amount &&
    item.accountId === entry.accountId && (item.toId ?? "") === (entry.toId ?? "") &&
    (item.category ?? "") === (entry.category ?? "") && (item.note ?? "").trim() === (entry.note ?? "").trim() &&
    ["loanId", "installment", "billId", "billMonth", "serviceId", "serviceDue", "receivableLoanId", "cardStatementId"].every(key => item[key] === entry[key]));
}

export function addStatement(ledger: Ledger, statement: Row, asOf: string): Ledger {
  const card = ledger.accounts.find(account => account.id === statement.cardId && account.type === "credit");
  const id = field(statement, "id");
  const issued = field(statement, "statementDate");
  const due = field(statement, "dueDate");
  const billed = minor(statement.billAmount);
  const minimum = minor(statement.minimumDue);
  if (!id || !card || !validDate(issued) || !validDate(due) || issued < card.openingDate || issued > asOf ||
      due < issued || billed <= 0 || minimum < 0 || minimum > billed)
    throw new Error("Check the card, dates, billed amount and minimum due.");
  const existing = rows(ledger.settings.cardStatements);
  if (existing.some(item => item.id === id ||
      (item.cardId === card.id && field(item, "statementDate").slice(0, 7) === issued.slice(0, 7))))
    throw new Error("A statement already exists for this card and issue month.");
  return { ...ledger, settings: { ...ledger.settings, cardStatements: [...existing, statement] } };
}
