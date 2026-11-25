import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {createInterface} from "node:readline";
import test from "node:test";
import {createApi} from "../api/app.mjs";
import {assistantCatalog} from "../api/assistant.mjs";

const model = "gemini-4-hydrogen";
const auth = {authorization:"Bearer synthetic.owner.session.token"};
const overview = {ref:"overview",start:"2026-11-01",end:"2026-11-30",asOf:"2026-11-25",
  values:{savings:2_400_000,netWorth:7_500_000,knownDebt:1_000_000,missingDebtCount:1,unpricedHoldingCount:0}};
const request = (overrides = {}) => ({id:randomUUID(),model,reasoning:"low",question:"What did I save?",context:[overview],history:[],...overrides});

async function startWorker(t) {
  const worker = spawn(process.env.ATLAS_EVAL_PYTHON || "python", ["eval_worker_fixture.py"], {
    cwd:new URL("../agent/",import.meta.url), stdio:["ignore","pipe","inherit"], windowsHide:true
  });
  t.after(() => worker.kill());
  const lines = createInterface({input:worker.stdout});
  const port = await new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(Error("Worker did not start within 35 seconds.")),35_000);
    worker.once("error",reject);
    worker.once("exit",code => reject(Error("Worker exited with code " + code)));
    lines.once("line",line => {
      clearTimeout(timer);
      const match = /^PORT ([0-9]+)$/.exec(line);
      if (match) resolve(match[1]);
      else reject(Error("Worker did not report a loopback port."));
    });
    t.after(() => {clearTimeout(timer);lines.close();});
  });
  const base = "http://127.0.0.1:" + port;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const result = await fetch(base + "/healthz",{signal:AbortSignal.timeout(1_000)});
      if (result.ok) return base;
    } catch {}
    await new Promise(resolve => setTimeout(resolve,100));
  }
  throw Error("Worker health check failed.");
}

test("HTTP API to FastAPI and ADK", {timeout:90_000}, async t => {
  const worker = await startWorker(t);
  const runs = new Map();
  let budgetAvailable = true;
  let calls = 0;
  const invoke = path => async input => {
    calls++;
    const response = await fetch(worker + path,{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify(input),signal:AbortSignal.timeout(12_000)});
    if (!response.ok) throw Error("Worker returned " + response.status);
    return response.json();
  };
  const api = await createApi({
    ownerUid:"fixture-owner", storage:{}, verifyToken:async token => ({uid:token === auth.authorization.slice(7) ? "fixture-owner" : "another-user"}),
    assistant:{catalog:assistantCatalog({[model]:{location:"global",input:1.5,output:7.5}}),
      usage:{
        read:async () => ({runs:[...runs.values()]}),
        reserve:async metadata => {
          if (runs.has(metadata.id)) return null;
          if (!budgetAvailable) return false;
          runs.set(metadata.id,metadata);
          return "2026-11";
        },
        finish:async (metadata,_month,outcome) => {runs.set(metadata.id,{...metadata,...outcome});}
      },
      invoke:invoke("/chat"),research:{model,invoke:invoke("/policy")}
    }
  });
  t.after(() => api.close());
  const base = await api.listen({host:"127.0.0.1",port:0});
  const post = (path,body,headers = auth) => fetch(base + path,{method:"POST",headers:{...headers,"content-type":"application/json"},
    body:JSON.stringify(body),signal:AbortSignal.timeout(16_000)});
  const chat = (body,headers) => post("/v1/ai/chat",body,headers);

  await t.test("owner authorization rejects missing and mismatched identities before inference", async () => {
    assert.equal((await chat(request(),{})).status,401);
    assert.equal((await chat(request(),{authorization:"Bearer synthetic.other.session.token"})).status,403);
    assert.equal(calls,0);
  });
  await t.test("validated chat preserves references, charges measured usage and rejects replay", async () => {
    const input = request({history:[{role:"user",text:"Synthetic history canary"}]});
    const response = await chat(input);
    assert.equal(response.status,200);
    assert.match(response.headers.get("cache-control"),/no-store/);
    const reply = await response.json();
    assert.deepEqual(reply.references,["overview"]);
    assert.equal(reply.usage.cost,360);
    assert.equal((await chat(input)).status,409);
    assert.equal(calls,1);
    assert.doesNotMatch(JSON.stringify(runs.get(input.id)),/canary|What did I save|2400000/);
  });
  await t.test("bad dates and unapproved fact keys never reach the worker", async () => {
    const before = calls;
    assert.equal((await chat(request({context:[{...overview,start:"2026-11-31",end:"2026-12-01"}]}))).status,400);
    assert.equal((await chat(request({context:[{...overview,values:{unknownAccountField:123}}]}))).status,400);
    assert.equal(calls,before);
  });
  await t.test("unknown references fail closed and retain the budget reservation", async () => {
    const input = request({question:"Simulate an unknown reference."});
    const response = await chat(input);
    assert.equal(response.status,502);
    assert.doesNotMatch(await response.text(),/unknown-reference/);
    assert.equal(runs.get(input.id).status,"failed");
    assert.equal(runs.get(input.id).cost,null);
  });
  await t.test("partial replies retain available evidence and report incomplete usage", async () => {
    const response = await chat(request({question:"Simulate a partial reply.",context:[overview,{...overview,ref:"tax"}]}));
    assert.equal(response.status,200);
    const result = await response.json();
    assert.deepEqual(result.references,["overview"]);
    assert.match(result.answer,/could not complete/);
    assert.equal(result.usage.cost,null);
  });
  await t.test("policy research returns a source and accounts for search usage", async () => {
    const response = await post("/v1/ai/policy",{id:randomUUID(),insurer:"Fictional insurer",product:"Fictional public policy",uin:""});
    assert.equal(response.status,200);
    const result = await response.json();
    assert.deepEqual(result.sources,[{title:"Fictional policy wording",url:"https://example.test/policy"}]);
    assert.equal(result.usage.search,1);
  });
  await t.test("budget exhaustion stops dispatch", async () => {
    const before = calls;
    budgetAvailable = false;
    assert.equal((await chat(request())).status,429);
    assert.equal(calls,before);
  });
});
