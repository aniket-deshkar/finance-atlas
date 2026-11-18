import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { Storage } from "@google-cloud/storage";
import { GoogleAuth } from "google-auth-library";
import { randomUUID } from "node:crypto";
import { createApi, resolveUpdate } from "./app.mjs";
import { createCloud } from "./cloud-store.mjs";
import { assistantCatalog, createUsage } from "./assistant.mjs";

const ownerUid = process.env.ATLAS_OWNER_UID;
const projectId = process.env.ATLAS_FIREBASE_PROJECT;
if (!ownerUid || !/^[A-Za-z0-9_-]{1,128}$/.test(ownerUid) || !projectId)
  throw new Error("A valid ATLAS_OWNER_UID and ATLAS_FIREBASE_PROJECT are required.");
if (process.env.K_SERVICE && (process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.FIRESTORE_EMULATOR_HOST))
  throw new Error("Firebase emulators are only supported outside Cloud Run.");

const firebase = initializeApp({projectId});
const db = getFirestore(firebase);
const ref = db.collection("atlasVaults").doc(ownerUid);
const storage = {
  async read() {
    const document = await ref.get();
    return document.exists ? document.get("envelope") : null;
  },
  put(update) {
    return db.runTransaction(async tx => {
      const document = await tx.get(ref);
      const result = resolveUpdate(document.get("envelope"), update);
      if (result.status === "saved") tx.set(ref, {envelope: update.envelope});
      return result;
    });
  }
};
const auth = getAuth(firebase);
const worker = process.env.ATLAS_AGENT_URL;
if (worker && !/^https:\/\/[a-z0-9-]+\.[a-z0-9.-]*run\.app$|^https:\/\/[a-z0-9-]+\.run\.app$/.test(worker))
  throw Error("Set ATLAS_AGENT_URL to the HTTPS Cloud Run service origin.");
const client = worker ? await new GoogleAuth().getIdTokenClient(worker) : null;
const catalog = assistantCatalog(JSON.parse(process.env.ATLAS_CHAT_MODELS || "{}"));
const maxSpend = Number(process.env.ATLAS_AI_MONTHLY_USD_MICROS || "5000000");
if (!Number.isSafeInteger(maxSpend) || maxSpend < 0) throw Error("Invalid AI monthly budget.");
const usage = createUsage(db, ownerUid, maxSpend);
const cloudAi = process.env.ATLAS_ENABLE_AI === "true" && client;
const analysisModel = catalog.find(model => model.enabled && model.id === process.env.ATLAS_ANALYSIS_MODEL);
const cloud = process.env.ATLAS_SYNC_BUCKET ? createCloud({
  db, ownerUid, bucket: new Storage({projectId}).bucket(process.env.ATLAS_SYNC_BUCKET),
  mintToken: () => auth.createCustomToken(ownerUid),
  analyze: cloudAi && analysisModel ? async summary => {
    const estimate = Math.ceil((Buffer.byteLength(JSON.stringify(summary)) + 4000) * 2 * analysisModel.input + 1500 * analysisModel.output);
    const run = {id: randomUUID(), model: analysisModel.id, reasoning: "Worker default", estimate, kind: "analysis"};
    const month = await usage.reserve(run);
    if (!month) throw Object.assign(Error("AI budget limit reached."), {code: "ATLAS_AI_LIMIT"});
    let status = "failed";
    try {
      const response = await client.request({url: worker + "/analyze", method: "POST", data: summary, timeout: 48_000, retry: false});
      status = "complete";
      return response.data;
    } finally {
      await usage.finish(run, month, {status, cost: null});
    }
  } : null
}) : undefined;
const invokeWorker = path => async input => (await client.request({
  url: worker + path, data: input, method: "POST", timeout: 48_000, retry: false
})).data;
const assistant = cloudAi ? {
  catalog, usage, invoke: invokeWorker("/chat"),
  research: process.env.ATLAS_POLICY_MODEL ? {model: process.env.ATLAS_POLICY_MODEL, invoke: invokeWorker("/policy")} : undefined
} : undefined;
const market = cloud ? {dhanToken: process.env.ATLAS_DHAN_DATA_TOKEN} : undefined;
const app = await createApi({ownerUid, verifyToken: token => auth.verifyIdToken(token, true), storage, cloud, assistant, market});
await app.listen({host: "0.0.0.0", port: Number(process.env.PORT || 8080)});
