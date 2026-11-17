import {row, rows, type Ledger} from "./ledger.ts";
import {cashMetrics, debtRows, loans, receivables, schedule} from "./finance.ts";
import {zipFiles} from "./files.ts";

type Sheet = {name: string; rows: unknown[][]; currency: number[]};
const xml = (value: unknown) => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
  .replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"}[c]!));
const column = (index: number): string => {
  let result = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result;
  return result;
};

export function auditWorkbook(ledger: Ledger, month: string, asOf: string): Blob {
  const sheets: Sheet[] = [], metrics = cashMetrics(ledger, month, asOf);
  const add = (name: string, header: string[], values: unknown[][], currency: number[] = []) => {
    if (values.length > 100000) throw new Error("Workbook sheets support up to 100,000 rows. Use the complete JSON backup for larger schedules.");
    sheets.push({name, rows: [header, ...values], currency});
  };
  add("Monthly summary", ["Metric", "Amount INR"], [
    ["Income", metrics.income / 100], ["Spending", metrics.spending / 100], ["Net savings", metrics.savings / 100],
    ["Actual cash inflow", metrics.inflow / 100], ["Actual cash outflow", metrics.outflow / 100], ["Expected cash outflow", metrics.expectedOutflow / 100],
    ["Projected cash surplus", metrics.projectedCashSurplus / 100], ["Bank EMIs paid", metrics.bankEmiPaid / 100],
    ["Card EMIs posted", metrics.cardEmiPosted / 100], ["Card EMI settlement portion", metrics.cardEmiPaid / 100]
  ], [1]);
  add("Accounts", ["ID", "Name", "Type", "Opening INR", "Opening date", "Limit INR", "Statement day", "Due day"],
    ledger.accounts.map(a => [a.id, a.name, a.type, a.opening, a.openingDate, a.limit, a.statementDay, a.dueDay]), [3, 5]);
  add("Transactions", ["ID", "Date", "Type", "Amount INR", "Account ID", "Destination ID", "Category", "Notes", "Loan ID", "Installment", "Bill ID", "Statement ID", "Receivable plan"],
    ledger.transactions.map(t => [t.id, t.date, t.type, t.amount, t.accountId, t.toId, t.category, t.note, t.loanId, t.installment, t.serviceId || t.billId, t.cardStatementId, t.receivableLoanId]), [3]);
  add("Card statements", ["ID", "Card ID", "Issued", "Due", "Billed INR", "Minimum INR", "Reference"], rows(ledger.settings.cardStatements).map(s =>
    [s.id, s.cardId, s.statementDate, s.dueDate, s.billAmount, s.minimumDue, s.reference]), [4, 5]);
  add("Card payments", ["ID", "Statement ID", "Amount INR", "Initiated", "Completed", "Account ID", "Mode", "Reference", "Transaction ID"],
    rows(ledger.settings.cardStatementPayments).map(p => [p.id, p.statementId, p.amount, p.initiatedDate, p.completedDate, p.accountId, p.mode, p.reference, p.transactionId]), [2]);
  add("Bills and policies", ["ID", "Name", "Type", "Amount INR", "Account ID", "Due date", "Frequency", "Category", "Active", "Covered person", "Coverage INR", "Policy ends"],
    [...rows(ledger.settings.servicePlans), ...rows(ledger.settings.billRules)].map(p =>
      [p.id, p.name, p.kind, p.amount, p.accountId, p.dueDate || p.startMonth, p.frequency || "monthly", p.category, p.active !== false, p.insuredPerson, p.coverageAmount, p.policyEndDate]), [3, 10]);
  add("Bill payments", ["ID", "Plan ID", "Due cycle", "Amount INR", "Initiated", "Completed", "Account ID", "Transaction ID"],
    rows(ledger.settings.servicePayments).map(p => [p.id, p.serviceId, p.dueDate, p.amount, p.initiatedDate, p.completedDate, p.accountId, p.transactionId]), [3]);
  add("EMI plans", ["ID", "Name", "Kind", "EMI INR", "Financed INR", "Installments", "Previously paid", "First due", "Bank ID", "Card ID", "Category"],
    ledger.loans.map(l => [l.id, l.title, l.kind, l.emi, l.financed, l.installments, l.previouslyPaid, l.firstDue, l.bankId, l.cardId, l.category]), [3, 4]);
  const scheduleRows: unknown[][] = [];
  for (const loan of loans(ledger)) for (const item of schedule(ledger, loan, asOf)) {
    if (scheduleRows.length >= 100000) throw new Error("Workbook schedules support up to 100,000 rows. The JSON backup includes the full workspace.");
    scheduleRows.push([loan.id, loan.title, item.number, item.date, item.amount / 100, item.recorded, item.transaction?.id || "", item.link?.statementId || ""]);
  }
  add("EMI schedule", ["Plan ID", "Name", "Installment", "Due", "Amount INR", "Recorded", "Transaction ID", "Confirmed statement"], scheduleRows, [4]);
  add("Recoveries", ["Plan ID", "Name", "Expected INR", "Recovered INR", "Remaining INR"],
    receivables(ledger, asOf).map(r => [r.loan.id, r.loan.title, r.expected / 100, r.recovered / 100, r.remaining / 100]), [2, 3, 4]);
  add("Budgets", ["Period", "Type", "Category", "Planned INR"],
    Object.entries(ledger.budgets).flatMap(([period, budget]) => ["income", "expense"].flatMap(kind =>
      Object.entries(row(row(budget)[kind])).map(([category, amount]) => [period, kind, category, amount]))), [3]);
  add("Goals", ["ID", "Name", "Target INR", "Saved INR", "Deadline"], rows(ledger.goals).map(g => [g.id, g.name, g.target, g.saved, g.deadline]), [2, 3]);
  add("Debts", ["Name", "Source", "Known", "Principal INR", "APR", "Monthly payment INR"],
    debtRows(ledger, asOf).map(d => [d.name, d.source, d.known, typeof d.balance === "number" ? d.balance / 100 : "", d.apr, d.minPay]), [3, 5]);
  add("Reversals", ["ID", "Transaction ID", "Date", "Amount INR", "Reason", "Recorded at"], rows(ledger.settings.paymentReversals).map(r =>
    [r.id, r.transactionId, r.date, r.amount, r.reason, r.recordedAt]), [3]);
  add("Statement EMI links", ["ID", "Statement ID", "Loan ID", "Installment", "Amount INR", "Charge date"], rows(ledger.settings.statementEmiLinks).map(r =>
    [r.id, r.statementId, r.loanId, r.installment, r.amount, r.chargeDate]), [4]);
  add("EMI link corrections", ["ID", "Link ID", "Date", "Reason"], rows(ledger.settings.statementEmiLinkVoids).map(r => [r.id, r.linkId, r.date, r.reason]));
  add("Payment allocations", ["ID", "Transaction ID", "Statement ID", "Amount INR"], rows(ledger.settings.cardPaymentAllocations).map(r => [r.id, r.transactionId, r.statementId, r.amount]), [3]);
  add("Audit trail", ["When", "From revision", "To revision", "Change"], rows(row(ledger.settings.dailyV6).auditTrail).map(r => [r.at, r.from, r.to, r.changes]));
  const encoder = new TextEncoder(), entries: [string, Uint8Array][] = [];
  const file = (name: string, text: string) => entries.push([name, encoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + text)]);
  file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheets.map((_, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join("") + '</Types>');
  file("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  file("xl/workbook.xml", '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheets.map((sheet, i) => '<sheet name="' + xml(sheet.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join("") + '</sheets></workbook>');
  file("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets.map((_, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join("") +
    '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  file("xl/styles.xml", '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="₹#,##0.00;[Red]-₹#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>');
  sheets.forEach((sheet, index) => {
    const data = sheet.rows.map((values, r) => '<row r="' + (r + 1) + '">' + values.map((value, c) => {
      const reference = column(c) + (r + 1), style = r === 0 ? 1 : sheet.currency.includes(c) ? 2 : 0;
      return typeof value === "number" && Number.isFinite(value) ? '<c r="' + reference + '" s="' + style + '"><v>' + value + '</v></c>' :
        '<c r="' + reference + '" s="' + style + '" t="inlineStr"><is><t xml:space="preserve">' + xml(value) + '</t></is></c>';
    }).join("") + '</row>').join("");
    file("xl/worksheets/sheet" + (index + 1) + ".xml", '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultColWidth="22" defaultRowHeight="16"/><sheetData>' + data + '</sheetData></worksheet>');
  });
  return new Blob([zipFiles(entries)], {type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
}
