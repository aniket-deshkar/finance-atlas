const navUrl = "https://portal.amfiindia.com/spages/NAVAll.txt";
let cache;
const paise = value => {
  const price = Math.round(Number(value) * 100);
  return Number.isSafeInteger(price) && price > 0 && price <= 100_000_000_000 ? price : null;
};
const monthNumbers = new Map("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ").map((item,index) => [item,String(index + 1).padStart(2,"0")]));
function amfiDate(text) {
  const match = /^(\d{1,2})-([A-Z][a-z]{2})-(\d{4})$/.exec(text);
  return match && monthNumbers.has(match[2]) ? match[3] + "-" + monthNumbers.get(match[2]) + "-" + match[1].padStart(2,"0") : null;
}
export function parseNav(body) {
  const result = new Map();
  for (const line of body.split(/\r?\n/)) {
    const [code, , , , value, day] = line.split(";").map(part => part.trim());
    if (!/^\d{1,10}$/.test(code) || !day) continue;
    const price = paise(value), date = amfiDate(day);
    if (price && date) result.set(code, {price,date,source:"AMFI"});
  }
  return result;
}
async function nav(fetcher) {
  if (cache && Date.now() < cache.until) return cache.values;
  const result = await fetcher(navUrl,{redirect:"error",signal:AbortSignal.timeout(9000)});
  if (!result.ok) throw Error("AMFI unavailable.");
  const text = await result.text();
  if (text.length > 5_000_000) throw Error("AMFI report too large.");
  const values = parseNav(text);
  if (!values.size) throw Error("AMFI NAV format changed.");
  cache = {values,until:Date.now() + 3_600_000};
  return values;
}
async function dhan(fetcher, code, token) {
  const day = new Date(), early = new Date(day.getTime() - 7 * 86400_000);
  const response = await fetcher("https://api.dhan.co/v2/charts/historical", {
    method:"POST", redirect:"error", signal:AbortSignal.timeout(7500),
    headers:{"content-type":"application/json","access-token":token},
    body:JSON.stringify({securityId:code,exchangeSegment:"NSE_EQ",instrument:"EQUITY",
      fromDate:early.toISOString().slice(0,10),toDate:day.toISOString().slice(0,10),expiryCode:0,oi:false})
  });
  if (!response.ok) return null;
  const data = await response.json(), price = paise(data.close?.at(-1)), timestamp = data.timestamp?.at(-1);
  if (!price || !Number.isFinite(timestamp) || timestamp < 0 || timestamp > day.getTime() / 1000) return null;
  const date = new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata", year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(timestamp * 1000));
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? {date,price,source:"Dhan EOD"} : null;
}
export function registerMarket(app, owner, {fetcher = fetch, dhanToken} = {}) {
  app.post("/v1/market/quotes", {onRequest:owner, bodyLimit:4200, config:{rateLimit:{max:4,timeWindow:"1 minute"}}}, async (request,reply) => {
    const items = request.body?.instruments;
    if (!Array.isArray(items) || items.length > 25 || items.some(item => !item || typeof item.id !== "string" ||
      !/^[a-z0-9-]{1,64}$/i.test(item.id) || !["Mutual fund","Equity","ETF"].includes(item.kind) || !/^\d{1,10}$/.test(item.code)))
      return reply.code(400).send({error:"Choose up to 25 valid AMFI scheme codes or Dhan instrument IDs."});
    const funds = items.filter(item => item.kind === "Mutual fund");
    const data = funds.length ? await nav(fetcher).catch(() => new Map()) : new Map();
    const quotes = funds.flatMap(item => data.has(item.code) ? [{id:item.id,...data.get(item.code)}] : []);
    if (dhanToken) {
      const equity = items.filter(item => item.kind !== "Mutual fund");
      for (let i = 0; i < equity.length; i += 4) {
        const batch = await Promise.all(equity.slice(i,i + 4).map(async item => {
          const quote = await dhan(fetcher,item.code,dhanToken).catch(() => null);
          return quote && {id:item.id,...quote};
        }));
        quotes.push(...batch.filter(Boolean));
      }
    }
    return {quotes};
  });
}
