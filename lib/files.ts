import { field, importLedger, minor, row, rows, validDate, type Entry, type Ledger, type Row } from "./ledger.ts";
import {desktopDownload, isDesktop} from "./desktop.ts";
import { matchRecordedBills, validateFinance } from "./finance.ts";

export function csvEncode(table: unknown[][]) {
  return "\uFEFF" + table.map(line => line.map(value => {
    const text = String(value ?? "");
    const safe = /^[=+@\-\t\r]/.test(text) ? "'" + text : text;
    return '"' + safe.replace(/"/g, '""') + '"';
  }).join(",")).join("\r\n");
}

export function csvParse(text: string): string[][] {
  if (text.length > 3_000_000) throw new Error("Choose a statement CSV smaller than 3 MB.");
  const result: string[][] = [];
  let cell = "", line: string[] = [], quoted = false, closed = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {cell += '"'; i++;}
      else if (c === '"') {quoted = false;closed = true;}
      else cell += c;
    } else if (c === '"') {
      if (cell || closed) throw new Error("Malformed CSV quotes.");
      quoted = true;
    } else if (c === ",") {line.push(cell);cell = "";closed = false;}
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      line.push(cell); if (line.some(c => c.trim())) result.push(line);
      cell = "";line = [];closed = false;
    } else {
      if (closed && c.trim()) throw new Error("Unexpected text after a quoted CSV cell.");
      if (!closed) cell += c;
    }
  }
  if (quoted) throw new Error("An unclosed CSV quote was found.");
  line.push(cell);if (line.some(c => c.trim())) result.push(line);
  return result;
}

