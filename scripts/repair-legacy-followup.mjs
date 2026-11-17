import {readFileSync, writeFileSync} from "node:fs";
import {Script} from "node:vm";
const [source, target] = process.argv.slice(2);
if (!source || !target || source === target) throw Error("Provide distinct source and staging paths.");
let html = readFileSync(source, "utf8");
function replaceOnce(before, after) {
  const index = html.indexOf(before);
  if (index < 0 || html.indexOf(before, index + before.length) >= 0) throw Error("Expected one matching fragment: " + before.slice(0,100));
  html = html.slice(0,index) + after + html.slice(index+before.length);
}
replaceOnce('return `<div class="field"><label for="f-${name}">${label}</label><select id="f-${name}" name="${name}" required>${paymentAccountOptions(accounts,selected,blank)}</select></div>`;',
  'return `<div class="field"><label for="f-${esc(name)}">${esc(label)}</label><select id="f-${esc(name)}" name="${esc(name)}" required>${paymentAccountOptions(accounts,selected,blank)}</select></div>`;');
replaceOnce('const raw=localStorage.getItem(AUTH_KEY);', "let raw;try{raw=localStorage.getItem(AUTH_KEY);}catch{throw Error('Browser storage is unavailable. Your finance data has not been changed.');}");
replaceOnce("function tagTotals(m){const map=new Map();for(const t of state.transactions){if(!t.date.startsWith(m)||", "function tagTotals(m){const map=new Map(),p=window.AtlasFinance?.period(m,state)||{start:m+'-01',end:m+'-31'};for(const t of state.transactions){if(t.date<p.start||t.date>p.end||");
let count=0;
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) if(!/\bsrc\s*=/.test(match[1])) new Script(match[2], {filename:`legacy-script-${++count}.js`});
if (count < 19) throw Error("Unexpected script count.");
writeFileSync(target,html,{encoding:"utf8",flag:"wx"});
console.log(`Staged escaping, storage error and salary-period tag fixes; ${count} scripts parse.`);
