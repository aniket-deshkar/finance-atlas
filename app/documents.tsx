import {useEffect, useRef, useState} from "react";
import {base64, download, importStatement, type Staged} from "../lib/files";
import {merchantKey, readPdf, rowKey, statementCsvFromText, statementDraft, type DocumentKind, type ExtractedDocument} from "../lib/documents";
import {field, minor, money, row, rows} from "../lib/ledger";
import {deviceRecord} from "../lib/vault";
import type {FeatureProps} from "./feature-ui";

type Batch = ExtractedDocument & {staged?: Staged[]; outcomes?: Record<string, string>; at?: string};
type PasswordRequest = {name: string; wrong: boolean; resolve: (password: string) => void; reject: () => void};
const kinds: DocumentKind[] = ["Statement", "Tax evidence", "Policy", "Portfolio"];
const statementText = (item: ExtractedDocument) => item.kind !== "Statement" ? "" :
  /\.csv$/i.test(item.name) ? item.pages[0] : /\.pdf$/i.test(item.name) ? statementCsvFromText(item.pages) : "";

export async function saveDocumentIndex(scope: string, key: CryptoKey, batch: Batch) {
  const commit = async () => {
    const saved = await deviceRecord<Batch[]>(scope,"document-index",key) ?? [];
    if (saved.length >= 100 && !saved.some(item => item.id === batch.id)) throw Error("This device library supports up to 100 documents.");
    const next = [batch,...saved.filter(item => item.id !== batch.id)];
    await deviceRecord(scope,"document-index",key,next);
    window.dispatchEvent(new Event("atlas-documents-changed"));
    return next;
  };
  return navigator.locks ? navigator.locks.request("atlas-documents-" + scope,commit) : commit();
}

export function documentDigest(bytes: ArrayBuffer) {
  return crypto.subtle.digest("SHA-256",bytes).then(hash => Array.from(new Uint8Array(hash),
    byte => byte.toString(16).padStart(2,"0")).join(""));
}

export function useDocumentIndex(scope: string, key: CryptoKey) {
  const [entries, setEntries] = useState<Batch[]>([]);
  useEffect(() => {
    let active = true, revision = 0;
    const refresh = () => {
      const request = ++revision;
      void deviceRecord<Batch[]>(scope, "document-index", key).then(items => {
        if (active && revision === request) setEntries(items ?? []);
      }).catch(() => {if (active && revision === request) setEntries([]);});
    };
    refresh();
    window.addEventListener("atlas-documents-changed", refresh);
    return () => {active = false;window.removeEventListener("atlas-documents-changed", refresh);};
  }, [scope,key]);
  return entries;
}

export function DocumentReviewCount({scope,vaultKey,onOpen}: {scope:string; vaultKey:CryptoKey; onOpen:()=>void}) {
  const documents = useDocumentIndex(scope,vaultKey);
  const count = documents.reduce((sum,item) => sum + (item.staged?.length ?? 0), 0);
  return count > 0 && <p><button onClick={onOpen}>{count} imported {count === 1 ? "row needs" : "rows need"} review in Documents</button></p>;
}

