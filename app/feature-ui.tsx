"use client";

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { amountFromInput, field, hasReversal, money, rows, type Ledger, type Row } from "../lib/ledger";
import {
  linkExistingBill, obligations, paymentModes, recordBill, recordEmi, recordPendingCard, saveTransaction,
  type Obligation, type Save
} from "../lib/finance";

export const dateText = (date: string) => new Intl.DateTimeFormat("en-IN", {day: "numeric", month: "short", year: "numeric", timeZone: "UTC"})
  .format(new Date(date + "T12:00:00Z"));
export const accountName = (s: Ledger, id: unknown) => s.accounts.find(a => a.id === id)?.name ?? "Choose payment account";
export type FeatureProps = {ledger: Ledger; month: string; asOf: string; save: Save; busy: boolean; error?: string};
export const value = (data: FormData, key: string) => String(data.get(key) ?? "").trim();
export const amount = (data: FormData, key: string, maximum = 10_000_000_000) => amountFromInput(value(data, key), maximum);

export function Panel({title, subtitle, action, children}: {title: string; subtitle?: string; action?: ReactNode; children: ReactNode}) {
  return <section className="panel"><div className="panel-head"><div><h2>{title}</h2>{subtitle && <p className="muted">{subtitle}</p>}</div>{action}</div>{children}</section>;
}
export function Stats({items}: {items: [string, number | string, string?][]}) {
  return <div className="feature-stats">{items.map(([label, total, note], i) =>
    <article key={label} className={"feature-stat metric-" + i % 3}><span>{label}</span><strong>{typeof total === "number" ? money(total) : total}</strong>{note && <small>{note}</small>}</article>)}</div>;
}
export function Input({name, label, initial = "", type = "text", required = true, ...props}: {
  name: string; label: string; initial?: string | number; type?: string; required?: boolean; min?: string | number; max?: string | number; step?: string | number; maxLength?: number; readOnly?: boolean
}) {
  return <label>{label}<input name={name} type={type} defaultValue={initial} required={required} {...props} /></label>;
}
export function Select({name, label, initial = "", options, required = true}: {
  name: string; label: string; initial?: string | number; options: {id: string; name: string}[]; required?: boolean
}) {
  return <label>{label}<select name={name} defaultValue={initial} required={required}>
    <option value="">{required ? "Choose…" : "None"}</option>{options.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
  </select></label>;
}
export function Check({name, label, initial = false}: {name: string; label: string; initial?: boolean}) {
  return <label className="checkbox"><input name={name} type="checkbox" defaultChecked={initial} />{label}</label>;
}
export function Table({headers, children}: {headers: string[]; children: ReactNode}) {
  return <div className="table-scroll"><table><thead><tr>{headers.map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
}
export function Editor({title, close, busy, error, onSave, children, submit = "Save"}: {
  title: string; close: () => void; busy: boolean; error?: string; onSave?: (data: FormData) => Promise<boolean>; children: ReactNode; submit?: string
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [localError, setLocalError] = useState("");
  useLayoutEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      requestAnimationFrame(() => {
        if (element?.isConnected || document.querySelector("dialog[open]")) return;
        if (trigger instanceof HTMLElement && trigger.isConnected && !trigger.matches(":disabled")) trigger.focus();
        else document.getElementById("workspace-heading")?.focus();
      });
    };
  }, []);
  return <dialog ref={dialog} className="feature-dialog" aria-labelledby={titleId} onCancel={event => {event.preventDefault();if (!busy) close();}}>
    <div className="dialog-heading"><h2 id={titleId}>{title}</h2><button type="button" disabled={busy} aria-label="Close editor" onClick={close}>×</button></div>
    {onSave ? <form onSubmit={async event => {
      event.preventDefault();
      setLocalError("");
      try { if (await onSave(new FormData(event.currentTarget))) close(); }
      catch (problem) {setLocalError(problem instanceof Error ? problem.message : "Could not save this record.");}
    }}><fieldset disabled={busy}><div className="editor-fields">{children}</div>
      {(localError || error) && <p className="error" role="alert">{localError || error}</p>}
      <div className="dialog-actions"><button type="button" onClick={close}>Cancel</button><button className="primary" type="submit">{busy ? "Saving…" : submit}</button></div>
    </fieldset></form> : <div className="dialog-body">{children}</div>}
  </dialog>;
}

