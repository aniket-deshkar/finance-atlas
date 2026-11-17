import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApi, resolveUpdate } from "../app.mjs";

test("owner-only vault API validates envelopes, handles retry and rejects stale writes", async t => {
  let saved = null;
  const app = await createApi({
    ownerUid: "owner",
    verifyToken: async token => {
      if (token.startsWith("invalid")) throw new Error("Invalid");
      return {uid: token.startsWith("owner") ? "owner" : "other"};
    },
    storage: {
      read: async () => saved,
      put: async update => {
        const result = resolveUpdate(saved, update);
        if (result.status === "saved") saved = update.envelope;
        return result;
      }
    },
    rateLimitEnabled: false
  });
  t.after(() => app.close());
  const good = {authorization: "Bearer owner." + "a".repeat(30)};
  const other = {authorization: "Bearer other." + "a".repeat(30)};
  const bad = {authorization: "Bearer invalid." + "a".repeat(30)};
  const envelope = {
    version: 1, revision: randomUUID(), salt: Buffer.alloc(16).toString("base64"),
    iv: Buffer.alloc(12).toString("base64"), ciphertext: Buffer.alloc(40).toString("base64")
  };
  const path = "/v1/vault";
  const get = headers => app.inject({method: "GET", url: path, headers});
  const put = (headers, body) => app.inject({method: "PUT", url: path, headers, payload: body});
  assert.equal((await get({})).statusCode, 401);
  assert.equal((await get(bad)).statusCode, 401);
  assert.equal((await get(other)).statusCode, 403);
  assert.equal((await get(good)).statusCode, 404);
  assert.equal((await put(good, {expectedRevision: null, envelope: {...envelope, plaintext: true}})).statusCode, 400);
  assert.deepEqual((await put(good, {expectedRevision: null, envelope})).json(), {revision: envelope.revision, replayed: false});
  assert.deepEqual((await put(good, {expectedRevision: null, envelope})).json(), {revision: envelope.revision, replayed: true});
  assert.equal((await put(good, {expectedRevision: null, envelope: {...envelope, revision: randomUUID()}})).statusCode, 409);
  const read = await get(good);
  assert.deepEqual(read.json(), envelope);
  assert.equal(read.headers["cache-control"], "no-store");
});
