// Quote engine shared by the local server (server.js) and the serverless function (api/quotes.js).
// Resolves symbols/ISINs to Yahoo symbols and fetches live NSE/BSE quotes.

const MOCK = process.env.MOCK === '1';
const CACHE_MS = 5000; // don't hit Yahoo more than once per 5s per symbol
const cache = new Map(); // yahooSymbol -> { at, data }

// ---------- symbol handling ----------

const ISIN_RE = /^IN[A-Z0-9]{9}\d$/;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// Turn whatever the user's broker export has into a Yahoo symbol.
// RELIANCE -> RELIANCE.NS, NSE:TCS -> TCS.NS, BSE:500325 / 500325 -> 500325.BO,
// INFY-EQ -> INFY.NS, already-suffixed symbols are kept as-is.
// (ISINs are handled separately by resolveIsin.)
function toYahooSymbol(raw) {
  let s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  if (/\.(NS|BO)$/.test(s)) return s;
  let exch = 'NS';
  const m = s.match(/^(NSE|BSE)[:\-](.+)$/);
  if (m) { exch = m[1] === 'BSE' ? 'BO' : 'NS'; s = m[2]; }
  s = s.replace(/-(EQ|BE|BZ|SM|ST)$/, '');
  if (/^\d{6}$/.test(s)) exch = 'BO'; // BSE scrip codes are 6 digits
  return `${s}.${exch}`;
}

// ISIN -> NSE symbol, using NSE's published list of equities (refreshed every 12h),
// falling back to Yahoo's search for anything not listed on NSE.
const isinCache = new Map(); // isin -> yahoo symbol
let master = { at: 0, map: new Map(), failedAt: 0 };

