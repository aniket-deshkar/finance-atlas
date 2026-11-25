"use client";

import { useEffect, useRef, useState } from "react";
import { Switch } from "@chakra-ui/react";
import { addEntry, balance, field, hasReversal, minor, money, monthLabel, monthShift, row, rows, type Entry, type Ledger, type Row } from "../lib/ledger";
import { cardCycle, cardUsage, cashMetrics, categoryActual, debtRows, matchRecordedBills, netPosition, reconcileBalance,
  repeatingPayments, settingsV6, simulateDebt, sum } from "../lib/finance";
import { attachReceipt, base64, csvEncode, decodeStatementFile, download, importStatement, inferStatementDateOrder, receiptArchive, reviewStatement, statementColumns, statementMatches, unbase64, type Staged, type StatementColumns } from "../lib/files";
import { accountName, amount, Check, Editor, Input, Panel, Select, Stats, Table, value, type FeatureProps } from "./feature-ui";
import { deriveKey, deviceBackupLimit, deviceRecord, exportDeviceRecords, openEncryptedBackup, restoreDeviceRecords, serializeEnvelope, snapshots, type Envelope } from "../lib/vault";
import { documentDigest, saveDocumentIndex } from "./documents";
import { readPdf, rowKey, statementCsvFromText } from "../lib/documents";
import type { BackupControls } from "./backup";
import { layouts, navGroups, viewIds, views, widgets } from "../lib/navigation";
import { auditWorkbook } from "../lib/reports";
import {FileIntake, PdfUnlock} from "./file-intake";

export function DebtView(props: FeatureProps) {
  const {ledger, asOf, save, busy} = props;
  const [editing, setEditing] = useState<Row | null>(null);
  const debts = debtRows(ledger, asOf), cards = ledger.accounts.filter(a => a.type === "credit"), extra = minor(Number(ledger.settings.debtExtra) || 0);
  const snowball = simulateDebt(debts, extra, "snowball"), avalanche = simulateDebt(debts, extra, "avalanche");
  return <div className="stack"><Stats items={[["Known outstanding debt", sum(debts.filter(d => d.known).map(d => Number(d.balance)))],
    ["Principal balances missing", String(debts.filter(d => !d.known).length)], ["Reserved card EMI principal", sum(cards.map(a => cardUsage(ledger, a, asOf).reserved))]]} />
    <Panel title="Credit cards & utilization"><Table headers={["Card", "Outstanding", "EMI limit reserved", "Estimated total used", "Available", "Utilization"]}>
      {cards.map(card => {const usage = cardUsage(ledger, card, asOf);return <tr key={card.id}><td>{card.name}</td><td>{money(usage.owed)}</td><td>{money(usage.reserved)}
        <small>{usage.thirdParty ? money(usage.thirdParty) + " for others" : ""}</small></td><td>{money(usage.used)}</td><td>{usage.limit ? money(usage.available) : "Set limit"}</td><td>{usage.utilization === null ? "—" : usage.utilization.toFixed(1) + "%"}</td></tr>;})}
    </Table><p className="muted">Future card EMI principal is an estimate of blocked credit limit. Card repayments reduce actual outstanding. Card interest varies and is excluded from fixed-rate payoff simulations.</p></Panel>
    <Panel title="Bank loans & manual debts" action={<button className="primary" onClick={() => setEditing({})}>+ Add manual debt</button>}>
      <Table headers={["Debt", "Outstanding principal", "Remaining installments", "APR / minimum", ""]}>{debts.filter(d => d.source !== "Credit card").map(d =>
        <tr key={field(d, "id")}><td>{field(d, "name")}<small>{field(d, "source")}</small></td><td>{d.known ? money(Number(d.balance)) : "Principal not entered"}</td>
          <td>{typeof d.remainingInstallments === "number" ? money(d.remainingInstallments) : "—"}</td><td>{d.apr === null || d.apr === undefined ? "APR unset" : String(d.apr) + "%"}
            <small>{typeof d.minPay === "number" ? money(minor(d.minPay)) + " / month" : ""}</small></td><td><button onClick={() => setEditing(d)}>Update balance / terms</button></td></tr>)}
      </Table>
    </Panel>
    <Panel title="Payoff planner" subtitle="Fixed-rate bank loans and manual debts with known balances and terms">
      <form className="filter-row" onSubmit={e => {e.preventDefault();const data = new FormData(e.currentTarget);void save(s => ({...s, settings: {...s.settings, debtExtra: amount(data, "extra")}}));}}>
        <Input name="extra" label="Extra monthly payment ₹" initial={extra / 100} /><button type="submit" disabled={busy}>Recalculate</button>
      </form><div className="plan-grid">{[["Snowball", snowball], ["Avalanche", avalanche]].map(([name, calculation]) => {
        const result = calculation as typeof snowball;
        return <article key={String(name)} className="plan-card"><h3>{String(name)}</h3><strong>{result.count ? result.complete ? result.months + " months" : "Beyond 600 months" : "Add balance, APR and minimum payment"}</strong>
          <p>Estimated interest {money(result.interest)}</p><small>{result.order.map(o => o.name + " · month " + o.month).join(" → ")}</small></article>;
      })}</div>
    </Panel>
    <Panel title="Card billing windows"><Table headers={["Card", "Purchase today", "Next statement", "Payment due"]}>
      {cards.map(card => {const cycle = cardCycle(ledger, card, asOf);return <tr key={card.id}><td>{card.name}</td><td>{Math.round((Date.parse(cycle.due) - Date.parse(asOf)) / 86400000)} days to due date</td>
        <td>{cycle.statement}</td><td>{cycle.due}</td></tr>;})}</Table></Panel>
    {editing && <Editor title="Debt balance & payment terms" {...props} close={() => setEditing(null)} onSave={data => save(s => {
      const principal = amount(data, "balance"), apr = Number(value(data, "apr")), minimum = amount(data, "minimum");
      if (principal < 0 || !Number.isFinite(apr) || apr < 0 || apr > 100 || minimum < 0) throw new Error("Enter nonnegative balance and payment terms.");
      const old = rows(s.debts).find(d => editing.loanId ? d.loanId === editing.loanId : d.id === editing.id);
      const debt = {...old, id: field(old ?? {}, "id") || (editing.source === "Manual debt" ? field(editing, "id") : "") || crypto.randomUUID(),
        name: value(data, "name"), balance: principal, apr, minPay: minimum, ...(editing.loanId ? {loanId: editing.loanId} : {})};
      return {...s, debts: old ? rows(s.debts).map(d => d.id === old.id ? debt : d) : [...rows(s.debts), debt],
        settings: editing.loanId ? {...s.settings, dailyV6: {...settingsV6(s), loanPrincipal: {...row(settingsV6(s).loanPrincipal), [String(editing.loanId)]: principal},
          loanPrincipalDates: {...row(settingsV6(s).loanPrincipalDates), [String(editing.loanId)]: asOf}}} : s.settings};
    })}><Input name="name" label="Debt name" initial={field(editing, "name")} maxLength={120} />
      <Input name="balance" label="Current outstanding principal ₹" initial={editing.known ? Number(editing.balance) / 100 : ""} />
      <Input name="apr" label="Annual rate %" type="number" min={0} max={100} step="0.01" initial={Number(editing.apr) || 0} />
      <Input name="minimum" label="Minimum monthly payment ₹" initial={Number(editing.minPay) || 0} />
      <p className="editor-note">Principal is a balance from your lender, separate from remaining installments that may include interest. Refresh this balance after payments.</p>
    </Editor>}
  </div>;
}

