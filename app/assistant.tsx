import {useEffect, useEffectEvent, useRef, useState, type ReactNode} from "react";
import {createPortal} from "react-dom";
import {assistantFact, localAnswer, usd, type Fact, type Model, type Turn, type Usage} from "../lib/assistant";
import {checkedJson, cloudConfigured, cloudFetch, json, watchCloudConnection} from "../lib/cloud";
import {field, row} from "../lib/ledger";
import {viewIds, views, type View} from "../lib/navigation";
import {deviceRecord} from "../lib/vault";
import {documentHints, type ExtractedDocument} from "../lib/documents";
import {minor} from "../lib/ledger";
import type {Staged} from "../lib/files";
import {Editor, type FeatureProps} from "./feature-ui";
import {Icon} from "./icons";

type Catalog = {enabled?: boolean; models: Model[]; maxOutput?: number; research: boolean};
type Result = {answer: string; references: string[]; usage?: Usage};
type Source = {view: View; id?: string};
type AttachedDocument = ExtractedDocument & {staged?: Staged[]};
const label = (view: View) => view === "Overview" ? "Dashboard" : view;
const sourceViews = views.filter(view => !["Assistant", "Data & settings", "Documents", "Receipts", "Cashback", "Reconciliation"].includes(view));

function ModelPicker({catalog, id, reasoning, select, reason}: {catalog: Catalog | null; id: string; reasoning: string;
  select: (id: string) => void; reason: (level: string) => void}) {
  const current = catalog?.models.find(model => model.id === id && model.enabled);
  return <div className="filter-row"><label>Model<select value={current ? id : "local"} onChange={event => select(event.target.value)}>
    <option value="local">On-device figures</option>
    {catalog?.models.filter(model => model.enabled).map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>
    {current && <label>Reasoning<select value={current.levels.includes(reasoning) ? reasoning : current.fallback}
      onChange={event => reason(event.target.value)}>{current.levels.map(level => <option key={level}>{level}</option>)}</select></label>}
  </div>;
}

async function readCatalog(signal?: AbortSignal) {
  return checkedJson<Catalog>(await cloudFetch("/v1/ai/models", {signal}));
}

export function AssistantSettings({ledger, save, busy, cloudControls}: FeatureProps & {cloudControls: ReactNode}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [usage, setUsage] = useState<{month: string; used: number; limit: number; runs: Usage[]} | null>(null);
  const [message, setMessage] = useState("");
  const defaults = row(ledger.settings.assistantPreferences), id = field(defaults, "model") || "local";
  function setDefault(key: string, value: string) {
    void save(s => ({...s, settings: {...s.settings, assistantPreferences: {...row(s.settings.assistantPreferences), [key]: value}}}));
  }
  async function refresh(signal?: AbortSignal) {
    setMessage("");
    try {
      const models = await readCatalog(signal);
      signal?.throwIfAborted();
      setCatalog(models);
      if (models.enabled === false) {
        setUsage(null);
        return;
      }
      setUsage(await cloudFetch("/v1/ai/usage", {signal}).then(checkedJson<NonNullable<typeof usage>>));
    } catch (error) {if (!signal?.aborted) setMessage(error instanceof Error ? error.message : "Cloud AI is unavailable.");}
  }
  const load = useEffectEvent(refresh);
  useEffect(() => {
    let request: AbortController | undefined;
    const unsubscribe = watchCloudConnection(connected => {
      request?.abort();
      if (!connected) {setCatalog(null);setUsage(null);setMessage("");return;}
      request = new AbortController();
      void load(request.signal);
    });
    return () => {unsubscribe();request?.abort();};
  }, []);
  return <div className="stack atlas-ai-settings">{cloudControls}<section className="panel stack"><h2>AI & providers</h2>
    <p className="muted">{cloudConfigured ? "Connect to Google Cloud, then refresh the enabled models and usage." :
      "On-device figures are available in Assistant. Cloud models require a configured Finance Atlas deployment."}</p>
    {catalog?.enabled === false && <p role="status">Cloud AI is disabled on this deployment. On-device figures are available.</p>}
    <fieldset disabled={busy}><ModelPicker catalog={catalog} id={id} reasoning={field(defaults,"reasoning")}
      select={value => setDefault("model",value)} reason={value => setDefault("reasoning",value)} /></fieldset>
    {catalog?.models.filter(model => model.enabled).map(model => <p key={model.id} className="muted">{model.label} · {model.provider} · {model.location} · ${model.input} / ${model.output} per million input / output tokens</p>)}
    <p className="muted">The backend controls which models and provider destinations are enabled. Direct OpenAI is disabled.</p>
    {cloudConfigured && <button onClick={() => void refresh()}>Refresh models and AI usage</button>}
    {message && <p role="status">{message}</p>}
  </section><section className="panel stack"><h2>AI usage</h2>
    {usage ? <><p>{usage.month} · {usd(usage.used)} used or reserved of {usd(usage.limit)}</p>
      {usage.runs.length ? <div className="table-scroll"><table><thead><tr>{["Time", "Model", "Reasoning", "Run", "Tokens in / out", "Calls", "Searches", "Estimate", "Usage cost"].map(name => <th key={name}>{name}</th>)}</tr></thead>
      <tbody>{usage.runs.map(run => <tr key={run.id}><td>{run.at ? new Date(run.at).toLocaleString("en-IN") : "—"}</td><td>{run.model}</td>
        <td>{run.reasoning}</td><td>{run.kind} · {run.status}</td><td>{run.input ?? "—"} / {run.output ?? "—"}</td><td>{run.calls ?? "—"}</td>
        <td>{run.search ?? "—"}</td><td data-sensitive>{usd(run.estimate)}</td><td data-sensitive>{run.cost === null ? "Unknown" : usd(run.cost)}</td></tr>)}</tbody></table></div>
       : <p className="muted">No cloud prompts logged this month.</p>}</> : <p className="muted">Usage appears here after connecting to the cloud.</p>}
  </section></div>;
}

export function Assistant({ledger, month, asOf, view, target, vaultKey, scope, privacy, navigate, renderDocuments, launcher}: FeatureProps & {
  view: View; target: string; vaultKey: CryptoKey; scope: string; privacy: boolean; navigate: (view: View, id?: string) => void;
  launcher: HTMLElement | null;
  renderDocuments: (onReference: (document: AttachedDocument) => void) => ReactNode;
}) {
  const full = view === "Assistant";
  const [floating, setFloating] = useState(false);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [includeHistory, setIncludeHistory] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [attachment, setAttachment] = useState(false);
  const [linkedDocument, setLinkedDocument] = useState<{label: string; id: string; fact: Fact} | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [level, setLevel] = useState("");
  const [approval, setApproval] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const controller = useRef<AbortController | null>(null);
  const fab = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);
  const displayed = full || floating;
  useEffect(() => {if (privacy) controller.current?.abort();}, [privacy]);
  useEffect(() => {
    alive.current = true;
    let generation = 0;
    const read = () => {
      const request = ++generation;
      void deviceRecord<Turn[]>(scope, "assistant-history", vaultKey).then(history => {
        if (alive.current && request === generation && history) setTurns(history);
      }).catch(() => {if (alive.current && request === generation) setMessage("Local conversation history could not be read.");});
    };
    read();
    window.addEventListener("atlas-device-library-restored", read);
    return () => {
      generation++;alive.current = false;controller.current?.abort();
      window.removeEventListener("atlas-device-library-restored", read);
    };
  }, [scope, vaultKey]);
  useEffect(() => {
    if (!displayed || !cloudConfigured) return;
    const read = new AbortController();
    let generation = 0;
    const unsubscribe = watchCloudConnection(connected => {
      const request = ++generation;
      if (connected) void readCatalog(read.signal).then(result => {
        if (!read.signal.aborted && request === generation) setCatalog(result);
      }).catch(() => {});
      else setCatalog(null);
    });
    return () => {unsubscribe();read.abort();};
  }, [displayed]);
  useEffect(() => {
    if (!floating || full) return;
    composer.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {setFloating(false);fab.current?.focus();}
    };
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !drawer.current?.contains(target) && !fab.current?.contains(target)) setFloating(false);
    };
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", closeOutside);
    return () => {document.removeEventListener("keydown", close);document.removeEventListener("pointerdown", closeOutside);};
  }, [floating, full]);

  const defaults = row(ledger.settings.assistantPreferences);
  const modelId = chosen ?? (field(defaults, "model") || "local");
  const model = catalog?.models.find(item => item.id === modelId && item.enabled);
  const preferred = level || field(defaults, "reasoning");
  const reasoning = model && (model.levels.includes(preferred) ? preferred : model.fallback);
  const attachments: {fact:Fact; link:{ref:string; view:View; id?:string; label:string}}[] = sources.flatMap(item => {
    const ref = viewIds[item.view];
    const fact = assistantFact(ledger, item.view, ref, month, asOf, item.id);
    return fact ? [{fact, link: {ref, view:item.view, id:item.id, label:label(item.view)}}] : [];
  });
  if (linkedDocument) attachments.splice(5, attachments.length - 5);
  if (linkedDocument) attachments.push({fact:linkedDocument.fact,link:{ref:linkedDocument.fact.ref,view:"Documents",id:linkedDocument.id,label:linkedDocument.label}});
  const context = attachments.map(item => item.fact);
  const history = includeHistory ? turns.slice(-4).map(turn => ({role:turn.role, text:turn.text.slice(0,1000)})) : [];
  const rawQuestion = question.trim();
  const bytes = new TextEncoder().encode(JSON.stringify([rawQuestion,context,history])).length;
  const estimate = model ? Math.ceil((bytes + 1200) * 3 * (model.input ?? 0) + (catalog?.maxOutput ?? 768) * 3 * (model.output ?? 0)) : 0;
  const preview = JSON.stringify({model:model?.id, reasoning, question:rawQuestion, context, history}, null, 2);
  const canSend = Boolean(rawQuestion && !privacy && !loading && (modelId === "local" || model && approval === preview));

  async function send() {
    if (!canSend || !alive.current || controller.current) return;
    const signal = new AbortController();
    controller.current = signal;
    setLoading(true);setMessage("");setApproval("");setIncludeHistory(false);
    try {
      const result: Result = model ? await checkedJson<Result>(await cloudFetch("/v1/ai/chat", json({
        id:crypto.randomUUID(), model:model.id, reasoning, question:rawQuestion, context, history
      }, AbortSignal.any([signal.signal, AbortSignal.timeout(60_000)])))) : localAnswer(rawQuestion, context);
      signal.signal.throwIfAborted();
      const next: Turn[] = [...turns,{role:"user",text:rawQuestion},
        {role:"assistant",text:result.answer,sources:attachments.filter(item => result.references.includes(item.fact.ref)).map(item => item.link)}].slice(-50) as Turn[];
      await deviceRecord(scope,"assistant-history",vaultKey,next);
      if (!signal.signal.aborted && alive.current) {
        setTurns(next);setQuestion("");
        if (result.usage) setMessage(result.usage.cost === null ? "Usage cost unavailable for this run." : "Usage cost " + usd(result.usage.cost));
      }
    } catch(error) {if (!signal.signal.aborted && alive.current) setMessage(error instanceof Error ? error.message : "Assistant could not answer.");}
    finally {controller.current = null;if (alive.current) setLoading(false);}
  }
  const attach = (item: Source) => {
    setSources(values => [item, ...values.filter(x => x.view !== item.view)].slice(0, 6));
    setApproval("");
  };
  const starters: {text: string; view: View}[] = [
    {text: "How much have I saved?", view: "Overview"},
    {text: "What payments are coming up?", view: "Payment calendar"},
    {text: "Am I within my budget?", view: "Monthly budget"},
  ];
  function openFloating() {
    if (!floating) {
      if (assistantFact(ledger, view, viewIds[view], month, asOf, target)) attach({view,id:target});
      setFloating(true);
    } else setFloating(false);
  }

  return <>
    {!full && launcher && createPortal(<button ref={fab} className="atlas-assistant-fab" type="button"
      aria-label={floating ? "Close Assistant" : "Open Assistant"} aria-expanded={floating}
      onClick={openFloating}><Icon name="chat" /></button>, launcher)}
    {displayed && <section ref={drawer} role={full ? undefined : "dialog"} aria-label="Finance Atlas Assistant"
      className={"panel stack atlas-chat " + (full ? "atlas-content-enter" : "atlas-chat-drawer")}>
      <header className="panel-head"><div className="atlas-chat-heading"><span className="atlas-chat-kicker">YOUR FINANCIAL COPILOT</span><h2>{full ? "Ask Finance Atlas" : "Assistant"}</h2>
        <p>Review the figures you choose. Cloud questions always ask for your approval.</p></div><div className="button-row">
        {!full && <button onClick={() => {navigate("Assistant");setFloating(false);}}>Open full Assistant</button>}
        {!full && <button onClick={() => {setFloating(false);fab.current?.focus();}}>Close</button>}
        {!privacy && turns.length > 0 && <button disabled={loading} onClick={() => setConfirmClear(true)}>Clear chat</button>}
      </div></header>
      {privacy ? <p>Show amounts to open your conversation and send questions.</p> : <>
      <div className="atlas-chat-history" role="log" aria-label="Conversation">
        {!turns.length && <div className="atlas-chat-intro">
          <Icon name="chat" />
          <h3>What would you like to review?</h3>
          <p className="muted">Choose a question to attach the relevant figures, or write your own.</p>
          <div className="button-row">{starters.map(item => <button type="button" key={item.text} onClick={() => {
            attach({view: item.view});setQuestion(item.text);composer.current?.focus();
          }}>{item.text}</button>)}</div>
        </div>}
        {turns.map((turn,i) => <article className="atlas-message" data-role={turn.role} key={i}>
          <small>{turn.role === "user" ? "You" : "Assistant"}</small><p>{turn.text}</p>
          {turn.sources?.map(source => <button key={source.ref} onClick={() => {navigate(source.view,source.id);setFloating(false);}}>{source.label}</button>)}
        </article>)}
      </div>
      <form className="stack" onSubmit={event => {event.preventDefault();void send();}}>
        <fieldset disabled={loading}><ModelPicker catalog={catalog} id={modelId} reasoning={preferred}
          select={id => {setChosen(id);setLevel("");setApproval("");}} reason={value => {setLevel(value);setApproval("");}} /></fieldset>
        {!model && <p className="muted">{modelId === "local" ? "On-device mode answers with attached figures. Connect a cloud model in Settings for broader questions." :
          "The selected cloud model is unavailable. Reconnect in Settings or choose On-device figures."}</p>}
        {!model && modelId !== "local" && <button type="button" onClick={() => {setChosen("local");setApproval("");}}>Use on-device figures</button>}
        <div className="button-row"><label><span className="sr-only">Reference another tab</span>
          <select name="assistantReference" value="" onChange={event => {if(event.target.value) attach({view:event.target.value as View});}}>
            <option value="">@ Reference a tab</option>
            {sourceViews.map(item =>
              <option value={item} key={item}>{label(item)}</option>)}
          </select></label>
          <button type="button" aria-expanded={attachment} onClick={() => setAttachment(!attachment)}>Add document figures</button>
        </div>
        {attachments.length > 0 && <div className="button-row">{attachments.map(item => <button type="button" key={item.link.ref}
          title={item.fact.start + " to " + item.fact.end}
          onClick={() => {if (item.link.view === "Documents") setLinkedDocument(null);
            else setSources(values => values.filter(x => x.view !== item.link.view));setApproval("");}}>{item.link.label} ×</button>)}</div>}
        <label>Your question<textarea name="assistantQuestion" autoComplete="off" ref={composer} rows={3} maxLength={1600} value={question} onChange={event => {
          setQuestion(event.target.value);setApproval("");
        }} placeholder="How much have I saved in this period?" /></label>
        {model && rawQuestion && <>
          <p className="muted">{model.provider} · {model.location} · {model.label} · {reasoning} · estimated up to {usd(estimate)}</p>
          <p className="muted">Only the question and figures below are sent. Original documents stay on this device.</p>
          {turns.length > 0 && <label className="checkbox"><input type="checkbox" name="includeHistory" checked={includeHistory} onChange={event => {
            setIncludeHistory(event.target.checked);setApproval("");
          }} />Include up to four previous messages</label>}
          <details><summary>Review what will be sent</summary><pre className="atlas-context">{preview}</pre></details>
          <label className="checkbox"><input type="checkbox" checked={approval === preview} onChange={event => setApproval(event.target.checked ? preview : "")} />
            Send the reviewed information to {model.provider} for this reply</label>
        </>}
        <button className="primary" disabled={!canSend}>{loading ? "Preparing answer…" : "Send question"}</button>
      </form>
      {attachment && renderDocuments(document => {
        const hints = documentHints(document);
        const values: Record<string,number> = {};
        if (document.kind === "Tax evidence") for (const key of ["salary","interest","tds"] as const) {
          const value = hints[key];
          if (value !== undefined) values[key] = minor(value);
        }
        if (document.staged?.length) {
          values.debit = document.staged.reduce((total, line) => total + Math.max(0,-line.signed),0);
          values.credit = document.staged.reduce((total, line) => total + Math.max(0,line.signed),0);
          values.count = document.staged.length;
        }
        if (!Object.keys(values).length) {setMessage("This document has no supported figures to attach. You can enter the values in your question.");return;}
        const dates = document.staged?.map(item => item.entry.date).sort();
        const ref = document.kind === "Tax evidence" ? "tax-document" : "statement-document";
        setLinkedDocument({id:document.id,label:document.name,fact:{ref,start:dates?.[0] ?? document.date,end:dates?.at(-1) ?? document.date,values}});
        setAttachment(false);setApproval("");setMessage("Extracted figures attached for review.");
      })}
      {message && <p role="status">{message}</p>}
      </>}
    </section>}
    {confirmClear && !privacy && <Editor title="Clear conversation?" close={() => setConfirmClear(false)} busy={loading}
      submit="Clear conversation" onSave={async () => {
        await deviceRecord(scope,"assistant-history",vaultKey,[]);
        setTurns([]);setIncludeHistory(false);setApproval("");
        return true;
      }}><p>This removes the local conversation history from this device.</p></Editor>}
  </>;
}
