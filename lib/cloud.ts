import type {Auth} from "firebase/auth";
import {desktopInvoke, isDesktop} from "./desktop";
import {base64} from "./files";

const apiKey = process.env.NEXT_PUBLIC_ATLAS_FIREBASE_API_KEY;
const authDomain = process.env.NEXT_PUBLIC_ATLAS_FIREBASE_AUTH_DOMAIN;
const projectId = process.env.NEXT_PUBLIC_ATLAS_FIREBASE_PROJECT;
const origin = process.env.NEXT_PUBLIC_ATLAS_ORIGIN;
export const cloudConfigured = Boolean(apiKey && authDomain && projectId && origin && /^https:\/\/[a-z0-9-]+\.web\.app$/.test(origin));
let auth: Auth | undefined;
let sdk: Promise<{client: Auth; firebase: typeof import("firebase/auth")}> | undefined;

async function getCloudAuth() {
  if (!cloudConfigured) throw Error("Cloud access has not been configured for this build.");
  sdk ??= Promise.all([import("firebase/app"), import("firebase/auth")]).then(([app, firebase]) => {
    const client = firebase.initializeAuth(app.initializeApp({apiKey, authDomain, projectId}, "finance-atlas-cloud"), {
      persistence: isDesktop() ? firebase.inMemoryPersistence : firebase.browserSessionPersistence,
      ...(isDesktop() ? {} : {popupRedirectResolver: firebase.browserPopupRedirectResolver})
    });
    auth = client;
    return {client, firebase};
  }).catch(error => {
    sdk = undefined;
    throw error;
  });
  return sdk;
}

function toUrlBase64(bytes: Uint8Array) {
  return base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function connectCloud(signal: AbortSignal) {
  if (!isDesktop() && window.location.origin !== origin) throw Error("Open the configured Finance Atlas cloud site to sign in.");
  const {client, firebase} = await getCloudAuth();
  try {
    signal.throwIfAborted();
    if (!isDesktop()) {
      await firebase.signInWithPopup(client, new firebase.GoogleAuthProvider());
    } else {
      const verifier = toUrlBase64(crypto.getRandomValues(new Uint8Array(32)));
      const state = toUrlBase64(crypto.getRandomValues(new Uint8Array(32)));
      const challenge = toUrlBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
      signal.throwIfAborted();
      const code = await desktopInvoke<string>("desktop_pair", {challenge, state});
      signal.throwIfAborted();
      const response = await cloudFetch("/v1/auth/desktop/exchange", json({code, verifier}, signal), false);
      const {token} = await checkedJson<{token: string}>(response);
      signal.throwIfAborted();
      await firebase.signInWithCustomToken(client, token);
    }
    signal.throwIfAborted();
    await checkedJson(await cloudFetch("/v1/sync/head", {signal}));
  } catch (error) {
    await firebase.signOut(client);
    throw error;
  }
}

export async function disconnectCloud() {
  if (sdk) {
    const {client, firebase} = await getCloudAuth();
    await firebase.signOut(client);
  }
}

export const cloudConnected = () => Boolean(auth?.currentUser);

export function watchCloudConnection(listener: (connected: boolean) => void) {
  if (!cloudConfigured) return () => {};
  let closed = false;
  let stop: (() => void) | undefined;
  void getCloudAuth().then(({client, firebase}) => {
    if (!closed) stop = firebase.onAuthStateChanged(client, user => {if (!closed) listener(Boolean(user));});
  }).catch(() => {if (!closed) listener(false);});
  return () => {closed = true;stop?.();};
}

export function json(body: unknown, signal?: AbortSignal): RequestInit {
  return {method: "POST", signal, headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)};
}

export async function cloudFetch(path: string, init: RequestInit = {}, authorized = true) {
  if (!cloudConfigured || !path.startsWith("/v1/") || (!isDesktop() && window.location.origin !== origin))
    throw Error("Open the configured Finance Atlas cloud site to use this feature.");
  const headers = new Headers(init.headers);
  if (authorized) {
    const user = (await getCloudAuth()).client.currentUser;
    if (!user) throw Error("Connect to Google Cloud first.");
    headers.set("Authorization", "Bearer " + await user.getIdToken());
    init.signal?.throwIfAborted();
  }
  return fetch(origin + path, {...init, headers, cache: "no-store", credentials: "omit", redirect: "error"});
}

export async function checkedJson<T = unknown>(response: Response): Promise<T> {
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    if (response.status === 403 && data?.code === "owner_not_configured") {
      throw Error("Google sign-in succeeded. Copy your User UID from Firebase Authentication → Users, set ATLAS_OWNER_UID on the Finance Atlas API, then connect again.");
    }
    if (response.status === 401 || response.status === 403) throw Error("Cloud access denied. Sign in with the configured owner account.");
    throw Error(typeof data?.error === "string" ? data.error : "Finance Atlas Cloud is unavailable.");
  }
  return response.json() as Promise<T>;
}
