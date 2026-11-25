import {csvEncode, csvParse, inferStatementDateOrder, reviewStatement, statementColumns, statementMatches, type Staged, type StatementColumns} from "./files.ts";
import {field, minor, row, rows, type Ledger} from "./ledger.ts";

export type DocumentKind = "Statement" | "Tax evidence" | "Policy" | "Portfolio";
export type ExtractedDocument = {id: string; name: string; kind: DocumentKind; pages: string[]; date: string; accountId?: string;
  statementMapping?: {columns: StatementColumns; dateOrder: "day-first" | "month-first"; debitPositive: boolean}};

export function statementCsvFromText(pages: string[]) {
  const lines = pages.flatMap(page => page.split("\n"));
  const header = lines.find(line => /date/i.test(line) && /description|narration|particulars|transaction details/i.test(line) &&
    (/amount/i.test(line) || /(?:debit|withdrawal).*(?:credit|deposit)/i.test(line)));
  if (!header) return "";
  const columns = /(?:debit|withdrawal).*(?:credit|deposit)/i.test(header);
  const table: string[][] = [columns ? ["Date","Description","Debit","Credit"] : ["Date","Description","Amount","Direction"]];
  const date = /^(\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2})|\d{1,2}[ -][A-Za-z]{3,9}[ -](?:\d{4}|\d{2}))\s/;
  const columnAmount = /^(?:[₹\s]*[\d,]+(?:\.\d{1,2})?|[-—])$/;
  for (const source of lines) {
    const line = source.trim();
    const prefix = date.exec(line);
    if (!prefix) continue;
    const body = line.slice(prefix[0].length).trimStart();
    if (columns) {
      const fields = body.split(/\t+| {2,}/).map(cell => cell.trim());
      const trailing = /balance/i.test(header) ? 3 : 2;
      const amounts = fields.splice(-trailing);
      if (!fields.length || amounts.length !== trailing || !amounts.slice(0,2).every(cell => columnAmount.test(cell))) return "";
      table.push([prefix[1],fields.join(" "),...amounts.slice(0,2).map(cell => /^[-—]$/.test(cell) ? "" : cell)]);
    } else {
      const after = /^(.+?)\s+(?:(?:INR|Rs\.?)\s*|₹\s*)?([\d,]+(?:\.\d{1,2})?)\s*(DR|CR|DEBIT|CREDIT)\.?\s*(?:₹?[\d,]+(?:\.\d{1,2})?)?$/i.exec(body);
      const before = /^(.+?)\s+(DR|CR|DEBIT|CREDIT)\.?\s*(?:(?:INR|Rs\.?)\s*|₹\s*)?([\d,]+(?:\.\d{1,2})?)$/i.exec(body);
      if (!after && !before) return "";
      table.push(after ? [prefix[1],after[1],after[2],after[3]] : [prefix[1],before![1],before![3],before![2]]);
    }
  }
  return table.length > 1 ? csvEncode(table) : "";
}
export function documentHints(document: ExtractedDocument) {
  const text = document.pages.join("\n");
  const lines = text.split("\n");
  const find = (pattern: RegExp) => lines.map(line => pattern.exec(line.trim())?.[1] || "").find(Boolean) || "";
  const number = (pattern: RegExp) => {
    const value = find(pattern).replaceAll(",","");
    return value && /^\d{1,10}(?:\.\d{1,2})?$/.test(value) ? Number(value) : undefined;
  };
  return {
    insurer: find(/^(?:insurer|insurance company)\s*:\s*(.{2,100})$/i),
    product: find(/^(?:product name|plan name)\s*:\s*(.{2,100})$/i),
    uin: /\b\d{3}[A-Z]\d{3}V\d{2}\d{4}\b/i.exec(text)?.[0]?.toUpperCase() || "",
    salary: number(/^(?:gross salary|total gross salary)\s*[:₹\s]+([\d,.]+)$/i),
    interest: number(/^(?:total interest|interest income)\s*[:₹\s]+([\d,.]+)$/i),
    tds: number(/^(?:total tds|total tax deducted)\s*[:₹\s]+([\d,.]+)$/i)
  };
}
export const merchantKey = (note?: string) => (note || "").trim().toLowerCase().replace(/\s+/g, " ");
export const rowKey = (line: Staged) => JSON.stringify([line.statementAccountId, line.entry.date, line.signed, merchantKey(line.entry.note)]);
const amount = (text: string) => {
  const raw = text.trim().replace(/[₹,]/g, "");
  return /^-?\d+(?:\.\d{1,2})?$/.test(raw) ? minor(Number(raw)) : NaN;
};

