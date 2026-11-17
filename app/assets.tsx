import {useEffect, useEffectEvent, useRef, useState} from "react";
import {financialYear, portfolio, putFinancialRecord, taxFigures, unitsScale, vehicleCosts, workspaceRows, yearLabel} from "../lib/assets";
import {checkedJson, cloudConfigured, cloudConnected, cloudFetch, json} from "../lib/cloud";
import {desktopInvoke,isDesktop} from "../lib/desktop";
import {dayShift, displayPeriod, field, minor, money, row, validDate, type Row} from "../lib/ledger";
import {deviceRecord} from "../lib/vault";
import {documentHints} from "../lib/documents";
import {useDocumentIndex} from "./documents";
import {amount, Editor, Input, Panel, Select, Table, value, type FeatureProps} from "./feature-ui";

function PublicSource({url,title}: {url:string; title:string}) {
  return <a href={url} target="_blank" rel="noreferrer" onClick={event => {
    if (!isDesktop()) return;
    event.preventDefault();
    void desktopInvoke("open_public_source",{address:url}).catch(() => {});
  }}>{title}</a>;
}

export function TaxView(props: FeatureProps & {openDocuments: () => void; scope: string; vaultKey: CryptoKey}) {
  const {ledger, asOf, save, openDocuments, scope, vaultKey} = props;
  const current = financialYear(asOf), [year, setYear] = useState(current);
  const [edit, setEdit] = useState(false);
  const [evidenceId, setEvidenceId] = useState("");
  const documents = useDocumentIndex(scope,vaultKey).filter(item => item.kind === "Tax evidence");
  const selected = documents.find(item => item.id === evidenceId);
  const suggestions = selected ? documentHints(selected) : undefined;
  const facts = taxFigures(ledger, year, asOf);
  return <div className="stack">
    <Panel title="India tax estimate" action={<div className="button-row"><button onClick={openDocuments}>Open evidence library</button>
      <button className="primary" onClick={() => setEdit(true)}>Review tax inputs</button></div>}>
      <label>Financial year<select value={year} onChange={event => setYear(Number(event.target.value))}>
        {[...new Set([current, 2026, 2025])].sort((a,b) => b-a).map(item => <option key={item} value={item}>{yearLabel(item)}</option>)}</select></label>
      {documents.length > 0 && <label>Extracted evidence to review<select value={evidenceId} onChange={event => setEvidenceId(event.target.value)}>
        <option value="">Use current ledger information</option>{documents.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      <p className="muted">For resident individuals under 60 with salary and interest only, up to ₹50 lakh gross income. Review credits for gross salary and confirm eligible deductions from your evidence.</p>
      <div className="atlas-stat-grid">
        <div>Paycheck credits in ledger <strong data-sensitive>{money(facts.ledgerSalary)}</strong></div>
        <div>Interest credits in ledger <strong data-sensitive>{money(facts.ledgerInterest)}</strong></div>
        <div>Confirmed gross salary <strong data-sensitive>{facts.inputs.salary === undefined ? "Needs review" : money(facts.salary)}</strong></div>
        <div>Confirmed TDS <strong data-sensitive>{facts.inputs.tds === undefined ? "Needs review" : money(facts.tds)}</strong></div>
      </div>
      {facts.estimate ? <Table headers={["Regime", "Estimated tax", "After TDS"]}>
        <tr><td>Old regime</td><td data-sensitive>{money(facts.estimate.old)}</td><td data-sensitive>{money(facts.estimate.oldAfterTds)}</td></tr>
        <tr><td>New regime</td><td data-sensitive>{money(facts.estimate.modern)}</td><td data-sensitive>{money(facts.estimate.modernAfterTds)}</td></tr>
      </Table> : <p className="muted">Confirm a supported tax year, income profile, and gross salary to compare both regimes.</p>}
      <PublicSource url="https://www.incometax.gov.in/iec/foportal/help/all-topics/e-filing-services/income-and-tax-estimator-um"
        title="Income Tax Department estimator guide" />
    </Panel>
    <Panel title="Capital gains to review">
      <p className="muted">Portfolio sales appear here. Review their acquisition records and tax treatment separately.</p>
      <Table headers={["Date", "Instrument", "Sale proceeds"]}>{workspaceRows(ledger,"investmentEvents")
        .filter(event => event.type === "Sell" && financialYear(field(event,"date")) === year)
        .map(event => <tr key={field(event,"id")}><td>{field(event,"date")}</td><td>{field(workspaceRows(ledger,"holdings").find(x => x.id === event.assetId) ?? {},"name")}</td>
          <td data-sensitive>{money(Number(event.amount))}</td></tr>)}</Table>
    </Panel>
    {edit && <Editor title={"Tax inputs · " + yearLabel(year)} {...props} close={() => setEdit(false)} onSave={data => save(s => {
      const inputs = ["salary","interest","tds","deductions"].map(key => amount(data,key));
      if (inputs.some(number => number < 0)) throw Error("Enter non-negative tax inputs.");
      return putFinancialRecord(s,"tax",{id:"tax-"+year, year, salary:inputs[0], interest:inputs[1], tds:inputs[2], deductions:inputs[3],
        eligible:data.has("eligible"), evidence:value(data,"evidence"), ...(selected ? {evidenceId:selected.id} : {})});
    })}>
      {selected && <p className="editor-note">Review suggested values against {selected.name} before saving.</p>}
      <Input name="salary" label="Gross salary from Form 16 ₹" initial={suggestions?.salary ?? (facts.inputs.salary === undefined ? "" : facts.salary / 100)} />
      <Input name="interest" label="Total interest from statements / AIS ₹" initial={suggestions?.interest ?? facts.interest / 100} />
      <Input name="tds" label="Total TDS confirmed against Form 26AS ₹" initial={suggestions?.tds ?? (facts.inputs.tds === undefined ? "" : facts.tds / 100)} />
      <Input name="deductions" label="Confirmed old-regime deductions excluding standard deduction ₹" initial={(Number(facts.inputs.deductions) || 0) / 100} />
      <Input name="evidence" label="Evidence notes" initial={field(facts.inputs,"evidence")} maxLength={300} required={false} />
      <label className="checkbox"><input name="eligible" type="checkbox" defaultChecked={facts.inputs.eligible === true} />
        Resident, under 60, salary and regular interest only for this estimate</label>
    </Editor>}
  </div>;
}

export function InvestmentsView(props: FeatureProps & {openDocuments: () => void}) {
  const {ledger, asOf, save, busy, openDocuments} = props;
  const [edit, setEdit] = useState<{type: "holding" | "event" | "price"; item?: Row} | null>(null);
  const [priceMessage, setPriceMessage] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const summary = portfolio(ledger,asOf);
  const autoQuote = row(ledger.settings.marketQuotes).auto === true;
  const ref = useRef<AbortController | null>(null);
  useEffect(() => () => ref.current?.abort(), []);
  async function refresh() {
    const candidates = summary.positions.filter(item => item.quantity > 0 && ["Mutual fund","Equity","ETF"].includes(field(item.asset,"kind")) &&
      /^\d{1,10}$/.test(field(item.asset,"symbol"))).slice(0, 25);
    if (!candidates.length) {setPriceMessage("Add a public AMFI scheme code or Dhan instrument ID first.");return;}
    const request = new AbortController();
    ref.current = request;setRefreshing(true);setPriceMessage("");
    try {
      const result = await checkedJson<{quotes: {id: string; date: string; price: number; source: string}[]}>(await cloudFetch("/v1/market/quotes", json({
        instruments: candidates.map((item,index) => ({id:String(index), kind:item.asset.kind, code:item.asset.symbol}))
      }, request.signal)));
      request.signal.throwIfAborted();
      const quotes = result.quotes.flatMap(quote => {
        const item = /^[0-9]{1,2}$/.test(quote.id) && candidates[Number(quote.id)];
        return item && validDate(quote.date) && quote.date <= asOf && Number.isSafeInteger(quote.price) && quote.price > 0 ?
          [{...quote,id:field(item.asset,"id")}] : [];
      });
      const saved = !quotes.length || await save(s => quotes.reduce((next, quote) => putFinancialRecord(next,"prices",{
        ...quote, id:quote.id + ":" + quote.date + ":" + quote.source, assetId:quote.id
      }),s));
      if (saved) setPriceMessage(quotes.length + " of " + candidates.length + " prices refreshed. Last available prices remain visible.");
    } catch (error) {if (!request.signal.aborted) setPriceMessage(error instanceof Error ? error.message : "Market feed unavailable.");}
    finally {if (!request.signal.aborted) setRefreshing(false);}
  }
  const refreshOnOpen = useEffectEvent(() => {
    if (cloudConnected() && summary.positions.some(item => item.quantity > 0 && field(item.asset,"symbol") &&
        (!item.quote || field(item.quote,"date") < dayShift(asOf,-1)))) void refresh();
  });
  useEffect(() => {if(autoQuote) refreshOnOpen();}, [autoQuote]);
  return <div className="stack"><Panel title="Portfolio" action={<div className="button-row">
    <button onClick={openDocuments}>Open statements</button><button onClick={() => setEdit({type:"holding"})} className="primary">Add instrument</button></div>}>
    <div className="atlas-stat-grid"><div>Current cost basis <strong data-sensitive>{money(summary.invested)}</strong></div>
      <div>Market value of priced positions <strong data-sensitive>{money(summary.marketValue)}</strong></div>
      <div>Priced positions <strong>{summary.valuedCount} of {summary.positions.filter(pos => pos.quantity > 0).length}</strong></div></div>
    <p className="muted">Prices are dated. AMFI and optional Dhan data refresh shares only public instrument IDs. Dhan requires its own active data entitlement.</p>
    <div className="button-row"><button disabled={!cloudConfigured || refreshing || busy} onClick={() => void refresh()}>Refresh market prices</button>
      <span role="status">{priceMessage || (!cloudConfigured ? "Market refresh requires a cloud deployment." : "")}</span></div>
    <label className="checkbox"><input type="checkbox" disabled={busy || !cloudConfigured} checked={autoQuote}
      onChange={event => {const enabled = event.target.checked;
        void save(s => ({...s,settings:{...s.settings,marketQuotes:{...row(s.settings.marketQuotes),auto:enabled}}}));
      }} />Refresh dated prices when I open Investments while connected</label>
    <Table headers={["Instrument", "Units", "Cost basis", "Value and price date", "Realised P/L", "Dividends", "Actions"]}>
      {summary.positions.map(item => <tr key={field(item.asset,"id")}><td><strong>{field(item.asset,"name")}</strong><br /><small>{field(item.asset,"kind")}</small>{item.invalid && <p>Review trade quantities.</p>}</td>
        <td data-sensitive>{item.quantity / unitsScale}</td><td data-sensitive>{money(item.cost)}</td><td data-sensitive>{item.worth === null ? "Price required" :
          <>{money(item.worth)}<br /><small>{field(item.quote!,"date")} · {field(item.quote!,"source")}</small></>}</td>
        <td data-sensitive>{money(item.realised)}</td><td data-sensitive>{money(item.dividends)}</td><td><div className="button-row">
          <button onClick={() => setEdit({type:"holding",item:item.asset})}>Edit</button>
          <button onClick={() => setEdit({type:"event",item:item.asset})}>Add activity</button>
          <button onClick={() => setEdit({type:"price",item:item.asset})}>Set price</button></div></td></tr>)}</Table>
    {!summary.positions.length && <p className="muted">Add an instrument and record purchases or an opening position.</p>}
  </Panel>
  {edit && <Editor title={edit.type === "holding" ? "Instrument" : edit.type === "event" ? "Investment activity" : "Dated price"} {...props}
    close={() => setEdit(null)} onSave={data => save(s => {
      const id = crypto.randomUUID();
      if (edit.type === "holding") return putFinancialRecord(s,"holdings",{id:edit.item?.id || id,
        name:value(data,"name"),kind:value(data,"kind"),symbol:value(data,"symbol")});
      const date = value(data,"date"), assetId = field(edit.item ?? {},"id"), paise = amount(data,"amount");
      if (!assetId || !validDate(date) || date > asOf || paise <= 0) throw Error("Choose a valid date and positive amount.");
      if (edit.type === "price") return putFinancialRecord(s,"prices",{id:assetId+":"+date+":manual",assetId,date,price:paise,source:"Manual"});
      const type = value(data,"type"), raw = value(data,"units");
      const units = type === "Dividend" ? 0 : /^\d{1,8}(?:\.\d{1,6})?$/.test(raw) ? Math.round(Number(raw) * unitsScale) : 0;
      if (type !== "Dividend" && (!units || !Number.isSafeInteger(units))) throw Error("Enter positive units with up to six decimals.");
      const next = putFinancialRecord(s,"investmentEvents",{id,assetId,date,amount:paise,units,type});
      if (portfolio(next,asOf).positions.find(pos => pos.asset.id === assetId)?.invalid) throw Error("The sale exceeds units available on that date.");
      return next;
    })}>
    {edit.type === "holding" ? <>
      <Input name="name" label="Instrument name" initial={field(edit.item ?? {},"name")} maxLength={100} />
      <Select name="kind" label="Asset type" initial={field(edit.item ?? {},"kind") || "Mutual fund"}
        options={["Mutual fund","Equity","ETF","Other"].map(name => ({id:name,name}))} />
      <Input name="symbol" label="AMFI scheme code or Dhan instrument ID" initial={field(edit.item ?? {},"symbol")} required={false} maxLength={12} />
    </> : <>
      <Input type="date" name="date" label="Date" initial={asOf} max={asOf} />
      {edit.type === "event" && <>
        <Select name="type" label="Activity" initial="Buy" options={["Buy","Sell","Dividend"].map(name => ({id:name,name}))} />
        <Input name="units" label="Units (leave blank for dividends)" required={false} />
      </>}
      <Input name="amount" label={edit.type === "price" ? "Price per unit ₹" : "Total amount including buy fees or net sale proceeds ₹"} />
    </>}
  </Editor>}
  <SchemeComparison {...props} />
  </div>;
}

function SchemeComparison(props: FeatureProps) {
  const {ledger,save,busy} = props;
  const [editor,setEditor] = useState<Row | null>(null);
  const schemes = workspaceRows(ledger,"schemes");
  return <Panel title="Compare investment schemes" action={<button onClick={() => setEditor({})}>Add scheme to compare</button>}>
    <p className="muted">Use the scheme factsheet to compare cost, risk, lock-in and fit for your goal.</p>
    <Table headers={["Scheme / goal","Riskometer","Expense ratio","Liquidity / horizon","Source","Actions"]}>
      {schemes.map(item => <tr key={field(item,"id")}><td><strong>{field(item,"name")}</strong><br />{field(item,"goal")}</td>
        <td>{field(item,"risk")}</td><td>{String(item.expense)}%</td><td>{field(item,"liquidity")} / {field(item,"horizon")}</td>
        <td>{field(item,"source").startsWith("https://") && <PublicSource url={field(item,"source")} title="Factsheet" />}</td>
        <td><div className="button-row"><button onClick={() => setEditor(item)}>Edit</button><button disabled={busy} onClick={() => void save(s => ({
          ...s,settings:{...s.settings,financialRecords:{...row(s.settings.financialRecords),schemes:workspaceRows(s,"schemes").filter(scheme => scheme.id !== item.id)}}
        }))}>Remove</button></div></td></tr>)}
    </Table>
    {editor && <Editor title="Scheme comparison" {...props} close={() => setEditor(null)} onSave={data => save(s => {
      const source = value(data,"source"), parsed = new URL(source);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw Error("Use a public HTTPS factsheet link.");
      const expense = Number(value(data,"expense"));
      if (!Number.isFinite(expense) || expense < 0 || expense > 100) throw Error("Enter the expense ratio as a percentage.");
      return putFinancialRecord(s,"schemes",{id:editor.id || crypto.randomUUID(),name:value(data,"name"),goal:value(data,"goal"),
        risk:value(data,"risk"),expense,liquidity:value(data,"liquidity"),horizon:value(data,"horizon"),source:parsed.href});
    })}>
      <Input name="name" label="Scheme name" initial={field(editor,"name")} maxLength={120} />
      <Input name="goal" label="Goal" initial={field(editor,"goal")} maxLength={100} />
      <Select name="risk" label="Published risk level" initial={field(editor,"risk") || "Unknown"}
        options={["Unknown","Low","Low to Moderate","Moderate","Moderately High","High","Very High"].map(name => ({name,id:name}))} />
      <Input name="expense" label="Expense ratio %" initial={Number(editor.expense) || 0} />
      <Input name="liquidity" label="Redemption or lock-in terms" initial={field(editor,"liquidity")} maxLength={120} />
      <Input name="horizon" label="Investment horizon" initial={field(editor,"horizon")} maxLength={100} />
      <Input name="source" label="Factsheet HTTPS link" initial={field(editor,"source")} maxLength={1000} />
    </Editor>}
  </Panel>;
}

export function VehiclesView(props: FeatureProps) {
  const {ledger, month, asOf, save} = props;
  const [edit,setEdit] = useState<Row | null>(null);
  const [link,setLink] = useState<Row | null>(null);
  const period = displayPeriod(ledger,month,asOf);
  const vehicles = workspaceRows(ledger,"vehicles");
  const loans = ledger.loans.filter(loan => field(loan,"id"));
  return <div className="stack"><Panel title="Vehicle records" action={<button className="primary" onClick={() => setEdit({})}>Add vehicle</button>}>
    {!vehicles.length && <p className="muted">Add a vehicle to track service dates, related finance and ownership expenses.</p>}
    <div className="account-grid">{vehicles.map(vehicle => <article className="account" key={field(vehicle,"id")}>
      <h3>{field(vehicle,"name")}</h3><p>{Number(vehicle.odometer || 0).toLocaleString("en-IN")} km</p>
      <p>Period costs <strong data-sensitive>{money(vehicleCosts(ledger,field(vehicle,"id"),period.start,period.end,asOf))}</strong></p>
      {["insurance","service","registration"].map(key => field(vehicle,key) && <p key={key}>{key === "registration" ? "Registration" : key === "service" ? "Service" : "Insurance"} · {field(vehicle,key)}</p>)}
      {field(vehicle,"loanId") && <p>Linked EMI · {field(loans.find(loan => loan.id === vehicle.loanId) ?? {},"name")}</p>}
      <div className="button-row"><button onClick={() => setEdit(vehicle)}>Edit vehicle</button><button onClick={() => setLink(vehicle)}>Link a transaction</button></div>
    </article>)}</div>
  </Panel>
  {edit && <Editor title="Vehicle details" {...props} close={() => setEdit(null)} onSave={data => save(s => putFinancialRecord(s,"vehicles",{
    id:edit.id || crypto.randomUUID(), name:value(data,"name"),odometer:Number(value(data,"odometer") || 0),
    insurance:value(data,"insurance"),service:value(data,"service"),registration:value(data,"registration"),loanId:value(data,"loan")
  }))}>
    <Input name="name" label="Vehicle name" initial={field(edit,"name")} maxLength={100} />
    <Input name="odometer" label="Odometer km" type="number" min={0} initial={Number(edit.odometer) || 0} />
    <Input name="service" label="Next service date" type="date" initial={field(edit,"service")} required={false} />
    <Input name="insurance" label="Insurance renewal" type="date" initial={field(edit,"insurance")} required={false} />
    <Input name="registration" label="Registration renewal" type="date" initial={field(edit,"registration")} required={false} />
    <Select name="loan" label="Linked EMI plan" required={false} initial={field(edit,"loanId")}
      options={loans.map(loan => ({id:field(loan,"id"),name:field(loan,"name") || "Loan"}))} />
  </Editor>}
  {link && <Editor title="Link a recorded vehicle expense" {...props} close={() => setLink(null)} onSave={data => save(s => {
    const id = value(data,"transaction");
    if (!s.transactions.some(t => t.id === id && ["expense","refund"].includes(t.type))) throw Error("Choose a recorded expense or refund.");
    return putFinancialRecord(s,"vehicleLinks",{id,transactionId:id,vehicleId:link.id,classification:value(data,"classification")});
  })}>
    <Select name="transaction" label="Transaction" options={[...ledger.transactions].reverse().filter(t => ["expense","refund"].includes(t.type)).slice(0,250)
      .map(t => ({id:t.id,name:t.date + " · " + (t.note || t.category || "Transaction") + " · " + money(minor(t.amount))}))} />
    <Select name="classification" label="Ownership cost" initial="Fuel or charging" options={["Fuel or charging","Service","Insurance","Loan payment","Other"].map(name => ({id:name,name}))} />
  </Editor>}
  </div>;
}

type PolicyResult = {answer: string; sources: {title: string; url: string}[]; at?: string};
export function PolicyResearch({vaultKey, scope}: {vaultKey: CryptoKey; scope: string}) {
  const [publicInfo,setPublicInfo] = useState({insurer:"",product:"",uin:""});
  const [approved,setApproved] = useState(false);
  const [result,setResult] = useState<PolicyResult | null>(null);
  const [status,setStatus] = useState("");
  const [working,setWorking] = useState(false);
  const [evidenceId,setEvidenceId] = useState("");
  const documents = useDocumentIndex(scope,vaultKey).filter(document => document.kind === "Policy");
  const evidence = documents.find(document => document.id === evidenceId);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    let active = true;
    void deviceRecord<PolicyResult>(scope,"policy-research",vaultKey).then(value => {if(active && value) setResult(value);}).catch(() => {});
    return () => {active=false;controller.current?.abort();};
  },[scope,vaultKey]);
  return <Panel title="Policy Research">
    <p className="muted">Look up insurer and regulator documents using the public product name and optional IRDAI UIN. Compare the results with your own policy wording.</p>
    {documents.length > 0 && <label>Policy kept on this device<select value={evidenceId} onChange={event => {
      const id = event.target.value, document = documents.find(item => item.id === id);
      setEvidenceId(id);setApproved(false);
      const hints = document ? documentHints(document) : {insurer:"",product:"",uin:""};
      setPublicInfo({insurer:hints.insurer,product:hints.product,uin:hints.uin});
    }}><option value="">Enter public product details</option>
      {documents.map(document => <option value={document.id} key={document.id}>{document.name}</option>)}</select></label>}
    <form className="stack" onSubmit={async event => {
      event.preventDefault();
      if (!approved || working) return;
      const request = new AbortController();
      controller.current = request;setApproved(false);setWorking(true);setStatus("");
      try {
        const research = await checkedJson<PolicyResult>(await cloudFetch("/v1/ai/policy",json({id:crypto.randomUUID(),...publicInfo},request.signal)));
        request.signal.throwIfAborted();
        const dated = {...research, at:new Date().toISOString()};
        await deviceRecord(scope,"policy-research",vaultKey,dated);setResult(dated);
      } catch(error) {if(!request.signal.aborted) setStatus(error instanceof Error ? error.message : "Policy research failed.");}
      finally {if(!request.signal.aborted) setWorking(false);}
    }}><div className="filter-row">
      {([["insurer","Insurer"],["product","Public product name"],["uin","Public UIN (optional)"]] as const).map(([key,label]) =>
        <label key={key}>{label}<input value={publicInfo[key]} required={key !== "uin"} maxLength={key === "uin" ? 25 : 100}
          onChange={event => {setPublicInfo({...publicInfo,[key]:event.target.value});setApproved(false);}} /></label>)}
    </div><label className="checkbox"><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} />
      Send these public product identifiers to Vertex AI and Google Search</label>
    <button className="primary" disabled={!cloudConfigured || working || !approved}>Search policy wording</button></form>
    {!cloudConfigured && <p className="muted">Configure cloud AI to enable research.</p>}
    {status && <p role="status">{status}</p>}
    {result && <article className="atlas-message"><h3>Latest research {result.at?.slice(0,10)}</h3><p>{result.answer}</p>
      <ul>{result.sources.filter(item => item.url.startsWith("https://")).map((item,index) =>
        <li key={index}><PublicSource url={item.url} title={item.title} /></li>)}</ul></article>}
    {evidence && <details><summary>Compare your policy wording</summary><div className="atlas-document-preview" data-sensitive>
      {evidence.pages.map((text,index) => <div key={index}><strong>Page {index + 1}</strong><p>{text.slice(0,6000)}</p></div>)}
    </div></details>}
  </Panel>;
}
