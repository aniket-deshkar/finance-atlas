import {createHash, randomBytes, timingSafeEqual} from "node:crypto";

const revision = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const secret = /^[A-Za-z0-9_-]{43}$/;
const factId = /^(?:spend|due)-[0-9]{1,2}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const maxBytes = 30_000_016;
const digest = value => createHash("sha256").update(value).digest();
const keysAre = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const money = value => Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000_000_000;
const date = value => typeof value === "string" && datePattern.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const base64 = (value, size) => typeof value === "string" && value.length === Math.ceil(size / 3) * 4 &&
  Buffer.from(value, "base64").length === size && Buffer.from(value, "base64").toString("base64") === value;

export function validateAnalysis(body) {
  if (!keysAre(body, ["start", "end", "asOf", "spending", "obligations"]) ||
      ![body.start, body.end, body.asOf].every(date) || body.start > body.end) return false;
  if (!Array.isArray(body.spending) || body.spending.length > 12 || !Array.isArray(body.obligations) || body.obligations.length > 12) return false;
  if (!body.spending.every(item => keysAre(item, ["id", "actual", "budget"]) &&
      /^spend-[0-9]{1,2}$/.test(item.id) && [item.actual, item.budget].every(money) && item.budget > 0)) return false;
  if (!body.obligations.every(item => keysAre(item, ["id", "dueDate", "amount", "kind", "status"]) &&
      /^due-[0-9]{1,2}$/.test(item.id) && date(item.dueDate) && money(item.amount) && item.amount > 0 &&
      ["bill", "emi", "card", "other"].includes(item.kind) && ["overdue", "upcoming", "pending"].includes(item.status))) return false;
  return new Set([...body.spending, ...body.obligations].map(item => item.id)).size === body.spending.length + body.obligations.length;
}

export function filterAnalysis(result, input) {
  return ["spending", "obligations"].map(specialist => {
    const rows = result?.[specialist];
    if (!Array.isArray(rows)) return {specialist, status: "unavailable", items: []};
    const facts = new Map(input[specialist].map(fact => [fact.id, fact]));
    const items = [], seen = new Set();
    for (const item of rows.slice(0, 6)) {
      if (!keysAre(item, ["ref", "reason"]) || typeof item.ref !== "string" || !factId.test(item.ref) || seen.has(item.ref)) continue;
      const fact = facts.get(item.ref);
      if (!fact) continue;
      const allowed = specialist === "spending"
        ? item.reason === "over_budget" && fact.actual > fact.budget || item.reason === "near_budget" && fact.actual >= fact.budget * 0.8 && fact.actual <= fact.budget
        : item.reason === "overdue" && fact.status === "overdue" || item.reason === "due_soon" && fact.status === "upcoming" ||
          item.reason === "check_pending" && fact.status === "pending";
      if (!allowed) continue;
      seen.add(item.ref);
      items.push(item);
    }
    return {specialist, status: !facts.size ? "insufficient_data" : "complete", items};
  });
}

export function registerCloudRoutes(app, owner, {sync, pairing, analyze, reserveAnalysis}) {
  app.addContentTypeParser("application/octet-stream", {parseAs: "buffer"}, (_request, body, done) => done(null, body));
  app.get("/v1/sync/head", {onRequest: owner}, async () => ({head: await sync.head()}));
  app.get("/v1/sync/snapshots/:revision", {onRequest: owner}, async (request, reply) => {
    const id = request.params.revision;
    if (!revision.test(id)) return reply.code(400).send({error: "Invalid revision."});
    const snapshot = await sync.read(id);
    if (!snapshot) return reply.code(404).send({error: "Snapshot unavailable."});
    return reply.type("application/octet-stream").send(snapshot);
  });
  app.put("/v1/sync/snapshots/:revision", {onRequest: owner, bodyLimit: maxBytes}, async (request, reply) => {
    const id = request.params.revision;
    const expected = request.headers["x-atlas-base"];
    const salt = request.headers["x-atlas-salt"], iv = request.headers["x-atlas-iv"], bytes = request.body;
    if (!revision.test(id) || (expected !== "none" && (typeof expected !== "string" || !revision.test(expected))) ||
        !base64(salt, 16) || !base64(iv, 12) || !Buffer.isBuffer(bytes) || bytes.length < 17 || bytes.length > maxBytes)
      return reply.code(400).send({error: "Invalid encrypted snapshot."});
    const result = await sync.put({revision: id, salt, iv, digest: digest(bytes).toString("hex"), size: bytes.length}, bytes, expected === "none" ? null : expected);
    return reply.code(result.status === "conflict" ? 409 : 200).send(result);
  });

  if (pairing) {
    app.post("/v1/auth/desktop/issue", {onRequest: owner, bodyLimit: 1024}, async (request, reply) => {
      const {challenge} = request.body || {};
      if (typeof challenge !== "string" || !secret.test(challenge)) return reply.code(400).send({error: "Invalid pairing request."});
      const code = randomBytes(32).toString("base64url");
      await pairing.store(digest(code).toString("hex"), challenge, Date.now() + 120_000);
      return {code};
    });
    app.post("/v1/auth/desktop/exchange", {bodyLimit: 1024, config: {rateLimit: {max: 10, timeWindow: "1 minute"}}}, async (request, reply) => {
      const {code, verifier} = request.body || {};
      if (typeof code !== "string" || typeof verifier !== "string" || !secret.test(code) || !secret.test(verifier))
        return reply.code(400).send({error: "Invalid pairing code."});
      const consumed = await pairing.consume(digest(code).toString("hex"), (challenge, expiresAt) =>
        typeof challenge === "string" && secret.test(challenge) && expiresAt > Date.now() &&
        timingSafeEqual(digest(verifier), Buffer.from(challenge, "base64url")));
      if (!consumed) return reply.code(401).send({error: "Pairing code expired or invalid."});
      return {token: await pairing.token()};
    });
  }

  app.post("/v1/ai/analyze", {onRequest: owner, bodyLimit: 12_000}, async (request, reply) => {
    if (!analyze) return reply.code(503).send({error: "Cloud analysis is disabled."});
    if (!validateAnalysis(request.body)) return reply.code(400).send({error: "Invalid analysis summary."});
    if (!request.body.spending.length && !request.body.obligations.length) return {results: filterAnalysis({spending: [], obligations: []}, request.body)};
    if (!await reserveAnalysis()) return reply.code(429).send({error: "The five-analysis daily limit has been reached."});
    try {
      return {results: filterAnalysis(await analyze(request.body), request.body)};
    } catch {
      return reply.code(502).send({error: "The AI service could not complete this request."});
    }
  });
}