export function PaymentEditor({item, ledger, asOf, save, close, busy, error}: {
  item: Obligation; ledger: Ledger; asOf: string; save: Save; close: () => void; busy: boolean; error?: string
}) {
  const pending = item.pending;
  const canPending = Boolean(item.statement || (item.bill && !item.bill.legacy));
  const cash = ledger.accounts.filter(a => a.type !== "credit");
  const source = field(pending ?? {}, "accountId") || item.accountId || field(ledger.settings.salary as Row ?? {}, "accountId") || cash[0]?.id;
  const accounts = item.bill ? ledger.accounts : cash;
  const matching = item.statement ? ledger.transactions.filter(t => t.type === "cardPayment" && t.toId === item.statement?.cardId &&
    !hasReversal(ledger, t.id, asOf) && !((ledger.settings.cardStatementPayments as Row[] | undefined) ?? []).some(p => p.transactionId === t.id)) :
    item.bill ? ledger.transactions.filter(t => t.type === "expense" && t.date <= asOf && !t.serviceId && !t.billId && !t.loanId &&
      !hasReversal(ledger, t.id, asOf) && !rows(ledger.settings.servicePayments).some(p => p.transactionId === t.id) &&
      Math.abs(Date.parse(t.date) - Date.parse(item.date)) <= 32 * 86400000) : [];
  return <Editor title={item.impact === "card" ? "Record card charge" : "Record payment"} busy={busy} error={error} close={close} submit="Save payment"
    onSave={async data => save(s => {
      const payment = {date: value(data, "date"), amount: amount(data, "amount"), accountId: value(data, "accountId") || source,
        initiatedDate: value(data, "initiatedDate"), mode: value(data, "mode"), reference: value(data, "reference"), pending: value(data, "status") === "pending"};
      if (item.bill) {
        if (value(data, "existing")) {
          const t = s.transactions.find(t => t.id === value(data, "existing"));
          if (payment.pending || !t || t.accountId !== payment.accountId || t.date !== payment.date || t.amount !== payment.amount)
            throw new Error("The existing debit must match the source, settlement date and amount.");
          return linkExistingBill(s, t.id, item.bill.key, asOf);
        }
        return recordBill(s, item.bill, payment, asOf, field(pending ?? {}, "id"));
      }
      if (item.installment) return recordEmi(s, item.installment.loan.id, item.installment.number, payment.date, payment.accountId, asOf);
      if (item.statement) return recordPendingCard(s, field(item.statement, "id"), payment, asOf, field(pending ?? {}, "id"), value(data, "existing"));
      if (item.cardId && item.impact === "out") return saveTransaction(s, {id: crypto.randomUUID(), type: "cardPayment", date: payment.date,
        amount: payment.amount, accountId: payment.accountId, toId: item.cardId, category: "", note: "Credit card repayment"}, asOf);
      throw new Error("Open this scheduled transaction from Transactions to change its date or confirm it.");
    })}>
    <p className="editor-note">{item.name} · due {dateText(item.date)} · {money(item.amount)}
      {item.impact === "card" && <small>A card charge increases the card balance. The card repayment is recorded separately.</small>}</p>
    {canPending && <Select name="status" label="Payment status" initial="cleared" options={[{id: "cleared", name: "Cleared — money has moved"}, {id: "pending", name: "Pending — awaiting settlement"}]} />}
    <Input name="amount" label="Amount ₹" initial={(item.pending ? Number(item.pending.amount) : item.amount / 100).toFixed(2)} readOnly={Boolean(item.installment)} />
    <Input name="initiatedDate" label="Initiated on" type="date" initial={field(pending ?? {}, "initiatedDate") || asOf} max={asOf} />
    <Input name="date" label="Cleared / posted on" type="date" initial={asOf} max={asOf} />
    {item.impact !== "card" || item.bill ? <Select name="accountId" label="Payment account" initial={source} options={accounts.map(a => ({id: a.id, name: a.name}))} /> :
      <p className="editor-note">Posted to {accountName(ledger, item.accountId)}</p>}
    <Select name="mode" label="Payment mode" initial={field(pending ?? {}, "mode") || "Other"} options={paymentModes.map(mode => ({id: mode, name: mode}))} />
    <Input name="reference" label="Reference / UTR" initial={field(pending ?? {}, "reference")} required={false} maxLength={100} />
    {matching.length > 0 && <Select name="existing" label={item.bill ? "Link an existing expense" : "Link an existing repayment"} required={false}
      options={matching.map(t => ({id: t.id, name: t.date + " · " + money(Math.round(t.amount * 100)) + " · " + accountName(ledger, t.accountId)}))} />}
  </Editor>;
}

export function UpcomingChooser({ledger, asOf, monthEnd, save, busy, error}: {
  ledger: Ledger; asOf: string; monthEnd: string; save: Save; busy: boolean; error?: string
}) {
  const [selected, setSelected] = useState<Obligation | null>(null);
  const items = obligations(ledger, "1900-01-01", monthEnd, asOf).filter(item => item.bill || item.installment || item.statement);
  return <><label className="upcoming-chooser">Choose a bill, EMI or card payment through {dateText(monthEnd)}<select value="" onChange={event => setSelected(items.find(item => item.id === event.target.value) ?? null)}>
    <option value="">Ordinary transaction / choose an upcoming payment…</option>
    {items.map(item => <option key={item.id} value={item.id}>{item.date} · {item.name} · {money(item.amount)}</option>)}
  </select></label>
  {selected && <PaymentEditor item={selected} ledger={ledger} asOf={asOf} save={save} busy={busy} error={error} close={() => setSelected(null)} />}</>;
}