// Verification is intentionally restricted to a canonical export with running balances.
export function verifiedStatement(text: string, opening: number, closing: number, staged: Staged[]) {
  const [headers, ...lines] = csvParse(text);
  if (!Number.isSafeInteger(opening) || !Number.isSafeInteger(closing) ||
      headers?.map(value => value.trim().toLowerCase()).join(",") !== "date,description,debit,credit,balance" ||
      !lines.length || lines.length !== staged.length) return false;
  let running = opening;
  for (const [index, line] of lines.entries()) {
    if (line.length !== 5 || index > 0 && staged[index - 1].entry.date > staged[index].entry.date) return false;
    running += staged[index].signed;
    if (amount(line[4]) !== running) return false;
  }
  return running === closing;
}

export function statementDraft(ledger: Ledger, text: string, accountId: string, asOf: string,
  verification?: {opening: number; closing: number}, mapping?: ExtractedDocument["statementMapping"], reportIssues?: (issues: string[]) => void) {
  const {table, columns} = statementColumns(text);
  if (!mapping && columns.amount >= 0 && columns.direction < 0 && columns.debit < 0 && columns.credit < 0 &&
      !table.every(line => /(?:cr|dr)\.?$/i.test(line[columns.amount]?.trim() ?? "")))
    throw Error("This statement needs a sign convention. Open Reconciliation to map positive and negative amounts.");
  const {entries, issues} = reviewStatement(text, ledger, accountId, asOf, mapping?.dateOrder ?? inferStatementDateOrder(table, columns.date), mapping);
  if (issues.length && (!reportIssues || !entries.length)) throw Error(issues[0]);
  if (reportIssues) reportIssues(issues);
  const account = ledger.accounts.find(a => a.id === accountId);
  const automation = row(row(ledger.settings.statementAutomation)[accountId]);
  const canPost = Boolean(!issues.length && !mapping && automation.enabled && account?.type === "bank" && verification &&
    verifiedStatement(text, verification.opening, verification.closing, entries));
  return entries.map(line => {
    const description = merchantKey(line.entry.note);
    const matches = statementMatches(ledger, line).filter(t => t.date === line.entry.date && merchantKey(t.note) === description);
    const rule = rows(automation.rules).find(r => field(r, "note") === description && r.type === line.entry.type);
    const category = field(row(rule), "category");
    const allowed = line.entry.type === "income" ? ledger.categories.income : ledger.categories.expense;
    const transferLike = /transfer|payment|repay|neft|rtgs|imps|ach|autodebit|card settlement/i.test(description);
    const posted = canPost && !line.possible && !matches.length && Boolean(category) && allowed.includes(category) && !transferLike;
    return {...line, match: matches.length === 1 ? matches[0].id : "", possible: matches.length > 1 ? "review" : line.possible,
      selected: posted, entry: posted ? {...line.entry, category, source: "verified-statement"} : line.entry};
  });
}

export async function readPdf(bytes: ArrayBuffer, password: (incorrect: boolean) => Promise<string>) {
  const pdf = await import("pdfjs-dist");
  pdf.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const task = pdf.getDocument({data: bytes, useSystemFonts: false, isImageDecoderSupported: false,
    useWasm: false, stopAtErrors: true, maxImageSize: 4_000_000});
  task.onPassword = (update: (password: string) => void, code: number) => {
    void password(code === pdf.PasswordResponses.INCORRECT_PASSWORD).then(update, () => task.destroy()).catch(() => {});
  };
  try {
    const document = await task.promise;
    if (document.numPages > 200) throw Error("Split large PDFs into files of at most 200 pages.");
    const pages: string[] = [];
    let size = 0;
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      let previous: {end:number; y:number; height:number; eol:boolean} | undefined;
      const parts: string[] = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        if (!item.str.trim()) {
          if (item.hasEOL && previous) previous.eol = true;
          continue;
        }
        const x = item.transform[4], y = item.transform[5];
        if (previous) {
          const gap = x - previous.end;
          parts.push(previous.eol || Math.abs(y - previous.y) > 2 ? "\n" : gap > Math.max(6, previous.height * .68) ? "\t" : " ");
        }
        parts.push(item.str);
        previous = {end:x + item.width, y, height:item.height, eol:item.hasEOL};
      }
      const text = parts.join("").trim();
      size += text.length;
      if (size > 750_000) throw Error("Split this PDF into smaller files.");
      pages.push(text);
      page.cleanup();
    }
    return pages;
  } finally {await task.destroy();}
}
