import test from "node:test";
import assert from "node:assert/strict";
import {blank, addAccount} from "../lib/ledger.ts";
import {estimateTax, portfolio, putFinancialRecord, vehicleCosts} from "../lib/assets.ts";
import {statementDraft, verifiedStatement, documentHints} from "../lib/documents.ts";
import {assistantFact, localAnswer} from "../lib/assistant.ts";

const date = "2026-11-04";
const empty = () => addAccount(blank(),{id:"bank",name:"Fictional bank",type:"bank",opening:100,openingDate:"2026-04-01"});

test("local import only auto-posts verified rows classified by an exact rule", () => {
  const ledger = empty();
  ledger.settings.statementAutomation = {bank:{enabled:true,rules:[
    {note:"bakery",type:"expense",category:"Food"},
    {note:"card repayment",type:"expense",category:"Debt"}
  ]}};
  const text = "Date,Description,Debit,Credit,Balance\n2026-11-03,Bakery,12,,88\n2026-11-04,Card repayment,20,,68";
  const draft = statementDraft(ledger,text,"bank",date,{opening:10000,closing:6800});
  assert.ok(verifiedStatement(text,10000,6800,draft));
  assert.deepEqual(draft.map(line => line.selected),[true,false]);
  assert.equal(draft[0].entry.category,"Food");
  assert.deepEqual(statementDraft(ledger,text,"bank",date,{opening:10000,closing:6801}).map(line => line.selected),[false,false]);
  ledger.transactions.push({...draft[0].entry,id:"same"});
  const retry = statementDraft(ledger,text,"bank",date,{opening:10000,closing:6800});
  assert.equal(retry[0].match,"same");
  assert.equal(retry[0].selected,false);
});

test("tax estimates account for standard deduction, rebate, marginal relief, cess and TDS", () => {
  assert.equal(estimateTax(2026,127_500_000,0,0,0).modern,0);
  assert.equal(estimateTax(2026,128_500_000,0,23456,0).modernAfterTds,1_016_544);
  assert.equal(estimateTax(2025,55_000_000,0,0,0).old,0);
  assert.equal(estimateTax(2026,600_000_000,0,0,0),null);
});

test("portfolio sale updates cost basis without repricing earlier holdings; vehicle costs use unique linked entries", () => {
  let ledger = putFinancialRecord(empty(),"holdings",{id:"fund",name:"Fictional fund"});
  ledger = putFinancialRecord(ledger,"investmentEvents",{id:"buy",assetId:"fund",type:"Buy",date:"2026-11-01",units:3_000_000,amount:1500});
  ledger = putFinancialRecord(ledger,"investmentEvents",{id:"sell",assetId:"fund",type:"Sell",date:"2026-11-03",units:1_000_000,amount:750});
  ledger = putFinancialRecord(ledger,"prices",{id:"future",assetId:"fund",price:800,date:"2026-11-05"});
  const position = portfolio(ledger,date).positions[0];
  assert.equal(position.cost,1000);
  assert.equal(position.realised,250);
  assert.equal(position.worth,null);
  ledger.transactions.push({id:"fuel",type:"expense",amount:40,date,accountId:"bank",note:"Fuel"});
  ledger = putFinancialRecord(ledger,"vehicleLinks",{id:"fuel",vehicleId:"car",transactionId:"fuel"});
  assert.equal(vehicleCosts(ledger,"car","2026-11-01",date,date),4000);
});

test("Assistant references only numeric facts, and document hints are read without uploading originals", () => {
  const ledger = empty();
  const fact = assistantFact(ledger,"Accounts","accounts","2026-11",date,"bank");
  assert.deepEqual(fact.values,{liquidBalance:10000});
  assert.doesNotMatch(JSON.stringify(fact),/Fictional bank/);
  assert.deepEqual(localAnswer("What is my balance?",[fact]).references,["accounts"]);
  assert.deepEqual(localAnswer("What is my tax?",[fact]).references,[]);
  const clues = documentHints({pages:["Gross salary: 12,00,000\nTotal TDS: 4,000\nInsurer: Fictional Insurance\nProduct Name: Fictional Protection 123A045V012026"]});
  assert.equal(clues.salary,1200000);
  assert.equal(clues.tds,4000);
  assert.equal(clues.uin,"123A045V012026");
});
