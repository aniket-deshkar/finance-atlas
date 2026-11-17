import {createHash} from "node:crypto";

export function createCloud({db, ownerUid, bucket, mintToken, analyze}) {
  const root = db.collection("atlasCloud").doc(ownerUid);
  const snapshots = root.collection("snapshots");
  const pairings = root.collection("pairings");
  const object = meta => bucket.file(ownerUid + "/" + meta.revision + "/" + meta.digest);
  const sync = {
    async head() {
      return (await root.get()).get("head") ?? null;
    },
    async read(id) {
      const meta = (await snapshots.doc(id).get()).data();
      if (!meta) return null;
      const [bytes] = await object(meta).download();
      if (bytes.length !== meta.size || createHash("sha256").update(bytes).digest("hex") !== meta.digest)
        throw Error("Encrypted snapshot integrity check failed.");
      return bytes;
    },
    async put(meta, bytes, expected) {
      const ref = snapshots.doc(meta.revision);
      const prior = (await ref.get()).data();
      function replay(previous) {
        const same = ["digest", "salt", "iv", "size"].every(key => previous[key] === meta[key]);
        return {status: same ? "replay" : "conflict", revision: meta.revision};
      }
      if (prior) return replay(prior);
      const head = await sync.head();
      if ((head?.revision ?? null) !== expected) return {status: "conflict", revision: head?.revision ?? null};
      try {
        await object(meta).save(bytes, {resumable: false, contentType: "application/octet-stream", preconditionOpts: {ifGenerationMatch: 0}});
      } catch (error) {
        if (Number(error.code) !== 412) throw error;
      }
      return db.runTransaction(async tx => {
        const [workspace, previous] = await Promise.all([tx.get(root), tx.get(ref)]);
        if (previous.exists) return replay(previous.data());
        const latest = workspace.get("head")?.revision ?? null;
        if (latest !== expected) return {status: "conflict", revision: latest};
        tx.create(ref, meta);
        tx.set(root, {head: meta}, {merge: true});
        return {status: "saved", revision: meta.revision};
      });
    }
  };
  return {
    sync, analyze,
    pairing: {
      token: mintToken,
      store: (hashedCode, challenge, expiresAt) => pairings.doc(hashedCode).create({challenge, expiresAt, expires: new Date(expiresAt)}),
      consume: (hashedCode, matches) => db.runTransaction(async tx => {
        const ref = pairings.doc(hashedCode);
        const ticket = (await tx.get(ref)).data();
        if (!ticket || !matches(ticket.challenge, ticket.expiresAt)) return false;
        tx.delete(ref);
        return true;
      })
    },
    reserveAnalysis: () => db.runTransaction(async tx => {
      const day = new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date());
      const current = (await tx.get(root)).get("analysisUsage");
      const used = current?.day === day ? current.used : 0;
      if (used >= 5) return false;
      tx.set(root, {analysisUsage: {day, used: used + 1}}, {merge: true});
      return true;
    })
  };
}
