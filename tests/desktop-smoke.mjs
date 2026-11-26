import assert from "node:assert/strict";
import {selectLockedPdf} from "./pdf-fixture.mjs";
import {spawn, spawnSync} from "node:child_process";
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const executable = resolve(root, "src-tauri/target/debug/finance-atlas.exe");
assert.ok(existsSync(executable), "Build a debug executable with npm.cmd run desktop:dev or desktop:build -- --debug --no-bundle.");
const scratch = mkdtempSync(resolve(tmpdir(), "finance-atlas-desktop-test-"));
const portFile = resolve(scratch, "EBWebView", "DevToolsActivePort");
let app, socket;
let sequence = 0;
const pending = new Map(), errors = [];
const env = {...process.env, ATLAS_DESKTOP_TEST_PROFILE: scratch, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
  "--remote-debugging-port=0 --remote-debugging-address=127.0.0.1 --disable-background-networking"};

async function connect() {
  rmSync(portFile, {force: true});
  app = spawn(executable, [], {cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: false});
  let stderr = "";
  app.stderr.on("data", b => {stderr += String(b);});
  let page;
  let discovery = "WebView2 has not published a debug port";
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      try {
        const port = Number(readFileSync(portFile, "utf8").split(/\r?\n/, 1)[0]);
        assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, {signal: AbortSignal.timeout(1000)});
        const targets = await response.json();
        page = targets.find(p => p.type === "page" && /tauri\.localhost|tauri:/.test(p.url));
        discovery = `WebView2 published ${targets.length} target(s)`;
      } catch (error) {discovery = "CDP discovery failed: " + error.message;}
    }
    if (page) break;
    if (app.exitCode !== null) throw Error("Desktop exited: " + stderr);
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(page, discovery + ". " + stderr);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, reject) => {socket.addEventListener("open", r, {once: true});socket.addEventListener("error", reject, {once: true});});
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data), task = pending.get(message.id);
    if (task) {pending.delete(message.id);message.error ? task.reject(Error(message.error.message)) : task.resolve(message.result);}
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  });
  await send("Runtime.enable");
  await send("Page.enable");
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {const id = ++sequence;pending.set(id, {resolve, reject});socket.send(JSON.stringify({id, method, params}));});
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true});
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
async function until(expression) {
  for (let i = 0; i < 100; i++) {if (await evaluate(expression)) return;await new Promise(r => setTimeout(r, 80));}
  throw Error("Desktop check timed out: " + expression + " · " + await evaluate("document.body.innerText.slice(0,500)"));
}
const set = (selector, value) => evaluate(`document.querySelector(${JSON.stringify(selector)}).value=${JSON.stringify(value)}`);
const click = label => evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}).click()`);
async function closeApp() {
  socket?.close();
  if (app && app.exitCode === null) {
    spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Process -Id ${app.pid}).CloseMainWindow() | Out-Null`], {windowsHide: true, stdio: "ignore"});
    for (let i = 0; i < 50 && app.exitCode === null; i++) await new Promise(r => setTimeout(r, 100));
    if (app.exitCode === null) {app.kill();await new Promise(r => app.once("exit", r));}
  }
}

