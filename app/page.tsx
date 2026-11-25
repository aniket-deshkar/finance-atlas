"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  addAccount, amountFromInput, balance, blank, currentMonth, displayPeriod, field, importLedger,
  kinds, money, monthLabel, monthShift, reportPeriod, row, rows, statementAmounts, today, validDate,
  type Account, type EntryKind, type Ledger
} from "../lib/ledger";
import { decryptVault, deriveKey, installVault, preference, readVault, saveSnapshot, saveVault, type Envelope } from "../lib/vault";
import { cloudConfigured, connectCloud, disconnectCloud } from "../lib/cloud";
import { fetchSnapshot, readHead, type CloudHead } from "../lib/cloud-sync";
import { AttentionPanel } from "./attention";
import { Icon } from "./icons";
import { Overview } from "./overview";
import { BackgroundArt } from "./visuals";
import {orderedViews, type View} from "../lib/navigation";
import {PeriodPicker, Sidebar} from "./shell";
import { enforceHistory, matchRecordedBills, obligations, reconcileBalance, removeUnusedAccount, saveTransaction, settingsV6, validateFinance } from "../lib/finance";
import { base64, download as downloadFile, migrateEmiBackup, readLegacyArchive } from "../lib/files";
import {desktopInvoke, isDesktop} from "../lib/desktop";
import { BillsView, BudgetView, CalendarView, DailyView, EmiView, ForecastView, GoalsView, SalaryView } from "./planning";
import { DebtView, InsightsView, ReceiptsView, ReconcileView, ReportView, RewardsView, SettingsExtras } from "./records";
import { StatementsView } from "./statements";
import { amount, Editor, Input, Select, UpcomingChooser, value, type FeatureProps } from "./feature-ui";
import { useDailyBackup } from "./backup";
import { LedgerHistory } from "./transactions";
import { AlertReview } from "./alert-review";
import type { AlertSuggestion } from "../lib/alert-parser";
import {Assistant, AssistantSettings} from "./assistant";
import {AutomationSettings, DocumentReviewCount, DocumentsView} from "./documents";
import {InvestmentsView, PolicyResearch, TaxView, VehiclesView} from "./assets";

type Route = {view: View; accountId: string; scroll: number};

type Session = { ledger: Ledger; key: CryptoKey; envelope: Envelope };

const fileLimit = 32_000_000;
const describe = (error: unknown) => error instanceof Error ? error.message : "Something went wrong.";
const formatDate = (date: string) => validDate(date) ? new Intl.DateTimeFormat("en-IN", {
  day: "numeric", month: "short", year: "numeric", timeZone: "UTC"
}).format(new Date(date + "T12:00:00Z")) : "—";

function Section({ title, children, action, hidden = false }: { title: string; children: ReactNode; action?: ReactNode; hidden?: boolean }) {
  return <section className="panel" hidden={hidden}><div className="panel-head"><h2>{title}</h2>{action}</div>{children}</section>;
}

function AccountForm({ save, asOf }: { save: (command: (ledger: Ledger) => Ledger) => Promise<boolean>; asOf: string }) {
  const [type, setType] = useState<Account["type"]>("bank");
  return <form className="entry-form" onSubmit={async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const ok = await save(ledger => {
      const account: Account = {
        id: crypto.randomUUID(), name: String(data.get("name")).trim(), type, openingDate: String(data.get("date")),
        opening: amountFromInput(String(data.get("opening"))),
        statementDay: type === "credit" ? Number(data.get("statementDay")) : 15,
        dueDay: type === "credit" ? Number(data.get("dueDay")) : 5,
        dueOffset: type === "credit" ? Number(data.get("dueOffset")) : 1,
        limit: type === "credit" ? amountFromInput(String(data.get("limit"))) : 0
      };
      if (account.type === "credit" && account.dueOffset === 0 && Number(account.dueDay) <= Number(account.statementDay))
        throw new Error("The due day must follow the statement day for a same-month due date.");
      if (account.openingDate > asOf) throw new Error("Choose an opening date no later than today.");
      return addAccount(ledger, account);
    });
    if (ok) form.reset();
  }}>
    <label>Account name<input name="name" required maxLength={100} /></label>
    <label>Type<select name="accountType" value={type} onChange={event => setType(event.target.value as Account["type"])}>
      <option value="bank">Bank</option><option value="cash">Cash</option><option value="credit">Credit card</option>
    </select></label>
    <label>Opening date<input name="date" type="date" required max={asOf} defaultValue={asOf} /></label>
    <label>Opening amount ₹<input name="opening" inputMode="decimal" required defaultValue="0" /></label>
    {type === "credit" && <>
      <label>Credit limit ₹<input name="limit" type="number" min="0" step="0.01" required /></label>
      <label>Statement day<input name="statementDay" type="number" min="1" max="31" required /></label>
      <label>Payment due day<input name="dueDay" type="number" min="1" max="31" required /></label>
      <label>Due month<select name="dueOffset"><option value="1">Following month</option><option value="0">Statement month</option></select></label>
    </>}
    <button className="primary" type="submit">Add account</button>
  </form>;
}

