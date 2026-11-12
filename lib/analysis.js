// Rules-based technical health check for each holding, from one year of daily prices.
// Not investment advice: it looks only at price/volume behaviour, not at fundamentals, news or valuation.

const { MOCK, resolveSymbol } = require('./quotes');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const HIST_TTL = 6 * 3600e3; // daily data: refetch at most every 6 hours
const histCache = new Map(); // yahoo symbol -> { at, data }
const BENCHMARK = { symbol: '^NSEI', name: 'NIFTY 50' };

// ---------- data ----------

async function fetchHistory(sym) {
  let lastErr;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`;
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      if (res.status === 404) throw Object.assign(new Error('Symbol not found'), { fatal: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const r = (await res.json())?.chart?.result?.[0];
      if (!r) throw Object.assign(new Error('No price history'), { fatal: true });
      const q = r.indicators?.quote?.[0] || {};
      const rows = (r.timestamp || []).map((t, i) => ({ t: t * 1000, c: q.close?.[i], v: q.volume?.[i] ?? 0 })).filter((x) => x.c != null);
      return { name: r.meta?.longName || r.meta?.shortName || sym, rows };
    } catch (e) { lastErr = e; if (e.fatal) break; }
  }
  throw lastErr;
}

// Synthetic year of prices for demo mode: a random walk with a per-symbol drift.
function mockHistory(sym) {
  let h = 0;
  for (const c of sym) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const drift = ((h % 200) - 100) / 60000, vol = 0.01 + (h % 7) / 400;
  let p = 20 + (h % 3000), rnd = h;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const rows = [];
  const start = Date.now() - 365 * 864e5;
  for (let i = 0; i < 250; i++) {
    p *= 1 + drift + (rand() - 0.5) * vol * 2;
    rows.push({ t: start + i * 1.46 * 864e5, c: +p.toFixed(2), v: Math.round(2e4 + rand() * 2e6) });
  }
  return { name: sym.replace(/\.(NS|BO)$/, ''), rows };
}

async function getHistory(sym) {
  const hit = histCache.get(sym);
  if (hit && Date.now() - hit.at < HIST_TTL) return hit.data;
  const data = MOCK ? mockHistory(sym) : await fetchHistory(sym);
  histCache.set(sym, { at: Date.now(), data });
  return data;
}

// ---------- indicators ----------

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sma = (c, n) => (c.length >= n ? mean(c.slice(-n)) : null);
const ret = (c, n) => (c.length > n ? (c[c.length - 1] / c[c.length - 1 - n] - 1) * 100 : null);

function rsi(c, n = 14) {
  if (c.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < c.length; i++) { // Wilder smoothing
    const d = c[i] - c[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

function indicators({ rows }) {
  const c = rows.map((r) => r.c);
  const last = c[c.length - 1];
  const lr = c.slice(1).map((x, i) => Math.log(x / c[i]));
  const sd = lr.length > 20 ? Math.sqrt(mean(lr.map((x) => (x - mean(lr)) ** 2))) : null;
  const recent = rows.slice(-20);
  return {
    last, days: c.length, lastDate: rows[rows.length - 1]?.t,
    sma50: sma(c, 50), sma200: sma(c, 200), rsi14: rsi(c),
    ret1m: ret(c, 21), ret3m: ret(c, 63), ret6m: ret(c, 126), ret1y: ret(c, Math.min(c.length - 1, 250)),
    high52: Math.max(...c), low52: Math.min(...c),
    volatility: sd != null ? sd * Math.sqrt(252) * 100 : null, // annualised %
    avgValue: recent.length ? mean(recent.map((r) => r.c * (r.v || 0))) : null, // ₹ traded per day, 20-day average
  };
}

// ---------- scoring ----------

const pct = (x) => `${x > 0 ? '+' : ''}${x.toFixed(1)}%`;
const crore = (x) => (x >= 1e7 ? `₹${(x / 1e7).toFixed(1)} Cr` : `₹${(x / 1e5).toFixed(1)} lakh`);

// Each rule adds or removes a point and records why. Strong >= +3, Weak <= -3, otherwise Neutral.
function score(ind, bench) {
  const R = [];
  const add = (pts, text) => R.push({ pts, text });
  const { last } = ind;

  if (ind.lastDate && Date.now() - ind.lastDate > 10 * 864e5) {
    return { signal: 'inactive', score: null, reasons: [{ pts: 0, text: `No trades since ${new Date(ind.lastDate).toLocaleDateString('en-IN')} — suspended, delisted or very illiquid` }] };
  }
  if (ind.days < 60) add(0, `Only ${ind.days} trading days of history (recent listing) — signals are less reliable`);

  // Trend
  if (ind.sma200) {
    if (last > ind.sma200) add(2, `Price is above its 200-day average (${pct((last / ind.sma200 - 1) * 100)}) — long-term uptrend`);
    else add(-2, `Price is below its 200-day average (${pct((last / ind.sma200 - 1) * 100)}) — long-term downtrend`);
  }
  if (ind.sma50) {
    if (last > ind.sma50) add(1, 'Price is above its 50-day average — short-term trend up');
    else add(-1, 'Price is below its 50-day average — short-term trend down');
  }
  if (ind.sma50 && ind.sma200) {
    if (ind.sma50 > ind.sma200) add(1, '50-day average is above the 200-day (“golden cross” zone)');
    else add(-1, '50-day average is below the 200-day (“death cross” zone)');
  }

  // Momentum and relative strength
  if (ind.ret3m != null) {
    if (ind.ret3m > 5) add(1, `Up ${Math.abs(ind.ret3m).toFixed(1)}% in 3 months`);
    else if (ind.ret3m < -10) add(-1, `Down ${Math.abs(ind.ret3m).toFixed(1)}% in 3 months`);
  }
  if (ind.ret1y != null && bench?.ret1y != null) {
    const rel = ind.ret1y - bench.ret1y;
    if (rel > 5) add(1, `Beat the NIFTY 50 over the year (${pct(ind.ret1y)} vs ${pct(bench.ret1y)})`);
    else if (rel < -5) add(-1, `Lagged the NIFTY 50 over the year (${pct(ind.ret1y)} vs ${pct(bench.ret1y)})`);
  }

  // Position in the 52-week range
  const offHigh = (last / ind.high52 - 1) * 100;
  if (offHigh > -10) add(1, `Near its 52-week high (${Math.abs(offHigh).toFixed(1)}% below it)`);
  else if (offHigh < -40) add(-1, `${Math.abs(offHigh).toFixed(0)}% below its 52-week high`);

  // Overbought / oversold (information only)
  if (ind.rsi14 != null) {
    if (ind.rsi14 > 75) add(0, `RSI ${ind.rsi14.toFixed(0)}: overbought — could pull back short term`);
    else if (ind.rsi14 < 30) add(0, `RSI ${ind.rsi14.toFixed(0)}: oversold — selling may be overdone short term`);
  }

  // Risk flags
  if (last < 10) add(-1, `Penny stock (₹${last.toFixed(2)}) — prone to large swings`);
  if (ind.avgValue != null && ind.avgValue < 1e7) add(-1, `Low liquidity: about ${crore(ind.avgValue)} traded per day`);
  if (ind.volatility != null && ind.volatility > 60) add(0, `Very volatile (${ind.volatility.toFixed(0)}% a year)`);

  const s = R.reduce((a, r) => a + r.pts, 0);
  return { signal: s >= 3 ? 'strong' : s <= -3 ? 'weak' : 'neutral', score: s, reasons: R };
}

// ---------- API ----------

async function analyse(rawSymbols) {
  let bench = null;
  try {
    const bi = indicators(await getHistory(BENCHMARK.symbol));
    bench = { ...BENCHMARK, ...bi, trend: bi.sma200 ? (bi.last > bi.sma200 ? (bi.sma50 > bi.sma200 ? 'up' : 'mixed') : 'down') : null };
  } catch (e) { bench = { ...BENCHMARK, error: e.message }; }

  const out = {};
  const queue = [...new Set(rawSymbols)];
  const worker = async () => {
    while (queue.length) {
      const raw = queue.shift();
      try {
        const sym = await resolveSymbol(raw);
        const ind = indicators(await getHistory(sym));
        out[raw] = { symbol: sym, ...score(ind, bench), ind };
      } catch (e) {
        out[raw] = { signal: 'nodata', reasons: [{ pts: 0, text: e.message || 'No price history' }] };
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { bench, items: out };
}

module.exports = { analyse, indicators, score };