export function InsightsView({ledger, month, asOf}: FeatureProps) {
  const metrics = cashMetrics(ledger, month, asOf), position = netPosition(ledger, asOf), repeat = repeatingPayments(ledger, asOf);
  const tags = new Map<string, {amount: number; count: number}>(), merchants = new Map<string, number>();
  for (const entry of metrics.posted) {
    const signed = entry.type === "income" || entry.type === "refund" ? -entry.signed : entry.type === "expense" ? entry.signed : 0;
    for (const tag of new Set((entry.note ?? "").match(/#[\p{L}\p{N}_-]+/gu) ?? [])) {
      if (/^#split-/i.test(tag)) continue;
      const item = tags.get(tag.toLowerCase()) ?? {amount: 0, count: 0};
      item.amount += signed;item.count++;tags.set(tag.toLowerCase(), item);
    }
    if (entry.type === "expense" || entry.type === "refund") {
      const merchant = (entry.note ?? "").split(/[·|#]/)[0].trim() || entry.category || "Other";
      merchants.set(merchant, (merchants.get(merchant) ?? 0) + (entry.type === "refund" ? -entry.signed : entry.signed));
    }
  }
  return <div className="stack"><Stats items={[["Net position", position.net, position.unknown ? position.unknown + " loan principal balance(s) missing" : "Known assets less debt"],
    ["Savings rate", metrics.income ? (metrics.savings / metrics.income * 100).toFixed(1) + "%" : "No income"], ["Repeating payments / month", sum(repeat.map(r => r.monthly))], ["Annual recurring estimate", sum(repeat.map(r => r.monthly)) * 12]]} />
    <div className="plan-grid"><Panel title="What you own and owe"><dl className="compact-details"><dt>Bank & cash</dt><dd>{money(position.cash)}</dd><dt>Card credit balances</dt><dd>{money(position.cardCredits)}</dd><dt>Additional assets</dt><dd>{money(position.other)}</dd><dt>Known debts</dt><dd>{money(position.debt)}</dd>
      <dt>Goal allocations</dt><dd>{money(sum(rows(ledger.goals).filter(g => g.active !== false).map(g => minor(g.saved))))}</dd></dl></Panel>
      <Panel title="Spend by category"><Table headers={["Category", "Actual", "Budget"]}>{ledger.categories.expense.map(category => ({category, actual: categoryActual(ledger, month, "expense", category, asOf)})).filter(item => item.actual !== 0)
        .sort((a, b) => b.actual - a.actual).map(item => <tr key={item.category}><td>{item.category}</td><td>{money(item.actual)}</td><td>{money(minor(Number(row(row(ledger.budgets[month]).expense)[item.category]) || 0, 20_000_000_000))}</td></tr>)}</Table></Panel></div>
    <Panel title="Repeating payments" subtitle="All configured recurring bills and policies, with unlinked repeating descriptions shown separately">
      <Table headers={["Payment", "Account", "Frequency", "Monthly equivalent", "Source"]}>{repeat.map(item =>
        <tr key={item.id}><td>{item.name}</td><td>{accountName(ledger, item.accountId)}</td><td>{item.frequency}</td><td>{money(item.monthly)}</td><td>{item.configured ? "Recurring plan" : "Detected pattern"}</td></tr>)}</Table>
    </Panel>
    <div className="plan-grid"><Panel title="Groups & event tags"><Table headers={["Tag", "Entries", "Net spend"]}>{[...tags].map(([tag, item]) =>
      <tr key={tag}><td>{tag}</td><td>{item.count}</td><td>{money(item.amount)}</td></tr>)}</Table><p className="muted">Add #travel, #house or #event-name to group spending across categories. Entries with multiple tags appear in each group.</p></Panel>
      <Panel title="Merchant spending"><Table headers={["Merchant", "Net spend"]}>{[...merchants].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, amount]) =>
        <tr key={name}><td>{name}</td><td>{money(amount)}</td></tr>)}</Table></Panel></div>
    <Panel title="12-period account history"><Table headers={["Period", "Income", "Spending", "Savings", "Bank & cash less card dues"]}>
      {Array.from({length: 12}, (_, i) => monthShift(month, i - 11)).map(label => {
        const metrics = cashMetrics(ledger, label, asOf), end = metrics.end < asOf ? metrics.end : asOf;
        const cash = sum(ledger.accounts.filter(a => a.type !== "credit").map(a => balance(ledger, a, end)));
        const cards = sum(ledger.accounts.filter(a => a.type === "credit").map(a => balance(ledger, a, end)));
        return <tr key={label}><td>{monthLabel(label)}</td><td>{money(metrics.income)}</td><td>{money(metrics.spending)}</td><td>{money(metrics.savings)}</td><td>{money(cash - cards)}</td></tr>;
      })}</Table><p className="muted">Historical account positions exclude manual assets and loan principal snapshots without dated history.</p></Panel>
  </div>;
}

const mappingLabels: Record<keyof StatementColumns, string> = {
  date: "Date", note: "Description", amount: "Amount", debit: "Debit", credit: "Credit", direction: "Debit / credit indicator"
};
const transactionLabels: Record<Entry["type"], string> = {expense:"Expense", income:"Income", refund:"Refund", transfer:"Account transfer", cardPayment:"Card repayment"};

export function ReconcileView(props: FeatureProps & {scope: string; vaultKey: CryptoKey; initialAccount?: string}) {
  const {ledger, asOf, save, busy, scope, vaultKey} = props;
  const [accountId, setAccountId] = useState(ledger.accounts.find(a => a.id === props.initialAccount)?.id ??
    (ledger.accounts.length === 1 ? ledger.accounts[0].id : "")), [staged, setStaged] = useState<Staged[]>([]);
  const [file, setFile] = useState<{name:string; bytes:ArrayBuffer; pages:string[]; text:string; labels:string[]} | null>(null);
  const [columns, setColumns] = useState<StatementColumns | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [password, setPassword] = useState<{name: string; wrong: boolean; resolve: (value: string) => void; cancel: () => void} | null>(null);
  const passwordRef = useRef<typeof password>(null);
  const request = useRef(0);
  const [working,setWorking] = useState(false);
  const saving = useRef(false);
  const [dateOrder, setDateOrder] = useState<"day-first" | "month-first">("day-first");
  const [amountPolarity, setAmountPolarity] = useState<"" | "credit" | "debit">("");
  const [issues, setIssues] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const cfg = settingsV6(ledger), reconciled = row(cfg.reconciled), account = ledger.accounts.find(a => a.id === accountId);
  const selected = staged.filter(line => line.selected || line.match).length;
  const matches = staged.flatMap(line => line.match ? [line.match] : []);
  const repeatedMatch = new Set(matches).size !== matches.length;
  const missingCounterpart = staged.some(({selected, match, entry}) => selected && !match &&
    (entry.type === "transfer" || entry.type === "cardPayment") && (!entry.accountId || !entry.toId));
  const needsPolarity = Boolean(columns && columns.amount >= 0 && columns.direction < 0 && columns.credit < 0 && columns.debit < 0);
  const debitPositive = amountPolarity === "debit";
  useEffect(() => () => {request.current++;passwordRef.current?.cancel();}, []);
  function buildPreview(text: string, mapping: StatementColumns, order: typeof dateOrder, target = accountId) {
    setError("");setNotice("");setPage(0);setStaged([]);setIssues([]);
    try {
      const result = reviewStatement(text, ledger, target, asOf, order, {columns:mapping, debitPositive});
      setStaged(result.entries);setIssues(result.issues);
    } catch (problem) {setError(problem instanceof Error ? problem.message : "Could not map the statement.");}
  }
  async function upload(picked: File) {
    const id = ++request.current;
    setError("");setNotice("");setFile(null);setColumns(null);setStaged([]);setIssues([]);setAmountPolarity("");setWorking(true);
    try {
      const pdf = /\.pdf$/i.test(picked.name);
      if ((!pdf && !/\.(?:csv|tsv)$/i.test(picked.name)) || picked.size > (pdf ? 12_000_000 : 3_000_000))
        throw Error("Choose a CSV or TSV up to 3 MB, or a PDF up to 12 MB.");
      const bytes = await picked.arrayBuffer();
      const pages = pdf ? await readPdf(bytes.slice(0), wrong => new Promise((resolve, reject) => {
        if (request.current !== id) {reject(Error("Upload canceled."));return;}
        const prompt = {name:picked.name, wrong, resolve, cancel: () => reject(Error("Upload canceled."))};
        passwordRef.current = prompt;setPassword(prompt);
      })) : [decodeStatementFile(bytes)];
      if (request.current !== id) return;
      const text = pdf ? statementCsvFromText(pages) : pages[0];
      if (!text) throw Error(pages.some(Boolean) ? "This PDF layout could not be mapped confidently. Try the issuer’s CSV export." :
        "This PDF has no selectable text. Try the issuer’s CSV export or a text-based PDF.");
      const {labels, columns, table} = statementColumns(text);
      if (!labels.length) throw Error("The statement is empty.");
      setFile({name:picked.name,bytes,pages,text,labels});setColumns(columns);
      const order = inferStatementDateOrder(table, columns.date) ?? "day-first";
      setDateOrder(order);
      if (account && columns.date >= 0 && (columns.debit >= 0 || columns.credit >= 0 || columns.amount >= 0 && columns.direction >= 0))
        buildPreview(text, columns, order);
    } catch (problem) {
      if (request.current === id) setError(problem instanceof Error ? problem.message : "Could not read the statement.");
    } finally {
      if (request.current === id) {setWorking(false);setPassword(null);passwordRef.current = null;}
    }
  }
  function preview() {
    if (!file || !columns || needsPolarity && !amountPolarity) return;
    buildPreview(file.text, columns, dateOrder);
  }
  return <div className="stack"><Panel title="Import bank or credit card transactions" subtitle="Upload a statement to find transactions. Review them before anything is added to your ledger.">
    {!ledger.accounts.length && <p>Add a bank account or credit card in Accounts before importing a statement.</p>}
    <fieldset className="statement-setup" disabled={busy || working || !ledger.accounts.length}>
      <label>Statement account<select name="statementAccount" value={accountId} onChange={e => {
        const target = e.target.value;
        setAccountId(target);setStaged([]);setIssues([]);setError("");setNotice("");
        if (target && file && columns && columns.date >= 0 &&
            (columns.debit >= 0 || columns.credit >= 0 || columns.amount >= 0 && (columns.direction >= 0 || amountPolarity)))
          buildPreview(file.text, columns, dateOrder, target);
      }}>
        <option value="">Choose an account</option>{ledger.accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <FileIntake label="Upload statement" name="statementFile" accept=".csv,.tsv,.pdf" format="Drop a CSV, TSV or text PDF"
        disabled={busy || working || !ledger.accounts.length} onFiles={files => void upload(files[0])} onError={setError} />
    </fieldset>
    {working && <p role="status">Processing statement…</p>}
    {file && columns && <fieldset className="statement-mapping" disabled={busy || working}>
      <legend>{file.name}</legend>
      <p className="muted">{staged.length ? "Columns detected. Check the rows below or adjust the mapping." :
        account ? "Confirm the column mapping and date format to preview transactions." : "Choose the bank account or card for this statement."}</p>
      <div className="statement-setup">{Object.entries(mappingLabels).map(([key,label]) => {
        const field = key as keyof StatementColumns;
        return <label key={key}>{label}<select name={key} value={columns[field]} onChange={e => {
          setColumns({...columns,[field]:Number(e.target.value)});setStaged([]);setIssues([]);
        }}><option value={-1}>No column</option>{file.labels.map((heading,index) => <option key={index} value={index}>{heading || "Column " + (index + 1)}</option>)}</select></label>;
      })}
      <label>Numeric date format<select value={dateOrder} onChange={event => {setDateOrder(event.target.value as "day-first" | "month-first");setStaged([]);setIssues([]);}}><option value="day-first">Day / month / year</option><option value="month-first">Month / day / year</option></select></label>
      {needsPolarity && <label>Positive amounts mean<select value={amountPolarity} onChange={e => {setAmountPolarity(e.target.value as typeof amountPolarity);setStaged([]);setIssues([]);}}><option value="">Choose the statement’s sign convention</option><option value="credit">Money in / card credit</option><option value="debit">Money out / card charge</option></select></label>}
      </div><button type="button" className="primary" disabled={!account || needsPolarity && !amountPolarity} onClick={preview}>Preview transactions</button>
    </fieldset>}
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {issues.length > 0 && <details className="statement-row-issues">
      <summary>{issues.length} {issues.length === 1 ? "row was" : "rows were"} skipped during parsing</summary>
      <p>Correct these rows in the source file or add them manually. They won’t be imported.</p>
      <ul>{issues.slice(0, 20).map(issue => <li key={issue}>{issue}</li>)}</ul>
      {issues.length > 20 && <p>{issues.length - 20} more rows also need attention.</p>}
    </details>}
    {staged.length > 0 && <><div className="statement-review"><strong>{staged.length} rows · {selected} ready to import or match</strong>
      <p className="muted">Review transfers, card repayments and similar transactions before including them.</p></div>
      <Table headers={["Include", "Date / description", "Type / category", "Amount", "Match recorded entry"]}>{staged.slice(page * 40, page * 40 + 40).map((item, index) => {
      const i = page * 40 + index;
      return <tr key={item.entry.id}><td><input type="checkbox" aria-label={"Include row " + (i + 1)} checked={item.selected || Boolean(item.match)} disabled={Boolean(item.match) || busy || working} onChange={e => setStaged(old => old.map((r, j) => i === j ? {...r, selected: e.target.checked} : r))} /></td>
        <td>{item.entry.date}<small>{item.entry.note}</small></td><td><select aria-label={"Row " + (i + 1) + " type"} value={item.entry.type} disabled={Boolean(item.match)}
          onChange={e => setStaged(old => old.map((r, j) => {
            if (i !== j) return r;
            const type = e.target.value as Entry["type"], incoming = r.signed > 0;
            const linked = type === "transfer" || type === "cardPayment";
            const source = incoming && linked ? "" : accountId;
            const toId = incoming && linked ? accountId : "";
            const category = type === "cardPayment" || type === "transfer" ? "" : type === "income" ? ledger.categories.income[0] : ledger.categories.expense[0];
            return {...r, entry: {...r.entry, type, accountId: source, toId, category}};
          }))}>{(account?.type === "credit" ? item.signed > 0 ? ["refund", "cardPayment"] as const : ["expense"] as const
            : item.signed > 0 ? ["income", "refund", "transfer"] as const : ["expense", "transfer", "cardPayment"] as const)
            .map(t => <option key={t} value={t}>{transactionLabels[t]}</option>)}</select>
          {(item.entry.type === "transfer" || item.entry.type === "cardPayment") ? <>
            <label>From<select value={item.entry.accountId} disabled={Boolean(item.match) || item.signed < 0} onChange={e => setStaged(old => old.map((r, j) => i === j ? {...r, entry: {...r.entry, accountId: e.target.value}} : r))}>
              <option value="">Choose funding account</option>{ledger.accounts.filter(a => a.type !== "credit" && a.id !== item.entry.toId).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
            <label>To<select value={item.entry.toId} disabled={Boolean(item.match) || item.signed > 0} onChange={e => setStaged(old => old.map((r, j) => i === j ? {...r, entry: {...r.entry, toId: e.target.value}} : r))}>
              <option value="">Choose receiving account</option>{ledger.accounts.filter(a => a.id !== item.entry.accountId && (item.entry.type === "cardPayment" ? a.type === "credit" : a.type !== "credit")).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          </> : <select aria-label={"Row " + (i + 1) + " category"} value={item.entry.category} disabled={Boolean(item.match)}
          onChange={e => setStaged(old => old.map((r, j) => i === j ? {...r, entry: {...r.entry, category: e.target.value}} : r))}>
          {(item.entry.type === "income" ? ledger.categories.income : ledger.categories.expense).map(c => <option key={c}>{c}</option>)}</select>}</td><td>{money(minor(item.entry.amount))}</td>
        <td><select aria-label={"Row " + (i + 1) + " match"} value={item.match} onChange={e => setStaged(old => old.map((r, j) => i === j ? {...r, match: e.target.value, selected: false} : r))}>
          <option value="">Create new entry if included</option>{statementMatches(ledger, item).map(t =>
            <option value={t.id} key={t.id}>{t.note || t.type} · {transactionLabels[t.type]} · {t.date}</option>)}</select>{item.possible && !item.match && <small>Review before including this row.</small>}</td></tr>;
      })}</Table>
      {staged.length > 40 && <div className="button-row"><button disabled={!page} onClick={() => setPage(page - 1)}>Previous rows</button>
        <span>Page {page + 1} of {Math.ceil(staged.length / 40)}</span><button disabled={(page + 1) * 40 >= staged.length} onClick={() => setPage(page + 1)}>Next rows</button></div>}
      {missingCounterpart && <p role="status">Choose the other account for each transfer or card repayment you include.</p>}
      {repeatedMatch && <p role="status">Two rows match the same recorded entry. Change one of the matches before importing.</p>}
      <button className="primary" disabled={busy || working || !file || !selected || missingCounterpart || repeatedMatch} onClick={async () => {
        if (!file || !columns || saving.current) return;
        saving.current = true;
        setWorking(true);setError("");
        try {
          const id = await documentDigest(file.bytes);
          const originals = await deviceRecord<{id:string; accountId?:string; outcomes?:Record<string,string>}[]>(scope,"document-index",vaultKey) ?? [];
          const previous = originals.find(item => item.id === id);
          if (previous?.accountId && previous.accountId !== accountId)
            throw Error("This statement is already assigned to " + accountName(ledger, previous.accountId) + ".");
          await deviceRecord(scope,"original-" + id,vaultKey,base64(new Uint8Array(file.bytes)));
          const batch = {id,name:file.name,kind:"Statement" as const,pages:file.pages,date:asOf,accountId,staged,statementMapping:{columns,dateOrder,debitPositive}};
          if (!previous) await saveDocumentIndex(scope,vaultKey,batch);
          if (await save(s => importStatement(s,staged.map(line => ({...line,entry:{...line.entry,importDocumentId:id,importRowKey:rowKey(line)}})),file.name,"",asOf,false),true)) {
            setStaged([]);setFile(null);setColumns(null);setIssues([]);
            setNotice(selected + (selected === 1 ? " row" : " rows") + " imported or matched. The encrypted original is in Documents.");
            const outcomes = Object.fromEntries(staged.filter(line => line.selected || line.match).map(line => [rowKey(line),line.match || line.entry.id]));
            await saveDocumentIndex(scope,vaultKey,{...batch,staged:staged.filter(line => !outcomes[rowKey(line)]),outcomes:{...previous?.outcomes,...outcomes}});
          }
        } catch (problem) {setError(problem instanceof Error ? problem.message : "Could not save the local statement.");}
        finally {saving.current = false;setWorking(false);}
      }}>Import reviewed statement</button></>}
    </Panel>
    {password && <PdfUnlock key={String(password.wrong)} filename={password.name} wrong={password.wrong}
      onUnlock={value => {passwordRef.current = null;setPassword(null);password.resolve(value);}}
      onSkip={() => {passwordRef.current = null;setPassword(null);password.cancel();}} />}
    {account && <Panel title="Confirm current balance"><p className="muted">{account.name + " · recorded " + money(balance(ledger, account, asOf))}</p>
      <form className="filter-row" key={accountId} onSubmit={e => {e.preventDefault();const data = new FormData(e.currentTarget);void save(s => reconcileBalance(s, accountId, amount(data, "balance"), value(data, "date"), asOf));}}>
        <Input name="balance" label="Bank / card confirmed balance ₹" /><Input name="date" label="Balance date" type="date" initial={asOf} max={asOf} /><button disabled={busy}>Confirm balance</button></form>
    </Panel>}
    <Panel title="Legacy statement archive"><Table headers={["File", "Account", "Imported", ""]}>{rows(ledger.settings.statementArchives).map(item =>
      <tr key={field(item, "id")}><td>{field(item, "name")}</td><td>{accountName(ledger, item.accountId)}</td><td>{field(item, "importedAt")}</td><td><button onClick={() => download(field(item, "name"), new Blob([field(item, "text")], {type: "text/csv"}))}>Download original</button></td></tr>)}</Table>
      <p className="muted">{Object.keys(reconciled).length} entries reconciled. New originals are stored in Documents. Previously archived CSVs are included in ledger backups.</p>
    </Panel>
  </div>;
}

export function RewardsView(props: FeatureProps) {
  const {ledger, asOf, save} = props;
  const [editing, setEditing] = useState(false), [post, setPost] = useState<Row | null>(null);
  const rewards = rows(settingsV6(ledger).cashback);
  return <div className="stack"><Stats items={[["Pending cashback", sum(rewards.filter(r => !r.postedId).map(r => minor(r.amount)))],
    ["Credited cashback", sum(rewards.filter(r => r.postedId && !hasReversal(ledger, field(r, "postedId"), asOf)).map(r => minor(r.amount)))]]} />
    <Panel title="Cashback tracker" action={<button className="primary" onClick={() => setEditing(true)}>+ Track cashback</button>}>
      <Table headers={["Purchase", "Expected reward", "Status", ""]}>{rewards.map(reward => <tr key={field(reward, "id")}><td>{ledger.transactions.find(t => t.id === reward.txId)?.note || "Purchase"}</td>
        <td>{money(minor(reward.amount))}</td><td>{reward.postedId ? hasReversal(ledger, field(reward, "postedId"), asOf) ? "Credit reversed" : "Credited" : "Pending"}</td>
        <td>{!reward.postedId && <button onClick={() => setPost(reward)}>Record credit</button>}</td></tr>)}</Table>
    </Panel>
    {editing && <Editor title="Track cashback" {...props} close={() => setEditing(false)} onSave={data => save(s => {
      const entry = s.transactions.find(t => t.id === value(data, "transaction")), reward = amount(data, "amount");
      if (!entry || entry.type !== "expense" || reward <= 0 || reward > entry.amount) throw new Error("Choose an expense and a positive reward no larger than the purchase.");
      return {...s, settings: {...s.settings, dailyV6: {...settingsV6(s), cashback: [...rows(settingsV6(s).cashback),
        {id: crypto.randomUUID(), txId: entry.id, amount: reward, postedId: "", note: value(data, "note")}]}}};
    })}><Select name="transaction" label="Original purchase" options={ledger.transactions.filter(t => t.type === "expense").toSorted((a, b) => b.date.localeCompare(a.date)).slice(0, 500).map(t => ({id: t.id, name: t.date + " · " + (t.note || t.category)}))} />
      <Input name="amount" label="Expected reward ₹" /><Input name="note" label="Notes" required={false} maxLength={200} /></Editor>}
    {post && <Editor title="Record cashback credit" {...props} close={() => setPost(null)} onSave={data => save(s => {
      const reward = rows(settingsV6(s).cashback).find(r => r.id === post.id), original = s.transactions.find(t => t.id === reward?.txId);
      if (!reward || reward.postedId || !original) throw new Error("This reward is already recorded or its purchase is missing.");
      const entry: Entry = {id: crypto.randomUUID(), type: "refund", date: value(data, "date"), amount: Number(reward.amount),
        accountId: original.accountId, category: original.category, note: "Cashback · " + original.note};
      const next = addEntry(s, entry, asOf);
      return {...next, settings: {...next.settings, dailyV6: {...settingsV6(next), cashback: rows(settingsV6(next).cashback).map(r => r.id === reward.id ? {...r, postedId: entry.id} : r)}}};
    })}><p className="editor-note">{money(minor(post.amount))} will be credited to the original payment account.</p>
      <Input name="date" label="Credited on" type="date" initial={asOf} max={asOf} /></Editor>}
  </div>;
}

export function ReceiptsView({ledger, save, busy}: FeatureProps) {
  const [transaction, setTransaction] = useState(ledger.transactions[0]?.id ?? ""), [error, setError] = useState("");
  return <div className="stack"><Panel title="Receipts & attachments" subtitle="Files are encrypted with your ledger and included in its backups"
    action={<button onClick={() => download("Finance_Atlas_Full_Archive.zip", receiptArchive(ledger))}>Export unencrypted receipts ZIP</button>}>
    <div className="filter-row"><label>Transaction<select value={transaction} onChange={e => setTransaction(e.target.value)}><option value="">Choose an entry</option>
      {ledger.transactions.toSorted((a, b) => b.date.localeCompare(a.date)).slice(0, 1000).map(t => <option key={t.id} value={t.id}>{t.date} · {t.note || t.type}</option>)}</select></label>
      <label>Attach image / PDF<input type="file" accept="image/png,image/jpeg,image/webp,application/pdf" disabled={busy || !transaction}
        onChange={async e => {const file = e.target.files?.[0];e.target.value = "";if (!file) return;setError("");
          try {const next = await attachReceipt(ledger, transaction, file), receipt = rows(next.receipts).at(-1)!;await save(s => {
            if (!s.transactions.some(t => t.id === transaction)) throw new Error("The transaction is no longer available.");
            return {...s, receipts: [...rows(s.receipts), receipt]};
          });} catch (problem) {setError(problem instanceof Error ? problem.message : "Could not attach file.");}
        }} /></label></div>{error && <p className="error">{error}</p>}
    <Table headers={["File", "Transaction", "Size", ""]}>{rows(ledger.receipts).map(receipt => <tr key={field(receipt, "id")}><td>{field(receipt, "name")}</td>
      <td>{ledger.transactions.find(t => t.id === receipt.txId)?.note || "Imported attachment"}</td><td>{Math.round(Number(receipt.size) / 1024)} KB</td>
      <td><div className="button-row"><button onClick={() => download(field(receipt, "name"), new Blob([unbase64(field(receipt, "data"))], {type: field(receipt, "type")}))}>Download file</button>
        <button disabled={busy} onClick={() => save(s => ({...s, receipts: rows(s.receipts).filter(r => r.id !== receipt.id)}), true)}>Remove attachment</button></div></td></tr>)}</Table>
    </Panel></div>;
}

export function SettingsExtras(props: FeatureProps & {section: string; envelope: Envelope; vaultKey: CryptoKey; backups: BackupControls; previewRestore: (ledger: Ledger) => void}) {
  const {ledger, asOf, month, save, busy, backups, envelope, vaultKey, previewRestore, section} = props;
  const cfg = settingsV6(ledger);
  const ui = row(ledger.settings.uiCustomization), savedOrder = Array.isArray(ui.tabOrder) ? ui.tabOrder as string[] : [];
  const order = [...savedOrder.filter(id => Object.values(viewIds).includes(id)), ...Object.values(viewIds).filter(id => !savedOrder.includes(id))];
  const [category, setCategory] = useState(false), [template, setTemplate] = useState(false), [encrypted, setEncrypted] = useState(""), [recovery, setRecovery] = useState<{day: string; envelope: Envelope}[] | null>(null);
  const [notificationMessage, setNotificationMessage] = useState("");
  const [exportMessage, setExportMessage] = useState("");
  const [deviceBackup, setDeviceBackup] = useState<File | null>(null);
  const [pastDevice, setPastDevice] = useState<Envelope | null>(null);
  const [deviceMessage, setDeviceMessage] = useState("");
  const [deviceBusy, setDeviceBusy] = useState(false);
  const deviceOperation = useRef<AbortController | null>(null);
  useEffect(() => () => {deviceOperation.current?.abort();}, [section, vaultKey]);

  async function useDeviceBackup(action: (signal: AbortSignal) => Promise<string>) {
    if (deviceOperation.current) return false;
    const operation = new AbortController();
    deviceOperation.current = operation;
    setDeviceMessage("");setDeviceBusy(true);
    try {
      const message = await action(operation.signal);
      operation.signal.throwIfAborted();
      setDeviceMessage(message);
      return true;
    } catch (error) {
      if (!operation.signal.aborted) setDeviceMessage(error instanceof Error ? error.message : "The device backup could not be processed.");
      return false;
    } finally {deviceOperation.current = null;setDeviceBusy(false);}
  }

  async function downloadDevice(source: Envelope, key: CryptoKey, signal: AbortSignal) {
    const archive = await exportDeviceRecords(source.salt, key);
    signal.throwIfAborted();
    download("Finance_Atlas_Device_" + asOf + ".atlasdevice", archive);
    return "Encrypted device backup prepared.";
  }
  return <>
    {section === "Data, backup & security" && <><Panel title="Workspace lock">
      <form className="filter-row" onSubmit={event => {
        event.preventDefault();
        const minutes = Number(new FormData(event.currentTarget).get("idleMinutes"));
        void save(s => ({...s, settings:{...s.settings,dailyV6:{...settingsV6(s),idleLockMinutes:minutes}}}));
      }}>
        <Select name="idleMinutes" label="Lock after inactivity" initial={String(cfg.idleLockMinutes || 0)}
          options={[{id:"0",name:"Off"},{id:"5",name:"5 minutes"},{id:"15",name:"15 minutes"},{id:"30",name:"30 minutes"},{id:"60",name:"60 minutes"}]} />
        <button disabled={busy}>Save vault preferences</button>
      </form>
      <p className="muted">Unlock with your vault passphrase after inactivity. Unsaved form edits are discarded when the vault locks.</p>
    </Panel><Panel title="Encrypted ledger backups">
      <div className="backup-summary"><strong>Automatic recovery on this device</strong><span role="status">{backups.localStatus}</span></div>
      <p className="muted">Finance Atlas keeps an encrypted recovery copy when you unlock the workspace or save changes. Clearing app storage also clears these copies.</p>
      <p role="status">{backups.message}</p>{backups.folder && <p className="muted">Selected folder · {backups.folder}</p>}
      <p className="muted">Ledger backups include transactions and their receipts. Documents and Assistant history have a separate encrypted backup below.</p>
      {backups.lastAt && <small>Last verified {new Date(backups.lastAt).toLocaleString("en-IN")}</small>}
      <div className="button-row section-gap"><button onClick={() => void backups.choose()}>Choose backup folder</button>
        <button disabled={!backups.folder} onClick={() => void backups.toggle()}>{backups.enabled ? "Pause" : "Enable"} daily backups</button>
        <button disabled={!backups.enabled} onClick={() => void backups.run()}>Back up now</button>
        <button onClick={() => download("Finance_Atlas_" + asOf + ".atlasenc", serializeEnvelope(envelope))}>Download encrypted backup</button></div>
    </Panel>
    <Panel title="Encrypted device library backup">
      <p>Back up document originals, extracted records, and Assistant history separately. Unlock the backup with the vault passphrase used when it was saved.</p>
      <div className="button-row">
        <button type="button" disabled={busy || deviceBusy} onClick={() => void useDeviceBackup(signal => downloadDevice(envelope, vaultKey, signal))}>Download device backup</button>
        <label>Restore into an empty device library<input type="file" name="deviceBackup" accept=".atlasdevice,application/json" disabled={busy || deviceBusy}
          onChange={event => {
            const file = event.currentTarget.files?.[0];event.currentTarget.value = "";
            if (file && file.size <= deviceBackupLimit) {setDeviceMessage("");setDeviceBackup(file);}
            else if (file) setDeviceMessage("Choose a device backup no larger than 42 MB.");
          }} /></label>
      </div>
      {deviceMessage && <p role="status">{deviceMessage}</p>}
    </Panel>
    <Panel title="Encrypted restore & recovery">
      <label>Restore encrypted backup<input type="file" accept=".atlasenc,application/json" onChange={async e => {const file = e.target.files?.[0];e.target.value = "";if (file && file.size <= 42_000_000) setEncrypted(await file.text());}} /></label>
      <button className="section-gap" onClick={async () => setRecovery(await snapshots())}>Browse local recovery snapshots</button>
      <p className="muted">Restores are previewed before replacing the workspace. Browser recovery copies can be erased when site data is cleared.</p>
    </Panel></>}
    {section === "Appearance & navigation" && <Panel title="Display preferences">
      <div className="appearance-controls"><strong>Workspace theme</strong>
        <div className="segmented" aria-label="Workspace theme">{["light", "dark"].map(theme => <button key={theme} aria-label={"Use " + theme + " theme"} disabled={busy} aria-pressed={(field(row(ledger.settings.appearance), "theme") || "light") === theme} onClick={() => save(s => ({...s, settings: {...s.settings, appearance: {...row(s.settings.appearance), theme}}}))}>{theme === "light" ? "Light" : "Dark"}</button>)}</div></div>
      <Switch.Root unstyled className="atlas-setting-switch" checked={row(ledger.settings.appearance).reduceMotion === true} disabled={busy}
        onCheckedChange={({checked}) => void save(s => ({...s, settings: {...s.settings, appearance: {...row(s.settings.appearance), reduceMotion: checked}}}))}>
        <Switch.HiddenInput aria-describedby="motion-description" />
        <div><Switch.Label>Reduce animations</Switch.Label><small className="muted" id="motion-description">Limits interface motion in Finance Atlas. Your device’s reduced-motion preference always applies.</small></div>
        <Switch.Control><Switch.Thumb /></Switch.Control>
      </Switch.Root>
    </Panel>}
    {section === "Finance & automation" && <><Panel title="Reporting and reminders"><form key={JSON.stringify([ledger.settings.reportingPeriod, cfg])} onSubmit={event => {event.preventDefault();const data = new FormData(event.currentTarget);void save(s => ({
        ...s, settings: {...s.settings, reportingPeriod: {mode: value(data, "mode"), day: Number(value(data, "day"))},
          dailyV6: {...settingsV6(s), reservedCash: amount(data, "reserved"), otherAssets: amount(data, "assets"), rollover: data.has("rollover"), rolloverMonths: Number(value(data, "rolloverMonths")),
            reminders: data.has("reminders")}}}));}}>
        <fieldset disabled={busy}><div className="filter-row"><Select name="mode" label="Reporting calendar" initial={field(row(ledger.settings.reportingPeriod), "mode") || "calendar"}
          options={[{id: "calendar", name: "Calendar month"}, {id: "salary", name: "Salary cycle"}]} />
          <Input name="day" label="Salary / period start day" type="number" min={1} max={31} initial={Number(row(ledger.settings.reportingPeriod).day) || Number(row(ledger.settings.salary).day) || 1} />
          <Input name="reserved" label="Cash buffer ₹" initial={Number(cfg.reservedCash) || 0} />
          <Input name="assets" label="Additional owned assets ₹" initial={Number(cfg.otherAssets) || 0} />
          <Input name="rolloverMonths" label="Rollover lookback months" type="number" min={1} max={60} initial={Number(cfg.rolloverMonths) || 12} /></div>
          <Check name="rollover" label="Carry unused budget between periods" initial={cfg.rollover === true} />
          <Check name="reminders" label="Show due reminders in the workspace" initial={cfg.reminders !== false} />
          <button className="primary">Save preferences</button></fieldset></form>
      <div className="button-row section-gap"><button disabled={busy} onClick={async () => {
        try {
          if (typeof Notification === "undefined") throw new Error("This browser supports in-app reminders. System notifications are unavailable here.");
          const permission = await Notification.requestPermission();
          if (permission !== "granted") {setNotificationMessage("Permission was not granted. In-app reminders remain available.");return;}
          await save(s => ({...s, settings: {...s.settings, dailyV6: {...settingsV6(s), notifications: true}}}));
          setNotificationMessage("System reminders are enabled while the workspace is open and unlocked.");
        } catch (error) {setNotificationMessage(error instanceof Error ? error.message : "Notifications could not be enabled.");}
      }}>Enable system reminders</button>
        <button disabled={busy || !cfg.notifications} onClick={() => save(s => ({...s, settings: {...s.settings, dailyV6: {...settingsV6(s), notifications: false}}}))}>Pause system reminders</button></div>
      {notificationMessage && <p className="muted">{notificationMessage}</p>}
    </Panel>
    <Panel title="Categories & quick entry" action={<div className="button-row"><button onClick={() => setCategory(true)}>Add / merge category</button><button onClick={() => setTemplate(true)}>Add template</button></div>}>
      <p className="muted">Expense categories · {ledger.categories.expense.join(", ")}</p>
      <Table headers={["Quick entry template", "Category", "Amount", ""]}>{rows(cfg.merchantTemplates).map(item =>
        <tr key={field(item, "id")}><td>{field(item, "name")}</td><td>{field(item, "category")}</td><td>{money(minor(Number(item.amount) || 0))}</td>
          <td><button disabled={busy} onClick={() => save(s => ({...s, settings: {...s.settings, dailyV6: {...settingsV6(s),
            merchantTemplates: rows(settingsV6(s).merchantTemplates).filter(t => t.id !== item.id)}}}))}>Remove template</button></td></tr>)}</Table>
    </Panel></>}
    {section === "Appearance & navigation" && <Panel title="Navigation & dashboard">
      <form key={JSON.stringify(ui)} onSubmit={event => {event.preventDefault();const data = new FormData(event.currentTarget);void save(s => ({...s, settings: {...s.settings, uiCustomization: {
        ...row(s.settings.uiCustomization), navPlacement: value(data, "layout"), sidebarCollapsed: data.has("collapseSidebar") || value(data, "layout") === "compact",
        hiddenTabs: views.filter(view => view !== "Overview" && view !== "Data & settings" && !data.has("view-" + viewIds[view])).map(view => viewIds[view]),
        hiddenWidgets: widgets.filter(widget => !data.has("widget-" + widget.id)).map(widget => widget.id)
      }}}));}}><fieldset disabled={busy}>
        <Select name="layout" label="Navigation position" initial={field(ui, "navPlacement") || "left"} options={layouts} />
        <Check name="collapseSidebar" label="Use a collapsed sidebar" initial={ui.sidebarCollapsed === true || ui.navPlacement === "compact" && ui.sidebarCollapsed !== false} />
        <details className="settings-disclosure"><summary>Visible sections</summary><div className="preference-grid">{views.filter(view => !["Overview","Data & settings","Assistant"].includes(view)).map(view =>
          <Check key={view} name={"view-" + viewIds[view]} label={view} initial={!((ui.hiddenTabs as string[] | undefined) ?? []).includes(viewIds[view])} />)}</div></details>
        <details className="settings-disclosure"><summary>Dashboard cards</summary><div className="preference-grid">{widgets.map(widget =>
          <Check key={widget.id} name={"widget-" + widget.id} label={widget.name} initial={!((ui.hiddenWidgets as string[] | undefined) ?? []).includes(widget.id)} />)}</div></details>
        <button className="primary" type="submit">Save navigation preferences</button>
      </fieldset></form>
      <details className="settings-disclosure"><summary>Rearrange navigation</summary><div className="navigation-order">{navGroups.map(group => {
        const ids = new Set(group.views.map(view => viewIds[view]));
        const groupOrder = order.filter(id => ids.has(id));
        return <section key={group.label}><h3>{group.label}</h3>{groupOrder.map((id,index) => {
          const label = views.find(view => viewIds[view] === id) || id;
          const move = (delta: number) => save(s => {
            const next = [...order], origin = next.indexOf(id), target = next.indexOf(groupOrder[index + delta]);
            if (target < 0) return s;
            [next[origin], next[target]] = [next[target], next[origin]];
            return {...s,settings:{...s.settings,uiCustomization:{...row(s.settings.uiCustomization),tabOrder:next}}};
          });
          return <div className="button-row" key={id}><span>{label}</span>
            <button disabled={busy || index === 0} onClick={() => move(-1)} aria-label={"Move " + label + " up"}>↑</button>
            <button disabled={busy || index + 1 === groupOrder.length} onClick={() => move(1)} aria-label={"Move " + label + " down"}>↓</button></div>;
        })}</section>;
      })}</div></details>
    </Panel>}
    {section === "Data, backup & security" && <Panel title="Monthly report & audit exports">
      <div className="button-row"><button onClick={() => {
        try {download("Finance_Atlas_Audit_" + month + ".xlsx", auditWorkbook(ledger, month, asOf));setExportMessage("The workbook was generated locally.");}
        catch (error) {setExportMessage(error instanceof Error ? error.message : "Could not generate the workbook.");}
      }}>Export audit workbook XLSX</button><button onClick={() => {
        const m = cashMetrics(ledger, month, asOf);
        download("Finance_Atlas_Report_" + month + ".csv", new Blob([csvEncode([["Period", m.start, m.end], ["Income", m.income / 100], ["Spending", m.spending / 100], ["Net savings", m.savings / 100],
          ["Actual cash outflow", m.outflow / 100], ["Expected cash outflow", m.expectedOutflow / 100], ["Category", "Planned", "Actual"],
          ...ledger.categories.expense.map(c => [c, row(row(ledger.budgets[month]).expense)[c] ?? 0, categoryActual(ledger, month, "expense", c, asOf) / 100])])], {type: "text/csv"}));
      }}>Download monthly report</button><button onClick={() => window.print()}>Print this view</button>
        <button onClick={() => download("Finance_Atlas_Transactions.csv", new Blob([csvEncode([["ID", "Date", "Type", "Amount", "Account", "Destination", "Category", "Notes"],
          ...ledger.transactions.map(t => [t.id, t.date, t.type, t.amount, accountName(ledger, t.accountId), accountName(ledger, t.toId), t.category, t.note])])], {type: "text/csv"}))}>Export transactions CSV</button>
        <button onClick={() => download("Finance_Atlas_Audit.csv", new Blob([csvEncode([["When", "Change", "Revision"], ...rows(cfg.auditTrail).map(item => [item.at, item.changes, item.to])])], {type: "text/csv"}))}>Export audit log</button>
        <button disabled={busy} onClick={() => save(s => matchRecordedBills(s, asOf))}>Match recorded bills</button></div>
      {exportMessage && <p className="muted">{exportMessage}</p>}
      <Table headers={["When", "Change"]}>{rows(cfg.auditTrail).slice(-15).reverse().map((item, i) => <tr key={field(item, "id") || i}><td>{field(item, "at")}</td><td>{field(item, "changes")}</td></tr>)}</Table>
    </Panel>}
    {category && <Editor title="Add or merge category" {...props} close={() => setCategory(false)} onSave={data => save(s => {
      const kind = value(data, "kind") as "expense" | "income", name = value(data, "name"), old = value(data, "old");
      if (!name || name.length > 80 || ["__proto__", "constructor", "prototype"].includes(name.toLowerCase())) throw new Error("Enter a valid category name.");
      if (old === name) return s;
      if (old === "Money Given" && s.loans.some(l => l.category === old)) throw new Error("Money Given identifies lending plans. Keep that category while those plans exist.");
      const next = structuredClone(s);
      next.categories[kind] = [...new Set([...next.categories[kind].filter(c => c !== old), name])];
      if (!old) return next;
      for (const t of next.transactions) if (t.category === old && (kind === "income" ? t.type === "income" : t.type === "expense" || t.type === "refund")) t.category = name;
      if (kind === "expense") for (const collection of [next.loans, rows(next.settings.servicePlans), rows(next.settings.billRules), rows(settingsV6(next).merchantTemplates)])
        for (const item of collection) if (item.category === old) item.category = name;
      for (const budget of Object.values(next.budgets)) {
        const categories = row(row(budget)[kind]);
        if (Object.hasOwn(categories, old)) {categories[name] = (minor(Number(categories[name]) || 0) + minor(categories[old])) / 100;delete categories[old];}
      }
      return next;
    })}><Select name="kind" label="Category group" initial="expense" options={[{id: "expense", name: "Expense"}, {id: "income", name: "Income"}]} />
      <Input name="name" label="Category name / merge destination" maxLength={80} /><Select name="old" label="Rename / merge an existing category" required={false}
        options={[...new Set([...ledger.categories.expense, ...ledger.categories.income])].map(c => ({id: c, name: c}))} />
      <p className="editor-note">Merging moves the category links and combines budget allocations. Transaction amounts and payment histories stay intact.</p></Editor>}
    {template && <Editor title="Quick entry template" {...props} close={() => setTemplate(false)} onSave={data => save(s => ({...s, settings: {...s.settings, dailyV6: {...settingsV6(s),
      merchantTemplates: [...rows(settingsV6(s).merchantTemplates), {id: crypto.randomUUID(), name: value(data, "name"), type: value(data, "type"), accountId: value(data, "account"),
        amount: amount(data, "amount"), category: value(data, "category"), note: value(data, "note")} ]}}}))}>
      <Input name="name" label="Template name" maxLength={100} /><Select name="type" label="Type" initial="expense" options={[{id: "expense", name: "Expense"}, {id: "income", name: "Income"}]} />
      <Input name="amount" label="Usual amount ₹" initial={0} /><Select name="account" label="Account" options={ledger.accounts.map(a => ({id: a.id, name: a.name}))} />
      <Select name="category" label="Category" options={[...new Set([...ledger.categories.expense, ...ledger.categories.income])].map(c => ({id: c, name: c}))} /><Input name="note" label="Notes / tags" required={false} />
    </Editor>}
    {encrypted && <Editor title="Unlock backup for preview" {...props} close={() => setEncrypted("")} submit="Preview restore" onSave={async data => {
      const restored = await openEncryptedBackup(encrypted, String(data.get("passphrase") ?? ""));previewRestore(restored);return true;
    }}><Input name="passphrase" label="Backup passphrase" type="password" /></Editor>}
    {deviceBackup && <Editor title="Restore device backup" {...props} busy={busy || deviceBusy}
      close={() => setDeviceBackup(null)} submit="Restore device library" onSave={data => useDeviceBackup(async signal => {
        const count = await restoreDeviceRecords(await deviceBackup.text(), String(data.get("passphrase") ?? ""), envelope, vaultKey, signal);
        window.dispatchEvent(new Event("atlas-documents-changed"));
        window.dispatchEvent(new Event("atlas-device-library-restored"));
        return count + " encrypted device records restored.";
      })}>
      <p>This adds records only if this vault's device library is empty. The ledger stays as it is.</p>
      <Input name="passphrase" label="Original vault passphrase" type="password" maxLength={128} />
      {deviceMessage && <p role="status">{deviceMessage}</p>}
    </Editor>}
    {pastDevice && <Editor title="Export device records from this vault" {...props} busy={busy || deviceBusy}
      close={() => setPastDevice(null)} submit="Download encrypted device backup" onSave={data => useDeviceBackup(async signal => {
        try {return await downloadDevice(pastDevice, await deriveKey(String(data.get("passphrase") ?? ""), pastDevice.salt), signal);}
        catch (error) {if (error instanceof DOMException && error.name === "OperationError") throw Error("The original vault passphrase is incorrect.");throw error;}
      })}>
      <p>Export documents and chats that still belong to this earlier vault on this device.</p>
      <Input name="passphrase" label="Original vault passphrase" type="password" maxLength={128} />
      {deviceMessage && <p role="status">{deviceMessage}</p>}
    </Editor>}
    {recovery && <Editor title="Local recovery snapshots" {...props} close={() => setRecovery(null)}>
      {recovery.map(item => <div className="button-row section-gap" key={item.day}><span>{item.day}</span><button onClick={() => {setRecovery(null);setEncrypted(serializeEnvelope(item.envelope));}}>Preview restore</button>
        {base64(item.envelope.salt) !== base64(envelope.salt) && <button onClick={() => {setDeviceMessage("");setRecovery(null);setPastDevice(item.envelope);}}>Export device records</button>}</div>)}
      {!recovery.length && <p className="muted">A local recovery copy is created shortly after saving or opening the workspace.</p>}</Editor>}
  </>;
}

export function ReportView({ledger, month, asOf}: FeatureProps) {
  const metrics = cashMetrics(ledger, month, asOf), position = netPosition(ledger, asOf);
  return <div className="stack"><Panel title={"Finance Atlas · " + monthLabel(month)} subtitle={metrics.start + " to " + metrics.end}
    action={<button onClick={() => window.print()}>Print monthly report</button>}>
    <Stats items={[["Income", metrics.income], ["Spending", metrics.spending], ["Net savings", metrics.savings], ["Net position", position.net]]} />
    <dl className="compact-details"><dt>Actual inflow</dt><dd>{money(metrics.inflow)}</dd><dt>Actual cash outflow</dt><dd>{money(metrics.outflow)}</dd>
      <dt>Expected outflow</dt><dd>{money(metrics.expectedOutflow)}</dd><dt>Projected cash surplus</dt><dd>{money(metrics.projectedCashSurplus)}</dd>
      <dt>Bank EMIs paid</dt><dd>{money(metrics.bankEmiPaid)}</dd><dt>Card EMIs posted</dt><dd>{money(metrics.cardEmiPosted)}</dd>
      <dt>Missing loan principal balances</dt><dd>{position.unknown}</dd></dl>
    </Panel><Panel title="Spending by category"><Table headers={["Category", "Planned", "Actual", "Difference"]}>
      {ledger.categories.expense.map(category => {
        const planned = minor(Number(row(row(ledger.budgets[month]).expense)[category]) || 0, 20_000_000_000), actual = categoryActual(ledger, month, "expense", category, asOf);
        return <tr key={category}><td>{category}</td><td>{money(planned)}</td><td>{money(actual)}</td><td>{money(planned - actual)}</td></tr>;
      })}</Table></Panel>
    <Panel title="Largest expenses"><Table headers={["Date", "Description", "Category", "Amount"]}>{metrics.posted.filter(t => t.type === "expense" && t.signed > 0)
      .sort((a, b) => b.signed - a.signed).slice(0, 10).map(t => <tr key={t.id}><td>{t.date}</td><td>{t.note}</td><td>{t.category}</td><td>{money(t.signed)}</td></tr>)}</Table></Panel>
    <Panel title="Upcoming cash payments"><Table headers={["Due", "Payment", "Amount"]}>{metrics.expected.filter(e => e.impact === "out").map(item =>
      <tr key={item.id}><td>{item.date}</td><td>{item.name}</td><td>{money(item.amount)}</td></tr>)}</Table></Panel>
  </div>;
}