try {
  await connect();
  await until("!!document.querySelector('[name=confirm]')");
  assert.equal(await evaluate("isSecureContext && !!crypto.subtle && !!window.__TAURI_INTERNALS__"), true);
  assert.equal(await evaluate("location.hostname"), "tauri.localhost");
  await until("document.querySelector('.atlas-welcome-desktop')?.textContent.includes('Finance Atlas for Windows')");
  const blocked = await evaluate(`new Promise(resolve => {
    const handler = e => { window.removeEventListener('securitypolicyviolation', handler);resolve(e.effectiveDirective); };
    window.addEventListener('securitypolicyviolation', handler);
    fetch('https://example.invalid/finance-atlas-network-check').catch(() => setTimeout(() => resolve('No CSP violation reported'), 100));
  })`);
  assert.equal(blocked, "connect-src", "Native policy blocks external application connections");
  await set("[name=passphrase]", "fictional-native-check-12345");
  await set("[name=confirm]", "fictional-native-check-12345");
  await evaluate("document.querySelector('form').requestSubmit()");
  await until("document.querySelector('h1')?.textContent === 'Dashboard'");
  await until("document.querySelector('[aria-label=\"Needs your attention\"]')?.textContent.includes('No open review items')");
  const repeated = spawn(executable, [], {cwd: root, env, stdio: "ignore", windowsHide: false});
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {repeated.kill();reject(Error("Second launch did not focus the existing instance."));}, 5000);
    repeated.once("exit", () => {clearTimeout(timer);resolve();});
  });
  assert.equal(app.exitCode, null, "Original window stays running on repeated launch");
  await click("Accounts");
  await set("[name=name]", "Synthetic desktop bank");
  await set("[name=opening]", "12345.67");
  await evaluate("document.querySelector('.entry-form').requestSubmit()");
  await until("document.body.innerText.includes('Synthetic desktop bank') && !document.querySelector('.error')");
  await click("Documents");
  await evaluate(selectLockedPdf);
  await until("document.body.innerText.includes('Password required for test-locked.pdf')");
  await set("[name=password]", "atlas-fixture");
  await click("Unlock PDF");
  await until("document.querySelector('.atlas-document-preview')?.textContent.includes('Synthetic Atlas statement')");
  await click("Dashboard");
  await click("Open Assistant");
  await until("document.querySelector('[role=dialog]')?.innerText.includes('Dashboard')");
  await click("Close Assistant");
  await click("Settings");
  await click("Use dark theme");
  await until("document.documentElement.dataset.theme === 'dark'");
  assert.match(await evaluate("window.__TAURI_INTERNALS__.invoke('write_encrypted_backup',{text:'{\"transactions\":[]}'}).catch(e=>String(e))"), /encrypted Finance Atlas/);
  assert.match(await evaluate("window.__TAURI_INTERNALS__.invoke('export_file',{name:'bad.txt',data:'not base64!'}).catch(e=>String(e))"), /Invalid export/);
  await click("Dashboard");
  await send("Emulation.setEmulatedMedia", {features: [{name: "prefers-reduced-motion", value: "reduce"}]});
  await until("getComputedStyle(document.querySelector('.atlas-kpi')).opacity === '1'");
  if (process.env.ATLAS_DESKTOP_SCREENSHOT) {
    const screenshot = await send("Page.captureScreenshot", {format: "png"});
    writeFileSync(process.env.ATLAS_DESKTOP_SCREENSHOT, Buffer.from(screenshot.data, "base64"));
  }
  await evaluate("document.documentElement.dataset.reloadCheck = 'before'");
  await send("Page.reload");
  await until("document.documentElement.dataset.reloadCheck !== 'before' && document.querySelector('h1')?.textContent === 'Dashboard'");
  assert.equal(await evaluate("document.documentElement.dataset.theme"), "dark");
  assert.equal(await evaluate("document.querySelector('.liquid-value').textContent.includes('12,345.67')"), true);
  await closeApp();
  await connect();
  await until("document.querySelector('.atlas-welcome h1')?.textContent === 'Unlock your workspace'");
  await set("[name=passphrase]", "fictional-native-check-12345");
  await evaluate("document.querySelector('form').requestSubmit()");
  await until("document.querySelector('h1')?.textContent === 'Dashboard'");
  assert.equal(await evaluate("document.querySelector('.liquid-value').textContent.includes('12,345.67')"), true, "Vault survives a complete native app restart");
  assert.deepEqual(errors, []);
  console.log("Native Tauri webview passed: secure local origin, encrypted vault, persistence, theme, native command validation, and dashboard, using an isolated synthetic vault.");
} finally {
  await closeApp();
  if (scratch.startsWith(resolve(tmpdir()) + sep)) {
    try {rmSync(scratch, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});} catch {console.log("Isolated desktop test profile retained at " + scratch);}
  }
}