export function DocumentsView({ledger, save, asOf, busy, vaultKey, scope, onReference, initialDocument}: FeatureProps & {
  vaultKey: CryptoKey; scope: string; onReference?: (document: Batch) => void; initialDocument?: string;
}) {
  const [documents, setDocuments] = useState<Batch[]>([]);
  const [doc, setDoc] = useState<Batch | null>(null);
  const [kind, setKind] = useState<DocumentKind>("Statement");
  const [account, setAccount] = useState("");
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const [password, setPassword] = useState<PasswordRequest | null>(null);
  const pending = useRef<PasswordRequest | null>(null);
  const alive = useRef(true);
  const indexRef = useRef<Batch[]>([]);
  const [opening, setOpening] = useState("");
  const [closing, setClosing] = useState("");
  const [approved, setApproved] = useState<string[]>([]);
  useEffect(() => {
    alive.current = true;
    let revision = 0;
    const refresh = (initial = false) => {
      const request = ++revision;
      void deviceRecord<Batch[]>(scope, "document-index", vaultKey).then(value => {
        if (!alive.current || revision !== request) return;
        indexRef.current = value ?? [];setDocuments(indexRef.current);
        if (initial) setDoc(indexRef.current.find(document => document.id === initialDocument) ?? null);
      }).catch(() => {if (alive.current && revision === request) setMessage("Could not unlock local documents.");});
    };
    const changed = () => refresh();
    refresh(true);window.addEventListener("atlas-documents-changed",changed);
    return () => {alive.current = false;pending.current?.reject();pending.current = null;
      window.removeEventListener("atlas-documents-changed",changed);};
  }, [scope, vaultKey, initialDocument]);

  async function persist(batch: Batch) {
    const next = await saveDocumentIndex(scope,vaultKey,batch);
    indexRef.current = next;
    if (alive.current) {setDocuments(next);setDoc(batch);}
  }

  async function upload(files: File[]) {
    setWorking(true);setMessage("");setApproved([]);
    const results: string[] = [];
    for (const file of files) {
      if (!alive.current) break;
      try {
        if (file.size > 12_000_000 || !/\.(csv|pdf|txt)$/i.test(file.name)) throw Error("Choose a CSV, TXT or PDF up to 12 MB.");
        const bytes = await file.arrayBuffer();
        const id = await documentDigest(bytes);
        const previous = indexRef.current.find(item => item.id === id);
        if (previous) {setDoc(previous);results.push(file.name + " is already in Documents.");continue;}
        if (indexRef.current.length >= 100) throw Error("This device library supports up to 100 documents.");
        const isPdf = /\.pdf$/i.test(file.name);
        const pages = isPdf ? await readPdf(bytes.slice(0), wrong => new Promise((resolve, reject) => {
          if (!alive.current) {reject(Error("File closed."));return;}
          const request = {name: file.name, wrong, resolve, reject: () => reject(Error("Document skipped."))};
          pending.current = request;
          setPassword(request);
        })) : [await file.text()];
        if (!alive.current) break;
        if (pages.reduce((size, page) => size + page.length, 0) > 750_000) throw Error("Split this document into smaller files.");
        const record = {id, name:file.name,kind,pages,date:asOf,accountId:account};
        const csv = statementText(record);
        let staged: Staged[] | undefined;
        if (kind === "Statement" && csv && account) {
          try {staged = statementDraft(ledger, csv, account, asOf);}
          catch (error) {results.push(error instanceof Error ? error.message : "Review the statement format.");}
        }
        await deviceRecord(scope, "original-" + id, vaultKey, base64(new Uint8Array(bytes)));
        await persist({...record,staged});
        results.push(!pages.some(Boolean) ? file.name + " has no selectable text. Use a CSV or enter the records manually." :
          kind === "Statement" && !csv ? file.name + " saved for review. Use its CSV export to reconcile transactions." : file.name + " processed on this device.");
      } catch (error) {results.push(file.name + " · " + (error instanceof Error ? error.message : "Could not read file."));}
      finally {pending.current = null;if (alive.current) setPassword(null);}
    }
    if (alive.current) {setWorking(false);setMessage(results.join(" "));}
  }

  async function reconcile(batch: Batch, mode: "auto" | "review") {
    const target = batch.accountId || account;
    if (!target) {setMessage("Select the statement account.");return;}
    setWorking(true);setMessage("");
    try {
      const amounts = (value: string) => /^-?\d+(\.\d{1,2})?$/.test(value.trim()) ? minor(Number(value)) : NaN;
      const verification = opening && closing ? {opening: amounts(opening), closing: amounts(closing)} : undefined;
      let final = batch;
      const saved = await save(current => {
        const csv = statementText(batch);
        const draft = statementDraft(current, csv, target, asOf, mode === "auto" ? verification : undefined);
        const outcomes = {...batch.outcomes};
        const existing = new Set(current.transactions.map(entry => field(entry, "importRowKey")).filter(Boolean));
        const entries = draft.filter(line => !existing.has(rowKey(line)) && !outcomes[rowKey(line)]).map(line => {
          const key = rowKey(line);
          const selected = !line.match && (mode === "auto" ? line.selected : approved.includes(key));
          if (selected || line.match) outcomes[key] = line.match || line.entry.id;
          return {...line, selected, entry: {...line.entry, importRowKey: key, importDocumentId: batch.id}};
        });
        final = {...batch, accountId: target, staged: draft.filter(line => !existing.has(rowKey(line)) && !outcomes[rowKey(line)]), outcomes, at: new Date().toISOString()};
        if (!entries.some(line => line.selected || line.match)) return current;
        return importStatement(current, entries, batch.name, "", asOf, false);
      }, true);
      if (saved) {await persist(final);setApproved([]);setMessage("Reconciliation finished. Review any unmatched rows below.");}
    } catch (error) {setMessage(error instanceof Error ? error.message : "Could not reconcile this statement.");}
    finally {setWorking(false);}
  }

  const unread = doc?.staged?.filter(line => !doc.outcomes?.[rowKey(line)] && !ledger.transactions.some(entry => entry.importRowKey === rowKey(line))) ?? [];
  return <section className="panel atlas-docs stack"><div className="panel-head"><h2>Import documents</h2>
    <button disabled={!documents.length} onClick={() => download("Finance_Atlas_Extracted_Documents.json", JSON.stringify(documents.map(item => ({
      id: item.id, name: item.name, kind: item.kind, date: item.date, accountId: item.accountId, outcomes: item.outcomes
    })), null, 2))}>Export document index</button></div>
    <p className="muted">Originals and extracted text are encrypted on this device. Select an account for statement matching.</p>
    <div className="filter-row"><label>Document type<select value={kind} onChange={event => setKind(event.target.value as DocumentKind)}>
      {kinds.map(value => <option key={value}>{value}</option>)}</select></label>
      {kind === "Statement" && <label>Statement account<select value={account} onChange={event => setAccount(event.target.value)}>
        <option value="">Choose account</option>{ledger.accounts.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>}
      <label>Add files<input aria-label="Add financial documents" type="file" accept=".pdf,.csv,.txt" multiple disabled={working || busy}
        onChange={event => {const files = Array.from(event.target.files ?? []);event.target.value = "";if (files.length) void upload(files);}} /></label></div>
    {password && <form key={password.name + password.wrong} onSubmit={event => {
      event.preventDefault();const form = event.currentTarget;
      const input = String(new FormData(form).get("password") ?? "");form.reset();
      setPassword(null);pending.current = null;password.resolve(input);
    }}><label>{password.wrong ? "Incorrect password. Try again for " : "Password required for "}{password.name}
      <input type="password" name="password" required autoComplete="off" autoFocus /></label>
      <div className="button-row"><button className="primary">Unlock PDF</button>
        <button type="button" onClick={() => {setPassword(null);pending.current = null;password.reject();}}>Skip file</button></div>
    </form>}
    <p role="status">{working && !password ? "Processing on this device…" : message}</p>
    {documents.length > 0 && <label>Document library<select value={doc?.id || ""} onChange={event => {
      setDoc(documents.find(item => item.id === event.target.value) ?? null);setApproved([]);setOpening("");setClosing("");
    }}><option value="">Choose a document</option>
      {documents.map(item => <option value={item.id} key={item.id}>{item.kind} · {item.name}</option>)}</select></label>}
    {doc && <div className="stack"><h3>{doc.name}</h3>
      <button disabled={working} onClick={async () => {
        try {
          const encoded = await deviceRecord<string>(scope,"original-" + doc.id,vaultKey);
          if (!encoded || !alive.current) return;
          download(doc.name,new Blob([Uint8Array.from(atob(encoded), character => character.charCodeAt(0))]));
        } catch {if (alive.current) setMessage("The encrypted original could not be read.");}
      }}>Save a copy of the original</button>
      {onReference && <button onClick={() => onReference(doc)}>Reference extracted figures in Assistant</button>}
      {statementText(doc) && <>
        <div className="filter-row"><label>Opening balance ₹<input inputMode="decimal" value={opening} onChange={event => setOpening(event.target.value)} /></label>
          <label>Closing balance ₹<input inputMode="decimal" value={closing} onChange={event => setClosing(event.target.value)} /></label></div>
        <button disabled={busy || working} onClick={() => void reconcile(doc, "auto")}>Match and apply verified rules</button>
        {unread.length > 0 && <><div className="atlas-context">{unread.map(line => <label key={rowKey(line)}>
          <input type="checkbox" disabled={busy || working || Boolean(line.possible || line.match)} checked={approved.includes(rowKey(line))}
            onChange={event => setApproved(values => event.target.checked ? [...values, rowKey(line)] : values.filter(value => value !== rowKey(line)))} />
          {line.entry.date} · {line.entry.note} · {money(Math.abs(line.signed))}{line.possible ? " · Check for a matching transfer or repayment in Reconciliation" : ""}
        </label>)}</div><button disabled={busy || working || !approved.length} onClick={() => void reconcile(doc, "review")}>Post selected rows</button></>}
      </>}
      <details><summary>View extracted text</summary><div className="atlas-document-preview" data-sensitive>
        {doc.pages.slice(0, 20).map((page, index) => <div key={index}><strong>{doc.pages.length > 1 && "Page " + (index + 1)}</strong>{page.slice(0, 6000)}{"\n"}</div>)}
      </div></details>
    </div>}
  </section>;
}

export function AutomationSettings({ledger, save, busy}: FeatureProps) {
  const [account, setAccount] = useState("");
  const current = row(row(ledger.settings.statementAutomation)[account]);
  const [note, setNote] = useState("");
  const [type, setType] = useState("expense");
  const categories = type === "income" ? ledger.categories.income : ledger.categories.expense;
  return <section className="panel stack"><h2>Statement automation</h2>
    <label>Bank account<select value={account} onChange={event => setAccount(event.target.value)}><option value="">Choose account</option>
      {ledger.accounts.filter(item => item.type === "bank").map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
    {account && <>
      <label className="checkbox"><input type="checkbox" checked={current.enabled === true} disabled={busy} onChange={event => {
        const enabled = event.target.checked;
        void save(s => ({...s, settings: {...s.settings, statementAutomation: {...row(s.settings.statementAutomation), [account]: {...current, enabled}}}}));
      }} />Auto-post verified entries</label>
      <p className="muted">Automatic posting uses the Date, Description, Debit, Credit, Balance CSV layout with verified opening and closing balances.</p>
      <form className="stack" onSubmit={event => {
        event.preventDefault();
        const category = String(new FormData(event.currentTarget).get("category") || "");
        if (!merchantKey(note) || !categories.includes(category)) return;
        void save(s => {
          const settings = row(s.settings.statementAutomation), previous = row(settings[account]);
          const rules = rows(previous.rules).filter(rule => rule.note !== merchantKey(note) || rule.type !== type);
          return {...s, settings: {...s.settings, statementAutomation: {...settings, [account]: {...previous, rules: [...rules, {note: merchantKey(note), type, category}]}}}};
        });
      }}><div className="filter-row">
        <label>Exact statement description<input required maxLength={160} value={note} onChange={event => setNote(event.target.value)} /></label>
        <label>Type<select value={type} onChange={event => setType(event.target.value)}><option value="expense">Expense</option><option value="income">Income</option></select></label>
        <label>Category<select key={type} name="category">{categories.map(category => <option key={category}>{category}</option>)}</select></label></div>
        <button disabled={busy}>Save confirmed rule</button>
      </form>
      {rows(current.rules).map(rule => <div className="button-row" key={field(rule,"note") + rule.type}><span>{field(rule,"note")} · {field(rule,"category")}</span>
        <button disabled={busy} onClick={() => void save(s => {
          const settings = row(s.settings.statementAutomation), previous = row(settings[account]);
          return {...s, settings: {...s.settings, statementAutomation: {...settings, [account]: {...previous,
            rules: rows(previous.rules).filter(item => item.note !== rule.note || item.type !== rule.type)}}}};
        })}>Remove rule</button></div>)}
    </>}
  </section>;
}
