// Company fundamentals (valuation, profitability, balance sheet, growth, shareholding) from Yahoo Finance's
// quoteSummary API. That API needs a session cookie + "crumb", which we obtain once and reuse.

const { MOCK, resolveSymbol } = require('./quotes');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const TTL = 12 * 3600e3; // fundamentals change slowly
const cache = new Map(); // yahoo symbol -> { at, data }
let session = null; // { cookie, crumb, at }

// ---------- Yahoo session (cookie + crumb) ----------

function cookiesFrom(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  return list.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
}

async function getSession(force = false) {
  if (session && !force && Date.now() - session.at < 3600e3) return session;
  let cookie = '';
  for (const url of ['https://fc.yahoo.com/', 'https://finance.yahoo.com/']) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(8000) });
      cookie = cookiesFrom(res);
      if (cookie) break;
    } catch {}
  }
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const res = await fetch(`https://${host}/v1/test/getcrumb`, { headers: { 'User-Agent': UA, Cookie: cookie }, signal: AbortSignal.timeout(8000) });
      const crumb = (await res.text()).trim();
      if (res.ok && crumb && !crumb.includes('<') && crumb.length < 40) { session = { cookie, crumb, at: Date.now() }; return session; }
    } catch {}
  }
  throw new Error('Could not open a Yahoo Finance session for fundamentals');
}

const MODULES = 'assetProfile,summaryDetail,defaultKeyStatistics,financialData,price';

async function fetchSummary(sym, retry = true) {
  const s = await getSession();
  let lastErr;
  for (const host of ['query2.finance.yahoo.com', 'query1.finance.yahoo.com']) {
    try {
      const url = `https://${host}/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=${MODULES}&crumb=${encodeURIComponent(s.crumb)}`;
      const res = await fetch(url, { headers: { 'User-Agent': UA, Cookie: s.cookie, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      if ((res.status === 401 || res.status === 403) && retry) { await getSession(true); return fetchSummary(sym, false); }
      if (res.status === 404) throw Object.assign(new Error('No company data'), { fatal: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const r = (await res.json())?.quoteSummary?.result?.[0];
      if (!r) throw Object.assign(new Error('No company data'), { fatal: true });
      return r;
    } catch (e) { lastErr = e; if (e.fatal) break; }
  }
  throw lastErr;
}

// ---------- normalise ----------

const raw = (o) => (o && typeof o === 'object' ? (o.raw ?? null) : o ?? null);
const pct100 = (x) => (x == null ? null : x * 100);

function normalise(r) {
  const ap = r.assetProfile || {}, sd = r.summaryDetail || {}, ks = r.defaultKeyStatistics || {}, fd = r.financialData || {}, pr = r.price || {};
  const de = raw(fd.debtToEquity); // Yahoo reports this ×100 (e.g. 45.2 = 0.452)
  return {
    name: pr.longName || pr.shortName || null,
    type: pr.quoteType || null, // EQUITY, ETF…
    sector: ap.sector || null,
    industry: ap.industry || null,
    website: ap.website || null,
    employees: ap.fullTimeEmployees || null,
    about: ap.longBusinessSummary ? ap.longBusinessSummary.slice(0, 600) : null,
    marketCap: raw(sd.marketCap) ?? raw(pr.marketCap),
    pe: raw(sd.trailingPE),
    forwardPe: raw(sd.forwardPE) ?? raw(ks.forwardPE),
    pb: raw(ks.priceToBook),
    ps: raw(sd.priceToSalesTrailing12Months),
    evEbitda: raw(ks.enterpriseToEbitda),
    eps: raw(ks.trailingEps),
    bookValue: raw(ks.bookValue),
    roe: pct100(raw(fd.returnOnEquity)),
    roa: pct100(raw(fd.returnOnAssets)),
    profitMargin: pct100(raw(fd.profitMargins)),
    operatingMargin: pct100(raw(fd.operatingMargins)),
    revenueGrowth: pct100(raw(fd.revenueGrowth)),
    earningsGrowth: pct100(raw(fd.earningsGrowth) ?? raw(ks.earningsQuarterlyGrowth)),
    debtToEquity: de == null ? null : de / 100,
    currentRatio: raw(fd.currentRatio),
    totalDebt: raw(fd.totalDebt),
    totalCash: raw(fd.totalCash),
    revenue: raw(fd.totalRevenue),
    freeCashflow: raw(fd.freeCashflow),
    dividendYield: pct100(raw(sd.dividendYield) ?? raw(sd.trailingAnnualDividendYield)),
    payoutRatio: pct100(raw(sd.payoutRatio)),
    beta: raw(sd.beta),
    promoters: pct100(raw(ks.heldPercentInsiders)), // for Indian companies this is mostly the promoter group
    institutions: pct100(raw(ks.heldPercentInstitutions)),
  };
}

// Plausible random fundamentals for demo mode.
function mockFundamentals(sym) {
  let h = 0;
  for (const c of sym) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const r = (a, b, k = 1) => a + (((h = (h * 1103515245 + 12345) >>> 0) / 2 ** 32) * (b - a)) * k;
  const sectors = [['Financial Services', 'Banks—Regional'], ['Industrials', 'Railroads'], ['Utilities', 'Utilities—Renewable'], ['Energy', 'Oil & Gas Integrated'],
    ['Technology', 'Information Technology Services'], ['Consumer Defensive', 'Tobacco'], ['Basic Materials', 'Steel'], ['Communication Services', 'Telecom Services']];
  const [sector, industry] = sectors[h % sectors.length];
  const loss = h % 9 === 0;
  return {
    name: sym.replace(/\.(NS|BO)$/, ''), type: 'EQUITY', sector, industry, website: null, employees: Math.round(r(200, 90000)),
    about: 'Demo company profile.', marketCap: r(5e8, 1.5e13), pe: loss ? null : r(6, 80), forwardPe: r(5, 60), pb: r(0.5, 12), ps: r(0.3, 10),
    evEbitda: r(4, 40), eps: loss ? -r(1, 20) : r(1, 120), bookValue: r(10, 900), roe: loss ? -r(1, 15) : r(2, 35), roa: r(-2, 15),
    profitMargin: loss ? -r(1, 20) : r(2, 30), operatingMargin: r(-5, 40), revenueGrowth: r(-20, 45), earningsGrowth: r(-40, 80),
    debtToEquity: sector === 'Financial Services' ? r(3, 9) : r(0, 2.5), currentRatio: r(0.6, 3), totalDebt: r(0, 5e11), totalCash: r(1e8, 3e11),
    revenue: r(1e9, 5e12), freeCashflow: r(-1e10, 1e11), dividendYield: h % 3 ? r(0, 5) : null, payoutRatio: r(0, 70), beta: r(0.4, 1.8),
    promoters: r(0, 75), institutions: r(2, 60),
  };
}

async function getFundamentals(sym) {
  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const data = MOCK ? mockFundamentals(sym) : normalise(await fetchSummary(sym));
  cache.set(sym, { at: Date.now(), data });
  return data;
}

async function fundamentals(rawSymbols) {
  const out = {};
  const queue = [...new Set(rawSymbols)];
  const worker = async () => {
    while (queue.length) {
      const raw = queue.shift();
      try { out[raw] = await getFundamentals(await resolveSymbol(raw)); }
      catch (e) { out[raw] = { error: e.message || 'No company data' }; }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { items: out };
}

module.exports = { fundamentals, normalise };
