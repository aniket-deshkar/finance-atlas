import {field, minor, row, rows, validDate, type Ledger, type Row} from "./ledger.ts";
import {hasReversal} from "./ledger.ts";

export const workspaceRows = (ledger: Ledger, bucket: string) => rows(row(ledger.settings.financialRecords)[bucket]);
export function putFinancialRecord(ledger: Ledger, bucket: string, item: Row): Ledger {
  const existing = workspaceRows(ledger, bucket);
  return {...ledger, settings: {...ledger.settings, financialRecords: {...row(ledger.settings.financialRecords),
    [bucket]: [...existing.filter(value => value.id !== item.id), item]}}};
}

export function financialYear(date: string) {return Number(date.slice(0, 4)) - (date.slice(5, 7) < "04" ? 1 : 0);}
export const yearRange = (year: number) => ({start: year + "-04-01", end: (year + 1) + "-03-31"});
export const yearLabel = (year: number) => String(year) + "–" + String(year + 1).slice(-2);

function brackets(income: number, table: number[][]) {
  return Math.round(table.reduce((tax, [start, rate], index) =>
    tax + Math.max(0, Math.min(income, (table[index + 1]?.[0] ?? Infinity) * 100) - start * 100) * rate / 100, 0));
}

export function estimateTax(year: number, salary: number, interest: number, tds: number, deductions: number) {
  if (![2025, 2026].includes(year) || salary + interest > 500_000_000) return null;
  const oldBase = Math.max(0, salary - Math.min(salary, 5_000_000) + interest - deductions);
  const newBase = Math.max(0, salary - Math.min(salary, 7_500_000) + interest);
  const oldBeforeRebate = brackets(oldBase, [[250000, 5], [500000, 20], [1000000, 30]]);
  const newBeforeRebate = brackets(newBase, [[400000, 5], [800000, 10], [1200000, 15], [1600000, 20], [2000000, 25], [2400000, 30]]);
  const old = Math.round((oldBase <= 50_000_000 ? Math.max(0, oldBeforeRebate - 1_250_000) : oldBeforeRebate) * 1.04);
  const adjusted = newBase <= 120_000_000 ? Math.max(0, newBeforeRebate - 6_000_000) : Math.min(newBeforeRebate, newBase - 120_000_000);
  const modern = Math.round(adjusted * 1.04);
  return {old, modern, oldAfterTds: old - tds, modernAfterTds: modern - tds};
}

export function taxFigures(ledger: Ledger, year: number, asOf: string) {
  const {start, end} = yearRange(year);
  const inputs = workspaceRows(ledger, "tax").find(item => item.year === year) || {};
  const seen = ledger.transactions.filter(t => t.type === "income" && t.date >= start && t.date <= end && t.date <= asOf && !hasReversal(ledger, t.id, asOf));
  const ledgerSalary = seen.filter(t => t.category === "Paycheck").reduce((total, t) => total + minor(t.amount), 0);
  const ledgerInterest = seen.filter(t => t.category === "Interest").reduce((total, t) => total + minor(t.amount), 0);
  const salary = Number(inputs.salary) || 0, interest = inputs.interest === undefined ? ledgerInterest : Number(inputs.interest), tds = Number(inputs.tds) || 0;
  return {salary, interest, tds, ledgerSalary, ledgerInterest, inputs, estimate: inputs.salary === undefined || inputs.eligible !== true
    ? null : estimateTax(year, salary, interest, tds, Number(inputs.deductions) || 0)};
}

const fixedUnits = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 0;
export const unitsScale = 1_000_000;
export function portfolio(ledger: Ledger, asOf: string) {
  const positions = workspaceRows(ledger, "holdings").map(asset => {
    let quantity = 0, cost = 0, realised = 0, dividends = 0, invalid = false;
    const events = workspaceRows(ledger, "investmentEvents").filter(t => t.assetId === asset.id && field(t,"date") <= asOf)
      .sort((a,b) => field(a,"date").localeCompare(field(b,"date")));
    for (const event of events) {
      const amount = Math.max(0, Number(event.amount) || 0), units = fixedUnits(event.units);
      if (event.type === "Dividend") {dividends += amount;continue;}
      if (event.type === "Buy" && units) {quantity += units;cost += amount;continue;}
      if (event.type === "Sell" && units && units <= quantity) {
        const basis = units === quantity ? cost : Math.round(cost * units / quantity);
        quantity -= units;cost -= basis;realised += amount - basis;
      } else invalid = true;
    }
    const quote = workspaceRows(ledger, "prices").filter(q => q.assetId === asset.id && validDate(field(q,"date")) &&
      field(q,"date") <= asOf && Number(q.price) > 0).sort((a,b) => field(b,"date").localeCompare(field(a,"date"))).at(0);
    return {asset, quantity, cost, realised, dividends, invalid, quote, worth: quote ? Math.round(quantity * Number(quote.price) / unitsScale) : null};
  });
  return {positions, invested: positions.reduce((sum, item) => sum + item.cost, 0),
    marketValue: positions.reduce((sum, item) => sum + (item.worth ?? 0), 0),
    valuedCount: positions.filter(item => item.quantity > 0 && item.worth !== null).length};
}

export function vehicleCosts(ledger: Ledger, id: string, start: string, end: string, asOf: string) {
  const transactionIds = new Set(workspaceRows(ledger, "vehicleLinks").filter(row => row.vehicleId === id).map(row => row.transactionId));
  return ledger.transactions.filter(t => transactionIds.has(t.id) && t.date >= start && t.date <= end && t.date <= asOf &&
    !t.reversesId && !hasReversal(ledger, t.id, asOf))
    .reduce((sum, t) => sum + (t.type === "expense" ? minor(t.amount) : t.type === "refund" ? -minor(t.amount) : 0), 0);
}

export function vehicleReminders(ledger: Ledger, start: string, end: string) {
  return workspaceRows(ledger, "vehicles").flatMap(vehicle =>
    ([["insurance","Insurance renewal"],["service","Vehicle service"],["registration","Registration renewal"]] as const).flatMap(([key,label]) => {
      const date = field(vehicle,key);
      return validDate(date) && date >= start && date <= end ?
        [{id:field(vehicle,"id") + ":" + key,date,name:field(vehicle,"name") + " · " + label}] : [];
    })
  ).sort((a,b) => a.date.localeCompare(b.date));
}