// NSE's lists of equities and ETFs: SYMBOL ... ISIN columns.
async function fetchNseList(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/csv,*/*' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const lines = (await res.text()).split(/\r?\n/);
  const head = lines[0].split(',').map((h) => h.trim().toUpperCase());
  const iSym = head.indexOf('SYMBOL'), iIsin = head.findIndex((h) => h.startsWith('ISIN'));
  const map = new Map();
  for (const line of lines.slice(1)) {
    const c = line.split(','); // names may contain commas, so look for the ISIN if its column shifted
    const at = (c[iIsin] || '').trim();
    const isin = ISIN_RE.test(at) ? at : (c.find((x) => ISIN_RE.test(x.trim())) || '').trim();
    if (ISIN_RE.test(isin) && c[iSym]) map.set(isin, c[iSym].trim());
  }
  return map;
}

async function loadNseMaster() {
  const fresh = Date.now() - master.at < 12 * 3600e3;
  const recentlyFailed = Date.now() - master.failedAt < 10 * 60e3;
  if ((fresh && master.map.size) || recentlyFailed) return master.map;
  try {
    const map = await fetchNseList('https://archives.nseindia.com/content/equities/EQUITY_L.csv');
    if (map.size < 500) throw new Error('unexpected file');
    try { for (const [k, v] of await fetchNseList('https://archives.nseindia.com/content/equities/eq_etfseclist.csv')) map.set(k, v); }
    catch (e) { console.warn('Could not load NSE ETF list:', e.message); }
    master = { at: Date.now(), map, failedAt: 0 };
    console.log(`Loaded ${map.size} NSE ISIN mappings`);
  } catch (e) {
    master.failedAt = Date.now();
    console.warn('Could not load NSE equity list:', e.message);
  }
  return master.map;
}

async function resolveIsin(isin) {
  if (isinCache.has(isin)) return isinCache.get(isin);
  if (MOCK) return `${isin}.NS`;
  const nse = (await loadNseMaster()).get(isin);
  if (nse) { isinCache.set(isin, `${nse}.NS`); return `${nse}.NS`; }
  for (const host of ['query2.finance.yahoo.com', 'query1.finance.yahoo.com']) {
    try {
      const res = await fetch(`https://${host}/v1/finance/search?q=${isin}&quotesCount=6&newsCount=0`, {
        headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const syms = ((await res.json()).quotes || []).map((q) => q.symbol).filter(Boolean);
      const hit = syms.find((s) => s.endsWith('.NS')) || syms.find((s) => s.endsWith('.BO'));
      if (hit) { isinCache.set(isin, hit); return hit; }
    } catch {}
  }
  throw Object.assign(new Error(`No NSE/BSE symbol found for ISIN ${isin} — edit it and enter the symbol`), { fatal: true });
}

async function resolveSymbol(raw) {
  const s = String(raw || '').trim().toUpperCase();
  return ISIN_RE.test(s) ? resolveIsin(s) : toYahooSymbol(s);
}

// ---------- quote providers ----------

async function fetchYahoo(sym) {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let lastErr;
  for (const host of hosts) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=5m`;
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 404) throw Object.assign(new Error('Symbol not found'), { fatal: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const r = json?.chart?.result?.[0];
      if (!r) throw Object.assign(new Error(json?.chart?.error?.description || 'No data'), { fatal: true });
      const m = r.meta;
      const closes = (r.indicators?.quote?.[0]?.close || []).filter((v) => v != null);
      const price = m.regularMarketPrice ?? closes[closes.length - 1];
      const prevClose = m.chartPreviousClose ?? m.previousClose;
      return {
        symbol: sym,
        name: m.longName || m.shortName || sym,
        exchange: m.exchangeName,
        currency: m.currency,
        price,
        prevClose,
        change: price - prevClose,
        changePct: prevClose ? ((price - prevClose) / prevClose) * 100 : 0,
        dayHigh: m.regularMarketDayHigh,
        dayLow: m.regularMarketDayLow,
        high52: m.fiftyTwoWeekHigh,
        low52: m.fiftyTwoWeekLow,
        time: m.regularMarketTime ? m.regularMarketTime * 1000 : Date.now(),
        spark: closes.slice(-78),
      };
    } catch (e) {
      lastErr = e;
      if (e.fatal) break;
    }
  }
  throw lastErr;
}

// Deterministic-ish random walk so the demo looks alive.
const mockState = new Map();
function fetchMock(sym) {
  let st = mockState.get(sym);
  if (!st) {
    let h = 0;
    for (const c of sym) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const base = 100 + (h % 4000);
    st = { prevClose: base, price: base * (1 + ((h % 200) - 100) / 4000), spark: [] };
    for (let i = 0; i < 60; i++) { st.price *= 1 + (Math.random() - 0.5) / 300; st.spark.push(st.price); }
    mockState.set(sym, st);
  }
  st.price *= 1 + (Math.random() - 0.5) / 400;
  st.spark.push(st.price); if (st.spark.length > 78) st.spark.shift();
  const price = +st.price.toFixed(2);
  return {
    symbol: sym, name: sym.replace(/\.(NS|BO)$/, ''), exchange: sym.endsWith('.BO') ? 'BSE' : 'NSE',
    currency: 'INR', price, prevClose: st.prevClose, change: price - st.prevClose,
    changePct: ((price - st.prevClose) / st.prevClose) * 100,
    dayHigh: Math.max(...st.spark), dayLow: Math.min(...st.spark),
    high52: st.prevClose * 1.35, low52: st.prevClose * 0.7, time: Date.now(), spark: st.spark.slice(),
  };
}

async function getQuote(sym) {
  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = MOCK ? fetchMock(sym) : await fetchYahoo(sym);
  cache.set(sym, { at: Date.now(), data });
  return data;
}

// Run with limited concurrency so a 100-stock portfolio doesn't fire 100 requests at once.
async function getQuotes(rawSymbols) {
  const out = {};
  const queue = [...new Set(rawSymbols)];
  const worker = async () => {
    while (queue.length) {
      const raw = queue.shift();
      let sym = null;
      try {
        sym = await resolveSymbol(raw);
        if (!sym) continue;
        out[raw] = await getQuote(sym);
      } catch (e) { out[raw] = { symbol: sym, error: e.message || 'Failed' }; }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return out;
}

module.exports = { MOCK, getQuotes, toYahooSymbol, resolveSymbol };
