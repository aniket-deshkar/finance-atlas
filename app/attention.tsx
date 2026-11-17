"use client";
import {useEffect, useEffectEvent, useMemo, useRef, useState} from "react";
import {createPortal} from "react-dom";
import {analysisContext, currentAttention, reviewProposals, updateReview, type AgentResult, type AttentionItem} from "../lib/attention";
import {checkedJson, cloudConfigured, cloudFetch, connectCloud, disconnectCloud, json} from "../lib/cloud";
import {fetchSnapshot, publishSnapshot, readHead, type CloudHead} from "../lib/cloud-sync";
import {download} from "../lib/files";
import {money, rows, type Ledger} from "../lib/ledger";
import {views, type View} from "../lib/navigation";
import {preference, saveSnapshot, serializeEnvelope, type Envelope} from "../lib/vault";
import type {FeatureProps} from "./feature-ui";

type Props = FeatureProps & {
  visible: boolean; privacy: boolean; envelope: Envelope; cloudMount: HTMLElement | null; navigate: (view: View, target?: string) => void;
  restore: (remote: Envelope, localRevision: string, passphrase: string, signal: AbortSignal) => Promise<void>;
  reissue: (localRevision: string) => Promise<Envelope>;
};
type Conflict = {head: CloudHead; localRevision: string};
const syncPref = "cloud-sync-base:" + process.env.NEXT_PUBLIC_ATLAS_FIREBASE_PROJECT + ":" + process.env.NEXT_PUBLIC_ATLAS_ORIGIN;
const message = (problem: unknown) => problem instanceof Error ? problem.message : typeof problem === "string" ? problem : "The operation could not be completed.";

