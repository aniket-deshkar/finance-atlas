import test from "node:test";
import assert from "node:assert/strict";
import {blank, addAccount} from "../lib/ledger.ts";
import {estimateTax, portfolio, putFinancialRecord, vehicleCosts} from "../lib/assets.ts";
import {statementDraft, verifiedStatement, documentHints, statementCsvFromText} from "../lib/documents.ts";
import {importStatement, parseStatement, statementColumns} from "../lib/files.ts";
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

test("statement mapping preserves card charges, holds ambiguous repayments, and links recorded entries", () => {
  const ledger = addAccount(empty(), {id:"card", name:"Fictional card", type:"credit", opening:0, openingDate:"2026-04-01"});
  const source = "Posted,Shop,Value\n11/03/2026,Bakery,22\n11/04/2026,Card payment,-40";
  const {columns} = statementColumns(source);
  const mapping = {columns:{...columns,date:0,note:1,amount:2}, debitPositive:true};
  const draft = parseStatement(source, ledger, "card", date, "month-first", mapping);
  assert.deepEqual(draft.map(line => [line.signed,line.entry.type,line.selected]), [[-2200,"expense",true],[4000,"refund",false]]);
  const repayment = {...draft[1].entry,type:"cardPayment",accountId:"bank",toId:"card"};
  ledger.transactions.push(repayment);
  const retry = parseStatement(source, ledger, "card", date, "month-first", mapping);
  assert.equal(retry[1].match, repayment.id);
  const saved = importStatement(ledger, retry, "card.csv", "", date, false);
  assert.equal(saved.transactions.length, 2);
  assert.equal(saved.transactions.filter(entry => entry.type === "cardPayment").length, 1);
});

test("supported text PDFs retain explicit debit and credit directions", () => {
  const text = statementCsvFromText(["Date Description Amount\n02 Nov 2026 Cafe 250.00 DR.\n04 Nov 2026 Refund 55.00 CR"]);
  assert.deepEqual(parseStatement(text, empty(), "bank", date).map(line => line.signed), [-25000,5500]);
  assert.equal(statementCsvFromText(["Date Description Amount\n02 Nov 2026 Cafe 250.00"]), "");
});

test("a recorded movement can match only one row per statement account", () => {
  const ledger = empty();
  const text = "Date,Description,Debit,Credit\n2026-11-03,Bakery,22,\n2026-11-03,Groceries,22,";
  const preview = parseStatement(text, ledger, "bank", date);
  ledger.transactions.push({...preview[0].entry,id:"recorded"});
  const duplicatedMatch = preview.map(line => ({...line,match:"recorded",selected:false}));
  assert.throws(() => importStatement(ledger, duplicatedMatch, "bank.csv", "", date, false), /same recorded entry/);
  assert.equal(ledger.transactions.length, 1);
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
