// Stage narrowly scoped repairs to the standalone legacy HTML. Never access its browser storage.
import {readFileSync, writeFileSync} from "node:fs";
import {Script} from "node:vm";
const [source, target] = process.argv.slice(2);
if (!source || !target || source === target) throw Error("Provide distinct source and staging paths.");
let html = readFileSync(source, "utf8");
function replaceOnce(before, after) {
  const index = html.indexOf(before);
  if (index < 0 || html.indexOf(before, index + before.length) >= 0) throw Error("Expected exactly one matching legacy fragment: " + before.slice(0, 100));
  html = html.slice(0, index) + after + html.slice(index + before.length);
}
replaceOnce("commit(demoState());setView('overview')", "{const candidate=demoState();atlasRecoveryCandidate=candidate;try{commit(candidate);}finally{atlasRecoveryCandidate=null;}}setView('overview')");
replaceOnce("commit(initial());setView('overview')", "{const candidate=initial();atlasRecoveryCandidate=candidate;try{commit(candidate);}finally{atlasRecoveryCandidate=null;}}setView('overview')");
replaceOnce("t.billId===id&&t.billMonth===m&&t.type==='expense'", "t.billId===id&&t.billMonth===m&&t.type==='expense'&&!atlasIsReversed(state,t.id)");
replaceOnce("String(row[directionIdx]||'').trim().toLowerCase():''", "String(row[directionIdx]||'').trim().toLowerCase().replace(/^(dr|cr)\\.$/,'$1'):''");
replaceOnce("[data-action=\"clear-data\"],[data-action=\"demo\"]", "[data-action=\"fresh\"],[data-action=\"demo\"]");
let count=0;
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
  if (/\bsrc\s*=/.test(match[1])) continue;
  new Script(match[2], {filename: `legacy-script-${++count}.js`});
}
if (count < 19) throw Error(`Unexpected script count: ${count}`);
writeFileSync(target, html, {encoding:"utf8",flag:"wx"});
console.log(`Staged five targeted repairs; ${count} inline scripts parse successfully.`);
