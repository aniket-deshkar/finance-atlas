"use client";

import { useState } from "react";
import { addEntry, dayShift, displayPeriod, field, hasReversal, minor, money, monthLabel, monthShift, onDay, reportPeriod, row, rows, type Ledger, type Row } from "../lib/ledger";
import {vehicleReminders} from "../lib/assets";
import {
  billKinds, billRows, budgetLimit, cardCycle, cashMetrics, categoryActual, frequencies, loans,
  migrateLegacyBills, netPosition, obligations, personal, postedRows, receivables, recordRecovery, recordSalary, salaryDate, salaryFunding, salaryReceipt,
  removeUnusedLoan, reverseEntry, saveBudget, schedule, sum, upsertLoan, upsertService, type Bill, type Loan, type Obligation
} from "../lib/finance";
import { accountName, amount, Check, dateText, Editor, Input, Panel, PaymentEditor, Select, Stats, Table, value, type FeatureProps } from "./feature-ui";

function billItem(bill: Bill): Obligation {
  return {id: bill.key, date: bill.date, name: field(bill.plan, "name"), amount: bill.amount, impact: bill.credit ? "card" : "out",
    accountId: bill.accountId, kind: billKinds[field(bill.plan, "kind")] || "Recurring bill", bill, pending: bill.pending};
}
function emiItem(item: ReturnType<typeof schedule>[number]): Obligation {
  return {id: item.loan.id + "|" + item.number, date: item.date, name: item.loan.title + " · #" + item.number, amount: item.amount,
    kind: "EMI", impact: item.loan.kind === "credit" ? "card" : "out", accountId: item.loan.kind === "credit" ? item.loan.cardId : item.loan.bankId, installment: item};
}

