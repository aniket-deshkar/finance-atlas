import assert from "node:assert/strict";

const origin = new URL(process.argv[2] ?? "");
assert.match(origin.href, /^https:\/\/[a-z0-9-]+\.web\.app\/$/, "Use the staging Firebase Hosting origin.");
const expected = process.env.ATLAS_RELEASE_SHA;
assert.match(expected ?? "", /^[a-f0-9]{40}$/, "An expected commit SHA is required.");

async function get(path, status) {
  const response = await fetch(new URL(path, origin), {redirect:"error", signal:AbortSignal.timeout(20_000)});
  assert.equal(response.status, status, path);
  return response;
}
const [home, connect, release, health, sync, models] = await Promise.all([
  get("/", 200), get("/connect/", 200), get("/release.json", 200), get("/health", 200),
  get("/v1/sync/head", 401), get("/v1/ai/models", 401)
]);
for (const response of [home, connect]) {
  const script = (response.headers.get("content-security-policy") ?? "").split(";").find(value => value.trim().startsWith("script-src "));
  assert.ok(script?.includes("'sha256-"), "Hosting must send inline script hashes.");
  assert.ok(!script.includes("'unsafe-inline'"), "Inline JavaScript must require a hash.");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}
for (const response of [release, health, sync, models]) assert.match(response.headers.get("cache-control") ?? "", /\bno-store\b/);
assert.equal((await release.json()).revision, expected, "Hosting release revision");
const status = await health.json();
assert.equal(status.status, "ok");
assert.equal(status.revision, expected, "API release revision");
console.log("Verified Hosting and API revision " + expected + ", script policy and anonymous authorization.");
