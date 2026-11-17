"use client";

import { useState } from "react";
import { dayShift, field, hasReversal, kinds, minor, money, reportPeriod, row, type Entry } from "../lib/ledger";
import { billRows, confirmScheduled, linkExistingBill, postedRows, reverseEntry, splitPayment } from "../lib/finance";
import { accountName, amount, Editor, Input, Panel, Select, Table, value, type FeatureProps } from "./feature-ui";

export function LedgerHistory(props: FeatureProps & {search: string; openReceipts: () => void}) {
  const {ledger, month, asOf, save, busy, search} = props;
  const [type, setType] = useState(""), [source, setSource] = useState(""), [accountType, setAccountType] = useState(""), [sort, setSort] = useState("latest"), [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Entry | null>(null), [operation, setOperation] = useState(""), [split, setSplit] = useState(false);
  const period = reportPeriod(ledger, month), actual = postedRows(ledger, period.start, period.end, asOf);
  const scheduled: (Entry & {signed: number})[] = ledger.transactions.filter(t => t.date > asOf && t.date >= period.start && t.date <= period.end).map(t => ({...t, signed: minor(t.amount)}));
  const entries = [...actual, ...scheduled]
    .filter(t => (!type || t.type === type) && (!source || t.accountId === source || t.toId === source) &&
      (!accountType || ledger.accounts.some(a => a.type === accountType && (a.id === t.accountId || a.id === t.toId))) &&
      (!search || [t.note, t.category, accountName(ledger, t.accountId), accountName(ledger, t.toId)].some(text => text?.toLowerCase().includes(search.toLowerCase()))))
    .sort((a, b) => sort === "latest" ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date));
  const pages = Math.max(1, Math.ceil(entries.length / 50)), current = Math.min(page, pages - 1), visible = entries.slice(current * 50, current * 50 + 50);
  const detail = selected && ledger.transactions.find(t => t.id === selected.id);
  const matches = detail ? billRows(ledger, dayShift(detail.date, -32), dayShift(detail.date, 32), asOf).filter(b => !b.paid && !b.transaction) : [];
  return <><Panel title="Transaction history" action={<button onClick={() => setSplit(true)}>Split payment</button>}>
    <div className="filter-row"><label>Transaction type<select value={type} onChange={e => {setType(e.target.value);setPage(0);}}><option value="">All types</option>{Object.entries(kinds).map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label>
      <label>Account type<select value={accountType} onChange={e => {setAccountType(e.target.value);setPage(0);}}><option value="">All types</option><option value="bank">Bank</option><option value="credit">Credit card</option><option value="cash">Cash</option></select></label>
      <label>Account / card<select value={source} onChange={e => {setSource(e.target.value);setPage(0);}}><option value="">All accounts</option>{ledger.accounts.map(a => <option value={a.id} key={a.id}>{a.name}</option>)}</select></label>
      <label>Order<select value={sort} onChange={e => setSort(e.target.value)}><option value="latest">Latest first</option><option value="oldest">Oldest first</option></select></label></div>
    <Table headers={["Date / description", "Type / category", "Account", "Amount", "Status", ""]}>{visible.map(entry =>
      <tr key={entry.id}><td><strong>{entry.note || kinds[entry.type]}</strong><small>{entry.date}</small></td><td>{kinds[entry.type]}<small>{entry.category}</small></td>
        <td>{accountName(ledger, entry.accountId)}{entry.toId && <small>→ {accountName(ledger, entry.toId)}</small>}</td><td className="number">{money(entry.signed)}</td>
        <td>{entry.reversal ? "Reversal" : entry.statementBacked ? "Statement confirmed" : entry.date > asOf ? "Scheduled" : hasReversal(ledger, entry.id, asOf) ? "Reversed" : "Recorded"}</td>
        <td>{!entry.reversal && !entry.statementBacked && <button onClick={() => {setSelected(entry);setOperation("");}}>Details</button>}</td></tr>)}</Table>
    {!entries.length && <p className="empty-copy">No matching entries in this reporting period.</p>}
    <div className="pagination"><span>{entries.length} matching entries · page {current + 1} of {pages}</span>
      <button disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</button><button disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>Next</button></div>
  </Panel>
  {detail && !operation && <Editor title="Transaction details" {...props} close={() => setSelected(null)}>
    <dl className="compact-details"><dt>Description</dt><dd>{detail.note || kinds[detail.type]}</dd><dt>Amount</dt><dd>{money(minor(detail.amount))}</dd>
      <dt>Date</dt><dd>{detail.date}</dd><dt>Account</dt><dd>{accountName(ledger, detail.accountId)}</dd><dt>Category</dt><dd>{detail.category || kinds[detail.type]}</dd>
      <dt>Linked plan</dt><dd>{String(detail.loanId || detail.serviceId || detail.billId || detail.cardStatementId || detail.receivableLoanId || "None")}</dd>
      <dt>Reconciled</dt><dd>{row(row(ledger.settings.dailyV6).reconciled)[detail.id] ? "Yes" : "No"}</dd></dl>
    <div className="button-row section-gap"><button onClick={() => setOperation("notes")}>Edit description / category</button>
      {detail.date > asOf ? <><button onClick={() => setOperation("confirm")}>Confirm actual posting</button><button disabled={busy} onClick={async () => {
        if (await save(s => ({...s, transactions: s.transactions.filter(t => t.id !== detail.id)}))) setSelected(null);
      }}>Cancel scheduled entry</button></> : !hasReversal(ledger, detail.id, asOf) && <button onClick={() => setOperation("reverse")}>Reverse entry</button>}
      {detail.type === "expense" && !detail.billId && !detail.serviceId && !detail.loanId && detail.date <= asOf && <button onClick={() => setOperation("link")}>Link existing debit to bill</button>}
      <button onClick={() => {setSelected(null);props.openReceipts();}}>Receipts</button></div>
  </Editor>}
  {detail && operation && <Editor title={operation === "reverse" ? "Reverse entry" : operation === "confirm" ? "Confirm scheduled posting" : operation === "link" ? "Link existing debit" : "Edit transaction details"}
    {...props} close={() => {setOperation("");setSelected(null);}} onSave={data => save(s => {
      if (operation === "reverse") return reverseEntry(s, detail.id, value(data, "date"), value(data, "reason"), asOf);
      if (operation === "confirm") return confirmScheduled(s, detail.id, value(data, "date"), asOf);
      if (operation === "link") return linkExistingBill(s, detail.id, value(data, "bill"), asOf);
      return {...s, transactions: s.transactions.map(t => t.id === detail.id ? {...t, note: value(data, "note"), category: value(data, "category") || t.category} : t)};
    })}>
    {(operation === "reverse" || operation === "confirm") && <Input name="date" label="Actual date" type="date" initial={asOf} max={asOf} />}
    {operation === "reverse" && <Input name="reason" label="Reason for reversal" maxLength={300} />}
    {operation === "notes" && <><Input name="note" label="Description / tags" initial={detail.note || ""} required={false} maxLength={1200} />
      {!detail.loanId && !detail.receivableLoanId && !detail.serviceId && !detail.billId && (detail.type === "income" || detail.type === "expense" || detail.type === "refund") &&
        <Select name="category" label="Category" initial={detail.category} options={(detail.type === "income" ? ledger.categories.income : ledger.categories.expense).map(c => ({id: c, name: c}))} />}</>}
    {operation === "link" && <><Select name="bill" label="Unpaid bill occurrence" options={matches.map(b => ({id: b.key, name: b.date + " · " + field(b.plan, "name")}))} />
      <p className="editor-note">This links the existing debit. It creates no second payment.</p></>}
  </Editor>}
  {split && <SplitEditor {...props} close={() => setSplit(false)} />}
  </>;
}

function SplitEditor(props: FeatureProps & {close: () => void}) {
  const [count, setCount] = useState(2);
  return <Editor title="Split an expense by category" {...props} onSave={data => props.save(s => splitPayment(s, value(data, "date"), value(data, "account"), amount(data, "total"),
    Array.from({length: count}, (_, i) => ({category: value(data, "category-" + i), amount: amount(data, "amount-" + i), note: value(data, "note-" + i)})), props.asOf))}>
    <Input name="date" label="Paid / charged on" type="date" initial={props.asOf} max={props.asOf} /><Input name="total" label="Total payment ₹" />
    <Select name="account" label="Payment account" options={props.ledger.accounts.map(a => ({id: a.id, name: a.name}))} />
    <label>Number of parts<select value={count} onChange={e => setCount(Number(e.target.value))}>{[2, 3, 4, 5, 6, 8, 10, 12].map(n => <option key={n}>{n}</option>)}</select></label>
    {Array.from({length: count}, (_, i) => <div className="split-part" key={i}><Select name={"category-" + i} label={"Part " + (i + 1) + " category"} options={props.ledger.categories.expense.map(c => ({id: c, name: c}))} />
      <Input name={"amount-" + i} label="Amount ₹" /><Input name={"note-" + i} label="Notes / tags" required={false} maxLength={1100} /></div>)}
  </Editor>;
}
