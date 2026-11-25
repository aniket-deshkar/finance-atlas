import {field, money, type Account, type Ledger} from "../lib/ledger";
import {cardUsage} from "../lib/finance";
import {Icon} from "./icons";

const institutions = [
  {id:"hdfc", name:"HDFC Bank", pattern:/\bhdfc\b/i},
  {id:"sbin", name:"State Bank of India", pattern:/\b(?:sbi|state bank of india)\b/i},
  {id:"icic", name:"ICICI Bank", pattern:/\bicici\b/i},
  {id:"utib", name:"Axis Bank", pattern:/\baxis\b/i},
  {id:"kkbk", name:"Kotak Mahindra Bank", pattern:/\bkotak\b/i},
  {id:"indb", name:"IndusInd Bank", pattern:/\bindusind\b/i},
  {id:"scbl", name:"Standard Chartered", pattern:/\bstandard chartered\b/i}
];
export const institutionOptions = [...institutions, {id:"generic",name:"Other institution"}];
export const networkOptions = [
  {id:"visa",name:"Visa"}, {id:"mastercard",name:"Mastercard"}, {id:"rupay",name:"RuPay"},
  {id:"amex",name:"American Express"}, {id:"generic",name:"Other network"}
];

function institution(account: Account) {
  const id = field(account, "institution");
  return id ? institutions.find(item => item.id === id) : institutions.find(item => item.pattern.test(account.name));
}

function network(account: Account) {
  const id = field(account, "network");
  if (id) return networkOptions.find(item => item.id === id && item.id !== "generic");
  return networkOptions.find(item => item.id && item.id !== "generic" && (
    new RegExp("\\b" + item.id + "\\b", "i").test(account.name) || item.id === "amex" && /\bamerican express\b/i.test(account.name)));
}

export function InstitutionMark({account}: {account: Account}) {
  const bank = account.type === "cash" ? undefined : institution(account);
  return <span className="atlas-institution-mark">{bank
    ? <img src={"/brands/" + bank.id + ".svg"} width="90" height="27" alt={bank.name} />
    : <Icon name={account.type === "credit" ? "card" : account.type === "bank" ? "bank" : "wallet"} />}</span>;
}

export function AccountCard({account, ledger, asOf, amount, edit, statements}: {
  account: Account; ledger: Ledger; asOf: string; amount: number; edit: () => void; statements: () => void;
}) {
  const card = account.type === "credit";
  const cardNetwork = card ? network(account) : undefined;
  const usage = card ? cardUsage(ledger, account, asOf) : undefined;
  const type = card ? "Credit card" : account.type === "cash" ? "Cash" : "Bank account";
  return <article className="account atlas-account" data-kind={account.type}>
    <div className="atlas-account-top"><InstitutionMark account={account} /><small>{type}</small></div>
    <h3>{account.name}</h3>
    <div className="atlas-account-balance">
      <div><small>{card ? amount < 0 ? "Credit balance" : "Outstanding" : "Recorded balance"}</small><strong>{money(card ? Math.abs(amount) : amount)}</strong></div>
      {cardNetwork && <span className="atlas-card-network" data-network={cardNetwork.id}>
        {cardNetwork.id === "mastercard" && <span aria-hidden="true" />}<span>{cardNetwork.name}</span></span>}
    </div>
    {usage && usage.limit > 0 && <div className="atlas-card-limit">
      <meter aria-label="Credit limit used" min={0} max={usage.limit} value={Math.min(usage.limit, Math.max(0, usage.used))} />
      <small>{money(Math.max(0, usage.available))} available of {money(usage.limit)}</small>
    </div>}
    <div className="button-row"><button type="button" onClick={edit}>Edit / confirm balance</button>
      {card && <button type="button" onClick={statements}>Statements</button>}</div>
  </article>;
}
