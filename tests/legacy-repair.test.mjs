import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
const path = process.env.ATLAS_LEGACY_HTML;

test("legacy bill lookup ignores a reversed payment but finds its replacement", {skip: !path}, () => {
  const html = readFileSync(path, "utf8"), match = html.match(/const v4_billPaid =[^\n]+/);
  assert.ok(match);
  const state = {transactions: [{id:"old", billId:"b", billMonth:"2026-11", type:"expense"}]};
  const c = vm.createContext({state, atlasIsReversed: (_s, id) => id === "old"});
  const find = vm.runInContext(match[0] + "\nv4_billPaid", c);
  assert.equal(find("b", "2026-11"), undefined);
  state.transactions.push({id:"replacement", billId:"b", billMonth:"2026-11", type:"expense"});
  assert.equal(find("b", "2026-11").id, "replacement");
});

for (const action of ["demo", "fresh"]) test(`legacy ${action} permits explicit replacement and clears recovery permission`, {skip: !path}, () => {
  const html = readFileSync(path, "utf8"), match = html.match(new RegExp("case '" + action + "':([^\\n]+)"));
  assert.ok(match);
  let committed = false;
  const c = vm.createContext({confirm:()=>true, prompt:()=>"CLEAR", beforeReplace:()=>{}, demoState:()=>({kind:"demo"}), initial:()=>({kind:"fresh"}),
    atlasRecoveryCandidate:null, fileHandle:null, filePaused:false, fileStatus:"", setView:()=>{}, toast:()=>{}, commit: candidate => {
      assert.equal(c.atlasRecoveryCandidate, candidate);committed = true;
    }});
  vm.runInContext(`switch (${JSON.stringify(action)}) {case ${JSON.stringify(action)}:${match[1]}}`, c);
  assert.equal(committed, true);
  assert.equal(c.atlasRecoveryCandidate, null);
});

test("legacy tagged spending follows salary reporting period", {skip: !path}, () => {
  const html = readFileSync(path, "utf8"), match = html.match(/function tagTotals\(m\)[^\n]+/);
  assert.ok(match);
  const c = vm.createContext({state:{transactions:[{date:"2026-11-05",type:"expense",amount:4500,note:"#weekend"},
    {date:"2026-10-20",type:"expense",amount:200,note:"#weekend"}]},
    window:{AtlasFinance:{period:()=>({start:"2026-10-25",end:"2026-11-24"})}},tagsOf: text => [text], total: values => values.reduce((a,b)=>a+b,0)});
  const result = vm.runInContext(match[0] + "\ntagTotals('2026-10')", c);
  assert.equal(result[0].spent, 4500);
  assert.equal(result[0].count, 1);
});
