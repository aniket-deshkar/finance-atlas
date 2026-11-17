import {validDate, type EntryKind} from "./ledger.ts";

export type AlertSuggestion = {type: Extract<EntryKind, "income" | "expense"> | ""; amount: string; date: string; accountHint: string; warnings: string[]; uncertainStatus: boolean};

// An intentionally conservative, on-device suggestion. This is not proof of settlement.
export function parseFinancialAlert(input: string): AlertSuggestion {
  const text = input.trim();
  if (!text || text.length > 8000) throw new Error("Paste one alert of up to 8,000 characters.");
  if (/\b(?:otp|one[- ]time\s+(?:password|passcode)|verification\s+code|upi\s+pin|password|passcode)\b/i.test(text))
    throw new Error("Do not paste OTPs, passwords, verification codes or UPI PINs.");
  if (/(?:https?:\/\/|www\.)/i.test(text)) throw new Error("Remove links before reviewing the alert.");
  const debit = /\b(?:debited|debit(?:ed)?\s+from|spent|withdrawn|purchase(?:d)?)\b/i.test(text);
  const credit = /\b(?:credited|credit(?:ed)?\s+to|received|refunded)\b/i.test(text);
  const type = debit === credit ? "" : debit ? "expense" : "income";
  const warnings: string[] = [];
  if (!type) warnings.push("The direction is ambiguous. Choose the transaction type yourself.");
  const uncertainStatus = /\b(?:failed|declined|reversed|pending|scheduled|due|payable|minimum\s+due)\b/i.test(text);
  if (uncertainStatus)
    warnings.push("This may be a reminder, pending, failed or reversed event. Check its actual status before recording it.");
  const candidates: string[] = [];
  const amounts = /(?:₹|\bINR\b|\bRs\.?)(?:\s|:)*([0-9][0-9,]*(?:\.[0-9]{1,2})?)(?![0-9.])/gi;
  for (const match of text.matchAll(amounts)) {
    const prefix = text.slice(Math.max(0, match.index! - 30), match.index);
    if (/\b(?:available|avail|avl|closing|outstanding|remaining|current)?\s*(?:balance|bal|limit|due)\s*(?:is|of|:|-)?\s*$/i.test(prefix)) continue;
    const value = match[1].replace(/,/g, "");
    if (Number(value) > 0 && Number(value) <= 10_000_000_000) candidates.push(value);
  }
  const amount = candidates.length === 1 ? candidates[0] : "";
  if (!amount) warnings.push("The amount could not be identified uniquely. Enter it yourself.");
  const dates = new Set<string>();
  for (const match of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) if (validDate(match[0])) dates.add(match[0]);
  for (const match of text.matchAll(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4}|\d{2})\b/g)) {
    const year = match[3].length === 2 ? String(2000 + Number(match[3])) : match[3];
    const date = `${year}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
    if (validDate(date)) dates.add(date);
  }
  for (const match of text.matchAll(/\b(\d{1,2})[\s\/-]+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s,\/-]+(\d{4})\b/gi)) {
    const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(match[2].toLowerCase()) + 1;
    const date = `${match[3]}-${String(month).padStart(2, "0")}-${match[1].padStart(2, "0")}`;
    if (validDate(date)) dates.add(date);
  }
  const date = dates.size === 1 ? [...dates][0] : "";
  if (!date) warnings.push("The transaction date is unclear. Choose it yourself.");
  const hints = new Set([...text.matchAll(/\b(?:a\/?c|account|card)(?:\s+(?:no\.?|number|ending|ending\s+in))?\s*(?:[:#-]\s*)?(?:[xX*•]{2,}\s*)?(\d{4})\b/gi)].map(m => m[1]));
  const accountHint = hints.size === 1 ? [...hints][0] : "";
  warnings.push("Review the account and category. A message is not proof that a payment cleared.");
  return {type, amount, date, accountHint, warnings, uncertainStatus};
}
