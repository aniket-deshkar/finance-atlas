import {base64, unbase64} from "./files";
import type {Envelope} from "./vault";
import {checkedJson, cloudFetch} from "./cloud";

export type CloudHead = {revision: string; salt: string; iv: string; digest: string; size: number};
const revision = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export async function readHead(signal: AbortSignal) {
  const {head} = await checkedJson<{head: CloudHead | null}>(await cloudFetch("/v1/sync/head", {signal}));
  if (head !== null && (!head || !revision.test(head.revision) || !/^[0-9a-f]{64}$/.test(head.digest) ||
      !Number.isInteger(head.size) || head.size < 17 || head.size > 30_000_016))
    throw Error("The cloud snapshot metadata is invalid.");
  return head;
}

export async function fetchSnapshot(head: CloudHead, signal: AbortSignal): Promise<Envelope> {
  const response = await cloudFetch("/v1/sync/snapshots/" + head.revision, {signal});
  if (!response.ok) await checkedJson(response);
  const ciphertext = await response.arrayBuffer();
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", ciphertext));
  const hex = Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
  const salt = unbase64(head.salt), iv = unbase64(head.iv);
  if (ciphertext.byteLength !== head.size || hex !== head.digest || salt.length !== 16 || iv.length !== 12)
    throw Error("The encrypted snapshot failed its integrity check.");
  return {version: 1, revision: head.revision, salt, iv, ciphertext};
}

export async function publishSnapshot(local: Envelope, expected: string | null, signal: AbortSignal) {
  const response = await cloudFetch("/v1/sync/snapshots/" + local.revision, {
    method: "PUT", signal, body: local.ciphertext,
    headers: {"Content-Type": "application/octet-stream", "X-Atlas-Base": expected ?? "none",
      "X-Atlas-Salt": base64(local.salt), "X-Atlas-IV": base64(local.iv)}
  });
  if (response.status === 409) return false;
  const result = await checkedJson<{revision: string}>(response);
  if (result.revision !== local.revision) throw Error("Cloud sync did not confirm this revision.");
  return true;
}
