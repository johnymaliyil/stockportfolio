// Indian stock portfolio tracker — zero-dependency Node server (Node 18+).
// Serves the frontend from ./public and proxies live NSE/BSE quotes from
// Yahoo Finance (browsers can't call Yahoo directly because of CORS).
//
//   node server.js            -> live quotes
//   MOCK=1 node server.js     -> simulated quotes (offline demo)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const MOCK = process.env.MOCK === '1';
const CACHE_MS = 5000; // don't hit Yahoo more than once per 5s per symbol
const PUBLIC_DIR = path.join(__dirname, 'public');

const cache = new Map(); // yahooSymbol -> { at, data }

// ---------- symbol handling ----------

// Turn whatever the user's broker export has into a Yahoo symbol.
// RELIANCE -> RELIANCE.NS, NSE:TCS -> TCS.NS, BSE:500325 / 500325 -> 500325.BO,
// INFY-EQ -> INFY.NS, already-suffixed symbols are kept as-is.
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

// ---------- quote providers ----------

async function fetchYahoo(sym) {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let lastErr;
  for (const host of hosts) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=5m`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (portfolio-tracker)', Accept: 'application/json' },
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
    symbol: sym, name: sym.replace(/\.(NS|BO)$/, '') + ' (demo)', exchange: sym.endsWith('.BO') ? 'BSE' : 'NSE',
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
      const sym = toYahooSymbol(raw);
      if (!sym) continue;
      try { out[raw] = await getQuote(sym); }
      catch (e) { out[raw] = { symbol: sym, error: e.message || 'Failed' }; }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return out;
}

// ---------- http ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.csv': 'text/csv', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/quotes') {
    const symbols = (url.searchParams.get('symbols') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 300);
    if (!symbols.length) return sendJSON(res, 400, { error: 'Pass ?symbols=RELIANCE,TCS' });
    try { return sendJSON(res, 200, { mock: MOCK, at: Date.now(), quotes: await getQuotes(symbols) }); }
    catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  if (url.pathname === '/api/health') return sendJSON(res, 200, { ok: true, mock: MOCK });

  // static files
  let file = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  if (file === '/sample-portfolio.csv') file = path.join(__dirname, 'sample-portfolio.csv');
  else file = path.join(PUBLIC_DIR, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR) && !file.endsWith('sample-portfolio.csv')) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Portfolio tracker running at http://localhost:${PORT}${MOCK ? '  (MOCK prices)' : ''}`);
  });
}

module.exports = { toYahooSymbol };
