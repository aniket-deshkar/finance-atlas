import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {selectLockedPdf} from "./pdf-fixture.mjs";

const out = fileURLToPath(new URL("../out/", import.meta.url));
const chrome = process.env.ATLAS_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const scratch = mkdtempSync(resolve(tmpdir(), "atlas-next-smoke-"));
const config = JSON.parse(readFileSync(new URL("../firebase.release.json", import.meta.url), "utf8"));
const hostingHeaders = Object.fromEntries(config.hosting.headers[0].headers.map(header => [header.key, header.value]));
let browser, socket, recoveryServer;
const mime = { html: "text/html; charset=utf-8", js: "application/javascript", mjs: "application/javascript", css: "text/css", json: "application/json", ico: "image/x-icon" };
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  let file = resolve(out, "." + pathname);
  if (!file.toLowerCase().startsWith(out.toLowerCase()) && file.toLowerCase() !== resolve(out).toLowerCase()) {
    response.writeHead(404).end();
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = resolve(file, "index.html");
  if (!existsSync(file)) { response.writeHead(404).end(); return; }
  response.writeHead(200, { ...hostingHeaders, "Content-Type": mime[file.split(".").at(-1)] || "text/plain" });
  createReadStream(file).pipe(response);
});

async function main() {
  assert.ok(existsSync(resolve(out, "index.html")), "Run npm run build first.");
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  assert.equal((await fetch(origin + "/favicon.ico")).status, 200, "The app icon is included in the static export");
  browser = spawn(chrome, ["--headless=new", "--disable-extensions", "--disable-background-networking",
    "--no-first-run", "--remote-debugging-port=0", "--user-data-dir=" + scratch, "about:blank"],
    {windowsHide: true, stdio: ["ignore", "ignore", "pipe"]});
  const address = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error("Chrome did not start.")), 10000);
    browser.on("error", reject);
    browser.stderr.on("data", chunk => {
      const match = String(chunk).match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolve(new URL(match[1])); }
    });
  });
  const pages = await (await fetch("http://127.0.0.1:" + address.port + "/json/list")).json();
  socket = new WebSocket(pages.find(page => page.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, {once: true});
    socket.addEventListener("error", reject, {once: true});
  });
  let sequence = 0;
  const pending = new Map(), errors = [], remote = [];
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(Error(message.error.message)); else resolve(message.result);
    }
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
    if (message.method === "Network.requestWillBeSent" && /^https?:/.test(message.params.request.url) &&
        new URL(message.params.request.url).origin !== origin) remote.push(message.params.request.url);
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(Error("Chrome did not respond to " + method));
      }, 12000);
      pending.set(id, {
        resolve: result => {clearTimeout(timeout);resolve(result);},
        reject: error => {clearTimeout(timeout);reject(error);}
      });
      socket.send(JSON.stringify({id, method, params}));
    });
  }
  async function evaluate(expression) {
    const answer = await send("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true});
    if (answer.exceptionDetails) throw Error(answer.exceptionDetails.exception?.description || answer.exceptionDetails.text);
    return answer.result.value;
  }
  async function until(expression) {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    throw Error("Timed out: " + expression + " · " + await evaluate("document.body.innerText.slice(0, 420)"));
  }
  const click = label => evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === " +
    JSON.stringify(label) + " || b.getAttribute('aria-label') === " + JSON.stringify(label) + ").click()");
  const key = async (key, code, windowsVirtualKeyCode) => {
    const options = {key, code, windowsVirtualKeyCode};
    await send("Input.dispatchKeyEvent", {type:key === "Enter" ? "keyDown" : "rawKeyDown", ...options, ...(key === "Enter" ? {text:"\r"} : {})});
    await send("Input.dispatchKeyEvent", {type:"keyUp", ...options});
  };
  const set = (selector, value) => evaluate("document.querySelector(" + JSON.stringify(selector) + ").value = " + JSON.stringify(value));
  const submit = () => evaluate("document.querySelector('form').requestSubmit()");
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", {width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await send("Page.navigate", {url: origin});
  await until("!!document.querySelector('[name=confirm]')");
  await set("[name=passphrase]", "only-fictional-test-secret-123");
  await set("[name=confirm]", "only-fictional-test-secret-123");
  await submit();
  await until("document.querySelector('h1')?.textContent === 'Dashboard'");
  await click("Choose reporting period");
  await until("!!document.querySelector('.period-popover')");
  await evaluate("document.querySelector('h1').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
  await until("!document.querySelector('.period-popover')");
  assert.equal(await evaluate("Boolean(document.querySelector('.profile-menu'))"), false);
  await click("Settings");
  await click("Data, backup & security");
  const sampleDate = new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date());
  const sample = {state: {
    app: "Finance Atlas", version: 1,
    accounts: [
      {id: "bank", name: "Synthetic cash", type: "bank", opening: 400, openingDate: "2020-01-01"},
      {id: "card", name: "Synthetic card", type: "credit", opening: 0, openingDate: "2020-01-01", limit: 100000},
      {id: "card2", name: "Second test card", type: "credit", opening: 0, openingDate: "2020-01-01", limit: 75000}
    ],
    transactions: Array.from({length: 6}, (_, i) => {
      const point = new Date(sampleDate.slice(0, 7) + "-01T12:00:00Z");
      point.setUTCMonth(point.getUTCMonth() - 5 + i);
      const date = point.toISOString().slice(0, 10);
      return [
        {id: "salary-" + i, type: "income", date, accountId: "bank", amount: [45000, 47500, 46000, 51000, 48000, 52000][i], category: "Paycheck", note: "Salary"},
        {id: "expense-" + i, type: "expense", date, accountId: "bank", amount: [18000, 23000, 16500, 21500, 19000, 24000][i], category: "Food", note: "Monthly expenses"}
      ];
    }).flat(),
    loans: [
      {id: "personal-loan", title: "Synthetic bank loan", kind: "bank", emi: 1000, financed: 3000, installments: 3, previouslyPaid: 0, firstDue: sampleDate, category: "Debt", bankId: "bank", cardId: ""},
      {id: "lent-loan", title: "Synthetic money lent", kind: "credit", emi: 500, financed: 1500, installments: 3, previouslyPaid: 0, firstDue: sampleDate, category: "Money Given", bankId: "bank", cardId: "card2"}
    ],
    categories: {expense: ["Food", "Utilities", "Debt", "Money Given", "Subscriptions", "Insurance", "Clothing", "Other Expenses"], income: ["Paycheck", "Other"]},
    settings: {emiBudget: 0}, budgets: {},
    goals: [{id: "house", name: "My house", saved: 125000, target: 1000000}, {id: "travel", name: "Travel fund", saved: 35000, target: 80000}],
    sampleExtension: {preserve: true}
  }};
  await evaluate("(() => { const d = new DataTransfer(); d.items.add(new File([" + JSON.stringify(JSON.stringify(sample)) +
    "], 'test.json', {type:'application/json'})); const input=document.querySelector('[type=file]');input.files=d.files;input.dispatchEvent(new Event('change',{bubbles:true})); })()");
  await until("document.body.innerText.includes('Ready to import')");
  await click("Replace local workspace");
  await until("document.body.innerText.includes('Saved to this device')");
  await click("Dashboard");
  await click("Open Assistant");
  await until("document.querySelector('[role=dialog]')?.innerText.includes('Dashboard')");
  await evaluate("document.querySelector('main').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
  await until("!document.querySelector('[role=dialog]')");
  await click("Open Assistant");
  await until("!!document.querySelector('[role=dialog]')");
  await evaluate(`(() => {const input=document.querySelector('.atlas-chat textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'What are my savings?');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click("Send question");
  await until("document.querySelector('[role=log]')?.textContent.includes('Net savings')");
  await click("Open full Assistant");
  await until("document.querySelector('h1')?.textContent === 'Assistant'");
  assert.equal(await evaluate("document.querySelector('.atlas-chat').getBoundingClientRect().width <= 1216"), true);
  assert.match(await evaluate("document.querySelector('[role=log]').innerText"), /28,000\.00/);
  if (process.env.ATLAS_SCREENSHOT_ASSISTANT) {
    const shot = await send("Page.captureScreenshot", {format: "png"});
    writeFileSync(process.env.ATLAS_SCREENSHOT_ASSISTANT, Buffer.from(shot.data, "base64"));
  }
  await click("Documents");
  await evaluate(selectLockedPdf);
  await until("document.body.innerText.includes('Password required for test-locked.pdf')");
  await set("[name=password]", "incorrect-fixture");
  await click("Unlock PDF");
  await until("document.body.innerText.includes('Incorrect password. Try again')");
  await set("[name=password]", "atlas-fixture");
  await click("Unlock PDF");
  await until("document.querySelector('.atlas-document-preview')?.textContent.includes('Synthetic Atlas statement')");
  assert.equal(await evaluate("!!document.querySelector('[name=password]')"), false);
  await click("Dashboard");
  const attention = "document.querySelector('[aria-label=\"Needs your attention\"]')";
  await until(attention + ".textContent.includes('Confirm outstanding loan balances')");
  await evaluate(attention + ".querySelector('.attention-items button:nth-child(2)').click()");
  await until("!" + attention + ".textContent.includes('Confirm outstanding loan balances')");
  await click("+ New transaction");
  await set("[name=account]", "bank");
  await set("[name=amount]", "18.75");
  await set("[name=note]", "Fictional receipt");
  await submit();
  await until("document.body.innerText.includes('Fictional receipt')");
  await click("Card statements");
  await set("[name=due]", await evaluate("document.querySelector('[name=issued]').value"));
  await set("[name=billed]", "80.00");
  await submit();
  await until("document.querySelector('table tbody')?.innerText.includes('80.00')");
  await click("+ New transaction");
  await evaluate("(() => { const input = document.querySelector('[name=type]'); input.value = 'cardPayment'; input.dispatchEvent(new Event('change', {bubbles:true})); })()");
  await until("document.querySelector('[name=statement]')?.options.length === 2");
  await set("[name=account]", "bank");
  await set("[name=statement]", await evaluate("document.querySelector('[name=statement]').options[1].value"));
  await set("[name=amount]", "32.75");
  await submit();
  await until("!document.querySelector('[name=statement]')");
  await click("Card statements");
  assert.match(await evaluate("document.querySelector('table tbody').innerText"), /32\.75.*47\.25/s);
  assert.deepEqual(await evaluate("Object.keys(localStorage)"), ["atlas-appearance"], "Only the nonfinancial theme preference is stored outside the encrypted vault.");
  await send("Page.reload");
  await until("document.querySelector('h2')?.textContent === 'Unlock your workspace'");
  await set("[name=passphrase]", "wrong-passphrase");
  await submit();
  await until("document.body.innerText.includes('Could not unlock')");
  await set("[name=passphrase]", "only-fictional-test-secret-123");
  await submit();
  await until("document.querySelector('h1')?.textContent === 'Dashboard'");
  assert.equal(await evaluate("document.body.innerText.includes('Fictional receipt')"), true);
  await evaluate("document.querySelector('[aria-label=\"Next card\"]').click()");
  await until("document.querySelector('.atlas-mini-card > span')?.textContent === 'Second test card'");
  await evaluate("document.querySelector('[aria-label=\"Previous card\"]').click()");
  await until("document.querySelector('.atlas-mini-card > span')?.textContent === 'Synthetic card'");
  await click("Bills & policies");
  await click("+ Add bill or policy");
  await until("!!document.querySelector('dialog[open] [name=name]')");
  await set("dialog [name=name]", "Synthetic subscription");
  await set("dialog [name=amount]", "99.50");
  await set("dialog [name=category]", "Subscriptions");
  await set("dialog [name=accountId]", "bank");
  await evaluate("document.querySelector('dialog form').requestSubmit()");
  await until("!document.querySelector('dialog[open]')");
  await evaluate("Array.from(document.querySelectorAll('tr')).find(r => r.innerText.includes('Synthetic subscription')).querySelector('button').click()");
  await until("!!document.querySelector('dialog[open] [name=initiatedDate]')");
  await evaluate("document.querySelector('dialog form').requestSubmit()");
  await until("!document.querySelector('dialog[open]')");
  assert.match(await evaluate("Array.from(document.querySelectorAll('tr')).find(r => r.innerText.includes('Synthetic subscription')).innerText"), /Paid/);
  await click("Payment calendar");
  assert.equal(await evaluate("Array.from(document.querySelectorAll('.agenda-entry')).some(el => el.innerText.includes('Synthetic subscription'))"), false);
  await click("EMIs & recoveries");
  assert.equal(await evaluate("Array.from(document.querySelectorAll('tr')).some(el => el.innerText.includes('Synthetic money lent'))"), false);
  await evaluate("Array.from(document.querySelectorAll('tr')).find(r => r.innerText.includes('Synthetic bank loan')).querySelector('button').click()");
  await until("!!document.querySelector('dialog[open]')");
  await evaluate("Array.from(document.querySelectorAll('dialog button')).find(b => b.textContent === 'Record payment').click()");
  await until("!!document.querySelector('dialog[open] [name=initiatedDate]')");
  await evaluate("document.querySelector('dialog form').requestSubmit()");
  await until("!document.querySelector('dialog[open]')");
  await click("Monthly budget");
  assert.match(await evaluate("Array.from(document.querySelectorAll('.feature-stat')).find(el => el.innerText.startsWith('Bank EMIs paid')).innerText"), /1,000\.00/);
  await set("[name=expense-0]", "30000");
  await click("Save budget");
  await until("document.body.innerText.includes('Saved to this device')");
  await click("EMIs & recoveries");
  await click("Money lent & recoveries");
  await click("Record recovery");
  await until("!!document.querySelector('dialog[open] [name=accountId]')");
  await set("dialog [name=amount]", "300");
  await set("dialog [name=accountId]", "bank");
  await evaluate("document.querySelector('dialog form').requestSubmit()");
  await until("!document.querySelector('dialog[open]')");
  assert.match(await evaluate("Array.from(document.querySelectorAll('.feature-stat')).find(el => el.innerText.startsWith('Recovered')).innerText"), /300\.00/);
  await evaluate("Array.from(document.querySelectorAll('tr')).find(r => r.innerText.includes('Synthetic money lent')).querySelector('button').click()");
  await until("!!document.querySelector('dialog[open]')");
  await evaluate("Array.from(document.querySelectorAll('dialog button')).find(b => b.textContent === 'Record charge').click()");
  await until("!!document.querySelector('dialog[open] [name=initiatedDate]')");
  await evaluate("document.querySelector('dialog form').requestSubmit()");
  await until("!document.querySelector('dialog[open]')");
  await click("Monthly budget");
  assert.match(await evaluate("Array.from(document.querySelectorAll('.feature-stat')).find(el => el.innerText.startsWith('Card EMIs posted')).innerText"), /0\.00/);
  const screens = ["Daily hub", "Transactions", "Accounts", "Card statements", "Bills & policies", "EMIs & recoveries", "Monthly budget", "Payment calendar", "Salary & transfers", "Goals", "12-month plan", "Insights", "Debt & credit", "Reconciliation", "Cashback", "Receipts", "Monthly report", "Documents", "Investments", "Vehicles", "Tax", "Assistant", "Settings", "Dashboard"];
  for (const view of screens) {
    await click(view);
    await until("document.querySelector('h1')?.textContent === " + JSON.stringify(view));
  }
  await evaluate("new Promise((resolve,reject) => { const request=indexedDB.open('finance-atlas-web-v1');request.onsuccess=()=>{const db=request.result,tx=db.transaction('workspace','readwrite'),store=tx.objectStore('workspace'),get=store.get('ledger');get.onsuccess=()=>store.put({...get.result,revision:crypto.randomUUID()},'ledger');tx.oncomplete=()=>{db.close();resolve(true)};tx.onabort=()=>reject(tx.error)};request.onerror=()=>reject(request.error) })");
  await click("+ New transaction");
  await set("[name=account]", "bank");
  await set("[name=amount]", "1");
  await set("[name=note]", "Stale write must fail");
  await submit();
  await until("document.body.innerText.includes('changed in another tab')");
  await click("Lock workspace");
  await until("!!document.querySelector('[name=passphrase]')");
  await set("[name=passphrase]", "only-fictional-test-secret-123");
  await submit();
  await until("document.querySelector('h1')?.textContent === 'Dashboard'");
  await click("Monthly budget");
  assert.equal(await evaluate("document.querySelector('[name=expense-0]').value"), "30000.00");
  await click("Receipts");
  await evaluate("(() => {const original=File.prototype.arrayBuffer;window.__originalFileRead=original;File.prototype.arrayBuffer=function(){if(this.name==='deferred.pdf'){window.__attachmentStarted=true;return new Promise(resolve=>{window.__finishAttachment=()=>resolve(new Uint8Array([1,2,3]).buffer)})}return original.call(this)};const d=new DataTransfer();d.items.add(new File([new Uint8Array([1,2,3])],'deferred.pdf',{type:'application/pdf'}));const input=document.querySelector('input[type=file]');input.files=d.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await until("window.__attachmentStarted === true");
  await click("Lock workspace");
  await until("!!document.querySelector('[name=passphrase]')");
  await evaluate("window.__finishAttachment();File.prototype.arrayBuffer=window.__originalFileRead;new Promise(resolve=>setTimeout(resolve,100))");
  assert.equal(await evaluate("document.querySelector('h2')?.textContent"), "Unlock your workspace");
  await set("[name=passphrase]", "only-fictional-test-secret-123");
  await submit();
  await until("document.querySelector('h1')?.textContent === 'Dashboard'");
  await click("Settings");
  await click("Data, backup & security");
  const portable = await evaluate("new Promise((resolve,reject)=>{const r=indexedDB.open('finance-atlas-web-v1');r.onsuccess=()=>{const db=r.result,q=db.transaction('workspace').objectStore('workspace').get('ledger');q.onsuccess=()=>{const e=q.result,b64=a=>btoa(String.fromCharCode(...new Uint8Array(a)));db.close();resolve(JSON.stringify({format:'finance-atlas-web-enc-v1',version:1,revision:e.revision,salt:b64(e.salt),iv:b64(e.iv),ciphertext:b64(e.ciphertext)}))};q.onerror=()=>reject(q.error)}})");
  await click("Settings");
  await evaluate("(() => {const d=new DataTransfer();d.items.add(new File([" + JSON.stringify(portable) + "], 'restore.atlasenc',{type:'application/json'}));const input=Array.from(document.querySelectorAll('input[type=file]')).find(i=>i.accept.startsWith('.atlasenc'));input.files=d.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await until("!!document.querySelector('dialog[open] [name=passphrase]')");
  await set("dialog [name=passphrase]", "only-fictional-test-secret-123");
  await evaluate("document.querySelector('dialog form').requestSubmit()");
  await until("document.body.innerText.includes('Ready to import')");
  await click("Replace local workspace");
  await until("!document.body.innerText.includes('Ready to import')");
  await click("Monthly budget");
  assert.equal(await evaluate("document.querySelector('[name=expense-0]').value"), "30000.00");
  await click("Transactions");
  assert.equal(await evaluate("Array.from(document.querySelectorAll('tr')).some(el=>el.innerText.includes('Stale write must fail'))"), false);
  await click("Dashboard");
  for (const [width, height, deviceScaleFactor] of [[1440, 900, 1], [1536, 864, 1.25], [1280, 720, 1.5], [1366, 768, 1], [1024, 768, 1], [768, 1024, 1], [430, 932, 1], [390, 844, 1], [320, 700, 1]]) {
    await send("Emulation.setDeviceMetricsOverride", {width, height, deviceScaleFactor, mobile: false});
    assert.equal(await evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), true, width + "px layout");
    assert.equal(await evaluate("document.querySelector('.balance-hero').getBoundingClientRect().top < innerHeight"), true, "Liquid balance visible at " + width);
    assert.equal(await evaluate("document.querySelectorAll('.atlas-kpi').length"), 4);
    if (width === 1440 && process.env.ATLAS_SCREENSHOT) {
      await until("getComputedStyle(document.querySelector('.atlas-kpi:last-child')).opacity === '1'");
      const shot = await send("Page.captureScreenshot", {format: "png"});
      writeFileSync(process.env.ATLAS_SCREENSHOT, Buffer.from(shot.data, "base64"));
    }
    if (width === 390 && process.env.ATLAS_SCREENSHOT_MOBILE) {
      await until("document.querySelector('.atlas-kpi:last-child').getAnimations().every(a => a.playState === 'finished')");
      const shot = await send("Page.captureScreenshot", {format: "png"});
      writeFileSync(process.env.ATLAS_SCREENSHOT_MOBILE, Buffer.from(shot.data, "base64"));
    }
    if (width === 390) {
      assert.equal(await evaluate("document.querySelector('.topbar .atlas-assistant-fab') !== null"), true);
      await evaluate("document.querySelector('[aria-label=\"Open navigation\"]').focus()");
      await key("Enter", "Enter", 13);
      await until("document.activeElement.textContent === 'Close navigation' && document.querySelector('main').inert");
      await key("Tab", "Tab", 9);
      assert.equal(await evaluate("document.activeElement.closest('#workspace-sidebar') !== null"), true);
      await key("Escape", "Escape", 27);
      await until("document.activeElement.getAttribute('aria-label') === 'Open navigation' && !document.querySelector('main').inert");
      await click("Hide amounts");
      await until("document.querySelector('.workspace').dataset.private === 'true'");
      assert.equal(await evaluate("document.querySelector('.cash-bars') === null && !document.querySelector('.atlas-overview').textContent.includes('₹')"), true);
      await click("Show amounts");
      await until("document.querySelector('.workspace').dataset.private === 'false' && !!document.querySelector('.cash-bars')");
      assert.equal(await evaluate("document.querySelector('.topbar .search').getBoundingClientRect().width <= 40"), true, "Mobile search starts as an icon");
      await evaluate("document.querySelector('.topbar .search input').focus()");
      const mobileSearchWidth = await evaluate("document.querySelector('.topbar .search').getBoundingClientRect().width");
      assert.ok(mobileSearchWidth >= 240, `Mobile search expands when focused; got ${mobileSearchWidth}px`);
      await evaluate("document.querySelector('.topbar .search input').blur()");
    }
  }
  await send("Emulation.setDeviceMetricsOverride", {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
  await send("Emulation.setEmulatedMedia", {features: [{name: "prefers-reduced-motion", value: "no-preference"}]});
  await until("innerWidth === 1440 && document.querySelector('.atlas-panel').getAnimations().every(a=>a.playState === 'finished')");
  if (await evaluate("matchMedia('(hover: hover) and (pointer: fine)').matches")) {
    await evaluate("document.querySelector('.atlas-panel').scrollIntoView({block:'center', behavior:'instant'})");
    const panelPoint = await evaluate("(() => {const r=document.querySelector('.atlas-panel').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()");
    await send("Input.dispatchMouseEvent", {type: "mouseMoved", ...panelPoint});
    await until("new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.atlas-panel')).transform).m42 < -2");
    await send("Input.dispatchMouseEvent", {type: "mouseMoved", x: 0, y: 0});
  } else {
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.atlas-panel')).transform"), "none", "The panel stays flat without a fine pointer");
  }
  await click("Accounts");
  await click("Go back");
  await until("document.querySelector('h1')?.textContent === 'Dashboard'");
  await click("Collapse sidebar");
  await until("document.querySelector('.workspace').dataset.collapsed === 'true'");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Accounts\"]').getAttribute('title')"), "Accounts");
  await click("Settings");
  await click("Appearance & navigation");
  await click("Use dark theme");
  await until("document.documentElement.dataset.theme === 'dark'");
  await click("Dashboard");
  await until("getComputedStyle(document.querySelector('.atlas-panel')).backgroundColor === 'rgb(28, 40, 36)'");
  if (process.env.ATLAS_DARK_SCREENSHOT) {
    await send("Emulation.setDeviceMetricsOverride", {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
    await evaluate("new Promise(resolve=>setTimeout(resolve, 650))");
    const shot = await send("Page.captureScreenshot", {format: "png", captureBeyondViewport: true});
    writeFileSync(process.env.ATLAS_DARK_SCREENSHOT, Buffer.from(shot.data, "base64"));
  }
  await send("Emulation.setEmulatedMedia", {features: [{name: "prefers-reduced-motion", value: "reduce"}]});
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.atlas-kpi')).animationName"), "none");
  await click("Expand sidebar");
  await until("document.querySelector('.workspace').dataset.collapsed === 'false'");
  for (const width of [1440, 390]) {
    await send("Emulation.setDeviceMetricsOverride", {width, height: 900, deviceScaleFactor: 1, mobile: false});
    if (width === 390) {
      await click("Open navigation");
      await until("document.querySelector('aside').dataset.drawer === 'true'");
      await click("Close navigation");
      await until("document.querySelector('aside').dataset.drawer === 'false'");
    }
    for (const view of screens) {
      if (width === 390 && view !== "Settings") await click("Open navigation");
      await click(view);
      await until("document.querySelector('h1')?.textContent === " + JSON.stringify(view));
      assert.equal(await evaluate("document.querySelector('.workspace').dataset.theme"), "dark", view + " retains dark theme");
      assert.equal(await evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), true, view + " dark at " + width);
    }
  }
  await send("Emulation.setDeviceMetricsOverride", {width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await click("Collapse sidebar");
  await until("document.querySelector('.workspace').dataset.collapsed === 'true'");
  await send("Page.reload");
  await until("document.querySelector('h2')?.textContent === 'Unlock your workspace'");
  assert.equal(await evaluate("document.documentElement.dataset.theme"), "dark", "Lock screen retains the theme");
  await set("[name=passphrase]", "only-fictional-test-secret-123");
  await submit();
  await until("document.querySelector('h1')?.textContent === 'Dashboard'");
  assert.equal(await evaluate("document.querySelector('.workspace').dataset.collapsed"), "true", "Sidebar preference persists");
  await click("Expand sidebar");
  await until("document.querySelector('.workspace').dataset.collapsed === 'false'");
  await click("Settings");
  await click("Appearance & navigation");
  await click("Use light theme");
  await until("document.documentElement.dataset.theme === 'light'");
  await click("Dashboard");
  await send("Emulation.setEmulatedMedia", {features: []});
  await send("Emulation.setDeviceMetricsOverride", {width: 390, height: 790, deviceScaleFactor: 1, mobile: false});
  for (const [width, height] of [[1440, 900], [390, 790]]) {
    await send("Emulation.setDeviceMetricsOverride", {width, height, deviceScaleFactor: 1, mobile: false});
    for (const view of screens) {
      if (width === 390 && view !== "Settings") await click("Open navigation");
      await click(view);
      await until("document.querySelector('h1')?.textContent === " + JSON.stringify(view));
      assert.equal(await evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), true, view + " at " + width + "px");
      if (width === 1440 && view === "Payment calendar" && process.env.ATLAS_CALENDAR_SCREENSHOT) {
        const shot = await send("Page.captureScreenshot", {format: "png", captureBeyondViewport: true});
        writeFileSync(process.env.ATLAS_CALENDAR_SCREENSHOT, Buffer.from(shot.data, "base64"));
      }
    }
  }
  if (process.env.ATLAS_MOBILE_SCREENSHOT) {
    await until("getComputedStyle(document.querySelector('.atlas-kpi:last-child')).opacity === '1'");
    const shot = await send("Page.captureScreenshot", {format: "png", captureBeyondViewport: true});
    writeFileSync(process.env.ATLAS_MOBILE_SCREENSHOT, Buffer.from(shot.data, "base64"));
  }
  assert.equal(await evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), true,
    JSON.stringify(await evaluate("Array.from(document.querySelectorAll('body *')).filter(el => el.getBoundingClientRect().right > innerWidth + 1).map(el => [el.tagName, el.className, Math.round(el.getBoundingClientRect().width)]).slice(0, 10)")));
  await click("Dashboard");
  await click("+ New transaction");
  await evaluate("document.querySelector('.settings-disclosure summary').click()");
  await evaluate("(() => {const e=document.querySelector('.settings-disclosure textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'INR 1,234.50 debited from A/c XX1234 on 10-11-2026. Available balance INR 9,000.00');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await click("Review alert");
  await until("document.body.innerText.includes('1234.50')");
  await click("Use these suggestions");
  assert.equal(await evaluate("document.querySelector('[name=amount]').value"), "1234.50");
  assert.equal(await evaluate("document.querySelector('.settings-disclosure textarea').value"), "");
  await click("Settings");
  await click("Finance & automation");
  await set("[name=idleMinutes]", "5");
  await click("Save preferences");
  await until("!document.querySelector('fieldset:disabled')");
  await evaluate("window.__realNow = Date.now; Date.now = () => window.__realNow() + 360001; document.dispatchEvent(new Event('visibilitychange'))");
  await until("document.querySelector('h2')?.textContent === 'Unlock your workspace'");
  await evaluate("Date.now = window.__realNow");
  await set("[name=passphrase]", "only-fictional-test-secret-123");
  await submit();
  await until("document.querySelector('h1')?.textContent === 'Dashboard'");
  await click("Accounts");
  assert.equal(await evaluate("document.body.innerText.includes('Synthetic cash')"), true, "Auto-lock preserves the saved vault");
  await evaluate("[...document.querySelectorAll('button')].find(button => button.textContent === 'Edit / confirm balance').focus()");
  await key("Enter", "Enter", 13);
  await until("document.querySelector('dialog[open]')?.getAttribute('aria-labelledby')");
  assert.match(await evaluate("document.getElementById(document.querySelector('dialog[open]').getAttribute('aria-labelledby')).textContent"), /Account & balance/);
  await key("Escape", "Escape", 27);
  await until("document.activeElement.textContent === 'Edit / confirm balance'");

  await send("Browser.setDownloadBehavior", {behavior:"allow", downloadPath:scratch});
  await click("Settings");
  await click("Data, backup & security");
  await click("Download device backup");
  const deviceFile = resolve(scratch, "Finance_Atlas_Device_" + sampleDate + ".atlasdevice");
  for (let attempt = 0; attempt < 80 && !existsSync(deviceFile); attempt++)
    await new Promise(resolve => setTimeout(resolve, 100));
  const backup = readFileSync(deviceFile, "utf8");
  assert.equal(JSON.parse(backup).format, "finance-atlas-device-backup-v1");
  assert.ok(!backup.includes("What are my savings?") && !backup.includes("test-locked.pdf"));
  assert.deepEqual(errors, []);
  assert.deepEqual(remote, []);

  recoveryServer = createServer(server.listeners("request")[0]);
  await new Promise(resolve => recoveryServer.listen(0, "127.0.0.1", resolve));
  await send("Page.navigate", {url:"http://127.0.0.1:" + recoveryServer.address().port});
  await until("!!document.querySelector('[name=confirm]')");
  await set("[name=passphrase]", "synthetic-destination-secret");
  await set("[name=confirm]", "synthetic-destination-secret");
  await submit();
  await until("document.querySelector('h1')?.textContent === 'Dashboard'");
  await click("Settings");
  await click("Data, backup & security");
  await evaluate("(() => {const data = new DataTransfer();data.items.add(new File([" +
    JSON.stringify(backup) + "], 'test.atlasdevice'));const input = document.querySelector('[name=deviceBackup]');input.files = data.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await until("!!document.querySelector('dialog[open]')");
  await set("dialog [name=passphrase]", "invalid-test-passphrase");
  await click("Restore device library");
  await until("document.querySelector('dialog').textContent.includes('passphrase is incorrect')");
  await set("dialog [name=passphrase]", "only-fictional-test-secret-123");
  await click("Restore device library");
  await until("document.body.innerText.includes('encrypted device records restored') && !document.querySelector('dialog[open]')");
  await click("Assistant");
  await until("document.querySelector('[role=log]')?.textContent.includes('What are my savings?')");
  await click("Accounts");
  assert.equal(await evaluate("document.body.innerText.includes('Synthetic cash')"), false, "Device-library restore does not overwrite the destination ledger");
  assert.deepEqual(errors, []);
  console.log("Production build verified on desktop and mobile. Keyboard navigation, privacy, local ledger, encrypted device recovery, and stale-write rejection passed with fictional records.");
}

try { await main(); }
finally {
  socket?.close();
  browser?.kill();
  server.close();
  recoveryServer?.close();
  if (scratch.startsWith(resolve(tmpdir()) + sep)) {
    try { rmSync(scratch, {recursive: true, force: true, maxRetries: 5, retryDelay: 150}); } catch {}
  }
}