function bankDate(text: string, dateOrder: "day-first" | "month-first") {
  text = text.trim();
  const iso = /^(\d{4}-\d{2}-\d{2})(?:$|[ T])/.exec(text);
  if (iso && validDate(iso[1])) return iso[1];
  const match = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4}|\d{2})(?:$|\s)/.exec(text);
  if (match) {
    const year = match[3].length === 2 ? String(2000 + Number(match[3])) : match[3];
    const date = year + "-" + (dateOrder === "day-first" ? match[2] : match[1]).padStart(2, "0") + "-" + (dateOrder === "day-first" ? match[1] : match[2]).padStart(2, "0");
    if (validDate(date)) return date;
  }
  const named = /^(\d{1,2})[\s\/-]+([A-Za-z]{3,9})[\s,\/-]+(\d{4})(?:$|\s)/.exec(text);
  if (named) {
    const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(named[2].slice(0, 3).toLowerCase()) + 1;
    const date = named[3] + "-" + String(month).padStart(2, "0") + "-" + named[1].padStart(2, "0");
    if (month && validDate(date)) return date;
  }
  throw new Error("Use YYYY-MM-DD, DD/MM/YYYY, DD/MM/YY or DD Mon YYYY dates.");
}
function numeric(text: string) {
  text = text.trim();
  if (!text || text === "-" || text === "—") return 0;
  const negative = /dr\.?$/i.test(text) || /^\(/.test(text);
  const cleaned = text.replace(/(?:cr|dr)\.?$/i, "").replace(/[₹,\s()]/g, "");
  if (!/^[+-]?(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(cleaned)) throw new Error("Review the statement's monetary amounts.");
  return negative ? -Math.abs(Number(cleaned)) : Number(cleaned);
}
const signature = (entry: Row) => [entry.date, entry.type, minor(entry.amount), entry.accountId, entry.toId ?? "", field(entry, "note").trim().toLowerCase()].join("|");
export type Staged = {entry: Entry; match: string; possible: string; selected: boolean; statementAccountId: string; signed: number};
const normalizeDescription = (value?: string) => (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export function statementMovement(entry: Entry, accountId: string) {
  if (entry.accountId === accountId) return minor(entry.amount) * (entry.type === "income" || entry.type === "refund" ? 1 : -1);
  return entry.toId === accountId && (entry.type === "transfer" || entry.type === "cardPayment") ? minor(entry.amount) : 0;
}
export function statementMatches(ledger: Ledger, item: Staged) {
  return ledger.transactions.filter(t => t.date === item.entry.date && statementMovement(t, item.statementAccountId) === item.signed);
}

export const statementFields = {
  date: ["transactiondate", "txndate", "date", "valuedate", "postingdate"],
  note: ["description", "narration", "particulars", "particular", "details", "note", "merchant", "remarks"],
  debit: ["debit", "withdrawal", "withdrawalamt", "debitamount", "moneyout"],
  credit: ["credit", "deposit", "depositamt", "creditamount", "moneyin"],
  amount: ["transactionamount", "txnamount", "amount"],
  direction: ["transactiontype", "type", "direction", "drcr", "crdr"]
} as const;
export type StatementColumns = Record<keyof typeof statementFields, number>;

export function statementColumns(text: string) {
  const table = csvParse(text), labels = table.shift() ?? [];
  const headers = labels.map(text => text.toLowerCase().replace(/[^a-z]/g, ""));
  const col = (...names: string[]) => {
    for (const name of names) {const exact = headers.indexOf(name);if (exact >= 0) return exact;}
    return headers.findIndex(h => !h.includes("balance") && names.some(name => h.startsWith(name) || h.endsWith(name)));
  };
  const columns = Object.fromEntries(Object.entries(statementFields).map(([name, values]) => [name, col(...values)])) as StatementColumns;
  if (columns.amount === columns.debit || columns.amount === columns.credit) columns.amount = -1;
  return {table, labels, columns};
}

export function parseStatement(text: string, ledger: Ledger, accountId: string, asOf: string,
  dateOrder: "day-first" | "month-first" = "day-first", options?: {columns?: StatementColumns; debitPositive?: boolean}): Staged[] {
  const account = ledger.accounts.find(a => a.id === accountId);
  if (!account) throw new Error("Choose an account first.");
  const {table, columns, labels} = statementColumns(text);
  const {date, note, debit, credit, amount, direction} = options?.columns ?? columns;
  const selectedColumns = [date, note, debit, credit, amount, direction].filter(index => index >= 0);
  if (selectedColumns.some(index => !Number.isInteger(index) || index >= labels.length) || new Set(selectedColumns).size !== selectedColumns.length)
    throw new Error("Map each statement field to a different column.");
  if (date < 0 || (amount < 0 && debit < 0 && credit < 0)) throw new Error("CSV needs a Date column and Amount or Debit / Credit columns.");
  if (!table.length) throw new Error("This statement contains no transaction rows.");
  if (table.length > 5000) throw new Error("Import no more than 5,000 statement rows at a time.");
  const byMovement = new Map<number, Entry[]>(), categoriesByDescription = new Map<string, Set<string>>();
  const categoryKey = (type: string, description?: string) => type + ":" + normalizeDescription(description);
  for (const recorded of ledger.transactions) {
    const movement = statementMovement(recorded, accountId);
    if (!movement) continue;
    const neighbors = byMovement.get(movement) ?? [];
    neighbors.push(recorded);
    byMovement.set(movement, neighbors);
    if (recorded.category && normalizeDescription(recorded.note)) {
      const key = categoryKey(recorded.type, recorded.note);
      const common = categoriesByDescription.get(key) ?? new Set<string>();
      common.add(recorded.category);
      categoriesByDescription.set(key, common);
    }
  }
  const seen = new Set<string>();
  return table.map((line, i) => {
    try {
      const posted = bankDate(line[date] ?? "", dateOrder);
      if (posted < account.openingDate || posted > asOf) throw new Error("The date must be within the account's recorded history.");
      const dr = debit >= 0 ? Math.abs(numeric(line[debit] ?? "")) : 0, cr = credit >= 0 ? Math.abs(numeric(line[credit] ?? "")) : 0;
      if (dr && cr) throw new Error("The row contains both a debit and a credit.");
      let signed = amount >= 0 ? numeric(line[amount] ?? "") : 0;
      if (options?.debitPositive && !/(?:cr|dr)\.?$/i.test((line[amount] ?? "").trim())) signed = -signed;
      const mode = direction >= 0 ? (line[direction] ?? "").toLowerCase().trim().replace(/^(dr|cr)\.$/, "$1") : "";
      if (/^(dr|debit|expense|withdrawal)$/.test(mode)) signed = -Math.abs(signed);
      else if (/^(cr|credit|income|deposit|refund)$/.test(mode)) signed = Math.abs(signed);
      else if (mode) throw new Error("Unrecognized debit / credit direction.");
      if ((dr || cr) && signed && minor(Math.abs(signed)) !== minor(dr || cr))
        throw new Error("The amount disagrees with the debit or credit column.");
      if ((dr && /^(cr|credit|income|deposit|refund)$/.test(mode)) || (cr && /^(dr|debit|expense|withdrawal)$/.test(mode)))
        throw new Error("The direction disagrees with the debit or credit column.");
      const incoming = cr > 0 || (!dr && signed > 0);
      const type = incoming ? account.type === "credit" ? "refund" : "income" : "expense";
      const categories = type === "income" ? ledger.categories.income : ledger.categories.expense;
      const description = (note >= 0 ? line[note] : "")?.trim().slice(0, 1200) || "";
      const remembered = categoriesByDescription.get(categoryKey(type, description));
      const category = (remembered?.size === 1 ? categories.find(value => remembered.has(value)) : undefined) ||
        categories.find(c => c === (type === "income" ? "Other" : "Other Expenses")) || categories[0];
      const entry: Entry = {id: crypto.randomUUID(), type, date: posted, amount: dr || cr || Math.abs(signed), accountId,
        category, toId: "", note: description || "Statement entry", source: "statement"};
      if (minor(entry.amount) <= 0) throw new Error("The transaction amount must be positive.");
      const key = signature(entry);
      if (seen.has(key)) throw new Error("The file contains a duplicate transaction. Review it before importing.");
      seen.add(key);
      const signedAmount = minor(entry.amount) * (incoming ? 1 : -1);
      const possible = (byMovement.get(signedAmount) ?? []).filter(t => Math.abs(Date.parse(t.date) - Date.parse(entry.date)) <= 86400000);
      const sameDescription = possible.filter(t => t.date === entry.date && normalizeDescription(t.note) === normalizeDescription(entry.note));
      const match = sameDescription.length === 1 ? sameDescription[0].id : "";
      const needsClassification = /\b(?:neft|imps|rtgs|self transfer|funds? transfer|card payment|payment received|payment thank you|card repayment|card settlement)\b/i.test(entry.note ?? "");
      return {entry, match, possible: !match && (possible.length || needsClassification) ? possible.length === 1 ? possible[0].id : "review" : "",
        selected: !match && possible.length === 0 && !needsClassification, statementAccountId: accountId, signed: signedAmount};
    } catch (error) {throw new Error("CSV row " + (i + 2) + " · " + (error instanceof Error ? error.message : "Invalid row."));}
  });
}

export function importStatement(ledger: Ledger, staged: Staged[], filename: string, text: string, asOf: string, archive = true): Ledger {
  let next = structuredClone(ledger);
  const reconciled = {...row(row(next.settings.dailyV6).reconciled)};
  const signatures = new Set(next.transactions.map(signature));
  const matchedMovements = new Set<string>();
  for (const item of staged) {
    if (!item.selected && !item.match) continue;
    const target = item.match && next.transactions.find(t => t.id === item.match);
    if (item.match && (!target || target.date !== item.entry.date || statementMovement(target, item.statementAccountId) !== item.signed))
      throw new Error("A reconciliation match changed. Review the preview.");
    if (target) {
      const movement = JSON.stringify([item.statementAccountId, target.id]);
      if (matchedMovements.has(movement)) throw new Error("Two statement rows match the same recorded entry. Choose a different match for one of the rows.");
      matchedMovements.add(movement);
      reconciled[target.id] = {at: asOf, source: filename};
      continue;
    }
    if (statementMovement(item.entry, item.statementAccountId) !== item.signed) throw new Error("The classified transfer direction does not agree with the statement.");
    const key = signature(item.entry);
    if (signatures.has(key)) throw new Error("A matching transaction now exists. Preview the file again.");
    signatures.add(key);
    next.transactions.push(item.entry);
    reconciled[item.entry.id] = {at: asOf, source: filename};
  }
  next.settings.dailyV6 = {...row(next.settings.dailyV6), reconciled};
  if (archive) next.settings.statementArchives = [...rows(next.settings.statementArchives), {
    id: crypto.randomUUID(), name: filename.slice(0, 120), importedAt: new Date().toISOString(), text, accountId: staged[0]?.statementAccountId ?? ""
  }];
  next = matchRecordedBills(next, asOf);
  return validateFinance(next, asOf);
}

export function base64(bytes: Uint8Array) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 16384) text += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(text);
}
export function unbase64(text: string) {
  const decoded = atob(text);
  return Uint8Array.from(decoded, char => char.charCodeAt(0));
}
export function download(name: string, content: string | Blob) {
  if (isDesktop()) {
    void desktopDownload(name, typeof content === "string" ? new Blob([content], {type: "application/json"}) : content)
      .catch(error => window.dispatchEvent(new CustomEvent("atlas-export-status", {detail: {error: String(error)}})));
    return;
  }
  const url = URL.createObjectURL(typeof content === "string" ? new Blob([content], {type: "application/json"}) : content);
  const link = document.createElement("a");
  link.href = url;link.download = name;link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export async function attachReceipt(ledger: Ledger, transactionId: string, file: File): Promise<Ledger> {
  if (!ledger.transactions.some(t => t.id === transactionId)) throw new Error("Choose a recorded transaction.");
  if (!["image/png", "image/jpeg", "image/webp", "application/pdf"].includes(file.type) || file.size > 4_000_000)
    throw new Error("Choose a PNG, JPEG, WEBP or PDF no larger than 4 MB.");
  const receipts = rows(ledger.receipts);
  if (receipts.length >= 100 || receipts.reduce((size, item) => size + Number(item.size || 0), file.size) > 15_000_000)
    throw new Error("The attachment limit is 100 files and 15 MB per workspace. Export an archive before removing older attachments.");
  const receipt = {id: crypto.randomUUID(), txId: transactionId, name: file.name.slice(0, 120), type: file.type, size: file.size,
    data: base64(new Uint8Array(await file.arrayBuffer())), at: new Date().toISOString()};
  return {...ledger, receipts: [...receipts, receipt]};
}

// Legacy archives use ordinary ZIP entries. Limit both compressed and expanded sizes.
export async function readLegacyArchive(file: File): Promise<Ledger> {
  if (file.size > 30_000_000) throw new Error("Choose an archive smaller than 30 MB.");
  const data = new Uint8Array(await file.arrayBuffer()), view = new DataView(data.buffer), files = new Map<string, Uint8Array>();
  let offset = 0, expanded = 0;
  while (offset + 30 <= data.length && view.getUint32(offset, true) === 0x04034b50) {
    const flags = view.getUint16(offset + 6, true), method = view.getUint16(offset + 8, true);
    const compressed = view.getUint32(offset + 18, true), size = view.getUint32(offset + 22, true);
    const nameSize = view.getUint16(offset + 26, true), extra = view.getUint16(offset + 28, true);
    expanded += size;
    if (flags & 9 || expanded > 30_000_000 || files.size >= 120 || offset + 30 + nameSize + extra + compressed > data.length)
      throw new Error("Unsupported or oversized ZIP entry. Export an unencrypted legacy data-and-receipts archive.");
    const name = new TextDecoder().decode(data.subarray(offset + 30, offset + 30 + nameSize));
    const bytes = data.slice(offset + 30 + nameSize + extra, offset + 30 + nameSize + extra + compressed);
    let output: Uint8Array;
    if (method === 0) output = bytes;
    else if (method === 8) {
      const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
      const chunks: Uint8Array[] = [];let count = 0;
      for (;;) {const item = await reader.read();if (item.done) break;count += item.value.length;if (count > size || count > 30_000_000) {await reader.cancel();throw new Error("Expanded ZIP entry exceeds its size limit.");}chunks.push(item.value);}
      output = new Uint8Array(count);let position = 0;for (const chunk of chunks) {output.set(chunk, position);position += chunk.length;}
    } else throw new Error("Unsupported ZIP compression.");
    if (output.length !== size || checksum(output) !== view.getUint32(offset + 14, true)) throw new Error("An archive entry failed its integrity check.");
    if (files.has(name)) throw new Error("The archive contains duplicate filenames.");
    files.set(name, output);
    offset += 30 + nameSize + extra + compressed;
  }
  let ledger: Ledger | undefined;
  for (const [name, bytes] of files) if (name.toLowerCase().endsWith(".json")) {
    try {ledger = importLedger(JSON.parse(new TextDecoder().decode(bytes)));break;} catch {}
  }
  if (!ledger) throw new Error("This ZIP does not contain a Finance Atlas JSON ledger.");
  const manifestBytes = files.get("receipt_manifest.json");
  if (manifestBytes) {
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    if (!Array.isArray(manifest) || manifest.length > 100) throw new Error("Invalid receipt manifest.");
    const attachments = manifest.map(item => {
      const record = row(item), bytes = files.get(field(record, "path"));
      if (!bytes || bytes.length > 4_000_000 || !["image/png", "image/jpeg", "image/webp", "application/pdf"].includes(field(record, "type")))
        throw new Error("A receipt is missing or unsupported. The archive has not been imported.");
      return {id: field(record, "id") || crypto.randomUUID(), txId: field(record, "transactionId"), name: field(record, "name"),
        type: record.type, size: bytes.length, data: base64(bytes), at: new Date().toISOString()};
    });
    ledger = {...ledger, receipts: [...rows(ledger.receipts), ...attachments]};
  }
  return ledger;
}

function checksum(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

export function receiptArchive(ledger: Ledger): Blob {
  const encoder = new TextEncoder(), receipts = rows(ledger.receipts);
  const manifest = receipts.map((receipt, i) => ({id: receipt.id, transactionId: receipt.txId, name: receipt.name, type: receipt.type,
    path: "receipts/" + i + "_" + field(receipt, "name").replace(/[^a-zA-Z0-9.()_ -]/g, "_")}));
  const entries: [string, Uint8Array][] = [
    ["Finance_Atlas_Data.json", encoder.encode(JSON.stringify({app: "Finance Atlas", state: {...ledger, receipts: []}}))],
    ["receipt_manifest.json", encoder.encode(JSON.stringify(manifest))]
  ];
  for (let i = 0; i < receipts.length; i++) entries.push([manifest[i].path, unbase64(field(receipts[i], "data"))]);
  return zipFiles(entries);
}

export function zipFiles(entries: [string, Uint8Array][]): Blob {
  const encoder = new TextEncoder();
  const parts: Uint8Array<ArrayBuffer>[] = [], directory: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (const [filename, data] of entries) {
    const name = encoder.encode(filename), crc = checksum(data), header = new Uint8Array(30 + name.length), local = new DataView(header.buffer);
    local.setUint32(0, 0x04034b50, true);local.setUint16(4, 20, true);local.setUint16(6, 0x0800, true);
    local.setUint32(14, crc, true);local.setUint32(18, data.length, true);local.setUint32(22, data.length, true);local.setUint16(26, name.length, true);header.set(name, 30);
    const record = new Uint8Array(46 + name.length), central = new DataView(record.buffer);
    central.setUint32(0, 0x02014b50, true);central.setUint16(4, 20, true);central.setUint16(6, 20, true);central.setUint16(8, 0x0800, true);
    central.setUint32(16, crc, true);central.setUint32(20, data.length, true);central.setUint32(24, data.length, true);central.setUint16(28, name.length, true);central.setUint32(42, offset, true);record.set(name, 46);
    parts.push(header, new Uint8Array(data));directory.push(record);offset += header.length + data.length;
  }
  const end = new Uint8Array(22), trailer = new DataView(end.buffer);
  trailer.setUint32(0, 0x06054b50, true);trailer.setUint16(8, entries.length, true);trailer.setUint16(10, entries.length, true);
  trailer.setUint32(12, directory.reduce((size, item) => size + item.length, 0), true);trailer.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], {type: "application/zip"});
}

export function migrateEmiBackup(input: unknown, base: Ledger, asOf: string): Ledger {
  const old = row(row(input).state ?? input);
  if (!Array.isArray(old.loans) || !Array.isArray(old.payments) || base.loans.length) throw new Error("Import an EMI Control Room backup into a workspace without existing EMI plans.");
  const next = structuredClone(base), mappings = new Map<unknown, string>(), accounts = row(old.accounts);
  for (const [key, type] of [["creditCards", "credit"], ["savingsAccounts", "bank"]] as const) for (const item of rows(accounts[key])) {
    let a = next.accounts.find(a => a.name.toLowerCase() === field(item, "name").toLowerCase() && a.type === type);
    if (!a) {
      a = {id: crypto.randomUUID(), name: field(item, "name"), type, opening: 0, openingDate: "1900-01-01", statementDay: 15, dueDay: 5, dueOffset: 1, limit: 0};
      next.accounts.push(a);
    }
    mappings.set(item.id, a.id);
  }
  for (const item of rows(old.loans)) {
    const kind = /credit card|no.cost/i.test(field(item, "category")) ? "credit" : "bank";
    const category = next.categories.expense.includes(field(item, "category")) ? field(item, "category") : "Debt";
    next.loans.push({...item, id: String(item.id), title: field(item, "title"), kind, emi: Number(item.emi), financed: Number(item.financed) || 0,
      installments: Number(item.installments), previouslyPaid: Number(item.previouslyPaid) || 0, firstDue: field(item, "firstDue"), category,
      bankId: mappings.get(item.savingsAccountId) || "", cardId: mappings.get(item.creditCardId) || ""});
  }
  for (const item of rows(old.payments)) {
    const l = next.loans.find(l => l.id === item.loanId);
    if (!l) throw new Error("An imported EMI payment has no matching plan.");
    next.transactions.push({...item, id: crypto.randomUUID(), type: "expense", date: field(item, "paidOn"), amount: Number(item.amount), category: String(l.category),
      accountId: String(l.kind === "credit" ? l.cardId : mappings.get(item.savingsAccountId) || l.bankId), installment: Number(item.installment), loanId: String(l.id),
      note: field(l, "title") + " · migrated EMI #" + item.installment, toId: ""});
  }
  next.settings.emiBudget = Number(row(old.settings).budget) || 0;
  return validateFinance(next, asOf);
}
