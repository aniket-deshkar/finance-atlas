import {useEffect, useEffectEvent, useRef, useState, type ReactNode} from "react";
import {Button, Dialog, Popover, Portal, Textarea} from "@chakra-ui/react";
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
import {GoogleMark} from "./welcome";

type Catalog = {enabled?: boolean; models: Model[]; maxOutput?: number; research: boolean};
type Result = {answer: string; references: string[]; usage?: Usage};
type Source = {view: View; id?: string};
type AttachedDocument = ExtractedDocument & {staged?: Staged[]};
const label = (view: View) => view === "Overview" ? "Dashboard" : view;
const sourceViews = views.filter(view => !["Assistant", "Data & settings", "Documents", "Receipts", "Cashback", "Reconciliation"].includes(view));

function ModelPicker({catalog, id, reasoning, select, reason}: {catalog: Catalog | null; id: string; reasoning: string;
  select: (id: string) => void; reason: (level: string) => void}) {
  const current = catalog?.models.find(model => model.id === id && model.enabled);
  const providers = [...new Set(catalog?.models.map(model => model.provider))];
  return <div className="filter-row assistant-models"><label>Model<select name="assistantModel" value={id} onChange={event => select(event.target.value)}>
    <option value="local">On-device figures</option>
    {id !== "local" && !catalog?.models.some(model => model.id === id) && <option value={id} disabled>Saved cloud model · unavailable</option>}
    {providers.map(provider => <optgroup key={provider} label={provider}>{catalog?.models.filter(model => model.provider === provider).map(model =>
      <option disabled={!model.enabled} key={model.id} value={model.id}>{model.label}{model.enabled ? "" : " · unavailable"}</option>)}</optgroup>)}</select></label>
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
    <p className="muted">{cloudConfigured ? "Connect your Google account to load the available cloud models and see usage." :
      "On-device figures are available in Assistant. Cloud models require a configured Finance Atlas deployment."}</p>
    {catalog?.enabled === false && <p role="status">Cloud AI is disabled on this deployment. On-device figures are available.</p>}
    <fieldset disabled={busy}><ModelPicker catalog={catalog} id={id} reasoning={field(defaults,"reasoning")}
      select={value => setDefault("model",value)} reason={value => setDefault("reasoning",value)} /></fieldset>
    {catalog?.models.map(model => <div className="atlas-provider-row" key={model.id}>
      <span className="atlas-provider-mark">{model.provider.startsWith("OpenAI") ? <img src="/brands/openai.svg" alt="OpenAI" width="48" height="17" /> : <GoogleMark />}</span>
      <div><strong>{model.label}</strong><small>{model.enabled ? model.provider + " · " + (model.processing || model.location) : model.unavailable || "Unavailable"}</small></div>
      {model.enabled && <small>${model.input} in / ${model.output} out per million tokens</small>}
    </div>)}
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

export function Assistant({ledger, month, asOf, view, target, vaultKey, scope, privacy, navigate, renderDocuments}: FeatureProps & {
  view: View; target: string; vaultKey: CryptoKey; scope: string; privacy: boolean; navigate: (view: View, id?: string) => void;
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
  const composer = useRef<HTMLTextAreaElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const review = useRef<HTMLDivElement>(null);
  const [cloudStatus, setCloudStatus] = useState<"disconnected" | "loading" | "ready" | "error">("disconnected");
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
      if (connected) {
        setCloudStatus("loading");
        void readCatalog(read.signal).then(result => {
          if (!read.signal.aborted && request === generation) {setCatalog(result);setCloudStatus("ready");}
        }).catch(() => {
          if (!read.signal.aborted && request === generation) {setCatalog(null);setCloudStatus("error");}
        });
      } else {setCatalog(null);setCloudStatus("disconnected");}
    });
    return () => {unsubscribe();read.abort();};
  }, [displayed]);
  useEffect(() => {
    const log = conversation.current;
    if (displayed && log) log.scrollTop = log.scrollHeight;
  }, [displayed, turns, loading]);

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
  const canSend = Boolean(rawQuestion && !privacy && !loading && (modelId === "local" || model));
  const reviewing = Boolean(model && canSend && approval === preview);

  useEffect(() => {if (reviewing) review.current?.focus();}, [reviewing]);

  async function send() {
    if (!canSend || (model && !reviewing) || !alive.current || controller.current) return;
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

  const choose = (id: string) => {setChosen(id);setLevel("");setApproval("");};
  const requestSend = () => {
    if (!canSend) return;
    if (model) setApproval(preview);
    else void send();
  };
  const chooseStarter = (item: typeof starters[number]) => {
    attach({view:item.view});setQuestion(item.text);composer.current?.focus();
  };

  const chat = <section className={"atlas-chat assistant-workspace " + (full ? "panel atlas-content-enter" : "")}>
      <header className="atlas-chat-bar"><div className="atlas-chat-heading"><span className="assistant-mark"><Icon name="chat" /></span><div>
        {full ? <h2>Finance Atlas Assistant</h2> : <Dialog.Title>Finance Atlas Assistant</Dialog.Title>}
        <p>{model ? model.label : "On-device · Private"}</p></div></div><div className="atlas-chat-actions">
        {!privacy && <Popover.Root positioning={{placement:"bottom-end", gutter:10}}>
          <Popover.Trigger asChild><button type="button" className="atlas-chat-tool atlas-chat-model-trigger" aria-label="Choose AI model" title="Choose AI model">Model <Icon name="down" /></button></Popover.Trigger>
          <Popover.Positioner className="atlas-chat-popover"><Popover.Content className="atlas-chat-model-panel">
            <Popover.Title>Choose a model</Popover.Title>
            <fieldset disabled={loading}><ModelPicker catalog={catalog} id={modelId} reasoning={preferred}
              select={choose} reason={value => {setLevel(value);setApproval("");}} /></fieldset>
            {cloudStatus === "loading" && <p role="status">Loading cloud models…</p>}
            {cloudStatus === "error" && <p role="status">Cloud models could not load. Check your connection in Settings.</p>}
            {cloudStatus === "disconnected" && cloudConfigured && <button type="button" onClick={() => {setFloating(false);navigate("Data & settings", "AI & providers");}}>Connect Google for cloud models</button>}
            {catalog?.enabled === false && <p>Cloud AI is disabled for this workspace.</p>}
            {!model && modelId !== "local" && <button type="button" onClick={() => choose("local")}>Switch to on-device answers</button>}
          </Popover.Content></Popover.Positioner>
        </Popover.Root>}
        {!full && <button type="button" className="atlas-chat-tool" aria-label="Open full Assistant" title="Open full Assistant" onClick={() => {navigate("Assistant");setFloating(false);}}><Icon name="expand" /></button>}
        {!full && <Dialog.CloseTrigger asChild><button className="atlas-chat-tool" aria-label="Close Assistant" title="Close Assistant" type="button"><Icon name="close" /></button></Dialog.CloseTrigger>}
        {!privacy && full && turns.length > 0 && <button className="atlas-chat-tool" aria-label="Clear chat" title="Clear chat" disabled={loading} onClick={() => setConfirmClear(true)}><Icon name="trash" /></button>}
      </div></header>
      {privacy ? <p className="atlas-chat-private">Show amounts to open your conversation and send questions.</p> : <>
      <div ref={conversation} className="atlas-chat-history" role="log" aria-label="Conversation">
        {!turns.length && <div className="atlas-chat-intro">
          <span className="atlas-chat-intro-mark"><Icon name="sparkle" /></span>
          <h3>How can I help?</h3>
          <div className="atlas-chat-starters">{starters.map(item => <button type="button" key={item.text} onClick={() => chooseStarter(item)}>
            {item.text}<Icon name="right" /></button>)}</div>
        </div>}
        {turns.map((turn,i) => <article className="atlas-message" data-role={turn.role} key={i}>
          <small>{turn.role === "user" ? "You" : "Assistant"}</small><p>{turn.text}</p>
          {turn.sources?.map(source => <button key={source.ref} onClick={() => {navigate(source.view,source.id);setFloating(false);}}>{source.label}</button>)}
        </article>)}
        {loading && <><article className="atlas-message" data-role="user"><small>You</small><p>{rawQuestion}</p></article>
          <article className="atlas-message" data-role="assistant"><small>Assistant</small><p>Preparing your answer…</p></article></>}
      </div>
      <form className="assistant-composer" onSubmit={event => {event.preventDefault();requestSend();}}>
        {(!model && modelId !== "local") && <div className="atlas-chat-status" role="status">Selected model unavailable. <button type="button" onClick={() => choose("local")}>Use on-device answers</button></div>}
        {attachments.length > 0 && <div className="atlas-chat-chips">{attachments.map(item => <button type="button" key={item.link.ref}
          disabled={loading} aria-label={"Remove reference to " + item.link.label}
          title={item.fact.start + " to " + item.fact.end}
          onClick={() => {if (item.link.view === "Documents") setLinkedDocument(null);
            else setSources(values => values.filter(x => x.view !== item.link.view));setApproval("");}}>{item.link.label}<Icon name="close" /></button>)}</div>}
        <label><span className="sr-only">Your question</span><Textarea unstyled name="assistantQuestion" autoComplete="off" ref={composer} rows={2} maxLength={1600} value={question} disabled={loading} onChange={event => {
          setQuestion(event.target.value);setApproval("");
        }} onKeyDown={event => {if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();requestSend();
        }}} placeholder="Ask about your finances…" /></label>
        <div className="atlas-chat-composer-tools">
          <div className="atlas-chat-attachments"><label><span className="sr-only">Reference another tab</span>
            <select name="assistantReference" value="" disabled={loading} onChange={event => {if(event.target.value) attach({view:event.target.value as View});}}>
              <option value="">+ Add context</option>{sourceViews.map(item => <option value={item} key={item}>{label(item)}</option>)}
            </select></label>
            {full && <button type="button" aria-expanded={attachment} disabled={loading} onClick={() => setAttachment(!attachment)}><Icon name="file" />Document</button>}
            {model && turns.length > 0 && <label className="atlas-chat-include-history"><input type="checkbox" name="includeHistory" disabled={loading} checked={includeHistory} onChange={event => {
              setIncludeHistory(event.target.checked);setApproval("");
            }} />Recent chat</label>}
          </div>
          <Button unstyled type="submit" className="primary assistant-send" aria-label="Send question" title="Send question" disabled={!canSend}><Icon name="send" /></Button>
        </div>
        {reviewing && model && <div className="atlas-chat-review" ref={review} tabIndex={-1}>
          <strong>Review this cloud message</strong>
          <p>{model.label} · {model.processing || model.location} · estimated up to {usd(estimate)}</p>
          <details><summary>View question and selected figures</summary><pre className="atlas-context">{preview}</pre></details>
          <div className="button-row"><button type="button" onClick={() => {setApproval("");composer.current?.focus();}}>Back</button>
            <button type="button" className="primary" onClick={() => void send()}>Send to {model.provider}</button></div>
        </div>}
      </form>
      {full && attachment && renderDocuments(document => {
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
      {message && <p className="atlas-chat-status" role="status">{message}</p>}
      </>}
    </section>;
  return <>
    {full ? chat : <>
      <Button unstyled ref={fab} className="atlas-assistant-fab assistant-floating" type="button"
        aria-label="Open Assistant" aria-haspopup="dialog" aria-expanded={floating} onClick={openFloating}>
        <Icon name="chat" /><span>Assistant</span>
      </Button>
      <Dialog.Root unstyled open={floating} onOpenChange={event => setFloating(event.open)} scrollBehavior="inside"
        finalFocusEl={() => fab.current} lazyMount unmountOnExit>
        <Portal><Dialog.Backdrop className="assistant-backdrop" />
          <Dialog.Positioner className="assistant-positioner"><Dialog.Content className="assistant-sheet">
            {chat}
          </Dialog.Content></Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>}
    {confirmClear && !privacy && <Editor title="Clear conversation?" close={() => setConfirmClear(false)} busy={loading}
      submit="Clear conversation" onSave={async () => {
        await deviceRecord(scope,"assistant-history",vaultKey,[]);
        setTurns([]);setIncludeHistory(false);setApproval("");
        return true;
      }}><p>This removes the local conversation history from this device.</p></Editor>}
  </>;
}