export function BillsView(props: FeatureProps) {
  const {ledger, month, asOf, save, busy} = props;
  const [editing, setEditing] = useState<{plan: Row; legacy: boolean} | null>(null);
  const [payment, setPayment] = useState<Obligation | null>(null);
  const [reversal, setReversal] = useState("");
  const [migration, setMigration] = useState(false);
  const [filter, setFilter] = useState(""), [status, setStatus] = useState(""), [account, setAccount] = useState(""), [search, setSearch] = useState("");
  const period = reportPeriod(ledger, month);
  const plans = [...rows(ledger.settings.servicePlans).map(plan => ({plan, legacy: false})), ...rows(ledger.settings.billRules).map(plan => ({plan, legacy: true}))];
  const match = (p: Row) => (!filter || p.kind === filter) && (!account || p.accountId === account) && field(p, "name").toLowerCase().includes(search.toLowerCase());
  const bills = billRows(ledger, period.start, period.end, asOf).filter(bill => match(bill.plan) &&
    (!status || (bill.paid ? "paid" : bill.pending ? "pending" : bill.date < asOf ? "overdue" : "upcoming") === status));
  return <div className="stack">
    <Stats items={[["Scheduled this period", sum(bills.map(b => b.amount))], ["Paid / charged", sum(bills.filter(b => b.paid).map(b => b.amount))],
      ["Still to record", sum(bills.filter(b => !b.paid).map(b => b.amount)), "Card charges follow their billing cycle"]]} />
    <Panel title="Bills & policies" action={<button className="primary" onClick={() => setEditing({plan: {}, legacy: false})}>+ Add bill or policy</button>}>
      <div className="filter-row"><label>Search<input value={search} onChange={e => setSearch(e.target.value)} placeholder="Bill or provider" /></label>
        <label>Type<select value={filter} onChange={e => setFilter(e.target.value)}><option value="">All types</option>{Object.entries(billKinds).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <label>Status<select value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option>{["paid", "pending", "overdue", "upcoming"].map(id => <option key={id}>{id}</option>)}</select></label>
        <label>Account<select value={account} onChange={e => setAccount(e.target.value)}><option value="">All accounts</option>{ledger.accounts.map(a => <option value={a.id} key={a.id}>{a.name}</option>)}</select></label></div>
      <Table headers={["Due / charge date", "Bill", "Account", "Amount", "Status", ""]}>
        {bills.map(bill => <tr key={bill.key}><td>{dateText(bill.date)}</td><td><strong>{field(bill.plan, "name")}</strong><small>{billKinds[field(bill.plan, "kind")] || "Bill"}</small></td>
          <td>{accountName(ledger, bill.accountId)}{bill.credit && <small>Card payment due {dateText(cardCycle(ledger, ledger.accounts.find(a => a.id === bill.accountId)!, bill.transaction?.date || bill.date).due)}</small>}</td>
          <td>{money(bill.amount)}</td><td><span className={"status " + (bill.paid ? "paid" : "")}>{bill.paid ? bill.credit ? "Charged to card" : "Paid" : bill.pending ? "Pending settlement" : bill.date < asOf ? "Overdue" : "Upcoming"}</span></td>
          <td>{!bill.paid && !bill.transaction && <button disabled={busy} onClick={() => setPayment(billItem(bill))}>{bill.pending ? "Settle" : bill.credit ? "Post charge" : "Record payment"}</button>}</td></tr>)}
      </Table>{!bills.length && <p className="empty-copy">No scheduled bills match these filters.</p>}
    </Panel>
    <Panel title="Recurring plans and policy details">
      {rows(ledger.settings.billRules).length > 0 && <div className="editor-note"><strong>Older monthly plans</strong>
        <p>{rows(ledger.settings.billRules).length} older plan(s) can be converted to the current recurring schedule. Review the migration before saving.</p>
        <button disabled={busy} onClick={() => setMigration(true)}>Review recurring-plan migration</button></div>}
      <div className="plan-grid">{plans.filter(({plan}) => match(plan)).map(({plan, legacy}) => <article key={(legacy ? "legacy:" : "") + plan.id} className="plan-card">
        <div className="panel-head"><h3>{field(plan, "name")}</h3><span className="status">{plan.active === false ? "Archived" : billKinds[field(plan, "kind")] || "Monthly bill"}</span></div>
        <strong>{money(minor(plan.amount))}</strong><p className="muted">{legacy ? "Monthly" : frequencies[field(plan, "frequency")]} · {accountName(ledger, plan.accountId)}</p>
        <p className="muted">{field(plan, "provider")}{plan.autopay ? " · Auto-debit matching enabled" : ""}</p>
        {plan.kind === "insurance" && <dl className="compact-details"><dt>Covered person / asset</dt><dd>{field(plan, "insuredPerson") || "—"}</dd>
          <dt>Coverage</dt><dd>{money(minor(Number(plan.coverageAmount) || 0, 1_000_000_000_000))}</dd><dt>Coverage ends</dt><dd>{field(plan, "policyEndDate") || "Not set"}</dd><dt>Policy reference</dt><dd>{field(plan, "reference") || "—"}</dd></dl>}
        <div className="button-row"><button onClick={() => setEditing({plan, legacy})}>Edit plan</button>
          <button disabled={busy} onClick={() => save(s => upsertService(s, {...plan, active: plan.active === false}, legacy, asOf))}>{plan.active === false ? "Restore" : "Archive"}</button></div>
      </article>)}</div>
    </Panel>
    <Panel title="Bill payment history" subtitle="Settled amounts are preserved even when a plan changes or a payment is reversed">
      <Table headers={["Bill", "Due cycle", "Original amount", "Cleared on", "Status", ""]}>
        {rows(ledger.settings.servicePayments).filter(p => plans.some(({plan}) => plan.id === p.serviceId && match(plan))).map(p => {
          const plan = plans.find(({plan}) => plan.id === p.serviceId)?.plan, id = field(p, "transactionId"), reversed = hasReversal(ledger, id, asOf);
          return <tr key={field(p, "id")}><td>{field(plan ?? {}, "name")}</td><td>{field(p, "dueDate")}</td><td>{money(minor(p.amount))}</td>
            <td>{field(p, "completedDate") || "Pending"}</td><td>{reversed ? "Reversed" : p.completedDate ? "Cleared" : "Pending"}</td>
        <td>{p.completedDate && !reversed ? <button onClick={() => setReversal(id)}>Reverse</button> : !p.completedDate ?
          <button disabled={busy} onClick={() => save(s => ({...s, settings: {...s.settings, servicePayments: rows(s.settings.servicePayments).filter(r => r.id !== p.id)}}), true)}>Cancel pending</button> : null}</td></tr>;
        })}
        {ledger.transactions.filter(t => t.billId && !rows(ledger.settings.servicePayments).some(p => p.transactionId === t.id) && plans.some(({plan}) => plan.id === t.billId && match(plan))).map(t =>
          <tr key={t.id}><td>{field(plans.find(({plan}) => plan.id === t.billId)?.plan ?? {}, "name")}</td><td>{String(t.billMonth)}</td><td>{money(minor(t.amount))}</td>
            <td>{t.date}</td><td>{hasReversal(ledger, t.id, asOf) ? "Reversed" : t.date > asOf ? "Scheduled" : "Cleared"}</td>
            <td>{t.date <= asOf && !hasReversal(ledger, t.id, asOf) && <button onClick={() => setReversal(t.id)}>Reverse</button>}</td></tr>)}
      </Table>
    </Panel>
    {editing && <BillEditor {...props} plan={editing.plan} legacy={editing.legacy} close={() => setEditing(null)} />}
    {migration && <Editor title="Review recurring-plan migration" {...props} close={() => setMigration(false)} submit="Convert plans"
      onSave={() => save(s => migrateLegacyBills(s, asOf), true)}>
      <p className="editor-note">Convert {rows(ledger.settings.billRules).length} older monthly plan(s) to the current schedule. Existing transactions, original payment amounts and legacy plan fields are retained. An encrypted recovery snapshot is created before saving.</p>
      <p className="editor-note">Review the converted due dates and payment history after migration. Ambiguous records stop the migration without changing the workspace.</p>
    </Editor>}
    {payment && <PaymentEditor {...props} item={payment} close={() => setPayment(null)} />}
    {reversal && <Editor title="Reverse bill payment" {...props} close={() => setReversal("")} onSave={data => save(s => reverseEntry(s, reversal, value(data, "date"), value(data, "reason"), asOf))}>
      <Input name="date" label="Reversed on" type="date" initial={asOf} max={asOf} /><Input name="reason" label="Reason" maxLength={300} /></Editor>}
  </div>;
}

function BillEditor({plan, legacy, close, ...props}: FeatureProps & {plan: Row; legacy: boolean; close: () => void}) {
  const {ledger, asOf, save} = props;
  const [kind, setKind] = useState(field(plan, "kind") || "utility");
  const initialDue = field(plan, "dueDate") || (legacy ? onDay(field(plan, "startMonth"), Number(plan.dueDay)) : asOf);
  return <Editor title={plan.id ? "Edit bill / policy" : "Add bill / policy"} {...props} close={close} onSave={data => save(s => upsertService(s, {
    ...plan, id: field(plan, "id") || crypto.randomUUID(), name: value(data, "name"), kind, provider: value(data, "provider"), reference: value(data, "reference"),
    amount: amount(data, "amount"), category: value(data, "category"), accountId: value(data, "accountId"), frequency: value(data, "frequency"),
    dueDate: value(data, "dueDate"), ...(legacy ? {startMonth: value(data, "dueDate").slice(0, 7),
      dueDay: value(data, "dueDate") === initialDue ? Number(plan.dueDay) : Number(value(data, "dueDate").slice(8))} :
      {recurrenceDay: value(data, "dueDate") === initialDue && Number(plan.recurrenceDay) || Number(value(data, "dueDate").slice(8))}),
    active: data.has("active"), autopay: data.has("autopay"), remindDays: 3,
    ...(kind === "insurance" ? {policyType: value(data, "policyType"), insuredPerson: value(data, "insuredPerson"), coverageAmount: amount(data, "coverage", 1_000_000_000_000),
      policyStartDate: value(data, "coverageStart"), policyEndDate: value(data, "coverageEnd"), policyNotes: value(data, "policyNotes")} : {})
  }, legacy, asOf))}>
    <Input name="name" label="Bill / policy name" initial={field(plan, "name")} maxLength={110} />
    <label>Type<select value={kind} onChange={e => setKind(e.target.value)}>{Object.entries(billKinds).map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label>
    <Input name="amount" label="Amount ₹" initial={Number(plan.amount) || ""} />
    <Select name="category" label="Expense category" initial={field(plan, "category") || (kind === "insurance" ? "Insurance" : kind === "subscription" ? "Subscriptions" : "Utilities")}
      options={ledger.categories.expense.map(c => ({id: c, name: c}))} />
    <Select name="accountId" label="Charged / paid from" initial={field(plan, "accountId")} options={ledger.accounts.map(a => ({id: a.id, name: a.name}))} />
    <Input name="dueDate" label="First due / renewal date" type="date" initial={initialDue} />
    <Select name="frequency" label="Repeat" initial={legacy ? "monthly" : field(plan, "frequency") || "monthly"}
      options={Object.entries(frequencies).filter(([id]) => !legacy || id === "monthly").map(([id, name]) => ({id, name}))} />
    <Input name="provider" label="Provider" initial={field(plan, "provider")} required={false} maxLength={80} />
    <Input name="reference" label="Policy / bill reference" initial={field(plan, "reference")} required={false} maxLength={100} />
    <Check name="active" label="Active plan" initial={plan.active !== false} />
    <Check name="autopay" label="Match recorded auto-debits automatically" initial={plan.autopay === true} />
    {kind === "insurance" && <>
      <Select name="policyType" label="Insurance type" initial={field(plan, "policyType") || "other"} options={["health", "term", "life", "motor", "home", "travel", "other"].map(id => ({id, name: id}))} />
      <Input name="insuredPerson" label="Covered person / asset" initial={field(plan, "insuredPerson")} required={false} maxLength={120} />
      <Input name="coverage" label="Coverage amount ₹" initial={Number(plan.coverageAmount) || 0} />
      <Input name="coverageStart" label="Coverage starts" type="date" initial={field(plan, "policyStartDate")} required={false} />
      <Input name="coverageEnd" label="Coverage ends" type="date" initial={field(plan, "policyEndDate")} required={false} />
      <Input name="policyNotes" label="Policy notes" initial={field(plan, "policyNotes")} required={false} maxLength={800} />
    </>}
    <p className="editor-note">A plan creates reminders. Recorded debits can be matched when account, amount and timing agree uniquely. A cleared payment creates the ledger entry.</p>
  </Editor>;
}

export function EmiView(props: FeatureProps) {
  const {ledger, asOf, month, busy, save} = props;
  const [editing, setEditing] = useState<Row | null>(null), [open, setOpen] = useState<Loan | null>(null);
  const [payment, setPayment] = useState<Obligation | null>(null), [recovery, setRecovery] = useState<Loan | null>(null), [tab, setTab] = useState("personal");
  const all = loans(ledger), visible = all.filter(l => personal(l) === (tab === "personal"));
  const metrics = cashMetrics(ledger, month, asOf), received = receivables(ledger, asOf);
  return <div className="stack">
    <Stats items={tab === "personal" ? [["Bank EMIs paid", metrics.bankEmiPaid], ["Card EMIs posted", metrics.cardEmiPosted], ["Card EMI repayments", metrics.cardEmiPaid, "Pro rata from confirmed statement breakdowns"], ["Bank EMIs remaining", metrics.bankEmiExpected], ["Card postings remaining", metrics.cardEmiExpected]] :
      [["Scheduled recoveries remaining", sum(received.map(r => r.remaining))], ["Recovered", sum(received.map(r => r.recovered))], ["Lending plans", String(received.length)]]} />
    <Panel title="EMIs & recoveries" action={<button className="primary" onClick={() => setEditing({category: tab === "personal" ? "Debt" : "Money Given"})}>+ Add plan</button>}>
      <div className="segmented"><button aria-pressed={tab === "personal"} onClick={() => setTab("personal")}>My EMIs</button><button aria-pressed={tab === "lent"} onClick={() => setTab("lent")}>Money lent & recoveries</button></div>
      <Table headers={["Plan / account", "Installment", "Progress", "Remaining schedule", ""]}>{visible.map(loan => {
        const items = schedule(ledger, loan, asOf), completed = items.filter(i => i.recorded).length, next = items.find(i => !i.recorded);
        return <tr key={loan.id}><td><strong>{loan.title}</strong><small>{accountName(ledger, loan.kind === "credit" ? loan.cardId : loan.bankId)} · {loan.kind === "credit" ? "Your card" : "Bank loan"}</small></td>
          <td>{money(minor(loan.emi))}</td><td>{completed} / {loan.installments}<small>{next ? "Next " + next.date : "All recorded"}</small></td>
          <td>{money(sum(items.filter(i => !i.recorded).map(i => i.amount)))}</td><td><div className="button-row">
            <button onClick={() => setOpen(loan)}>Schedule</button><button onClick={() => setEditing(loan)}>Edit</button>
            {loan.previouslyPaid === 0 && !ledger.transactions.some(t => t.loanId === loan.id || t.receivableLoanId === loan.id) &&
              !rows(ledger.settings.statementEmiLinks).some(link => link.loanId === loan.id) &&
              <button disabled={busy} onClick={() => save(s => removeUnusedLoan(s, loan.id), true)}>Remove unused plan</button>}
            {!personal(loan) && <button onClick={() => setRecovery(loan)}>Record recovery</button>}
          </div></td></tr>;
      })}</Table>{!visible.length && <p className="empty-copy">No plans in this group.</p>}
      <p className="muted">Money lent is separate from your own EMIs and debt. Purchases on your card and payments from your bank still affect those accounts.</p>
    </Panel>
    {tab === "lent" && <Panel title="Recovery balances"><Table headers={["Plan", "Expected total", "Recovered", "Remaining"]}>{received.map(r =>
      <tr key={r.loan.id}><td>{r.loan.title}</td><td>{money(r.expected)}</td><td>{money(r.recovered)}</td><td>{money(r.remaining)}</td></tr>)}</Table></Panel>}
    {editing && <Editor title={editing.id ? "Edit EMI plan" : "Add EMI plan"} {...props} close={() => setEditing(null)}
      onSave={data => save(s => upsertLoan(s, {...editing, id: field(editing, "id") || crypto.randomUUID(), title: value(data, "title"), kind: value(data, "kind"),
        emi: amount(data, "emi"), financed: amount(data, "financed"), installments: Number(value(data, "installments")), previouslyPaid: Number(value(data, "paid")),
        firstDue: value(data, "firstDue"), category: value(data, "category"), bankId: value(data, "bankId"), cardId: value(data, "cardId"),
        notes: value(data, "notes"), autopay: data.has("autopay")} as Loan, asOf))}>
      <Input name="title" label="Plan / person / purchase" initial={field(editing, "title")} maxLength={120} />
      <Select name="kind" label="Payment type" initial={field(editing, "kind") || "bank"} options={[{id: "bank", name: "Bank / personal loan"}, {id: "credit", name: "Credit card EMI"}]} />
      <Input name="emi" label="Full installment ₹" initial={Number(editing.emi) || ""} />
      <Input name="financed" label="Financed amount ₹" initial={Number(editing.financed) || 0} />
      <Input name="installments" label="Number of installments" type="number" min={1} max={600} initial={Number(editing.installments) || 12} />
      <Input name="paid" label="Installments included in opening balances" type="number" min={0} max={600} initial={Number(editing.previouslyPaid) || 0} />
      <Input name="firstDue" label="First installment date" type="date" initial={field(editing, "firstDue") || asOf} />
      <Select name="category" label="Category" initial={field(editing, "category") || "Debt"} options={ledger.categories.expense.map(c => ({id: c, name: c}))} />
      <Select name="bankId" label="Bank / card repayment account" required={false} initial={field(editing, "bankId")} options={ledger.accounts.filter(a => a.type !== "credit").map(a => ({id: a.id, name: a.name}))} />
      <Select name="cardId" label="Credit card for card EMIs" required={false} initial={field(editing, "cardId")} options={ledger.accounts.filter(a => a.type === "credit").map(a => ({id: a.id, name: a.name}))} />
      <Input name="notes" label="Notes" initial={field(editing, "notes")} required={false} maxLength={1200} />
      <Check name="autopay" label="Lender auto-debit enabled" initial={editing.autopay === true} />
      <p className="editor-note">For card EMIs, post each installment as a card expense or confirm its statement breakdown. Paying the card bill is a separate bank movement.</p>
    </Editor>}
    {open && <Editor title={open.title + " · schedule"} {...props} close={() => setOpen(null)}><Table headers={["#", "Due", "Amount", "Status", ""]}>
      {schedule(ledger, open, asOf).map(item => <tr key={item.number}><td>{item.number}</td><td>{item.date}</td><td>{money(item.amount)}</td>
        <td>{item.number <= open.previouslyPaid ? "Historical" : item.link ? "Included in statement" : item.recorded ? "Recorded" : item.transaction ? "Scheduled" : "Unrecorded"}</td>
        <td>{!item.recorded && !item.transaction && <button onClick={() => {setOpen(null);setPayment(emiItem(item));}}>Record {open.kind === "credit" ? "charge" : "payment"}</button>}</td></tr>)}
    </Table></Editor>}
    {payment && <PaymentEditor {...props} item={payment} close={() => setPayment(null)} />}
    {recovery && <Editor title={"Recover money · " + recovery.title} {...props} close={() => setRecovery(null)}
      onSave={data => save(s => recordRecovery(s, recovery.id, {date: value(data, "date"), accountId: value(data, "accountId"), amount: amount(data, "amount"), initiatedDate: value(data, "date"), mode: "Other", reference: ""}, asOf))}>
      <Input name="amount" label="Amount received ₹" /><Input name="date" label="Received on" type="date" initial={asOf} max={asOf} />
      <Select name="accountId" label="Received in" options={ledger.accounts.filter(a => a.type !== "credit").map(a => ({id: a.id, name: a.name}))} />
    </Editor>}
  </div>;
}

export function BudgetView({ledger, month, asOf, save, busy}: FeatureProps) {
  const metrics = cashMetrics(ledger, month, asOf), budget = row(ledger.budgets[month]);
  return <div className="stack">
    <Stats items={[["Recorded inflow", metrics.inflow], ["Actual cash outflow", metrics.outflow], ["Expected cash outflow", metrics.expectedOutflow], ["Projected cash surplus", metrics.projectedCashSurplus, "Through the selected reporting cycle"]]} />
    <Stats items={[["Bank EMIs paid", metrics.bankEmiPaid], ["Bank EMIs remaining", metrics.bankEmiExpected], ["Card EMIs posted", metrics.cardEmiPosted], ["Card EMI repayments", metrics.cardEmiPaid, "Based on confirmed statement portions"], ["Card postings remaining", metrics.cardEmiExpected]]} />
    <Panel title="Monthly category plan" subtitle="Card purchases count as spending. Card repayments appear in cash outflow."
      action={<button disabled={busy || !ledger.budgets[monthShift(month, -1)]} onClick={() => save(s => saveBudget(s, month, structuredClone(row(s.budgets[monthShift(month, -1)])), asOf))}>Copy previous period</button>}>
      <form key={month + JSON.stringify(budget)} onSubmit={async event => {
        event.preventDefault(); const data = new FormData(event.currentTarget);
        await save(s => {
          const expense = Object.fromEntries(s.categories.expense.map((c, i) => [c, amount(data, "expense-" + i, ["Insurance", "Other Expenses"].includes(c) ? 20_000_000_000 : 10_000_000_000)]));
          const income = Object.fromEntries(s.categories.income.map((c, i) => [c, amount(data, "income-" + i)]));
          return saveBudget({...s, settings: {...s.settings, emiBudget: amount(data, "emiBudget")}}, month, {expense, income}, asOf);
        });
      }}><fieldset disabled={busy}>
        {(["expense", "income"] as const).map(kind => <div key={kind} className="section-gap"><h3>{kind === "expense" ? "Spending" : "Income"}</h3>
          <Table headers={["Category", "Planned ₹", "Actual", kind === "expense" ? "Available incl. rollover" : "Still to earn"]}>
            {ledger.categories[kind].map((category, i) => {
              const actual = categoryActual(ledger, month, kind, category, asOf), plan = Number(row(budget[kind])[category]) || 0;
              return <tr key={category}><td>{category}</td><td><input aria-label={category + " planned " + kind} name={kind + "-" + i} defaultValue={plan.toFixed(2)} inputMode="decimal" required /></td>
                <td>{money(actual)}</td><td>{money((kind === "expense" ? budgetLimit(ledger, month, category, asOf) : minor(plan)) - actual)}</td></tr>;
            })}
          </Table></div>)}
        <div className="filter-row"><Input name="emiBudget" label="Personal monthly EMI budget ₹" initial={Number(ledger.settings.emiBudget) || 0} /><button className="primary" type="submit">Save budget</button></div>
      </fieldset></form>
    </Panel>
    <Panel title="Expected payments"><ObligationTable {...{ledger, asOf}} items={metrics.expected} /></Panel>
  </div>;
}

function ObligationTable({items, ledger, asOf, choose}: {items: Obligation[]; ledger: Ledger; asOf: string; choose?: (item: Obligation) => void}) {
  return <><Table headers={["Date", "Payment", "Account / card", "Amount", ""]}>{items.map(item =>
    <tr key={item.id}><td>{item.date}<small>{item.date < asOf ? "Overdue / unrecorded" : "Upcoming"}</small></td>
      <td>{item.name}<small>{item.kind}{item.projected ? " · estimate" : ""}</small></td><td>{accountName(ledger, item.accountId || item.cardId)}</td>
      <td>{money(item.amount)}<small>{item.impact === "card" ? "Card charge" : item.impact === "in" ? "Expected inflow" : "Cash outflow"}</small></td>
      <td>{choose && (item.bill || item.installment || item.statement) && <button onClick={() => choose(item)}>{item.impact === "card" ? "Post" : "Pay"}</button>}</td></tr>)}</Table>
    {!items.length && <p className="empty-copy">No outstanding payments for this selection.</p>}</>;
}

export function CalendarView(props: FeatureProps) {
  const {ledger, month, asOf} = props;
  const [kind, setKind] = useState(""), [status, setStatus] = useState("due"), [selected, setSelected] = useState("");
  const [payment, setPayment] = useState<Obligation | null>(null);
  const period = displayPeriod(ledger, month, asOf), due = obligations(ledger, period.start, period.end, asOf);
  const posted = postedRows(ledger, period.start, period.end, asOf);
  const events = [
    ...vehicleReminders(ledger,period.start,period.end).map(item => ({...item,amount:null,kind:"vehicle",
      status:item.date < asOf ? "overdue" : "upcoming",item:undefined})),
    ...due.map(item => ({id: item.id, date: item.date, name: item.name, amount: item.amount, kind: item.bill ? field(item.bill.plan, "kind") : item.installment ? "emi" : item.cardId ? "card" : "other", status: item.date < asOf ? "overdue" : "upcoming", item})),
    ...posted.map(t => ({id: t.id, date: t.date, name: t.note || t.category || t.type, amount: t.signed, kind: t.loanId ? "emi" : t.serviceId || t.billId ? field([...rows(ledger.settings.servicePlans), ...rows(ledger.settings.billRules)].find(p => p.id === (t.serviceId || t.billId)) ?? {}, "kind") : t.type === "cardPayment" ? "card" : t.type, status: "recorded", item: undefined}))
  ].filter(e => (!kind || e.kind === kind) && (status === "all" || status === "due" ? status === "all" || e.status !== "recorded" : e.status === status));
  const active = selected >= period.start && selected <= period.end ? selected : events.find(e => e.date >= asOf)?.date || period.start;
  const days: string[] = [];
  for (let date = period.start; date <= period.end; date = dayShift(date, 1)) days.push(date);
  const kinds = [...new Set(events.map(e => e.kind).filter(Boolean))];
  return <div className="stack calendar-workspace">
    <Panel title="Upcoming payments">
      <div className="calendar-pointers"><div><small>Cash payments remaining</small><strong>{money(sum(due.filter(d => d.impact === "out").map(d => d.amount)))}</strong></div>
        <div><small>Unrecorded / overdue</small><strong>{due.filter(d => d.date < asOf).length}</strong></div>
        <div><small>Next payment</small><strong>{due[0]?.name || "All clear"}</strong><small>{due[0]?.date}</small></div></div>
      {due.filter(item => item.impact === "out").length > 1 && <div className="upcoming-chips">{due.filter(item => item.impact === "out").slice(0, 4).map(item =>
        <button key={item.id} onClick={() => setSelected(item.date)}>{item.name}<small>{item.date} · {money(item.amount)}</small></button>)}</div>}
    </Panel>
    <Panel title="Choose a day"><div className="filter-row">
      <label>Bill / event type<select value={kind} onChange={e => setKind(e.target.value)}><option value="">All types</option>
        {[...new Set([...Object.keys(billKinds), "emi", "card", "expense", "income", "refund", "transfer", "vehicle", ...kinds])].map(id => <option key={id} value={id}>{billKinds[id] || id}</option>)}</select></label>
      <label>Show<select value={status} onChange={e => setStatus(e.target.value)}>{["due", "upcoming", "overdue", "recorded", "all"].map(id => <option key={id}>{id}</option>)}</select></label>
    </div><div className="calendar-layout"><div className="calendar-grid">
      {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(day => <span className="weekday" key={day}>{day}</span>)}
      {Array.from({length: new Date(period.start + "T12:00:00Z").getUTCDay()}, (_, i) => <span key={"pad" + i} />)}
      {days.map(date => {const daily = events.filter(e => e.date === date); return <button key={date} className={"calendar-day" + (date === asOf ? " today" : "")}
        aria-pressed={date === active} onClick={() => setSelected(date)}><span>{Number(date.slice(8))}{date.slice(8) === "01" && <small>{monthLabel(date.slice(0, 7)).split(" ")[0]}</small>}</span>
        {daily.length > 0 && <><span className="event-dots">{daily.slice(0, 3).map(e => <i key={e.id} className={e.status} />)}</span><small>{daily.length} event{daily.length > 1 ? "s" : ""}</small></>}</button>;})}
    </div><div className="day-agenda"><h3>{dateText(active)}</h3>{events.filter(e => e.date === active).map(e =>
      <article className="agenda-entry" key={e.id}><span className="status">{e.status} · {billKinds[e.kind] || e.kind}</span><strong>{e.name}</strong>{e.amount !== null && <span>{money(e.amount)}</span>}
        {e.item && (e.item.bill || e.item.installment || e.item.statement) && <button onClick={() => setPayment(e.item!)}>Record {e.item.impact === "card" ? "charge" : "payment"}</button>}</article>)}
      {!events.some(e => e.date === active) && <p className="empty-copy">No matching events on this day.</p>}</div></div>
    </Panel>
    {payment && <PaymentEditor {...props} item={payment} close={() => setPayment(null)} />}
  </div>;
}

export function DailyView(props: FeatureProps) {
  const {ledger, month, asOf} = props;
  const [sort, setSort] = useState("latest"), [kind, setKind] = useState("all"), [payment, setPayment] = useState<Obligation | null>(null);
  const period = reportPeriod(ledger, month), cash = cashMetrics(ledger, month, asOf);
  const position = netPosition(ledger, asOf), reserve = minor(Number(row(ledger.settings.dailyV6).reservedCash) || 0);
  const upcoming = obligations(ledger, period.start, period.end, asOf);
  const daysRemaining = Math.max(1, Math.round((Date.parse(period.end) - Date.parse(asOf)) / 86400000) + 1);
  const available = position.cash - reserve - cash.expectedOutflow;
  const entries = [...postedRows(ledger, period.start, period.end, asOf).map(t =>
    ({id: t.id, date: t.date, name: t.note || t.category || t.type, amount: t.signed, kind: t.loanId ? "emi" : t.type, status: t.reversal ? "Reversal" : "Recorded", item: undefined as Obligation | undefined})),
    ...upcoming.map(item => ({id: item.id, date: item.date, name: item.name, amount: item.amount, kind: item.installment ? "emi" : item.bill ? "bill" : item.cardId ? "cardPayment" : "scheduled", status: item.date < asOf ? "Overdue" : "Upcoming", item}))]
    .filter(e => kind === "all" || e.kind === kind).sort((a, b) => sort === "latest" ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date));
  const dates = [...new Set(entries.map(e => e.date))];
  return <div className="stack">
    <Stats items={[["Available after planned payments", available], ["Daily spending room", Math.floor(Math.max(0, available) / daysRemaining)],
      ["Upcoming cash payments", cash.expectedOutflow], ["Cash on hand", position.cash]]} />
    <Panel title="Daily timeline" subtitle="Recorded activity and scheduled events grouped by day">
      <div className="filter-row"><label>Order<select value={sort} onChange={e => setSort(e.target.value)}><option value="latest">Latest first</option><option value="oldest">Oldest first</option></select></label>
        <label>Events<select value={kind} onChange={e => setKind(e.target.value)}>{["all", "income", "expense", "refund", "transfer", "cardPayment", "emi", "bill"].map(id => <option key={id}>{id}</option>)}</select></label></div>
      <div className="daily-timeline">{dates.map(date => <section className="timeline-day" key={date}>
        <header><h3>{dateText(date)}</h3><small>{date === asOf ? "Today" : new Intl.DateTimeFormat("en-IN", {weekday: "long", timeZone: "UTC"}).format(new Date(date))}</small></header>
        <div>{entries.filter(e => e.date === date).map(entry => <article className="timeline-event" key={entry.id}><span className="timeline-dot" />
          <div><small>{entry.status} · {entry.kind}</small><strong>{entry.name}</strong></div><span>{money(entry.amount)}</span>
          {entry.item && (entry.item.bill || entry.item.installment || entry.item.statement) && <button onClick={() => setPayment(entry.item!)}>Record</button>}</article>)}</div>
      </section>)}</div>{!entries.length && <p className="empty-copy">No activity for this period.</p>}
    </Panel>{payment && <PaymentEditor {...props} item={payment} close={() => setPayment(null)} />}
  </div>;
}

export function SalaryView(props: FeatureProps) {
  const {ledger, month, asOf, save, busy} = props;
  const [edit, setEdit] = useState(false), [receive, setReceive] = useState(false), [transfer, setTransfer] = useState<{id: string; amount: number} | null>(null);
  const salary = row(ledger.settings.salary), cfg = row(ledger.settings.salaryAllocation), funding = salaryFunding(ledger, month, asOf);
  const banks = ledger.accounts.filter(a => a.type !== "credit");
  return <div className="stack">
    <Stats items={[["Expected salary", minor(Number(salary.amount) || 0), salaryDate(ledger, month) || "Configure salary schedule"],
      ["Receipt", funding.receipt ? "Recorded" : "Awaiting entry"], ["Transfers to fund", funding.transferTotal], ["Unassigned payments", sum(funding.unassigned.map(item => item.amount))], ["Funding shortfall", funding.shortfall]]} />
    <Panel title="Salary schedule" subtitle={"Funding cycle · " + funding.start + " to " + funding.end}
      action={<div className="button-row"><button onClick={() => setEdit(true)}>Edit schedule</button><button className="primary" disabled={Boolean(salaryReceipt(ledger, month, asOf))} onClick={() => setReceive(true)}>Record salary</button></div>}>
      <p>{accountName(ledger, salary.accountId)} · day {Number(salary.day) || "—"} · weekend adjustment {field(salary, "weekend") || "none"}</p>
      <p className="muted">Transfer suggestions include unpaid bills, upcoming EMIs and issued card statements, including pending payments and overdue amounts. Save a transfer only after moving the money.</p>
    </Panel>
    <Panel title="Salary transfer plan">
      <form onSubmit={event => {event.preventDefault();const data = new FormData(event.currentTarget);void save(s => ({...s, settings: {...s.settings, salaryAllocation: {...row(s.settings.salaryAllocation),
        useExistingBalances: data.has("balances"), useBalances: data.has("balances"), includeOverdue: data.has("overdue"), includeIssuedCards: data.has("issued"),
        cardAccounts: Object.fromEntries(s.accounts.filter(a => a.type === "credit").map(a => [a.id, value(data, "card-" + a.id)])),
        reserves: Object.fromEntries(banks.map(a => [a.id, amount(data, "reserve-" + a.id)]))}}}));}}>
        <fieldset disabled={busy}><div className="filter-row">{ledger.accounts.filter(a => a.type === "credit").map(card =>
          <Select key={card.id} name={"card-" + card.id} label={"Pay " + card.name + " from"} required={false} initial={String(row(cfg.cardAccounts)[card.id] ?? "")} options={banks.map(a => ({id: a.id, name: a.name}))} />)}</div>
        <Check name="balances" label="Use existing account balances to fund dues" initial={cfg.useExistingBalances !== false && cfg.useBalances !== false} />
        <Check name="overdue" label="Include overdue unpaid payments" initial={cfg.includeOverdue !== false} />
        <Check name="issued" label="Reserve for issued card statements due after this cycle" initial={cfg.includeIssuedCards !== false} />
        <Table headers={["Account", "Linked dues", "Available balance", "Keep as buffer ₹", "Suggested funding", ""]}>
          {funding.accounts.map(item => <tr key={item.account.id}><td>{item.account.name}<small>{item.account.id === funding.sourceId ? "Salary source" : ""}</small></td>
            <td>{money(item.due)}<small>{item.items.length} payment(s)</small></td><td>{money(item.available)}</td>
            <td><input name={"reserve-" + item.account.id} aria-label={item.account.name + " buffer"} defaultValue={Number(row(cfg.reserves)[item.account.id] ?? 0)} required inputMode="decimal" /></td>
            <td>{money(item.required)}</td><td>{item.account.id !== funding.sourceId && item.required > 0 && <button type="button" disabled={!funding.receipt} onClick={() => setTransfer({id: item.account.id, amount: item.required})}>Record transfer</button>}</td></tr>)}
        </Table><button className="primary" type="submit">Save funding preferences</button></fieldset>
      </form>
      {funding.unassigned.length > 0 && <p className="error">Assign a payment account for {funding.unassigned.map(item => item.name).join(", ")}.</p>}
      {funding.shortfall > 0 && <p className="error">The salary source is short by {money(funding.shortfall)} after its own payments and buffer.</p>}
    </Panel>
    <Panel title="Payments included"><Table headers={["Due", "Payment", "Fund account", "Amount"]}>{funding.entries.map(item =>
      <tr key={item.id}><td>{item.date}</td><td>{item.name}<small>{item.projected ? "Estimated" : item.pending ? "Pending settlement" : item.kind}</small></td><td>{accountName(ledger, item.target)}</td><td>{money(item.amount)}</td></tr>)}</Table></Panel>
    {edit && <Editor title="Salary & reporting schedule" {...props} close={() => setEdit(false)} onSave={data => save(s => ({...s, settings: {...s.settings,
      salary: {...row(s.settings.salary), enabled: data.has("enabled"), amount: amount(data, "amount"), accountId: value(data, "account"), day: Number(value(data, "day")), startMonth: value(data, "startMonth"), weekend: value(data, "weekend")},
      reportingPeriod: {mode: value(data, "mode"), day: Number(value(data, "day"))}}}))}>
      <Check name="enabled" label="Enable salary schedule" initial={salary.enabled !== false} />
      <Input name="amount" label="Usual salary ₹" initial={Number(salary.amount) || ""} />
      <Select name="account" label="Salary account" initial={field(salary, "accountId")} options={banks.map(a => ({id: a.id, name: a.name}))} />
      <Input name="day" label="Salary credit day" type="number" min={1} max={31} initial={Number(salary.day) || 1} />
      <Input name="startMonth" label="Starts in" type="month" initial={field(salary, "startMonth") || month} />
      <Select name="weekend" label="Weekend payday" initial={field(salary, "weekend") || "none"} options={[{id: "none", name: "Keep date"}, {id: "previous", name: "Previous Friday"}, {id: "next", name: "Next Monday"}]} />
      <Select name="mode" label="Reporting calendar" initial={field(row(ledger.settings.reportingPeriod), "mode") || "salary"} options={[{id: "salary", name: "Salary day to next salary day"}, {id: "calendar", name: "Calendar month"}]} />
    </Editor>}
    {receive && <Editor title={"Record salary · " + month} {...props} close={() => setReceive(false)} onSave={data => save(s =>
      recordSalary(s, month, {date: value(data, "date"), amount: amount(data, "amount"), accountId: value(data, "account"), initiatedDate: value(data, "date"), mode: "Other", reference: ""}, asOf))}>
      <Input name="amount" label="Salary credited ₹" initial={Number(salary.amount) || ""} /><Input name="date" label="Credited on" type="date" initial={asOf} max={asOf} />
      <Select name="account" label="Receiving account" initial={field(salary, "accountId")} options={banks.map(a => ({id: a.id, name: a.name}))} />
    </Editor>}
    {transfer && <Editor title="Record completed salary transfer" {...props} close={() => setTransfer(null)} onSave={data => save(s => addEntry(s, {
      id: crypto.randomUUID(), type: "transfer", date: value(data, "date"), amount: amount(data, "amount"), accountId: funding.sourceId, toId: transfer.id, category: "", note: "Salary funding · " + month
    }, asOf))}><p className="editor-note">{accountName(ledger, funding.sourceId)} → {accountName(ledger, transfer.id)}</p>
      <Input name="amount" label="Transferred ₹" initial={transfer.amount / 100} /><Input name="date" label="Transferred on" type="date" initial={asOf} max={asOf} />
    </Editor>}
  </div>;
}

export function GoalsView(props: FeatureProps) {
  const {ledger, save, month, asOf, busy} = props;
  const [edit, setEdit] = useState<Row | null>(null), [adjust, setAdjust] = useState<Row | null>(null);
  const goals = rows(ledger.goals).filter(g => g.active !== false);
  return <div className="stack"><Stats items={[["Saved towards goals", sum(goals.map(g => minor(g.saved)))], ["Target total", sum(goals.map(g => minor(g.target)))], ["Recorded savings this cycle", cashMetrics(ledger, month, asOf).savings]]} />
    <Panel title="Savings goals" action={<button className="primary" onClick={() => setEdit({})}>+ Add goal</button>}>
      <div className="plan-grid">{goals.map(goal => {
        const left = Math.max(0, minor(goal.target) - minor(goal.saved)), deadline = field(goal, "deadline");
        const months = deadline ? Math.max(1, (Number(deadline.slice(0, 4)) - Number(asOf.slice(0, 4))) * 12 + Number(deadline.slice(5)) - Number(asOf.slice(5, 7)) + 1) : 0;
        return <article className="plan-card" key={field(goal, "id")}><h3>{field(goal, "name")}</h3><strong>{money(minor(goal.saved))}</strong><small>of {money(minor(goal.target))}</small>
          <progress aria-label={field(goal, "name")} max="100" value={Math.min(100, Number(goal.saved) / Number(goal.target) * 100)} />
          <p className="muted">{deadline ? "By " + monthLabel(deadline) + " · " + money(Math.ceil(left / months)) + " per month" : money(left) + " to go"}</p>
          <div className="button-row"><button onClick={() => setAdjust(goal)}>Add / withdraw</button><button onClick={() => setEdit(goal)}>Edit</button>
            <button disabled={busy} onClick={() => save(s => ({...s, goals: rows(s.goals).map(g => g.id === goal.id ? {...g, active: false} : g)}))}>Archive</button></div></article>;
      })}</div>{!goals.length && <p className="empty-copy">Create a goal for a house, travel, an emergency fund or another event.</p>}
      <p className="muted">Goal allocations earmark money already in your accounts. They do not create a second expense or move funds.</p>
    </Panel>
    {edit && <Editor title={edit.id ? "Edit goal" : "Add goal"} {...props} close={() => setEdit(null)} onSave={data => save(s => {
      const goal = {...edit, id: field(edit, "id") || crypto.randomUUID(), name: value(data, "name"), target: amount(data, "target"), saved: edit.id ? Number(edit.saved) : amount(data, "saved"), deadline: value(data, "deadline"), active: true};
      return {...s, goals: edit.id ? rows(s.goals).map(g => g.id === edit.id ? goal : g) : [...rows(s.goals), goal]};
    })}><Input name="name" label="Goal name" initial={field(edit, "name")} maxLength={100} /><Input name="target" label="Target ₹" initial={Number(edit.target) || ""} />
      {!edit.id && <Input name="saved" label="Already allocated ₹" initial={0} />}<Input name="deadline" label="Target month" type="month" required={false} initial={field(edit, "deadline")} />
    </Editor>}
    {adjust && <Editor title="Adjust goal allocation" {...props} close={() => setAdjust(null)} onSave={data => save(s => {
      const requested = amount(data, "amount");
      const delta = requested * (value(data, "direction") === "withdraw" ? -1 : 1);
      if (requested <= 0 || Number(adjust.saved) + delta < 0) throw new Error("Enter a positive amount within this goal's saved allocation.");
      return {...s, goals: rows(s.goals).map(g => g.id === adjust.id ? {...g, saved: (minor(g.saved) + minor(delta)) / 100} : g),
        settings: {...s.settings, goalMovements: [...rows(s.settings.goalMovements), {id: crypto.randomUUID(), goalId: adjust.id, amount: delta, date: asOf}]}};
    })}><Select name="direction" label="Action" initial="add" options={[{id: "add", name: "Add allocation"}, {id: "withdraw", name: "Withdraw allocation"}]} /><Input name="amount" label="Amount ₹" /></Editor>}
  </div>;
}

export function ForecastView({ledger, month, asOf}: FeatureProps) {
  const first = reportPeriod(ledger, month);
  const forecasts = Array.from({length: 12}, (_, i) => {
    const label = monthShift(month, i);
    return {month: label, ...cashMetrics(ledger, label, asOf)};
  });
  const anchor = dayShift(first.start, -1) < asOf ? dayShift(first.start, -1) : asOf;
  let running = netPosition(ledger, anchor).cash;
  return <div className="stack"><Stats items={[["Expected inflow", sum(forecasts.map(f => f.expectedIncome))], ["Expected cash outflow", sum(forecasts.map(f => f.expectedOutflow))],
    ["Future personal bank EMIs", sum(forecasts.map(f => f.bankEmiExpected))]]} />
    <Panel title="12-month cash-flow plan" subtitle="Known schedules and recorded entries. Unplanned spending is outside this forecast.">
      <Table headers={["Period", "Expected inflow", "Actual outflow", "Expected outflow", "Bank EMIs left", "Card postings left", "Projected cash balance"]}>
        {forecasts.map(item => {running += item.inflow - item.outflow + item.expectedIncome - item.expectedOutflow; return <tr key={item.month}>
          <td>{monthLabel(item.month)}<small>{item.start} → {item.end}</small></td><td>{money(item.expectedIncome)}</td><td>{money(item.outflow)}</td><td>{money(item.expectedOutflow)}</td>
          <td>{money(item.bankEmiExpected)}</td><td>{money(item.cardEmiExpected)}</td><td>{money(running)}</td></tr>;})}
      </Table>
    </Panel>
  </div>;
}
