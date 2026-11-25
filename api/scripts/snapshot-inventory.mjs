import {initializeApp} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";
import {Storage} from "@google-cloud/storage";

const {ATLAS_FIREBASE_PROJECT:projectId, ATLAS_SYNC_BUCKET:bucketName, ATLAS_OWNER_UID:owner} = process.env;
if (!projectId || !bucketName || !owner || !/^[A-Za-z0-9_-]{1,128}$/.test(owner) || owner === "unassigned")
  throw Error("Configure the explicit project, bucket and initialized owner for this inventory run.");

const firestore = getFirestore(initializeApp({projectId}));
const workspace = firestore.collection("atlasCloud").doc(owner);
const bucket = new Storage({projectId}).bucket(bucketName);
const report = {knownSnapshots:0, youngUnreferenced:0, olderUnreferenced:0, unrecognizedObjects:0, olderUnreferencedBytes:0};
const cutoff = Date.now() - 86_400_000;
const prefix = owner + "/";
for await (const file of bucket.getFilesStream({prefix})) {
  const [revision, digest, extra] = file.name.slice(prefix.length).split("/");
  if (extra !== undefined || !/^[a-f0-9-]{36}$/.test(revision ?? "") || !/^[a-f0-9]{64}$/.test(digest ?? "")) {
    report.unrecognizedObjects++;
    continue;
  }
  const snapshot = (await workspace.collection("snapshots").doc(revision).get()).data();
  if (snapshot?.digest === digest) {
    report.knownSnapshots++;
    continue;
  }
  // Check the head separately so an inconsistent manifest never suggests deleting it.
  const head = (await workspace.get()).get("head");
  if (head?.revision === revision && head?.digest === digest) {
    report.knownSnapshots++;
    continue;
  }
  const created = Date.parse(file.metadata.timeCreated ?? "");
  if (!Number.isFinite(created) || created > cutoff) report.youngUnreferenced++;
  else {
    report.olderUnreferenced++;
    report.olderUnreferencedBytes += Number(file.metadata.size) || 0;
  }
}
console.log(JSON.stringify(report));
await firestore.terminate();
