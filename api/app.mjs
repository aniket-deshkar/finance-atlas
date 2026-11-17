import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import {registerCloudRoutes} from "./cloud-routes.mjs";
import {registerAssistant} from "./assistant.mjs";
import {registerMarket} from "./market.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function validBase64(text, minimum, maximum) {
  if (typeof text !== "string" || text.length > Math.ceil(maximum / 3) * 4) return false;
  const buffer = Buffer.from(text, "base64");
  return buffer.length >= minimum && buffer.length <= maximum && buffer.toString("base64") === text;
}

function parseUpdate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { expectedRevision, envelope } = body;
  if (expectedRevision !== null && (typeof expectedRevision !== "string" || !uuid.test(expectedRevision))) return null;
  if (!envelope || envelope.version !== 1 || typeof envelope.revision !== "string" || !uuid.test(envelope.revision) ||
      !validBase64(envelope.salt, 16, 16) || !validBase64(envelope.iv, 12, 12) ||
      !validBase64(envelope.ciphertext, 17, 512 * 1024)) return null;
  if (Object.keys(body).length !== 2 || Object.keys(envelope).length !== 5) return null;
  const {version, revision, salt, iv, ciphertext} = envelope;
  return { expectedRevision, envelope: {version, revision, salt, iv, ciphertext} };
}

export async function createApi({ ownerUid, verifyToken, storage, cloud, assistant, market, rateLimitEnabled = true }) {
  if (!ownerUid || !verifyToken || !storage) throw new Error("Configure the owner identity and encrypted vault store.");
  const app = Fastify({bodyLimit: 710_000, logger: false});
  if (rateLimitEnabled) await app.register(rateLimit, {max: 90, timeWindow: "1 minute"});
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const origin = request.headers.origin;
    if ((cloud || assistant) && ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"].includes(origin)) {
      reply.header("Access-Control-Allow-Origin", origin).header("Vary", "Origin");
      if (request.method === "OPTIONS") {
        return reply.header("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
          .header("Access-Control-Allow-Headers", "authorization, content-type, x-atlas-base, x-atlas-salt, x-atlas-iv")
          .code(204).send();
      }
    }
  });
  if (cloud || assistant) app.options("/v1/*", async (_request, reply) => reply.code(403).send());
  app.get("/healthz", async () => ({status: "ok"}));

  async function owner(request, reply) {
    const match = /^Bearer ([A-Za-z0-9_.-]{20,8192})$/.exec(request.headers.authorization ?? "");
    if (!match) return reply.code(401).send({error: "Sign in to access the vault."});
    let identity;
    try { identity = await verifyToken(match[1]); }
    catch { return reply.code(401).send({error: "Sign in again to access the vault."}); }
    if (identity?.uid !== ownerUid) return reply.code(403).send({error: "Vault access is restricted."});
  }

  if (assistant) registerAssistant(app, owner, assistant);
  if (market) registerMarket(app, owner, market);
  if (cloud) registerCloudRoutes(app, owner, cloud);
  else {
    app.get("/v1/vault", {onRequest: owner}, async (_request, reply) => {
      const envelope = await storage.read();
      if (!envelope) return reply.code(404).send({error: "No encrypted snapshot has been uploaded."});
      return envelope;
    });

    app.put("/v1/vault", {onRequest: owner}, async (request, reply) => {
      const update = parseUpdate(request.body);
      if (!update) return reply.code(400).send({error: "Upload a valid encrypted snapshot within the size limit."});
      const result = await storage.put(update);
      if (result.status === "conflict") return reply.code(409).send({error: "The cloud snapshot changed.", revision: result.revision});
      return {revision: result.revision, replayed: result.status === "replay"};
    });
  }

  app.setErrorHandler((error, _request, reply) => {
    const status = error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    reply.code(status).send({error: status === 500 ? "Vault service unavailable." : "The request could not be accepted."});
  });
  return app;
}

export function resolveUpdate(existing, update) {
  const revision = existing?.revision ?? null;
  if (existing && revision === update.envelope.revision) {
    const same = ["version", "salt", "iv", "ciphertext"].every(key => existing[key] === update.envelope[key]);
    return {status: same ? "replay" : "conflict", revision};
  }
  if (revision !== update.expectedRevision) return {status: "conflict", revision};
  return {status: "saved", revision: update.envelope.revision};
}
