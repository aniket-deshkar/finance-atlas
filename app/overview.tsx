"use client";
import type {ReactNode} from "react";

import { useState } from "react";
import { balance, dayShift, displayPeriod, field, hasReversal, kinds, latestStatement, minor, money as formatMoney, monthLabel, monthShift, reportPeriod, rows, statementAmounts, totals, type Ledger } from "../lib/ledger";
import { budgetLimit, cashMetrics, cardBills, cardUsage, loans, netPosition, personal, postedRows, schedule, sum } from "../lib/finance";
import {portfolio} from "../lib/assets";
import { widgetVisible, type View } from "../lib/navigation";
import { Icon, type IconName } from "./icons";
import { dateText } from "./feature-ui";

function Panel({title, subtitle, children, action, hidden = false}: {title: string; subtitle: string; children: React.ReactNode; action: () => void; hidden?: boolean}) {
  return <section className="atlas-panel" hidden={hidden}><header><div><h2>{title}</h2><p>{subtitle}</p></div>
    <button className="icon-button" onClick={action} aria-label={"Open " + title.toLowerCase()}><Icon name="right" /></button></header>{children}</section>;
}

export function Overview({ledger, month, asOf, privacy, navigate, attention, selectMonth}: {ledger: Ledger; month: string; asOf: string; privacy: boolean; navigate: (view: View, accountId?: string) => void; attention?: ReactNode; selectMonth: (month: string) => void}) {
  const money = privacy ? () => "Hidden" : formatMoney;
  const [cardIndex, setCardIndex] = useState(0);
  const [flowIndex, setFlowIndex] = useState(5);
  const [spendCategory, setSpendCategory] = useState("");
  const [worthIndex, setWorthIndex] = useState(5);
  const period = displayPeriod(ledger, month, asOf), cash = cashMetrics(ledger, month, asOf, period);
  const liquid = sum(ledger.accounts.filter(a => a.type !== "credit").map(a => balance(ledger, a, asOf)));
  const cards = ledger.accounts.filter(a => a.type === "credit");
  const position = netPosition(ledger, asOf);
  const investments = portfolio(ledger, asOf);
  const unpriced = investments.positions.filter(item => item.quantity > 0 && item.worth === null).length;
  const worth = position.net + investments.marketValue;
  const trend = privacy ? [] : Array.from({length:6}, (_, i) => {
    const month = monthShift(asOf.slice(0, 7), i - 5);
    const date = i === 5 ? asOf : dayShift(monthShift(month, 1) + "-01", -1);
    const balanceTotal = sum(ledger.accounts.map(account => balance(ledger, account, date) * (account.type === "credit" ? -1 : 1)));
    return {date, month, value:balanceTotal + portfolio(ledger, date).marketValue};
  });
  const trendScale = Math.max(1, ...trend.map(item => Math.abs(item.value)));
  const labels = Array.from({length: 6}, (_, i) => monthShift(month, i - 5));
  const history = labels.map(m => {const p = displayPeriod(ledger, m, asOf);return totals(ledger, p.start, p.end, asOf);});
  const maxFlow = Math.max(1, ...history.flatMap(h => [h.income, Math.max(0, h.spending)]));
  const posted = postedRows(ledger, period.start, period.end, asOf);
  const mix = ledger.categories.expense.map(name => ({name, amount: sum(posted.filter(t => t.category === name && (t.type === "expense" || t.type === "refund")).map(t => t.type === "refund" ? -t.signed : t.signed))}))
    .filter(c => c.amount > 0).sort((a, b) => b.amount - a.amount);
  const mixTotal = sum(mix.map(c => c.amount));
  const selectedMix = mix.find(item => item.name === spendCategory);
  const palette = ["var(--green)", "var(--blue)", "var(--purple)", "var(--gold)", "var(--red)", "var(--muted)"];
  let running = 0;
  const stops = mix.map((c, i) => {const start = running;running += c.amount / mixTotal * 100;return `${palette[i % palette.length]} ${start}% ${running}%`;});
  const planned = sum(ledger.categories.expense.map(c => budgetLimit(ledger, month, c, asOf)));
  const budgetActualPeriod = reportPeriod(ledger, month);
  const configuredBudgetPeriod = `${budgetActualPeriod.basis} · ${dateText(budgetActualPeriod.start)} to ${dateText(budgetActualPeriod.end)}`;
  const budgetActual = totals(ledger, budgetActualPeriod.start, budgetActualPeriod.end, asOf).spending;
  const installments = loans(ledger).filter(personal).flatMap(l => schedule(ledger, l, asOf)).filter(i => !i.recorded && i.date <= period.end).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3);
  const bills = cards.flatMap(card => cardBills(ledger, card, asOf).map(b => ({...b, card}))).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3);
  const recent = ledger.transactions.filter(t => t.date >= period.start && t.date <= period.end && t.date <= asOf).slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4);
  const goals = rows(ledger.goals).filter(g => g.active !== false).slice(0, 2);
  const primary = cards[cardIndex % Math.max(1, cards.length)];
  const usage = primary ? cardUsage(ledger, primary, asOf) : undefined;
  const statement = primary ? latestStatement(ledger, primary.id, asOf) : undefined;
  const metrics: {label: string; amount: number; note: string; icon: IconName; tone: string; target: View}[] = [
    {label: "Income", amount: cash.income, note: "Recorded this payment cycle", icon: "income", tone: "mint", target: "Transactions"},
    {label: "Spending", amount: cash.spending, note: "Expenses less refunds", icon: "expense", tone: "sand", target: "Transactions"},
    {label: "Net savings", amount: cash.savings, note: cash.income > 0 ? `${(cash.savings / cash.income * 100).toFixed(1)}% of recorded income` : "Income less spending", icon: "wallet", tone: "blue", target: "Insights"},
    {label: "Projected savings", amount: cash.projectedCashSurplus, note: "Cash flow through " + dateText(period.end), icon: "activity", tone: "lilac", target: "Payment calendar"}
  ];
  return <div className="atlas-overview">
    <div className="atlas-hero-grid">
      <section className="balance-hero atlas-worth"><div className="hero-orbit" aria-hidden="true" /><div className="balance-top"><h2>Known net worth</h2><span className="local-badge"><Icon name="shield" />Local & encrypted</span></div>
        <strong className="liquid-value financial-value">{ money(worth) }</strong><p>Assets less recorded debt · {dateText(asOf)}</p>
        {!privacy && (position.unknown > 0 || unpriced > 0) && <p>{[
          position.unknown ? position.unknown + (position.unknown === 1 ? " debt without a balance" : " debts without balances") : "",
          unpriced ? unpriced + (unpriced === 1 ? " holding without a price" : " holdings without prices") : ""
        ].filter(Boolean).join(" · ")}</p>}
        <div className="atlas-worth-actions"><button className="atlas-liquid-link" onClick={() => navigate("Accounts")}>View accounts <Icon name="right" /></button>
          {!privacy && <button onClick={() => navigate("Documents")}><Icon name="file" /> Import files</button>}</div>
        <div className="balance-foot"><button onClick={() => navigate("Accounts")}><span>Cash & bank</span><strong className="financial-value">{money(liquid)}</strong></button>
          <button onClick={() => navigate("Investments")}><span>Priced investments</span><strong className="financial-value">{money(investments.marketValue)}</strong></button>
          <button onClick={() => navigate("Debt & credit")}><span>Known debt</span><strong className="financial-value">{money(position.debt)}</strong></button></div>
      </section>
      <div className="atlas-kpis" hidden={!widgetVisible(ledger, "kpiCards")}>{metrics.map(m => <button key={m.label} className={"atlas-kpi " + m.tone} onClick={() => navigate(m.target)} hidden={m.label === "Projected savings" && !widgetVisible(ledger, "upcomingBills")}>
        <span className="kpi-top"><span>{m.label}</span><Icon name={m.icon} /></span><strong className="financial-value">{money(m.amount)}</strong><small>{privacy && m.label === "Net savings" ? "Income less spending" : m.note}</small>
        <span className="kpi-line" aria-hidden="true"><svg viewBox="0 0 90 50"><circle cx="66" cy="42" r="30" /><circle cx="66" cy="42" r="20" /><circle cx="66" cy="42" r="40" /></svg></span>
      </button>)}</div>
    </div>
    {privacy ? <section className="atlas-panel"><h2>Charts and recent activity are hidden</h2>
      <p>Use Show amounts to view spending, balances, and activity.</p></section> : <>
    <div className="atlas-charts">
      <Panel title="Balance history" subtitle="Bank, cash, cards and priced holdings" action={() => navigate("Insights")}>
        <div className="atlas-worth-history" aria-label="Explore balance history">{trend.map((item, i) =>
          <button key={item.date} aria-label={monthLabel(item.month) + " " + money(item.value)} aria-pressed={worthIndex === i} onClick={() => setWorthIndex(i)}>
            <span className="atlas-worth-column" aria-hidden="true"><i data-negative={item.value < 0} style={{height: Math.abs(item.value) / trendScale * 48 + "%"}} /></span>
            <small>{monthLabel(item.month).split(" ")[0].slice(0, 3)}</small></button>)}</div>
        <p aria-live="polite">{dateText(trend[worthIndex].date)} · <strong className="financial-value">{money(trend[worthIndex].value)}</strong></p>
        <small className="muted">Historical balances exclude loans and separately tracked assets.</small>
      </Panel>
      <Panel title="Cash flow" subtitle={"Six periods ending " + monthLabel(month)} action={() => navigate("Insights")} hidden={!widgetVisible(ledger, "cashFlow")}>
        <div className="cash-bars" role="img" aria-label={history.map((h, i) => `${monthLabel(labels[i])}: income ${money(h.income)}, spending ${money(h.spending)}`).join("; ")}>
          {history.map((h, i) => <div className="cash-bar-group" key={labels[i]}><div className="cash-bar-pair"><span className="income-bar" style={{height: `${Math.max(0, h.income) / maxFlow * 100}%`}} /><span className="spend-bar" style={{height: `${Math.max(0, h.spending) / maxFlow * 100}%`}} /></div><small>{monthLabel(labels[i]).split(" ")[0].slice(0, 3)}</small></div>)}
        </div><div className="atlas-legend"><span><i />Income</span><span><i />Spending</span></div>
        <div className="atlas-chart-periods" aria-label="Explore cash flow">{labels.map((m,i) =>
          <button key={m} aria-pressed={flowIndex === i} onClick={() => setFlowIndex(i)}>{monthLabel(m).split(" ")[0].slice(0,3)}</button>)}</div>
        <p aria-live="polite">{monthLabel(labels[flowIndex])} · <span className="financial-value">{money(history[flowIndex].savings)}</span> net savings</p>
        <button onClick={() => {selectMonth(labels[flowIndex]);navigate("Transactions");}}>View this period’s transactions</button>
      </Panel>
      <Panel title="Spending mix" subtitle="Where your money goes this cycle" action={() => navigate("Monthly budget")} hidden={!widgetVisible(ledger, "cashFlow")}>
        {mixTotal ? <div className="spending-mix"><div className="atlas-donut" style={{background: `conic-gradient(${stops.join(",")})`}} role="img" aria-label="Spending category proportions"><div><strong>{mix.length}</strong><small>categories</small></div></div>
          <ul>{mix.slice(0, 6).map((c, i) => <li key={c.name}><button aria-pressed={spendCategory === c.name} onClick={() => setSpendCategory(c.name)}>
            <i style={{background: palette[i]}} />{c.name}</button><strong className="financial-value">{money(c.amount)}</strong></li>)}</ul></div> : <div className="atlas-empty"><Icon name="activity" /><strong>No spending recorded</strong><p>Record an expense to see spending by category.</p></div>}
        {selectedMix && <p aria-live="polite">{selectedMix.name} · <span className="financial-value">{(selectedMix.amount / mixTotal * 100).toFixed(1)}%</span> of spending</p>}
      </Panel>
    </div>
    {attention}
    <div className="atlas-detail-grid">
      <Panel title="Monthly budget" subtitle={configuredBudgetPeriod} action={() => navigate("Monthly budget")}>
        <span className="eyebrow">BUDGET REMAINING</span><strong className={"budget-value financial-value " + (planned && budgetActual > planned ? "over-budget" : "")}>{planned ? money(planned - budgetActual) : "Not set"}</strong>
        <progress max={100} value={planned ? Math.min(100, Math.max(0, budgetActual / planned * 100)) : 0} aria-label="Monthly budget used" />
        <div className="budget-labels"><span className="financial-value">{money(budgetActual)} spent</span><span className="financial-value">{money(planned)} planned</span></div>
        <button className="text-link" onClick={() => navigate("Monthly budget")}>Review budget<Icon name="right" /></button>
      </Panel>
      <Panel title="Next EMI installments" subtitle="Unrecorded · earliest first" action={() => navigate("EMIs & recoveries")}>
        {installments.length ? <ul className="atlas-rows">{installments.map(i => <li key={i.loan.id + i.number}><button onClick={() => navigate("EMIs & recoveries")}><span className="row-symbol"><Icon name="activity" /></span><span><strong>{i.loan.title}</strong><small>#{i.number} · {dateText(i.date)}{i.date < asOf ? " · Overdue" : ""}</small></span><strong className="financial-value">{money(i.amount)}</strong></button></li>)}</ul> : <div className="atlas-empty"><Icon name="calendar" /><strong>No installments due this cycle</strong><p>Your EMI schedule will appear here.</p></div>}
      </Panel>
      <Panel title="Card bills to prepare for" subtitle="Outstanding recorded card bills" action={() => navigate("Card statements")} hidden={!widgetVisible(ledger, "cardBills")}>
        {bills.length ? <ul className="atlas-rows">{bills.map((b, i) => <li key={b.card.id + i}><button onClick={() => navigate("Card statements", b.card.id)}><span className="row-symbol"><Icon name="card" /></span><span><strong>{b.card.name}</strong><small>{b.projected ? "Estimated due " : "Due "}{dateText(b.date)}</small></span><strong className="financial-value">{money(b.amount)}</strong></button></li>)}</ul> : <div className="atlas-empty"><Icon name="shield" /><strong>No outstanding card bills</strong><p>Add statements to track their payment dates.</p></div>}
      </Panel>
      <Panel title="Recent activity" subtitle="Your latest recorded transactions" action={() => navigate("Transactions")} hidden={!widgetVisible(ledger, "recentActivity")}>
        {recent.length ? <ul className="atlas-rows">{recent.map(t => <li key={t.id}><button onClick={() => navigate("Transactions")}><span className="row-symbol"><Icon name={t.type === "income" || t.type === "refund" ? "income" : "transfer"} /></span><span><strong>{t.note || t.category || kinds[t.type]}</strong><small>{dateText(t.date)}{hasReversal(ledger, t.id, asOf) ? " · Reversed" : ""}</small></span><strong className="financial-value">{money(minor(t.amount))}</strong></button></li>)}</ul> : <div className="atlas-empty"><Icon name="transfer" /><strong>No transactions this cycle</strong><p>Your daily activity, together in one place.</p></div>}
      </Panel>
      <Panel title="Savings goals" subtitle="Make room for what matters" action={() => navigate("Goals")} hidden={!widgetVisible(ledger, "goals")}>
        {goals.length ? <ul className="atlas-goals">{goals.map(g => <li key={field(g, "id")}><div><strong>{field(g, "name")}</strong><span className="financial-value">{money(minor(Number(g.saved) || 0))}</span></div><progress max={100} value={Number(g.target) > 0 ? Math.min(100, Math.max(0, Number(g.saved) / Number(g.target) * 100)) : 0} aria-label={field(g, "name") + " progress"} /></li>)}</ul> : <div className="atlas-empty"><Icon name="goals" /><strong>Your next chapter starts here</strong><p>Set a target for travel, a home, or a rainy day.</p></div>}
      </Panel>
      <Panel title="My cards" subtitle="Balances and limits at a glance" action={() => navigate("Accounts")} hidden={!widgetVisible(ledger, "cardBills")}>
        {primary ? <><button className="atlas-mini-card" onClick={() => navigate("Card statements", primary.id)}><span>{primary.name}<Icon name="card" /></span><strong className="financial-value">{money(balance(ledger, primary, asOf))}</strong><small>Current balance · view statements</small></button>
          <div className="mini-card-footer"><span>{usage?.limit ? `${(usage.utilization ?? 0).toFixed(1)}% limit used` : "Limit unset"}{statement && <small className="financial-value">{money(statementAmounts(ledger, statement, asOf).due)} statement due</small>}</span><div className="mini-card-controls"><button className="icon-button" disabled={cards.length < 2} onClick={() => setCardIndex(i => (i + cards.length - 1) % Math.max(1, cards.length))} aria-label="Previous card"><Icon name="left" /></button><button className="icon-button" disabled={cards.length < 2} onClick={() => setCardIndex(i => i + 1)} aria-label="Next card"><Icon name="right" /></button></div></div></> : <div className="atlas-empty"><Icon name="card" /><strong>Your cards, together</strong><p>Add a card in Accounts to get started.</p></div>}
      </Panel>
    </div>
    </>}
    {privacy && attention}
  </div>;
}
