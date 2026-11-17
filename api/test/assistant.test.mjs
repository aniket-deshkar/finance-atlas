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

test("AMFI price parser ignores invalid rows and retains the published date", () => {
  const values = parseNav("000111;AAA;;Fictional fund;18.7250;15-Nov-2026\n999999;;;Invalid;not available;15-Nov-2026");
  assert.deepEqual(values.get("000111"),{price:1873,date:"2026-11-15",source:"AMFI"});
  assert.equal(values.has("999999"),false);
});
