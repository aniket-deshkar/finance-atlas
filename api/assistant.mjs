import {validIsoDate} from "./cloud-routes.mjs";

const availableModels = [
  {id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", provider: "Vertex AI", levels: ["minimal", "low", "medium", "high"], fallback: "low"},
  {id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", provider: "Vertex AI", levels: ["low", "medium", "high", "xhigh"], fallback: "low"},
  {id: "gemini-4-carbon", label: "Gemini 4 Carbon", provider: "Vertex AI", levels: ["low", "medium", "high"], fallback: "low"},
  {id: "gpt-6.1-terra", label: "GPT-6.1 Terra", provider: "Vertex AI private preview", levels: [], fallback: "", unavailable: "Requires a verified private-preview adapter. Direct OpenAI is disabled."}
];
const ref = /^[a-z][a-z0-9-]{0,65}$/;
const requestId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const maximum = 768;
const knownFields = new Set(["income", "spending", "savings", "liquidBalance", "cardOutstanding", "cashOutflow", "expectedOutflow", "projected", "due", "count",
  "fundingNeeded", "shortfall", "budgeted", "invested", "marketValue", "valuedCount", "linkedCosts", "salary", "interest", "tds", "estimatedTaxOld", "estimatedTaxNew", "debit", "credit"]);
const regions = /^[a-z0-9-]{1,45}$/;

export function assistantCatalog(config) {
  return availableModels.map(({id, label, provider, levels, fallback, unavailable}) => {
    const spec = Object.hasOwn(config, id) ? config[id] : null;
    const enabled = Boolean(!unavailable && spec && typeof spec.location === "string" && regions.test(spec.location) &&
      [spec.input, spec.output].every(value => Number.isFinite(value) && value > 0));
    return {id, label, provider, levels, fallback, enabled, unavailable: enabled ? undefined : unavailable || "Not enabled in this GCP deployment.",
      ...(enabled ? {input: spec.input, output: spec.output, location: spec.location, pricingDate: spec.pricingDate || ""} : {})};
  });
}

export function validateChat(body, catalog) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !["id", "model", "reasoning", "question", "context", "history"].includes(key))) return null;
  const {id, reasoning, question, context, history} = body;
  const model = catalog.find(item => item.id === body.model && item.enabled);
  if (typeof id !== "string" || !requestId.test(id) || !model?.levels.includes(reasoning) || typeof question !== "string" || !question.trim() || question.length > 1600 ||
      !Array.isArray(context) || context.length > 6 || !Array.isArray(history) || history.length > 4) return null;
  for (const item of context) {
    if (!item || Object.keys(item).some(key => !["ref", "start", "end", "values"].includes(key)) || typeof item.ref !== "string" || !ref.test(item.ref) ||
        ![item.start, item.end].every(validIsoDate) || item.start > item.end ||
        !item.values || Array.isArray(item.values) || typeof item.values !== "object" ||
        Object.keys(item.values).length > 24 ||
        !Object.entries(item.values).every(([name, value]) => knownFields.has(name) && Number.isSafeInteger(value) && Math.abs(value) <= 1e13)) return null;
  }
  for (const item of history) {
    if (!item || Object.keys(item).some(key => !["role", "text"].includes(key)) ||
        !["user", "assistant"].includes(item.role) || typeof item.text !== "string" || item.text.length > 1000) return null;
  }
  if (new Set(context.map(item => item.ref)).size !== context.length) return null;
  return {id, model, reasoning, question: question.trim(), context, history};
}

const usdMicros = (input, output, model) => Math.ceil(input * model.input + output * model.output);
export function estimateRun(body) {
  return usdMicros((Buffer.byteLength(JSON.stringify([body.question, body.context, body.history])) + 1200) * 3, maximum * 3, body.model);
}

export function createUsage(db, uid, monthlyLimit) {
  const root = db.collection("atlasAiUsage").doc(uid);
  const monthId = () => new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit"}).format(new Date());
  return {
    read: async () => {
      const month = monthId(), budget = await root.collection("months").doc(month).get();
      const records = await root.collection("runs").where("month", "==", month).limit(500).get();
      return {month, limit: monthlyLimit, used: budget.get("total") ?? 0, runs: records.docs.map(doc => doc.data()).sort((a, b) => b.at.localeCompare(a.at))};
    },
    reserve(data) {
      return db.runTransaction(async tx => {
        const month = monthId(), budget = root.collection("months").doc(month), run = root.collection("runs").doc(data.id);
        const [prior, totals] = await Promise.all([tx.get(run), tx.get(budget)]);
        if (prior.exists) return null;
        const total = totals.get("total") ?? 0, count = totals.get("count") ?? 0;
        if (total + data.estimate > monthlyLimit || count >= 500) return false;
        tx.set(budget, {total: total + data.estimate, count: count + 1});
        tx.create(run, {...data, month, at: new Date().toISOString(), status: "pending"});
        return month;
      });
    },
    finish(data, month, result) {
      return db.runTransaction(async tx => {
        const budget = root.collection("months").doc(month), run = root.collection("runs").doc(data.id);
        const [prior, totals] = await Promise.all([tx.get(run), tx.get(budget)]);
        if (prior.get("status") !== "pending") return;
        tx.update(run, result);
        if (result.cost !== null) tx.update(budget, {total: Math.max(0, (totals.get("total") ?? 0) - data.estimate + result.cost)});
      });
    }
  };
}

