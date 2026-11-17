import { importLedger, type Ledger } from "./ledger.ts";
import { base64, unbase64 } from "./files.ts";

export type Envelope = {
  version: 1;
  revision: string;
  salt: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
};

const aad = new TextEncoder().encode("finance-atlas-web-vault-v1");
const storeName = "workspace";

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("finance-atlas-web-v1", 3);
    request.onupgradeneeded = () => {
      for (const name of [storeName, "preferences", "snapshots", "deviceRecords"])
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
    };
    request.onerror = () => reject(request.error ?? new Error("Local storage is unavailable."));
    request.onsuccess = () => resolve(request.result);
  });
}

export async function deviceRecord<T>(scope: string, id: string, key: CryptoKey, value?: T): Promise<T | undefined> {
  const db = await database();
  const recordId = scope + "/" + id;
  const additionalData = new TextEncoder().encode("finance-atlas-device-v1/" + recordId);
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = value === undefined ? undefined : {
      iv, data: await crypto.subtle.encrypt({name: "AES-GCM", iv, additionalData}, key, new TextEncoder().encode(JSON.stringify(value)))
    };
    const result = await new Promise<{iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer} | undefined>((resolve, reject) => {
      const tx = db.transaction("deviceRecords", sealed ? "readwrite" : "readonly");
      const collection = tx.objectStore("deviceRecords");
      const request = sealed ? collection.put(sealed, recordId) : collection.get(recordId);
      tx.oncomplete = () => resolve(sealed ? undefined : request.result);
      tx.onabort = tx.onerror = () => reject(tx.error ?? Error("Local storage could not be updated."));
    });
    if (!result) return value;
    const clear = await crypto.subtle.decrypt({name: "AES-GCM", iv: result.iv, additionalData}, key, result.data);
    return JSON.parse(new TextDecoder().decode(clear)) as T;
  } finally {db.close();}
}

export async function readVault(): Promise<Envelope | null> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const request = tx.objectStore(storeName).get("ledger");
      request.onsuccess = () => resolve((request.result as Envelope | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

export async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle) throw new Error("Open Finance Atlas on HTTPS or localhost to use the local vault.");
  const bytes = new TextEncoder().encode(passphrase);
  try {
    const material = await crypto.subtle.importKey("raw", bytes, "PBKDF2", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey(
      {name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256"},
      material, {name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]
    );
  } finally { bytes.fill(0); }
}

export async function decryptVault(envelope: Envelope, key: CryptoKey): Promise<Ledger> {
  if (envelope.version !== 1 || envelope.salt.length !== 16 || envelope.iv.length !== 12)
    throw new Error("This local vault version is unsupported.");
  const bytes = await crypto.subtle.decrypt({name: "AES-GCM", iv: envelope.iv, additionalData: aad}, key, envelope.ciphertext);
  try { return importLedger(JSON.parse(new TextDecoder().decode(bytes))); }
  finally { new Uint8Array(bytes).fill(0); }
}

export async function saveVault(ledger: Ledger, key: CryptoKey, salt: Uint8Array<ArrayBuffer>, expected: string | null): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new TextEncoder().encode(JSON.stringify(ledger));
  if (bytes.length > 30_000_000) throw new Error("The workspace exceeds 30 MB. Export an archive and remove older receipt files before saving.");
  let ciphertext: ArrayBuffer;
  try {
    ciphertext = await crypto.subtle.encrypt({name: "AES-GCM", iv, additionalData: aad}, key, bytes);
  } finally { bytes.fill(0); }
  const next: Envelope = { version: 1, revision: crypto.randomUUID(), salt, iv, ciphertext };
  await installVault(next, expected);
  return next;
}

// Callers changing the vault from a cloud snapshot must decrypt and validate it first.
export async function installVault(next: Envelope, expected: string | null): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const objectStore = tx.objectStore(storeName);
      const request = objectStore.get("ledger");
      let conflict = false;
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(conflict
        ? new Error("The workspace changed in another tab. Lock and reopen it before saving.")
        : tx.error ?? new Error("The encrypted workspace could not be saved."));
      request.onsuccess = () => {
        const existing = request.result as Envelope | undefined;
        if ((existing?.revision ?? null) !== expected) {
          conflict = true;
          tx.abort();
          return;
        }
        objectStore.put(next, "ledger");
      };
    });
  } finally { db.close(); }
}

export function serializeEnvelope(envelope: Envelope) {
  return JSON.stringify({format: "finance-atlas-web-enc-v1", version: envelope.version, revision: envelope.revision,
    salt: base64(envelope.salt), iv: base64(envelope.iv), ciphertext: base64(new Uint8Array(envelope.ciphertext))});
}

export async function openEncryptedBackup(text: string, passphrase: string): Promise<Ledger> {
  if (text.length > 42_000_000) throw new Error("The encrypted backup exceeds the supported size.");
  const value = JSON.parse(text);
  if (value.format === "finance-atlas-enc-v1" && value.iterations === 250000 && value.cipher === "AES-256-GCM") {
    const salt = unbase64(value.salt), iv = unbase64(value.iv);
    if (salt.length !== 16 || iv.length !== 12) throw new Error("Invalid legacy encrypted backup.");
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256"}, material, {name: "AES-GCM", length: 256}, false, ["decrypt"]);
    const bytes = await crypto.subtle.decrypt({name: "AES-GCM", iv}, key, unbase64(value.data));
    try {return importLedger(JSON.parse(new TextDecoder().decode(bytes)));}
    finally {new Uint8Array(bytes).fill(0);}
  }
  if (value.format !== "finance-atlas-web-enc-v1" || value.version !== 1) throw new Error("Choose a supported encrypted Finance Atlas backup.");
  const salt = unbase64(value.salt), iv = unbase64(value.iv);
  const envelope: Envelope = {version: 1, revision: value.revision, salt, iv, ciphertext: unbase64(value.ciphertext).buffer};
  return decryptVault(envelope, await deriveKey(passphrase, salt));
}

export async function preference<T>(name: string, update?: T): Promise<T | undefined> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("preferences", update === undefined ? "readonly" : "readwrite"), store = tx.objectStore("preferences");
      const request = update === undefined ? store.get(name) : store.put(update, name);
      let result: T | undefined;
      request.onsuccess = () => {result = update === undefined ? request.result as T : update;};
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  } finally {db.close();}
}

export async function saveSnapshot(envelope: Envelope, day: string) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("snapshots", "readwrite"), store = tx.objectStore("snapshots");
      store.put(envelope, day);
      const keys = store.getAllKeys();
      keys.onsuccess = () => {
        for (const key of keys.result.sort().slice(0, -25)) store.delete(key);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  } finally {db.close();}
}

export async function snapshots(): Promise<{day: string; envelope: Envelope}[]> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("snapshots", "readonly"), store = tx.objectStore("snapshots");
      const keys = store.getAllKeys(), values = store.getAll();
      tx.oncomplete = () => resolve(keys.result.map((key, i) => ({day: String(key), envelope: values.result[i] as Envelope})).reverse());
      tx.onabort = () => reject(tx.error);
    });
  } finally {db.close();}
}