export function AttentionPanel({ledger, month, asOf, busy, save, visible, privacy, envelope, navigate, restore, reissue, cloudMount}: Props) {
  const [connected, setConnected] = useState(false), [working, setWorking] = useState(false), [syncEnabled, setSyncEnabled] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null), [notice, setNotice] = useState(""), [error, setError] = useState("");
  const [review, setReview] = useState(false), [approved, setApproved] = useState("");
  const [reports, setReports] = useState<string[]>([]);
  const operation = useRef<AbortController | null>(null);
  const autoAttempted = useRef("");
  const mounted = useRef(true);
  const context = useMemo(() => analysisContext(ledger, month, asOf), [ledger, month, asOf]);
  const alerts = useMemo(() => currentAttention(ledger, month, asOf, context), [ledger, month, asOf, context]);
  const localRevision = envelope.revision;
  const approvalKey = localRevision + ":" + month + ":" + asOf;
  const confirmed = approved === approvalKey;
  const assisted = (rows(ledger.settings.attentionSuggestions) as (AttentionItem & {stale?: boolean})[])
    .filter(item => typeof item.id === "string" && typeof item.title === "string" && typeof item.detail === "string" &&
      typeof item.fingerprint === "string" && Number.isInteger(item.priority) && views.includes(item.view));
  const decisions = new Map(rows(ledger.settings.attentionDecisions).map(decision => [decision.id, decision.fingerprint]));
  const current = new Map<string, AttentionItem>();
  const evidence = new Map([...context.evidence.values()].map(item => [item.id, item]));
  for (const item of assisted) {
    const fact = evidence.get(item.id);
    if (!fact || decisions.get(item.id) === item.fingerprint) continue;
    current.set(item.id, {...item, ...{stale: item.stale || fact.detail !== item.detail}});
  }
  for (const item of alerts) if (decisions.get(item.id) !== item.fingerprint) current.set(item.id, item);
  const items = [...current.values()].sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title));

  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false;operation.current?.abort();void disconnectCloud().catch(() => {});};
  }, []);

  async function run(work: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return;
    const request = new AbortController();
    operation.current = request;
    setWorking(true);setError("");setNotice("");
    try {await work(AbortSignal.any([request.signal, AbortSignal.timeout(125_000)]));}
    catch (problem) {if (!request.signal.aborted && mounted.current) setError(message(problem));}
    finally {operation.current = null;if (mounted.current) setWorking(false);}
  }

  async function sync(local: Envelope, signal: AbortSignal) {
    const head = await readHead(signal);
    const base = await preference<string>(syncPref) || null;
    signal.throwIfAborted();
    if (head?.revision === local.revision) {
      await preference(syncPref, local.revision);
    } else if (head && base === local.revision) {
      const remote = await fetchSnapshot(head, signal);
      await saveSnapshot(local, new Date().toISOString() + " · Before cloud update");
      try {await restore(remote, local.revision, "", signal);}
      catch (problem) {
        if (!signal.aborted) setConflict({head, localRevision: local.revision});
        throw problem;
      }
      await preference(syncPref, head.revision);
    } else if (head && base !== head.revision) {
      setConflict({head, localRevision: local.revision});
      return;
    } else {
      if (!head && base) throw Error("The cloud workspace is missing. Your local vault remains available.");
      if (!await publishSnapshot(local, head?.revision ?? null, signal)) {
        const newer = await readHead(signal);
        if (!newer) throw Error("Cloud sync changed. Try again.");
        setConflict({head: newer, localRevision: local.revision});
        return;
      }
      await preference(syncPref, local.revision);
    }
    setConflict(null);
    setNotice("Encrypted cloud copy is current.");
  }

  const autoSync = useEffectEvent(() => {
    if (busy || working || conflict) return;
    autoAttempted.current = envelope.revision;
    void run(signal => sync(envelope, signal));
  });
  useEffect(() => {
    if (!connected || !syncEnabled || busy || working || conflict || autoAttempted.current === localRevision) return;
    const timeout = setTimeout(() => autoSync(), 1250);
    return () => clearTimeout(timeout);
  }, [localRevision, connected, syncEnabled, busy, working, conflict]);

  async function resolveConflict(passphrase: string, useRemote: boolean, signal: AbortSignal) {
    if (!conflict || conflict.localRevision !== envelope.revision) {
      await sync(envelope, signal);
      throw Error("Review the refreshed conflict before choosing a version.");
    }
    const latest = await readHead(signal);
    if (!latest || latest.revision !== conflict.head.revision) {
      await sync(envelope, signal);
      throw Error("The cloud revision changed. Review the current copies.");
    }
    const remote = await fetchSnapshot(latest, signal);
    const now = new Date().toISOString();
    await saveSnapshot(envelope, now + " · Local conflict copy");
    await saveSnapshot(remote, now + " · Cloud conflict copy");
    signal.throwIfAborted();
    if (useRemote) {
      await restore(remote, localRevision, passphrase, signal);
      await preference(syncPref, remote.revision);
    } else {
      const updated = await reissue(localRevision);
      if (!await publishSnapshot(updated, remote.revision, signal)) {
        const head = await readHead(signal);
        if (head) setConflict({head, localRevision: updated.revision});
        throw Error("The cloud changed again. Both copies remain recoverable.");
      }
      await preference(syncPref, updated.revision);
    }
    setConflict(null);setNotice("Vault version selected. Both earlier copies are available in recovery snapshots.");
  }

  async function analyze(signal: AbortSignal) {
    if (privacy || !confirmed) return;
    const {results} = await checkedJson<{results: AgentResult[]}>(await cloudFetch("/v1/ai/analyze", json(context.summary, signal)));
    const next = reviewProposals(results, context);
    signal.throwIfAborted();
    if (!await save(candidate => {
      if (candidate.revision !== ledger.revision) throw Error("The ledger changed during analysis. Review the new figures before trying again.");
      const old = rows(candidate.settings.attentionSuggestions).filter(item => !next.some(suggestion => suggestion.id === item.id));
      const examined = new Set([...context.evidence.values()].map(item => item.id));
      return {...candidate, settings: {...candidate.settings, attentionSuggestions: [...old.map(item => examined.has(String(item.id)) ? {...item, stale: true} : item), ...next].slice(-100)}};
    })) throw Error("The review items could not be saved.");
    setReports(results.map(result => (result.specialist === "spending" ? "Spending Analyst" : "Obligations Analyst") + " · " + result.status.replaceAll("_", " ")));
    setReview(false);setApproved("");
    setNotice(next.length ? "Review suggestions saved." : "No suggestions from the available evidence.");
  }

  return <>{cloudMount && createPortal(<section className="panel stack" aria-label="Cloud connection">
    <div className="panel-head"><h2>Cloud connection</h2>
      <div className="button-row">{cloudConfigured && (connected ? <>
        <button type="button" disabled={working || busy} onClick={() => {
          autoAttempted.current = envelope.revision;
          if (!syncEnabled) setSyncEnabled(true);
          void run(signal => sync(envelope, signal));
        }}>{syncEnabled ? "Sync now" : "Enable encrypted sync"}</button>
        <button type="button" disabled={working || busy || privacy} onClick={() => {setReview(!review);setApproved("");}}>Review data for AI analysis</button>
        <button type="button" disabled={working} onClick={() => void run(async () => {await disconnectCloud();setConnected(false);setSyncEnabled(false);setConflict(null);setReview(false);setApproved("");})}>Disconnect cloud</button>
      </> : <button type="button" disabled={working || busy} onClick={() => void run(async signal => {
        await connectCloud(signal);signal.throwIfAborted();setConnected(true);setNotice("Cloud connected. Your vault remains encrypted.");
      })}>Connect to Google Cloud</button>)}</div>
    </div>
    {!cloudConfigured && <p className="muted">Local checks are available. Cloud sync and AI require a configured Finance Atlas deployment.</p>}
    {connected && !syncEnabled && <p className="muted">Enabling sync uploads the encrypted vault and keeps it current as you save changes during this session.</p>}
    {working && <p role="status">Working with Finance Atlas Cloud…</p>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert" className="error">{error}</p>}
    {conflict && <div className="editor-note">
      <h3>Review different vault versions</h3>
      <p>Choose the version to keep. Finance Atlas saves both encrypted versions to local recovery before changing the active copy.</p>
      <div className="button-row">
        <button type="button" disabled={working || busy} onClick={() => download("Finance_Atlas_Local_Conflict.atlasenc", serializeEnvelope(envelope))}>Export local copy</button>
        <button type="button" disabled={working || busy} onClick={() => void run(async signal => download("Finance_Atlas_Cloud_Conflict.atlasenc", serializeEnvelope(await fetchSnapshot(conflict.head, signal))))}>Export cloud copy</button>
        <button type="button" disabled={working || busy} onClick={() => void run(signal => resolveConflict("", false, signal))}>Keep this device’s version</button>
      </div>
      <form onSubmit={event => {
        event.preventDefault();
        const form = event.currentTarget, passphrase = String(new FormData(form).get("cloudPassphrase") ?? "");
        form.reset();void run(signal => resolveConflict(passphrase, true, signal));
      }}>
        <label>Cloud vault passphrase <span className="muted">(leave blank if it matches this device)</span><input type="password" name="cloudPassphrase" autoComplete="off" disabled={working || busy} /></label>
        <button type="submit" disabled={working || busy}>Use cloud version</button>
      </form>
    </div>}
    {review && !privacy && <div className="editor-note">
      <h3>Approve the figures sent to Gemini</h3>
      <p>Reporting period {context.summary.start} through {context.summary.end}. Data as of {asOf}.</p>
      <ul>{context.summary.spending.map(item => <li key={item.id}>{item.id} · Actual {money(item.actual)} · Budget {money(item.budget)}</li>)}
        {context.summary.obligations.map(item => <li key={item.id}>{item.id} · {item.kind} · {item.status} · {item.dueDate} · {money(item.amount)}</li>)}</ul>
      <label className="checkbox"><input type="checkbox" checked={confirmed} onChange={event => setApproved(event.target.checked ? approvalKey : "")} />Send these figures for this analysis</label>
      <button type="button" disabled={!confirmed || working || busy} onClick={() => {setApproved("");void run(analyze);}}>Run both specialists</button>
    </div>}
    {reports.length > 0 && <p className="muted">{reports.join(" · ")}</p>}
  </section>, cloudMount)}
  <section className="panel section-gap" hidden={!visible} aria-label="Needs your attention">
    <div className="panel-head"><h2>Needs your attention</h2><button onClick={() => navigate("Documents")}>Documents</button></div>
    {items.length ? <ul className="attention-items">{items.map(item => <li key={item.id}>
      <strong>{privacy ? "Review item" : item.title}{(item as {stale?: boolean}).stale ? " · Stale" : ""}</strong>
      {!privacy && <p>{item.detail}</p>}
      <div className="button-row">
        <button type="button" onClick={() => navigate(item.view, item.target)}>Review</button>
        <button type="button" disabled={busy || working} onClick={() => void save(s => updateReview(s, item, "dismissed"))}>Dismiss</button>
        <button type="button" disabled={busy || working} onClick={() => void save(s => updateReview(s, item, "resolved"))}>Mark resolved</button>
      </div>
    </li>)}</ul> : <p className="muted">No open review items.</p>}
  </section></>;
}