export function registerAssistant(app, owner, {catalog, usage, invoke, research}) {
  app.get("/v1/ai/models", {onRequest: owner}, async () => ({enabled: true, models: catalog, maxOutput: maximum, research: Boolean(research)}));
  app.get("/v1/ai/usage", {onRequest: owner}, async () => usage.read());
  app.post("/v1/ai/chat", {onRequest: owner, bodyLimit: 18_000}, async (request, reply) => {
    const input = validateChat(request.body, catalog);
    if (!input) return reply.code(400).send({error: "Check the selected model, reasoning level and context."});
    const metadata = {id: input.id, model: input.model.id, reasoning: input.reasoning, estimate: estimateRun(input), kind: "chat"};
    const month = await usage.reserve(metadata);
    if (month === null) return reply.code(409).send({error: "This request was already submitted."});
    if (!month) return reply.code(429).send({error: "The AI budget limit has been reached."});
    let outcome = {status: "failed", cost: null};
    try {
      const result = await invoke({...input, model: input.model.id, location: input.model.location, maxOutput: maximum});
      const refs = new Set(input.context.map(item => item.ref));
      if (!result || typeof result.answer !== "string" || !result.answer.trim() || result.answer.length > 25_000 ||
          !Array.isArray(result.references) || !result.references.every(value => refs.has(value))) throw Error("Invalid model result");
      const tokens = result.usage;
      if (tokens && [tokens.input, tokens.output, tokens.calls].every(value => Number.isSafeInteger(value) && value >= 0))
        outcome = {status: "complete", cost: usdMicros(tokens.input, tokens.output, input.model), input: tokens.input, output: tokens.output, calls: tokens.calls, search: 0};
      else outcome = {status: "complete", cost: null};
      return {answer: result.answer, references: result.references, usage: {...metadata, ...outcome}};
    } catch {
      return reply.code(502).send({error: "The selected model could not answer. Choose another enabled model or try again."});
    } finally {await usage.finish(metadata, month, outcome);}
  });

  if (research) app.post("/v1/ai/policy", {onRequest: owner, bodyLimit: 1200}, async (request, reply) => {
    const {id, insurer, product, uin} = request.body ?? {};
    const phrase = /^[\p{L}\p{N} .,&()’'/-]{2,100}$/u;
    const model = catalog.find(item => item.id === research.model && item.enabled);
    if (!model) return reply.code(503).send({error: "The policy research model is unavailable."});
    if (typeof id !== "string" || !requestId.test(id) || [insurer, product].some(value => typeof value !== "string" || !phrase.test(value) || /\d{7}/.test(value)) ||
        typeof uin !== "string" || (uin && !/^\d{3}[A-Z]\d{3}V\d{2}\d{4}$/i.test(uin)))
      return reply.code(400).send({error: "Enter the public insurer and product name and the IRDAI UIN if available."});
    const metadata = {id, model: model.id, reasoning: model.fallback, estimate: usdMicros(2500, 768, model) + 70_000, kind: "policy"};
    const month = await usage.reserve(metadata);
    if (!month) return reply.code(month === null ? 409 : 429).send({error: "This run was already sent or the AI budget was reached."});
    let outcome = {status: "failed", cost: null};
    try {
      const result = await research.invoke({insurer, product, uin, model: model.id, location: model.location, reasoning: model.fallback, maxOutput: maximum});
      const tokens = result.usage;
      const sources = Array.isArray(result.sources) ? result.sources.filter(source => typeof source.title === "string" && typeof source.url === "string" && /^https:\/\//.test(source.url)).slice(0, 12) : [];
      if (typeof result.answer !== "string" || result.answer.length > 12000 || !sources.length) throw Error("No grounded policy answer");
      if (tokens && [tokens.input, tokens.output, tokens.search].every(value => Number.isSafeInteger(value) && value >= 0))
        outcome = {status: "complete", cost: usdMicros(tokens.input, tokens.output, model) + tokens.search * 14_000,
          input: tokens.input, output: tokens.output, calls: 1, search: tokens.search};
      else outcome = {status: "complete", cost: null};
      return {answer: result.answer, sources, usage: {...metadata, ...outcome}};
    } catch {
      return reply.code(502).send({error: "Policy research could not find verified sources for that product."});
    } finally {await usage.finish(metadata, month, outcome);}
  });
}