function TransactionForm({ ledger, save, asOf, close, busy, error, month }: FeatureProps & {close: () => void}) {
  const [type, setType] = useState<EntryKind | "">("expense");
  const [templateId, setTemplateId] = useState("");
  const [alert, setAlert] = useState<AlertSuggestion | null>(null);
  const [alertRevision, setAlertRevision] = useState(0);
  const [destination, setDestination] = useState(ledger.accounts.find(a => a.type === "credit")?.id || "");
  const templates = rows(settingsV6(ledger).merchantTemplates);
  const template = templates.find(t => t.id === templateId);
  const accounts = ledger.accounts.filter(account => !["income", "transfer", "cardPayment"].includes(type) || account.type !== "credit");
  const categories = type === "income" ? ledger.categories.income : ledger.categories.expense;
  const statements = type === "cardPayment" ? rows(ledger.settings.cardStatements).filter(st => st.cardId === destination &&
    field(st, "statementDate") <= asOf && statementAmounts(ledger, st, asOf).due > 0) : [];
  const period = displayPeriod(ledger, month, asOf);
  return <>
    <UpcomingChooser ledger={ledger} save={save} asOf={asOf} monthEnd={period.end} busy={busy} error={error} />
    <AlertReview useSuggestion={suggestion => {setTemplateId("");setType(suggestion.type);setAlert(suggestion);setAlertRevision(i => i + 1);}} />
    {alert && <p className="editor-note">Verify every field before saving.{alert.accountHint && " The alert mentioned an account ending " + alert.accountHint + "."} Account, category and payment status require your review.</p>}
    <label className="upcoming-chooser">Quick entry template<select value={templateId} onChange={event => {
      const selected = templates.find(t => t.id === event.target.value);setTemplateId(event.target.value);setAlert(null);
      if (selected) setType(field(selected, "type") as EntryKind);
    }}><option value="">No template</option>{templates.map(t => <option key={field(t, "id")} value={field(t, "id")}>{field(t, "name")}</option>)}</select></label>
    <form key={templateId + type + alertRevision} className="entry-form" onSubmit={async event => {
      event.preventDefault();const data = new FormData(event.currentTarget);
      if (!type) return;
      const statement = statements.find(item => item.id === data.get("statement"));
      if (await save(current => saveTransaction(current, {
        id: crypto.randomUUID(), type, date: value(data, "date"), accountId: value(data, "account"),
        toId: type === "transfer" ? value(data, "destination") : type === "cardPayment" ? destination : "",
        category: ["transfer", "cardPayment"].includes(type) ? "" : value(data, "category"), amount: amount(data, "amount"),
        ...(statement ? {cardStatementId: statement.id} : {}), paymentMode: value(data, "mode"),
        subscription: data.has("subscription"), subscriptionFrequency: value(data, "frequency"), note: value(data, "note"), confirmDuplicate: data.has("confirmDuplicate")
      }, asOf))) close();
    }}>
      <label>Type<select name="type" required value={type} onChange={event => setType(event.target.value as EntryKind | "")}>
        <option value="">Choose transaction type</option>
        {(Object.keys(kinds) as EntryKind[]).map(kind => <option key={kind} value={kind}>{kinds[kind]}</option>)}
      </select></label>
      <label>Date<input name="date" type="date" required defaultValue={alert ? alert.date : asOf} /></label>
      <label>Amount ₹<input name="amount" inputMode="decimal" defaultValue={alert?.amount || Number(template?.amount) || ""} required /></label>
      <label>Account<select name="account" required defaultValue={field(template ?? {}, "accountId")}>
        <option value="">Choose account</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
      {type === "transfer" && <label>Transfer to<select name="destination" required><option value="">Choose destination</option>
        {accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>}
      {type === "cardPayment" && <><label>Credit card<select name="repaymentCard" required value={destination} onChange={event => setDestination(event.target.value)}>
        {ledger.accounts.filter(a => a.type === "credit").map(card => <option key={card.id} value={card.id}>{card.name}</option>)}</select></label>
        <label>Card statement paid<select name="statement" defaultValue=""><option value="">Prepayment / no statement link</option>
          {statements.map(statement => <option key={field(statement, "id")} value={field(statement, "id")}>{formatDate(field(statement, "statementDate"))} ? {money(statementAmounts(ledger, statement, asOf).due)} due</option>)}
        </select></label></>}
      {type && type !== "transfer" && type !== "cardPayment" && <label>Category<select name="category" required defaultValue={field(template ?? {}, "category")}>
        {categories.map(category => <option key={category}>{category}</option>)}</select></label>}
      <label>Payment mode<select name="mode"><option>Other</option><option>UPI</option><option>Bank transfer</option><option>Auto-debit</option><option>Cash</option><option>Credit card</option></select></label>
      <label>Notes / event tags<input name="note" maxLength={1200} defaultValue={field(template ?? {}, "note")} /></label>
      <label className="checkbox"><input name="confirmDuplicate" type="checkbox" />Confirm this is a separate identical entry</label>
      {type === "expense" && <><label className="checkbox"><input name="subscription" type="checkbox" />This expense is a subscription</label>
        <label>Subscription repeat<select name="frequency"><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option><option value="d28">Every 28 days</option></select></label></>}
      <button className="primary" type="submit">Record transaction</button><button type="button" onClick={close}>Cancel</button>
      <p className="editor-note">A future date schedules an entry. Balances change on its recorded date. Choose an upcoming payment above to link its bill or installment.</p>
    </form>
  </>;
}

export default function Page() {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {setDesktop(isDesktop());}, []);
  const [existing, setExisting] = useState<Envelope | null | undefined>();
  const [welcomeHead, setWelcomeHead] = useState<CloudHead | null>(null);
  const [welcomeConnected, setWelcomeConnected] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const selectedTheme = session ? row(session.ledger.settings.appearance).theme === "dark" ? "dark" : "light" : null;
  useEffect(() => {
    let theme = selectedTheme;
    try { theme ??= localStorage.getItem("atlas-appearance") === "dark" ? "dark" : "light"; }
    catch { theme ??= "light"; }
    document.documentElement.dataset.theme = theme;
    if (isDesktop()) void desktopInvoke("set_native_theme", {theme}).catch(() => {});
    if (selectedTheme) try { localStorage.setItem("atlas-appearance", selectedTheme); } catch { /* The vault remains the source of truth. */ }
  }, [selectedTheme]);
  const [view, setView] = useState<View>("Overview");
  const [navDrawer, setNavDrawer] = useState(false);
  const navTrigger = useRef<HTMLButtonElement>(null);
  const [settingsSection, setSettingsSection] = useState("Appearance & navigation");
  const [cloudMount, setCloudMount] = useState<HTMLDivElement | null>(null);
  const [assistantMount, setAssistantMount] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!navDrawer) return;
    const desktopLayout = window.matchMedia("(min-width: 901px)");
    const close = () => {if (desktopLayout.matches) setNavDrawer(false);};
    desktopLayout.addEventListener("change", close);
    return () => desktopLayout.removeEventListener("change", close);
  }, [navDrawer]);
  const [month, setMonth] = useState("");
  const [clockDay, setClockDay] = useState(today);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const exported = (event: Event) => {
      const detail = (event as CustomEvent<{message?: string; error?: string}>).detail;
      if (detail?.error) setError(detail.error);
      else if (detail?.message) setNotice(detail.message);
    };
    window.addEventListener("atlas-export-status", exported);
    return () => window.removeEventListener("atlas-export-status", exported);
  }, []);
  const [busy, setBusy] = useState(false);
  const [entryOpen, setEntryOpen] = useState(false);
  const [focusedCard, setFocusedCard] = useState("");
  const navigation = useRef<Route>({view: "Overview", accountId: "", scroll: 0});
  const previousRoutes = useRef<Route[]>([]);
  const [backDepth, setBackDepth] = useState(0);
  const [accountEdit, setAccountEdit] = useState<Account | null>(null);
  const [preview, setPreview] = useState<Ledger | null>(null);
  const busyRef = useRef(false);
  const activeSession = useRef<Session | null>(null);
  const sessionGeneration = useRef(0);
  const renderGeneration = sessionGeneration.current;
  const importRequest = useRef(0);
  const backups = useDailyBackup(session?.envelope);
  const idleMinutes = session ? Number(settingsV6(session.ledger).idleLockMinutes) : 0;
  const unlocked = !!session;
  useEffect(() => {
    if (!unlocked || ![5, 15, 30, 60].includes(idleMinutes)) return;
    let lastActivity = Date.now(), active = true;
    const check = () => {
      if (!active || Date.now() - lastActivity < idleMinutes * 60_000) return false;
      if (!busyRef.current) {active = false;lock();}
      return true;
    };
    const activity = (event: Event) => {if (event.isTrusted && !check()) lastActivity = Date.now();};
    const visible = () => {if (!document.hidden) check();};
    for (const name of ["pointerdown", "keydown", "wheel", "touchstart"]) window.addEventListener(name, activity, {passive: true});
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    const timer = window.setInterval(check, 1000);
    return () => {
      active = false;clearInterval(timer);window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
      for (const name of ["pointerdown", "keydown", "wheel", "touchstart"]) window.removeEventListener(name, activity);
    };
  }, [unlocked, idleMinutes]);
  useEffect(() => {
    const refresh = () => setClockDay(today());
    const timer = setInterval(refresh, 60000);
    window.addEventListener("focus", refresh);
    return () => {clearInterval(timer);window.removeEventListener("focus", refresh);};
  }, []);
  useEffect(() => {
    if (preview) document.querySelector(".import-preview")?.scrollIntoView({block: "center"});
  }, [preview]);
  useEffect(() => {
    if (!session || busyRef.current) return;
    const matched = matchRecordedBills(structuredClone(session.ledger), clockDay);
    if (JSON.stringify(matched) !== JSON.stringify(session.ledger)) void save(() => matched);
  }, [session, clockDay]);
  useEffect(() => {
    if (!session || !settingsV6(session.ledger).notifications || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    let live = true;
    const notify = async () => {
      const day = today(), last = await preference<string>("last-reminder-day");
      if (!live || last === day) return;
      const period = displayPeriod(session.ledger, currentMonth(session.ledger, day), day);
      const dues = obligations(session.ledger, period.start, day, day).filter(item => item.impact === "out");
      if (!dues.length) return;
      if (live) {
        new Notification("Finance Atlas payment reminder", {body: dues.length + " payment(s) are due or unrecorded. Open your workspace to review.", tag: "finance-atlas-dues"});
        await preference("last-reminder-day", day);
      }
    };
    void notify().catch(() => {});
    const timer = setInterval(() => {void notify().catch(() => {});}, 60000);
    return () => {live = false;clearInterval(timer);};
  }, [session]);
  useEffect(() => {
    if (!session) return;
    const shortcut = (event: KeyboardEvent) => {
      if (busyRef.current || event.ctrlKey || event.metaKey || event.altKey || document.querySelector("dialog[open]") ||
          (event.target instanceof Element && event.target.closest("input, select, textarea, [contenteditable=true]"))) return;
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();navigate("Transactions");setEntryOpen(true);
      }
      if (/^[0-9]$/.test(event.key)) {
        const target = orderedViews(session.ledger)[event.key === "0" ? 9 : Number(event.key) - 1];
        if (target) {event.preventDefault();navigate(target);}
      }
      if (event.key.toLowerCase() === "p") {
        event.preventDefault();void save(s => ({...s, settings: {...s.settings, appearance: {...row(s.settings.appearance), private: !row(s.settings.appearance).private}}}));
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [session]);

  useEffect(() => {
    let live = true;
    readVault().then(value => { if (live) setExisting(value); }).catch(() => {
      if (live) setError("This browser could not open its encrypted workspace storage.");
    });
    return () => { live = false; };
  }, []);

  async function connectWelcome() {
    if (busyRef.current || existing !== null) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const signal = AbortSignal.timeout(125_000);
      await connectCloud(signal);
      setWelcomeHead(await readHead(signal));
      setWelcomeConnected(true);
    } catch (problem) {
      await disconnectCloud().catch(() => {});
      setError(describe(problem));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current || existing === undefined) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const passphrase = String(data.get("passphrase") ?? "");
    if (!existing && !welcomeHead && (passphrase.length < 12 || passphrase !== data.get("confirm"))) {
      setError("Choose a passphrase of at least 12 characters and confirm it.");
      return;
    }
    form.reset();
    setError("");
    busyRef.current = true;
    setBusy(true);
    try {
      const latest = await readVault();
      if ((latest?.revision ?? null) !== (existing?.revision ?? null)) {
        setExisting(latest);
        setError("The vault changed in another tab. Try again.");
        return;
      }
      const snapshot = existing ?? (welcomeHead ? await fetchSnapshot(welcomeHead, AbortSignal.timeout(45_000)) : null);
      const salt = snapshot?.salt ?? crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKey(passphrase, salt);
      const ledger = validateFinance(snapshot ? await decryptVault(snapshot, key) : blank(), today());
      if (snapshot && !existing) await installVault(snapshot, null);
      const envelope = snapshot ?? await saveVault(ledger, key, salt, null);
      setWelcomeHead(null);
      setWelcomeConnected(false);
      setExisting(envelope);
      setClockDay(today());
      setMonth(currentMonth(ledger, today()));
      const unlocked = {ledger, key, envelope};
      sessionGeneration.current++;
      activeSession.current = unlocked;
      setSession(unlocked);
    } catch (problem) {
      setError((existing || welcomeHead) && problem instanceof DOMException && problem.name === "OperationError"
        ? "Could not unlock the vault. Check the passphrase." : describe(problem));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function save(command: (ledger: Ledger) => Ledger, replacement = false, checkpoint = false): Promise<boolean> {
    const current = activeSession.current;
    if (!current || busyRef.current || renderGeneration !== sessionGeneration.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const proposed = command(structuredClone(current.ledger));
      const ledger = validateFinance(matchRecordedBills(proposed, today()), today());
      if (replacement || checkpoint) await saveSnapshot(current.envelope, new Date().toISOString());
      if (!replacement) enforceHistory(current.ledger, ledger, today());
      const beforeRevision = Number(current.ledger.revision) || 0;
      ledger.revision = beforeRevision + 1;
      ledger.settings = {...ledger.settings, dailyV6: {...settingsV6(ledger), auditTrail: [...rows(settingsV6(ledger).auditTrail), {
        id: crypto.randomUUID(), at: new Date().toISOString(), from: beforeRevision, to: beforeRevision + 1,
        changes: replacement ? "Restored workspace backup" : view + " · " + (ledger.transactions.length - current.ledger.transactions.length) + " ledger entry change(s)"
      }].slice(-500)}};
      const envelope = await saveVault(ledger, current.key, current.envelope.salt, current.envelope.revision);
      if (activeSession.current !== current || renderGeneration !== sessionGeneration.current) return false;
      if (replacement) {sessionGeneration.current++;importRequest.current++;}
      const updated = {...current, ledger, envelope};
      activeSession.current = updated;
      setSession(updated);
      setExisting(envelope);
      setNotice("Saved to this device.");
      return true;
    } catch (problem) {
      setError(describe(problem));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function restoreCloud(remote: Envelope, expected: string, passphrase: string, signal: AbortSignal) {
    const current = activeSession.current;
    if (!current || current.envelope.revision !== expected || busyRef.current) throw Error("The local vault changed. Review both copies again.");
    busyRef.current = true;setBusy(true);
    try {
      if (!passphrase && !current.envelope.salt.every((byte, index) => byte === remote.salt[index]))
        throw Error("Enter the cloud vault passphrase to use this copy.");
      const key = passphrase ? await deriveKey(passphrase, remote.salt) : current.key;
      let ledger: Ledger;
      try {ledger = validateFinance(await decryptVault(remote, key), today());}
      catch (problem) {
        if (problem instanceof DOMException && problem.name === "OperationError") throw Error("Could not unlock the cloud vault. Enter its passphrase.");
        throw problem;
      }
      signal.throwIfAborted();
      if (activeSession.current !== current) throw Error("Unlock the local workspace and try again.");
      await installVault(remote, expected);
      if (activeSession.current !== current) return;
      sessionGeneration.current++;importRequest.current++;
      const updated = {ledger, key, envelope: remote};
      activeSession.current = updated;
      setSession(updated);setExisting(remote);setMonth(currentMonth(ledger, today()));setPreview(null);setEntryOpen(false);setAccountEdit(null);
    } finally {busyRef.current = false;setBusy(false);}
  }

  async function reissueCloudRevision(expected: string) {
    const current = activeSession.current;
    if (!current || current.envelope.revision !== expected || busyRef.current) throw Error("The local vault changed. Review both copies again.");
    busyRef.current = true;setBusy(true);
    try {
      const envelope = await saveVault(current.ledger, current.key, current.envelope.salt, expected);
      if (activeSession.current !== current) throw Error("Unlock the local workspace and try again.");
      const updated = {...current, envelope};
      activeSession.current = updated;
      setSession(updated);setExisting(envelope);
      return envelope;
    } finally {busyRef.current = false;setBusy(false);}
  }

  function navigate(destination: View, accountId = "") {
    setNavDrawer(false);
    const current = navigation.current;
    if (current.view !== destination || current.accountId !== accountId) {
      previousRoutes.current.push({...current, scroll: window.scrollY});
      if (previousRoutes.current.length > 60) previousRoutes.current.shift();
      setBackDepth(previousRoutes.current.length);
    }
    navigation.current = {view: destination, accountId, scroll: 0};
    setView(destination);
    setFocusedCard(accountId);
    setEntryOpen(false);
    setError("");
    setNotice("");
    window.scrollTo({top: 0});
    if (navDrawer) requestAnimationFrame(() => document.querySelector<HTMLElement>("#workspace-heading")?.focus());
  }

  function closeNavigation() {
    setNavDrawer(false);
    requestAnimationFrame(() => navTrigger.current?.focus());
  }

  function goBack() {
    if (entryOpen) {setEntryOpen(false);return;}
    const previous = previousRoutes.current.pop() ?? {view: "Overview" as View, accountId: "", scroll: 0};
    navigation.current = previous;
    setBackDepth(previousRoutes.current.length);
    setView(previous.view);
    setFocusedCard(previous.accountId);
    setError("");setNotice("");
    requestAnimationFrame(() => window.scrollTo({top: previous.scroll}));
  }

  function lock() {
    setNavDrawer(false);
    navigation.current = {view: "Overview", accountId: "", scroll: 0};
    previousRoutes.current = [];
    setBackDepth(0);
    importRequest.current++;
    sessionGeneration.current++;
    activeSession.current = null;
    setSession(null);
    setPreview(null);
    setSearch("");
    setNotice("");
    setError("");
    setView("Overview");
    setEntryOpen(false);
    setAccountEdit(null);
    readVault().then(setExisting).catch(() => setError("Could not refresh the local vault."));
  }

  async function readImport(file: File) {
    const request = ++importRequest.current;
    setPreview(null);
    setError("");
    try {
      if (file.size > fileLimit) throw new Error("Choose a backup smaller than 32 MB.");
      const input = file.name.toLowerCase().endsWith(".zip") ? await readLegacyArchive(file) : JSON.parse(await file.text());
      const candidate = row(row(input).state ?? input);
      const ledger = validateFinance(candidate.app === "Finance Atlas" ? importLedger(input) : migrateEmiBackup(input, session!.ledger, today()), today());
      if (request === importRequest.current) setPreview(ledger);
    } catch (problem) {
      if (request === importRequest.current) setError(describe(problem));
    }
  }

  function download(ledger: Ledger) {
    downloadFile("Finance_Atlas_Backup_" + today() + ".json", JSON.stringify({app: ledger.app, exportedAt: new Date().toISOString(), state: ledger}));
  }

  if (!session) return <main className="login">
    <section className="login-story"><div className="brand"><span>◈</span> Finance Atlas</div>
      <div><h1>A clearer view of your money.</h1>
      <p>See what’s due, where you spend, and how your savings are progressing.</p>
      <svg className="atlas-login-visual" viewBox="0 0 320 100" aria-hidden="true"><path d="M4 88H316M4 58H316M4 28H316" stroke="currentColor" strokeOpacity=".16" />
        <path d="M4 83C28 83 40 63 63 64S102 75 125 51S162 65 186 38S222 48 241 27S274 43 313 7" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg></div>
      <p className="login-foot">Encrypted storage on this device</p>
    </section>
    <section className="login-form"><p className="eyebrow">FINANCE ATLAS {desktop ? "DESKTOP" : "WEB PILOT"}</p><h2>{existing ? "Unlock your workspace" : welcomeHead ? "Unlock your cloud workspace" : welcomeConnected ? "Create your workspace" : "Create a local workspace"}</h2>
      <p className="muted">Your vault passphrase unlocks your records on this device. Google sign-in connects optional cloud services.</p>
      {cloudConfigured && existing === null && (welcomeConnected
        ? <button type="button" disabled={busy} onClick={() => {
          void disconnectCloud().then(() => {setWelcomeHead(null);setWelcomeConnected(false);setError("");}).catch(problem => setError(describe(problem)));
        }}>Disconnect Google</button>
        : <button type="button" disabled={busy} onClick={() => void connectWelcome()}>Continue with Google</button>)}
      {existing === undefined ? <p role="status">{error || "Checking local storage…"}</p> : <form onSubmit={unlock}>
        <label>Passphrase<input name="passphrase" type="password" required minLength={existing || welcomeHead ? 1 : 12}
          maxLength={128} autoComplete={existing || welcomeHead ? "current-password" : "new-password"} /></label>
        {!existing && !welcomeHead && <label>Confirm passphrase<input name="confirm" type="password" required minLength={12} maxLength={128} autoComplete="new-password" /></label>}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? "Working…" : existing || welcomeHead ? "Unlock workspace" : "Create workspace"}</button>
      </form>}
    </section>
  </main>;

  const { ledger } = session;
  const asOf = clockDay;
  const featureProps: FeatureProps = {ledger, month, asOf, save: (command, checkpoint) => save(command, false, checkpoint), busy, error};
  const period = view === "Overview" || view === "Payment calendar" ? displayPeriod(ledger, month, asOf) : reportPeriod(ledger, month);
  const customization = row(ledger.settings.uiCustomization);
  const placement = field(customization, "navPlacement") || "left";
  const hasSidebar = ["left", "right", "compact"].includes(placement);
  const collapsed = hasSidebar && (customization.sidebarCollapsed === true || placement === "compact" && customization.sidebarCollapsed !== false);
  const reduceMotion = row(ledger.settings.appearance).reduceMotion === true;
  const privacy = row(ledger.settings.appearance).private === true;
  const deviceProps = {vaultKey:session.key, scope:base64(session.envelope.salt)};
  const openDocuments = () => navigate("Documents");
  return <div className="workspace" data-nav={placement === "compact" ? "left" : placement} data-collapsed={collapsed} data-motion={reduceMotion ? "reduced" : "full"} data-theme={row(ledger.settings.appearance).theme === "dark" ? "dark" : "light"} data-private={row(ledger.settings.appearance).private === true}>
    <BackgroundArt />
    <Sidebar ledger={ledger} view={view} collapsed={collapsed} hasSidebar={hasSidebar} busy={busy} drawer={navDrawer}
      navigate={navigate} close={closeNavigation} lock={lock} toggle={() => void save(s => ({...s,
        settings: {...s.settings, uiCustomization: {...row(s.settings.uiCustomization), sidebarCollapsed: !collapsed}}}))} />
    <main className="content" inert={navDrawer}>
      <a className="skip-link" href="#workspace-heading">Skip to main content</a>
      <header className="topbar">
        <div className="topbar-leading">{hasSidebar && <button ref={navTrigger} className="icon-button atlas-nav-trigger" aria-label="Open navigation" aria-controls="workspace-sidebar" aria-expanded={navDrawer} onClick={() => setNavDrawer(true)}><Icon name="menu" /></button>}
        <button className="back-button" aria-label="Go back" title="Back to the previous section" disabled={!entryOpen && backDepth === 0 && view === "Overview"} onClick={goBack}><Icon name="left" /><span>Back</span></button>
        {!privacy && <label className="search"><span className="sr-only">Search transactions</span><Icon name="search" /><input name="transactionSearch" autoComplete="off" type="search" value={search} placeholder="Search"
          onChange={event => {setSearch(event.target.value); if (view !== "Transactions") navigate("Transactions");}} /></label>}</div>
        <div className="topbar-actions"><PeriodPicker key={view}>
        <span className="eyebrow">REPORTING PERIOD</span><div className="period-control"><button aria-label="Previous period" onClick={() => setMonth(monthShift(month, -1))}>‹</button>
          <strong>{monthLabel(month)}</strong><button aria-label="Next period" onClick={() => setMonth(monthShift(month, 1))}>›</button>
          </div><button className="quiet" onClick={() => setMonth(currentMonth(ledger, asOf))}>Current period</button></PeriodPicker>
        <button className="icon-button" aria-label="View card statements and payment dues" onClick={() => navigate("Card statements")}><Icon name="bell" /></button>
        <button className="icon-button" aria-label={row(ledger.settings.appearance).private ? "Show amounts" : "Hide amounts"} aria-pressed={row(ledger.settings.appearance).private === true}
          disabled={busy} onClick={() => {setSearch("");void save(s => ({...s, settings: {...s.settings, appearance: {...row(s.settings.appearance), private: !row(s.settings.appearance).private}}}));}}><Icon name="eye" /></button>
        <button className="icon-button" aria-label="Settings" title="Settings" aria-current={view === "Data & settings" ? "page" : undefined} onClick={() => navigate("Data & settings")}><Icon name="settings" /></button>
        <div ref={setAssistantMount} className="assistant-launch-slot" />
        </div>
      </header>
      <div className="page-title atlas-content-enter" key={view}><div><h1 id="workspace-heading" tabIndex={-1}>{view === "Overview" ? "Dashboard" : view === "Data & settings" ? "Settings" : view}</h1>
        <p className="muted">{period.basis} · {formatDate(period.start)} to {formatDate(period.end)}</p></div>
        {!privacy && !["Data & settings", "Assistant", "Documents", "Tax", "Vehicles", "Investments"].includes(view) && <button className="primary" disabled={busy} onClick={() => {navigate(ledger.accounts.length ? "Transactions" : "Accounts");setEntryOpen(Boolean(ledger.accounts.length));}}>
          {ledger.accounts.length ? "+ New transaction" : "Set up an account"}
        </button>}</div>
      {error && <p className="error" role="alert">{privacy ? "The action could not be completed. Show amounts to see details." : error}</p>}
      {notice && !privacy && <p className="notice" role="status">{notice}</p>}
      <div hidden={view !== "Overview"}><Overview ledger={ledger} month={month} asOf={asOf} privacy={privacy} navigate={navigate} selectMonth={setMonth} attention={<>
        <AttentionPanel {...featureProps} visible={view === "Overview"} privacy={privacy} cloudMount={cloudMount}
          envelope={session.envelope} vaultKey={session.key} navigate={navigate} restore={restoreCloud} reissue={reissueCloudRevision} />
        {view === "Overview" && !privacy && <DocumentReviewCount {...deviceProps} onOpen={openDocuments} />}
      </>} /></div>
      {privacy ? view !== "Overview" && view !== "Assistant" && <section className="panel">
        <h2>Workspace details are hidden</h2><p>Use Show amounts in the toolbar to view details, or lock the workspace to end the session.</p>
      </section> : <>
      {view === "Transactions" && <div className="stack">
        {entryOpen && <Section title="New transaction"><fieldset disabled={busy}><TransactionForm {...featureProps} close={() => setEntryOpen(false)} /></fieldset></Section>}
        <LedgerHistory {...featureProps} search={search} openReceipts={() => navigate("Receipts")} />
      </div>}
      {view === "Accounts" && <div className="stack">
        <Section title="Recorded balances"><p className="muted">As of {formatDate(asOf)}</p><div className="account-grid">{ledger.accounts.map(account => <article className="account" key={account.id}>
          <small>{account.type === "credit" ? "Credit card" : account.type === "cash" ? "Cash" : "Bank account"}</small><h3>{account.name}</h3>
          <strong>{money(balance(ledger, account, asOf))}</strong>
          <div className="button-row section-gap"><button onClick={() => setAccountEdit(account)}>Edit / confirm balance</button>
            {account.type === "credit" && <button onClick={() => navigate("Card statements", account.id)}>Statements</button>}</div></article>)}</div>
          {!ledger.accounts.length && <p className="muted">Add an account below or import an existing backup.</p>}</Section>
        <Section title="Add an account"><fieldset disabled={busy}><AccountForm save={save} asOf={asOf} /></fieldset></Section>
      </div>}
      {view === "Card statements" && <StatementsView key={focusedCard} {...featureProps} focusedCard={focusedCard} />}
      {view === "Daily hub" && <DailyView {...featureProps} />}
      {view === "Bills & policies" && <div className="stack"><BillsView {...featureProps} /><PolicyResearch {...deviceProps} /></div>}
      {view === "EMIs & recoveries" && <EmiView {...featureProps} />}
      {view === "Monthly budget" && <BudgetView {...featureProps} />}
      {view === "Payment calendar" && <CalendarView {...featureProps} />}
      {view === "Salary & transfers" && <SalaryView {...featureProps} />}
      {view === "Goals" && <GoalsView {...featureProps} />}
      {view === "12-month plan" && <ForecastView {...featureProps} />}
      {view === "Insights" && <InsightsView {...featureProps} />}
      {view === "Debt & credit" && <DebtView {...featureProps} />}
      {view === "Reconciliation" && <div className="stack"><DocumentsView {...featureProps} {...deviceProps} /><ReconcileView {...featureProps} {...deviceProps} /></div>}
      {view === "Cashback" && <RewardsView {...featureProps} />}
      {view === "Receipts" && <ReceiptsView {...featureProps} />}
      {view === "Monthly report" && <ReportView {...featureProps} />}
      {view === "Documents" && <DocumentsView {...featureProps} {...deviceProps} initialDocument={focusedCard} />}
      {view === "Tax" && <TaxView {...featureProps} {...deviceProps} openDocuments={openDocuments} />}
      {view === "Investments" && <InvestmentsView {...featureProps} openDocuments={openDocuments} />}
      {view === "Vehicles" && <VehiclesView {...featureProps} />}
      {view === "Data & settings" && <div className="stack"><div className="settings-sections" role="group" aria-label="Settings sections">
        {(["Appearance & navigation","Finance & automation","AI & providers","Data, backup & security"] as const).map((name,index) =>
          <button key={name} aria-pressed={settingsSection === name} onClick={() => setSettingsSection(name)}>
            <Icon name={index === 0 ? "dashboard" : index === 1 ? "wallet" : index === 2 ? "chat" : "shield"} />{name}</button>)}
      </div>
      {settingsSection === "AI & providers" && <AssistantSettings {...featureProps} cloudControls={<div ref={setCloudMount} />} />}
      {settingsSection === "Finance & automation" && <AutomationSettings {...featureProps} />}
      {settingsSection === "Data, backup & security" && <Section title="Local workspace">
        <p className="muted">Import a Finance Atlas version 1 JSON ledger to create a local working copy.</p>
        <label className="upload">Preview JSON backup<input type="file" accept=".json,.zip,application/json,application/zip" disabled={busy}
          onChange={event => {const file = event.target.files?.[0]; if (file) void readImport(file); event.target.value = "";}} /></label>
        {preview && <div className="import-preview"><strong>Ready to import</strong><p>{preview.accounts.length} accounts · {preview.transactions.length} transactions · {preview.loans.length} loans</p>
          <p>This replaces this browser’s workspace. Download its backup first if it has records you need.</p>
          <div className="button-row"><button className="primary" disabled={busy} onClick={async () => {
            if (await save(() => preview, true)) {setMonth(currentMonth(preview, today()));setPreview(null);}
          }}>Replace local workspace</button><button disabled={busy} onClick={() => setPreview(null)}>Cancel</button></div>
        </div>}
        <button onClick={() => download(ledger)}>Download unencrypted JSON</button>
        <p className="muted">JSON is readable by anyone with the file. For private storage, use the encrypted ledger backup below.</p>
      </Section>}<SettingsExtras {...featureProps} section={settingsSection} envelope={session.envelope} vaultKey={session.key} backups={backups} previewRestore={restored => {
        if (activeSession.current?.key === session.key && renderGeneration === sessionGeneration.current) setPreview(validateFinance(restored, today()));
      }} /></div>}
      {accountEdit && <Editor title={"Account & balance · " + accountEdit.name} {...featureProps} close={() => setAccountEdit(null)}
        onSave={data => save(s => {
          const old = s.accounts.find(a => a.id === accountEdit.id)!;
          const next = {...s, accounts: s.accounts.map(a => a.id === old.id ? {...a, name: value(data, "name"),
            ...(old.type === "credit" ? {limit: amount(data, "limit"), statementDay: Number(value(data, "statementDay")), dueDay: Number(value(data, "dueDay")), dueOffset: Number(value(data, "dueOffset"))} : {})} : a)};
          return value(data, "current") ? reconcileBalance(next, old.id, amount(data, "current"), value(data, "date"), asOf) : next;
        })}><Input name="name" label="Account name" initial={accountEdit.name} maxLength={100} />
        <Input name="current" label="Confirmed current balance ₹" initial={balance(ledger, accountEdit, asOf) / 100} />
        <Input name="date" label="Current balance date" type="date" initial={asOf} max={asOf} />
        {accountEdit.type === "credit" && <><Input name="limit" label="Credit limit ₹" initial={Number(accountEdit.limit) || 0} />
          <Input name="statementDay" label="Statement day" type="number" min={1} max={31} initial={Number(accountEdit.statementDay) || 15} />
          <Input name="dueDay" label="Due day" type="number" min={1} max={31} initial={Number(accountEdit.dueDay) || 5} />
          <Select name="dueOffset" label="Due month" initial={Number(accountEdit.dueOffset ?? 1)} options={[{id: "0", name: "Same month"}, {id: "1", name: "Following month"}]} /></>}
        <p className="editor-note">The balance confirmation records a dated checkpoint. Previous transactions and their original amounts remain in history.</p>
        <button type="button" disabled={busy} onClick={async () => {
          if (await save(s => removeUnusedAccount(s, accountEdit.id), false, true)) setAccountEdit(null);
        }}>Remove unused account</button>
      </Editor>}
      </>}
      <Assistant key={deviceProps.scope} {...featureProps} {...deviceProps} view={view} target={focusedCard} launcher={assistantMount}
        privacy={privacy} navigate={navigate} renderDocuments={onReference => view === "Documents" || view === "Reconciliation" ?
          <p>Open the full Assistant to reference an extracted document.</p> : <DocumentsView {...featureProps} {...deviceProps} onReference={onReference} />} />
    </main>
  </div>;
}

