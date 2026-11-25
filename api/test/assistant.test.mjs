import test from "node:test";
import assert from "node:assert/strict";
import {createApi} from "../app.mjs";
import {assistantCatalog} from "../assistant.mjs";
import {parseNav} from "../market.mjs";

const id = "2c8d72ab-a0e1-462c-870f-4192a186f4dd";
const token = "abcdefgh.abcdefghi.abcdefghijk";
const model = "gemini-4-hydrogen";
const auth = {authorization:"Bearer " + token};
const catalog = assistantCatalog({[model]:{location:"global", input:1.5,output:7.5}});
const body = {id,model,reasoning:"low",question:"What did I save?",history:[],
  context:[{ref:"overview",start:"2026-11-01",end:"2026-11-30",values:{savings:2400000}}]};

test("owner-only chat accepts bounded approved facts, accounts for usage and rejects replay", async t => {
  let dispatched = 0;
  const runs = new Map();
  const api = await createApi({ownerUid:"owner",verifyToken:async value => ({uid:value === token ? "owner" : "other"}),storage:{},rateLimitEnabled:false,
    assistant:{catalog,usage:{
      read:async () => ({runs:[...runs.values()]}),
      reserve:async metadata => {if(runs.has(metadata.id)) return null;runs.set(metadata.id,metadata);return "2026-11";},
      finish:async (metadata,_month,outcome) => runs.set(metadata.id,{...metadata,...outcome})
    },invoke:async () => {
      dispatched++;
      return {answer:"Saved ₹24,000.",references:["overview"],usage:{input:1000,output:100,calls:1}};
    }}
  });
  t.after(() => api.close());
  const send = (payload,headers = auth) => api.inject({method:"POST",url:"/v1/ai/chat",headers,payload});
  assert.equal((await send(body,{})).statusCode,401);
  assert.equal((await send({...body,context:[{...body.context[0],values:{pan:12345}}]})).statusCode,400);
  assert.equal((await send({...body,reasoning:"max"})).statusCode,400);
  const response = await send(body);
  assert.equal(response.statusCode,200,response.body);
  assert.equal(response.json().usage.cost,2250);
  assert.equal((await send(body)).statusCode,409);
  assert.equal(dispatched,1);
  const {runs:recorded} = (await api.inject({url:"/v1/ai/usage",headers:auth})).json();
  assert.equal(recorded[0].status,"complete");
  assert.equal(JSON.stringify(recorded).includes(body.question),false);
});

test("request summaries use route templates and omit payloads, tokens and supplied request IDs", async t => {
  const events = [];
  const api = await createApi({ownerUid:"owner", verifyToken:async () => ({uid:"owner"}), storage:{},
    cloud:{sync:{read:async () => null}}, rateLimitEnabled:false, auditLog:event => events.push(event)});
  t.after(() => api.close());
  const revision = "2c8d72ab-a0e1-462c-870f-4192a186f4dd";
  const response = await api.inject({method:"GET", url:"/v1/sync/snapshots/" + revision + "?private=hidden",
    headers:{...auth, "x-request-id":"supplied-private-value"}});
  assert.equal(response.statusCode,404);
  assert.equal(events.length,1);
  assert.equal(events[0].route,"/v1/sync/snapshots/:revision");
  assert.equal(events[0].requestId,response.headers["x-request-id"]);
  assert.match(events[0].requestId,/^[a-f0-9-]{36}$/);
  assert.ok(![revision, token, "?private", "supplied-private-value"].some(value => JSON.stringify(events).includes(value)));
});

test("market refresh keeps available quotes when an upstream body exceeds its byte limit", async t => {
  const api = await createApi({ownerUid:"owner",verifyToken:async () => ({uid:"owner"}),storage:{},rateLimitEnabled:false,
    market:{dhanToken:"fictional", fetcher:async url => url.includes("amfiindia.com")
      ? new Response("123; ; ;Test fund;10.54;03-Nov-2026")
      : new Response(new Uint8Array(150_001))}
  });
  t.after(() => api.close());
  const result = await api.inject({method:"POST",url:"/v1/market/quotes",headers:auth,
    payload:{instruments:[{id:"fund",kind:"Mutual fund",code:"123"},{id:"stock",kind:"Equity",code:"456"}]}});
  assert.equal(result.statusCode,200);
  assert.deepEqual(result.json().quotes.map(quote => quote.id),["fund"]);
});

test("AMFI price parser ignores invalid rows and retains the published date", () => {
  const values = parseNav("000111;AAA;;Fictional fund;18.7250;15-Nov-2026\n999999;;;Invalid;not available;15-Nov-2026");
  assert.deepEqual(values.get("000111"),{price:1873,date:"2026-11-15",source:"AMFI"});
  assert.equal(values.has("999999"),false);
});
