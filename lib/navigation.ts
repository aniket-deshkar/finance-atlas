import type {IconName} from "../app/icons";
import {row, type Ledger} from "./ledger";

export const views = ["Overview", "Daily hub", "Transactions", "Accounts", "Card statements", "Bills & policies", "EMIs & recoveries",
  "Monthly budget", "Payment calendar", "Salary & transfers", "Goals", "12-month plan", "Insights", "Debt & credit",
  "Reconciliation", "Cashback", "Receipts", "Monthly report", "Documents", "Tax", "Investments", "Vehicles", "Assistant", "Data & settings"] as const;
export type View = typeof views[number];
export const viewIcons: Record<View, IconName> = {
  Overview: "dashboard", "Daily hub": "activity", Transactions: "transfer", Accounts: "wallet", "Card statements": "card",
  "Bills & policies": "calendar", "EMIs & recoveries": "activity", "Monthly budget": "wallet", "Payment calendar": "calendar",
  "Salary & transfers": "transfer", Goals: "goals", "12-month plan": "activity", Insights: "activity", "Debt & credit": "card",
  Reconciliation: "shield", Cashback: "income", Receipts: "card", "Monthly report": "activity", "Data & settings": "settings",
  Documents: "file", Tax: "file", Investments: "activity", Vehicles: "vehicle", Assistant: "chat"
};
export const viewIds: Record<View, string> = {
  Overview: "overview", "Daily hub": "daily", Transactions: "transactions", Accounts: "accounts", "Card statements": "statements",
  "Bills & policies": "bills", "EMIs & recoveries": "emis", "Monthly budget": "budgets", "Payment calendar": "calendar",
  "Salary & transfers": "salary", Goals: "goals", "12-month plan": "forecast", Insights: "insights", "Debt & credit": "debt",
  Reconciliation: "reconcile", Cashback: "rewards", Receipts: "receipts", "Monthly report": "report", "Data & settings": "settings",
  Documents: "documents", Tax: "tax", Investments: "investments", Vehicles: "vehicles", Assistant: "assistant"
};
export const navGroups: {label: string; views: View[]}[] = [
  {label: "Daily finances", views: ["Overview", "Daily hub", "Transactions", "Accounts", "Card statements", "Bills & policies", "EMIs & recoveries", "Reconciliation", "Cashback"]},
  {label: "Planning", views: ["Monthly budget", "Payment calendar", "Salary & transfers", "Goals", "12-month plan", "Insights", "Debt & credit", "Monthly report", "Tax"]},
  {label: "Assets & documents", views: ["Investments", "Vehicles", "Documents", "Receipts"]}
];
export const layouts = [
  {id: "left", name: "Left sidebar"}, {id: "right", name: "Right sidebar"}, {id: "compact", name: "Compact rail"},
  {id: "top", name: "Top navigation"}, {id: "top-centered", name: "Top centred"}, {id: "bottom-centered", name: "Bottom centred"}, {id: "bottom-wide", name: "Bottom full width"}
];
export const widgets = [
  {id: "kpiCards", name: "Income, spending and savings"}, {id: "goals", name: "Savings goals"}, {id: "cashFlow", name: "Activity graph"},
  {id: "recentActivity", name: "Recent history"}, {id: "cardBills", name: "Credit card preview"}, {id: "upcomingBills", name: "Projected cash surplus"}
];
export function orderedViews(s: Ledger): View[] {
  const config = row(s.settings.uiCustomization);
  const order = Array.isArray(config.tabOrder) ? config.tabOrder as string[] : [];
  const hidden = Array.isArray(config.hiddenTabs) ? config.hiddenTabs as string[] : [];
  const sorted = [...views].sort((a, b) => {
    const aIndex = order.indexOf(viewIds[a]), bIndex = order.indexOf(viewIds[b]);
    return (aIndex < 0 ? 1000 + views.indexOf(a) : aIndex) - (bIndex < 0 ? 1000 + views.indexOf(b) : bIndex);
  });
  return sorted.filter(view => view === "Overview" || view === "Assistant" || view === "Data & settings" || !hidden.includes(viewIds[view]));
}
export const widgetVisible = (s: Ledger, id: string) => !((row(s.settings.uiCustomization).hiddenWidgets as string[] | undefined) ?? []).includes(id);
