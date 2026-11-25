"use client";

import { useState } from "react";
import { addStatement, field, hasReversal, latestStatement, minor, money, reportPeriod, rows, statementAmounts, type Row } from "../lib/ledger";
import { activeLinks, addMonths, confirmStatementEmi, loans, postedRows, recordPendingCard, removeUnsettledStatement, reverseEntry, schedule, sum, updateStatement, type Obligation } from "../lib/finance";
import { accountName, amount, dateText, Editor, Input, Panel, PaymentEditor, Select, Stats, Table, value, type FeatureProps } from "./feature-ui";

export function StatementsView(props: FeatureProps & {focusedCard?: string; onImport: (account: string) => void}) {
  const {ledger, month, asOf, save, busy} = props;
  const [card, setCard] = useState(props.focusedCard || ""), [layout, setLayout] = useState("list"), [status, setStatus] = useState("");
  const [payment, setPayment] = useState<Obligation | null>(null), [editing, setEditing] = useState<Row | null>(null), [breakdown, setBreakdown] = useState<Row | null>(null);
  const [reversal, setReversal] = useState(""), [voidLink, setVoidLink] = useState<Row | null>(null);
  const period = reportPeriod(ledger, month);
  const statements = rows(ledger.settings.cardStatements).filter(st => !card || st.cardId === card)
    .sort((a, b) => field(b, "statementDate").localeCompare(field(a, "statementDate")));
  const latest = statements.filter(st => latestStatement(ledger, field(st, "cardId"), asOf)?.id === st.id);
  const selected = statements.filter(st => !status || (status === "due" ? latest.includes(st) && statementAmounts(ledger, st, asOf).due > 0
    : status === "paid" ? statementAmounts(ledger, st, asOf).due === 0 : rows(ledger.settings.cardStatementPayments).some(p => p.statementId === st.id && !p.completedDate)));
  const pending = rows(ledger.settings.cardStatementPayments).filter(p => statements.some(st => st.id === p.statementId) && !p.completedDate);
  const choosePayment = (st: Row, pending?: Row) => setPayment({id: String(st.id), name: accountName(ledger, st.cardId), date: field(st, "dueDate"),
    amount: statementAmounts(ledger, st, asOf).due, accountId: field(pending ?? {}, "accountId"), kind: "Card statement", impact: "out", statement: st, pending});
  return <div className="stack">
    <Stats items={[["Billed this period", sum(statements.filter(st => field(st, "statementDate") >= period.start && field(st, "statementDate") <= period.end).map(st => minor(st.billAmount)))],
      ["Recorded repayments", sum(postedRows(ledger, period.start, period.end, asOf).filter(t => t.type === "cardPayment" && (!card || t.toId === card)).map(t => t.signed))],
      ["Current statement dues", sum(latest.map(st => statementAmounts(ledger, st, asOf).due))], ["Pending settlements", sum(pending.map(p => minor(p.amount)))]]} />
    <Panel title="Card statements"><div className="filter-row"><button type="button" onClick={() => props.onImport(card || ledger.accounts.find(a => a.type === "credit")?.id || "")}>Import card transactions</button><label>Credit card<select value={card} onChange={e => setCard(e.target.value)}><option value="">All credit cards</option>{ledger.accounts.filter(a => a.type === "credit").map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <label>Status<select value={status} onChange={e => setStatus(e.target.value)}><option value="">All statements</option><option value="due">Current dues</option><option value="paid">Settled</option><option value="pending">Pending payment</option></select></label>
      <div className="segmented"><button aria-pressed={layout === "list"} onClick={() => setLayout("list")}>List</button><button aria-pressed={layout === "cards"} onClick={() => setLayout("cards")}>Cards</button></div></div>
      {layout === "list" ? <Table headers={["Card / issued", "Due", "Total billed", "Settled", "Current remaining", ""]}>{selected.map(st => {
        const totals = statementAmounts(ledger, st, asOf), current = latest.includes(st);
        return <tr key={field(st, "id")}><td><strong>{accountName(ledger, st.cardId)}</strong><small>{st.statementDate as string}</small></td><td>{st.dueDate as string}</td>
          <td>{money(totals.billed)}</td><td>{money(totals.paid)}</td><td>{current ? money(totals.due) : "Carried into newer snapshot"}</td>
          <td><div className="button-row">{current && totals.due > 0 && <button onClick={() => choosePayment(st)}>Record payment</button>}<button onClick={() => setEditing(st)}>Edit</button><button onClick={() => setBreakdown(st)}>EMI breakdown</button></div></td></tr>;
      })}</Table> : <div className="plan-grid">{selected.map(st => {
        const total = statementAmounts(ledger, st, asOf), current = latest.includes(st);
        return <article className="plan-card" key={field(st, "id")}><h3>{accountName(ledger, st.cardId)}</h3><p className="muted">Issued {dateText(field(st, "statementDate"))} · due {dateText(field(st, "dueDate"))}</p>
          <dl className="compact-details"><dt>Total billed</dt><dd>{money(total.billed)}</dd><dt>Settled</dt><dd>{money(total.paid)}</dd><dt>Current due</dt><dd>{current ? money(total.due) : "Superseded snapshot"}</dd></dl>
          <div className="button-row">{current && total.due > 0 && <button className="primary" onClick={() => choosePayment(st)}>Record payment</button>}
            <button onClick={() => setEditing(st)}>Edit statement</button><button onClick={() => setBreakdown(st)}>EMI breakdown</button></div></article>;
      })}</div>}
    </Panel>
    <Panel title="Payment history" subtitle="Original settled values remain intact after reversals">
      <Table headers={["Card / statement", "Amount", "Initiated / cleared", "Account", "Status", ""]}>{rows(ledger.settings.cardStatementPayments)
        .filter(p => statements.some(st => st.id === p.statementId)).map(p => {
          const st = statements.find(st => st.id === p.statementId)!;
          const reversed = hasReversal(ledger, field(p, "transactionId"), asOf);
          return <tr key={field(p, "id")}><td>{accountName(ledger, st.cardId)}<small>{field(st, "statementDate")}</small></td><td>{money(minor(p.amount))}</td>
            <td>{field(p, "initiatedDate")}<small>{field(p, "completedDate") || "Awaiting settlement"}</small></td><td>{accountName(ledger, p.accountId)}</td>
            <td>{reversed ? "Reversed" : p.completedDate ? "Cleared" : "Pending"}</td><td>{!p.completedDate ? <div className="button-row"><button onClick={() => choosePayment(st, p)}>Settle / edit</button>
              <button disabled={busy} onClick={() => save(s => ({...s, settings: {...s.settings, cardStatementPayments: rows(s.settings.cardStatementPayments).filter(row => row.id !== p.id)}}))}>Cancel pending</button></div>
              : !reversed && <button onClick={() => setReversal(field(p, "transactionId"))}>Reverse</button>}</td></tr>;
        })}</Table>
    </Panel>
    {ledger.accounts.some(a => a.type === "credit") && <Panel title="Record a card statement">
      <form onSubmit={async event => {
        event.preventDefault();const form = event.currentTarget, data = new FormData(form);
        if (await save(s => {
          const statement = {id: crypto.randomUUID(), cardId: value(data, "card"), statementDate: value(data, "issued"), dueDate: value(data, "due"),
            billAmount: amount(data, "billed"), minimumDue: amount(data, "minimum"), reference: value(data, "reference")};
          const next = addStatement(s, statement, asOf), paid = amount(data, "initialPaid");
          return paid > 0 ? recordPendingCard(next, statement.id, {amount: paid, date: value(data, "paidDate"), initiatedDate: value(data, "paidDate"),
            accountId: value(data, "paidAccount"), mode: "Other", reference: ""}, asOf) : next;
        })) form.reset();
      }}><fieldset disabled={busy} className="entry-form">
        <Select name="card" label="Credit card" initial={card || ledger.accounts.find(a => a.type === "credit")?.id} options={ledger.accounts.filter(a => a.type === "credit").map(a => ({id: a.id, name: a.name}))} />
        <Input name="issued" label="Issued on" type="date" initial={asOf} max={asOf} /><Input name="due" label="Due on" type="date" />
        <Input name="billed" label="Billed amount ₹" /><Input name="minimum" label="Minimum due ₹" initial={0} /><Input name="reference" label="Reference" required={false} maxLength={100} />
        <Input name="initialPaid" label="Already settled ₹" initial={0} /><Input name="paidDate" label="Already settled on" type="date" initial={asOf} max={asOf} />
        <Select name="paidAccount" label="Settlement source" required={false} options={ledger.accounts.filter(a => a.type !== "credit").map(a => ({id: a.id, name: a.name}))} />
        <button className="primary">Record statement</button>
      </fieldset></form>
    </Panel>}
    {editing && <Editor title="Edit statement" {...props} close={() => setEditing(null)} onSave={data => save(s => updateStatement(s, {...editing,
      billAmount: amount(data, "billed"), minimumDue: amount(data, "minimum"), dueDate: value(data, "due"), reference: value(data, "reference")}, asOf))}>
      <Input name="billed" label="Bank-issued balance ₹" initial={Number(editing.billAmount)} /><Input name="minimum" label="Minimum due ₹" initial={Number(editing.minimumDue) || 0} />
      <Input name="due" label="Due on" type="date" initial={field(editing, "dueDate")} /><Input name="reference" label="Reference" initial={field(editing, "reference")} required={false} />
      <button type="button" disabled={busy} onClick={async () => {
        if (await save(s => removeUnsettledStatement(s, String(editing.id)), true)) setEditing(null);
      }}>Remove statement without history</button>
    </Editor>}
    {breakdown && <Editor title="Confirm statement EMI portions" {...props} close={() => setBreakdown(null)} onSave={data => save(s => {
      let next = s;for (const selection of data.getAll("installment")) {
        const [id, number] = String(selection).split("|");next = confirmStatementEmi(next, String(breakdown.id), id, Number(number), asOf);
      } return next;
    })}><p className="editor-note">Select only installments included in the bank-issued total. This confirms the spending without adding a second card charge.</p>
      {loans(ledger).filter(l => l.kind === "credit" && l.cardId === breakdown.cardId).flatMap(l => schedule(ledger, l, asOf)
        .filter(item => !item.recorded && !item.transaction && item.date > addMonths(field(breakdown, "statementDate"), -1) && item.date <= field(breakdown, "statementDate"))
        .map(item => <label className="checkbox" key={l.id + "|" + item.number}><input type="checkbox" name="installment" value={l.id + "|" + item.number} />{l.title} · #{item.number} · {item.date} · {money(item.amount)}</label>))}
      <Table headers={["Confirmed plan", "Installment", "Amount", ""]}>{activeLinks(ledger).filter(link => link.statementId === breakdown.id).map(link =>
        <tr key={field(link, "id")}><td>{loans(ledger).find(l => l.id === link.loanId)?.title}</td><td>{Number(link.installment)}</td><td>{money(minor(link.amount))}</td>
          <td><button type="button" onClick={() => {setBreakdown(null);setVoidLink(link);}}>Correct link</button></td></tr>)}</Table>
    </Editor>}
    {voidLink && <Editor title="Correct statement EMI link" {...props} close={() => setVoidLink(null)} onSave={data => save(s => ({...s, settings: {...s.settings,
      statementEmiLinkVoids: [...rows(s.settings.statementEmiLinkVoids), {id: crypto.randomUUID(), linkId: voidLink.id, date: asOf, reason: value(data, "reason")} ]}}))}>
      <Input name="reason" label="Correction reason" maxLength={300} /><p className="editor-note">The original link remains in the audit history. The installment becomes available to record again.</p></Editor>}
    {reversal && <Editor title="Reverse settled repayment" {...props} close={() => setReversal("")} onSave={data => save(s => reverseEntry(s, reversal, value(data, "date"), value(data, "reason"), asOf))}>
      <Input name="date" label="Reversed on" type="date" initial={asOf} max={asOf} /><Input name="reason" label="Reason" maxLength={300} /></Editor>}
    {payment && <PaymentEditor {...props} item={payment} close={() => setPayment(null)} />}
  </div>;
}
