import {createHash} from "node:crypto";
import {readdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";

const root = new URL("../", import.meta.url);
const config = JSON.parse(await readFile(new URL("firebase.json", root), "utf8"));
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const out = new URL(config.hosting.public + "/", root);
const hashSet = new Set();
for (const entry of await readdir(out, {recursive: true, withFileTypes: true})) {
  if (!entry.isFile() || !entry.name.endsWith(".html")) continue;
  const document = await readFile(join(entry.parentPath, entry.name), "utf8");
  for (const script of document.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const [, attributes, body] = script;
    if (/(?:^|\s)src\s*=/i.test(attributes) || !body.trim()) continue;
    const hash = createHash("sha256").update(body.replace(/\r\n?/g, "\n")).digest("base64");
    hashSet.add("'sha256-" + hash + "'");
  }
}
if (!hashSet.size) throw Error("The static export did not contain any inline scripts to authorize.");
const policy = config.hosting.headers.flatMap(entry => entry.headers).find(header => header.key.toLowerCase() === "content-security-policy");
const scriptSource = policy?.value.match(/(?:^|;\s*)(script-src [^;]+)/)?.[1];
if (!scriptSource || scriptSource.includes("'unsafe-inline'")) throw Error("Unexpected base Content Security Policy.");
policy.value = policy.value.replace(scriptSource, scriptSource + " " + [...hashSet].sort().join(" "));
const site = process.env.ATLAS_HOSTING_SITE_ID;
if (site) {
  if (!/^[a-z0-9-]{1,63}$/.test(site)) throw Error("Use a valid Firebase Hosting site ID.");
  if (process.env.NEXT_PUBLIC_ATLAS_ORIGIN !== "https://" + site + ".web.app")
    throw Error("The built cloud origin must match the selected Firebase Hosting site.");
  config.hosting.site = site;
  const authDomain = process.env.NEXT_PUBLIC_ATLAS_FIREBASE_AUTH_DOMAIN;
  if (authDomain && authDomain !== site + ".web.app") {
    const project = process.env.NEXT_PUBLIC_ATLAS_FIREBASE_PROJECT;
    if (!/^[a-z][a-z0-9-]{4,29}$/.test(project ?? "") || authDomain !== project + ".firebaseapp.com")
      throw Error("Use the Hosting site's domain or the configured project's Firebase Auth domain.");
    policy.value += "; frame-src 'self' https://" + authDomain;
  }
}
const revision = process.env.ATLAS_RELEASE_SHA;
if (revision && !/^[a-f0-9]{40}$/.test(revision)) throw Error("ATLAS_RELEASE_SHA must be a full Git commit SHA.");
for (const source of ["/", "/connect", "/connect/**", "/release.json"]) config.hosting.headers.push({
  source, headers: [{key:"Cache-Control", value:source === "/release.json" ? "no-store" : "no-cache"}]
});
await writeFile(new URL("release.json", out), JSON.stringify({
  release:pkg.version, revision:revision ?? null, builtAt:new Date().toISOString()
}) + "\n");
await writeFile(new URL("firebase.release.json", root), JSON.stringify(config, null, 2) + "\n");
console.log("Prepared Firebase release with " + hashSet.size + " inline script hashes.");
