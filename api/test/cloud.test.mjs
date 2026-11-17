import assert from "node:assert/strict";
import {createHash, randomBytes, randomUUID} from "node:crypto";
import {test} from "node:test";
import {createApi} from "../app.mjs";

const owner = {authorization: "Bearer " + "a".repeat(24)};
const other = {authorization: "Bearer " + "b".repeat(24)};

async function fixture(t, analyze) {
  const snapshots = new Map(), pairings = new Map();
  let head = null, spent = 0;
  const app = await createApi({
    ownerUid: "owner", verifyToken: async token => ({uid: token.startsWith("a") ? "owner" : "other"}), rateLimitEnabled: false,
    storage: {read: async () => null},
    cloud: {
      analyze, reserveAnalysis: async () => spent++ < 5,
      pairing: {
        store: async (hash, challenge, expiry) => pairings.set(hash, [challenge, expiry]),
        consume: async (hash, verify) => {
          const ticket = pairings.get(hash);
          if (!ticket || !verify(...ticket)) return false;
          return pairings.delete(hash);
        },
        token: async () => "test-custom-token",
      },
      sync: {
        head: async () => head,
        read: async id => snapshots.get(id)?.bytes ?? null,
        put: async (meta, bytes, expected) => {
          const saved = snapshots.get(meta.revision);
          if (saved?.meta.digest === meta.digest) return {status: "replay", revision: meta.revision};
          if (saved || expected !== (head?.revision ?? null)) return {status: "conflict", revision: head?.revision ?? null};
          snapshots.set(meta.revision, {meta, bytes});
          head = meta;
          return {status: "saved", revision: meta.revision};
        }
      }
    }
  });
  t.after(() => app.close());
  return app;
}

test("binary snapshot sync protects the owner boundary and rejects a stale device", async t => {
  const app = await fixture(t);
  const bytes = Buffer.alloc(1_000_000, 8);
  const first = randomUUID(), second = randomUUID(), stale = randomUUID();
  const url = id => "/v1/sync/snapshots/" + id;
  const put = (id, base, authentication = owner) => app.inject({
    method: "PUT", url: url(id), payload: bytes,
    headers: {...authentication, "content-type": "application/octet-stream", "x-atlas-base": base,
      "x-atlas-salt": Buffer.alloc(16).toString("base64"), "x-atlas-iv": Buffer.alloc(12).toString("base64")}
  });
  assert.equal((await put(first, "none", other)).statusCode, 403);
  assert.equal((await put(first, "none")).json().status, "saved");
  assert.equal((await put(second, first)).json().status, "saved");
  assert.equal((await put(first, "none")).json().status, "replay");
  assert.equal((await put(stale, first)).statusCode, 409);
  const head = await app.inject({url: "/v1/sync/head", headers: owner});
  assert.equal(head.json().head.revision, second);
  assert.equal((await app.inject({url: url(first), headers: other})).statusCode, 403);
  assert.deepEqual((await app.inject({url: url(first), headers: owner})).rawPayload, bytes);
});

test("desktop sign-in code requires the original PKCE verifier and cannot be replayed", async t => {
  const app = await fixture(t);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const issue = headers => app.inject({method: "POST", url: "/v1/auth/desktop/issue", headers, payload: {challenge}});
  assert.equal((await issue(other)).statusCode, 403);
  const {code} = (await issue(owner)).json();
  const exchange = proof => app.inject({method: "POST", url: "/v1/auth/desktop/exchange", payload: {code, verifier: proof}});
  assert.equal((await exchange(randomBytes(32).toString("base64url"))).statusCode, 401);
  assert.equal((await exchange(verifier)).json().token, "test-custom-token");
  assert.equal((await exchange(verifier)).statusCode, 401);
});

test("AI rejects extra private fields, invented facts and unsupported classifications", async t => {
  const app = await fixture(t, async () => ({
    spending: [{ref: "spend-0", reason: "over_budget"}, {ref: "spend-1", reason: "near_budget"}, {ref: "spend-99", reason: "over_budget"}],
    obligations: null,
  }));
  const input = {
    start: "2026-11-01", end: "2026-11-30", asOf: "2026-11-15",
    spending: [{id: "spend-0", actual: 120, budget: 100}, {id: "spend-1", actual: 40, budget: 100}],
    obligations: [{id: "due-0", dueDate: "2026-11-07", amount: 100, kind: "bill", status: "overdue"}]
  };
  const post = (payload, headers = owner) => app.inject({method: "POST", url: "/v1/ai/analyze", headers, payload});
  assert.equal((await post(input, other)).statusCode, 403);
  assert.equal((await post({...input, accountName: "Fake"})).statusCode, 400);
  assert.equal((await post({...input, asOf: "2026-02-31"})).statusCode, 400);
  assert.deepEqual((await post(input)).json().results, [
    {specialist: "spending", status: "complete", items: [{ref: "spend-0", reason: "over_budget"}]},
    {specialist: "obligations", status: "unavailable", items: []}
  ]);
  for (let i = 0; i < 4; i++) assert.equal((await post(input)).statusCode, 200);
  assert.equal((await post(input)).statusCode, 429);
});
