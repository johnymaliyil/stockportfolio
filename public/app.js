'use strict';

// ---------- state ----------
const LS_KEY = 'portfolio.v1';
const LS_PREF = 'portfolio.prefs.v1';
// holdings: [{ symbol, qty, avg|null, isin?, name?, refPrice?, refDate?, account?, accountLabel? }]
// `account` is the demat account (DP/BO ID) a statement came from; each account is replaced independently on upload.
let holdings = load(LS_KEY, []);
let prefs = load(LS_PREF, { sortKey: 'current', sortAsc: false, refresh: 15, theme: null, account: 'all' });
const LS_QUOTES = 'portfolio.quotes.v1';
const cachedQuotes = load(LS_QUOTES, null); // last prices seen, so the app opens instantly / offline
let quotes = cachedQuotes?.quotes || {};   // symbol -> quote
let prevPrices = {};
const LS_ANALYSIS = 'portfolio.analysis.v1';
let analysis = load(LS_ANALYSIS, null);      // { at, bench, items: { symbol: { signal, score, reasons, ind } } }
let analysisLoading = false;
const LS_FUND = 'portfolio.fund.v1';
let fund = load(LS_FUND, null);              // { at, items: { symbol: { sector, pe, roe, … } } }
let fundLoading = false;                      // symbol -> last price, for flash animation
let timer = null;
let editingIndex = -1;

function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(holdings)); localStorage.setItem(LS_PREF, JSON.stringify(prefs)); } catch {}
}

// ---------- formatting ----------
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const inr0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const num = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const fmt = (v, f = inr) => (v == null || !isFinite(v) ? '—' : f.format(v));
const signed = (v, f = inr) => (v == null || !isFinite(v) ? '—' : (v > 0 ? '+' : '') + f.format(v));
const pct = (v) => (v == null || !isFinite(v) ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%');
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (id) => document.getElementById(id);

function toast(msg, ms = 3500) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

// ---------- file parsing ----------
const ALIASES = {
  symbol: ['symbol', 'tradingsymbol', 'instrument', 'stocksymbol', 'nsesymbol', 'scripcode', 'scrip', 'ticker', 'isin', 'isincode', 'isinno', 'stock', 'stockname', 'security', 'company', 'companyname', 'name', 'bsecode', 'nsecode'],
  qty: ['quantity', 'qty', 'shares', 'noofshares', 'quantityavailable', 'availableqty', 'holdingqty', 'totalqty', 'netqty', 'units'],
  name: ['scripname', 'companyname', 'securityname', 'stockname', 'instrumentname', 'name', 'company', 'security'],
  isin: ['isin', 'isincode', 'isinno', 'isinnumber'],
  ref: ['statementprice', 'closingrate', 'closingprice', 'closeprice', 'ltp', 'lastprice', 'lasttradedprice', 'marketprice', 'currentprice', 'marketrate', 'cmp', 'prevclose', 'close', 'rate'],
  value: ['totalvalue', 'marketvalue', 'currentvalue', 'presentvalue', 'holdingvalue', 'value'],
  avg: ['avgcost', 'averageprice', 'avgprice', 'averagecost', 'avgbuyprice', 'averagebuyprice', 'buyavg', 'buyprice', 'costprice', 'avgtradingprice', 'purchaseprice', 'buyrate', 'avgrate', 'avg', 'price'],
};
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function findCols(header) {
  const h = header.map(norm);
  const cols = {};
  for (const [key, list] of Object.entries(ALIASES)) {
    let idx = -1;
    for (const a of list) { idx = h.indexOf(a); if (idx >= 0) break; }
    if (idx < 0) for (const a of list) { idx = h.findIndex((x) => x && x.includes(a)); if (idx >= 0) break; }
    cols[key] = idx;
  }
  // a buy-price column must not double as the closing-price / name column
  if (cols.ref === cols.avg) cols.ref = -1;
  if (cols.name === cols.symbol) cols.name = -1;
  return cols;
}

function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  const sample = text.split('\n').slice(0, 40).join('\n');
  const delim = [',', '\t', ';', '|'].map((d) => [d, sample.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const toNum = (v) => {
  if (typeof v === 'number') return v;
  let t = String(v ?? '').trim().replace(/^(Rs\.?|INR|₹)\s*/i, '').replace(/\s/g, '');
  if (/^-?\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.'); // decimal comma (2450,5); Indian thousands groups are 3 digits
  const n = parseFloat(t.replace(/[₹,]/g, ''));
  return isFinite(n) ? n : NaN;
};

function rowsToHoldings(rows) {
  // Broker exports often have a few title rows before the real header — scan for it.
  let hi = -1, cols;
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const c = findCols(rows[i]);
    if (c.symbol >= 0 && c.qty >= 0) { hi = i; cols = c; break; }
  }
  if (hi < 0) throw new Error('Could not find Symbol (or ISIN) and Quantity columns. Check the header row.');

  // Broker reports put the client code / name and report date above the table.
  const pre = rows.slice(0, hi).map((r) => r.filter((c) => String(c).trim()).join(' ')).join('\n');
  const code = pre.match(/\b(?:Client|UCC|Account|BO|DP)\s*(?:Code|ID|No\.?)\s*[:\-]?\s*([A-Z0-9-]{4,20})/i)?.[1] || null;
  const holder = pre.match(/\b(?:Client|Account|Holder)\s*Name\s*[:\-]?\s*([A-Za-z .]+)/i)?.[1].trim() || '';
  const asOn = pre.match(/\b(?:as\s*on|date)\b[^0-9A-Za-z]*(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2}-[A-Za-z]{3}-\d{4})/i)?.[1] || null;
  const get = (r, k) => (cols[k] >= 0 ? r[cols[k]] : undefined);
  // Our own CSV export (and multi-account sheets) carry the account on every row.
  const hdr = rows[hi].map(norm);
  const idCol = hdr.findIndex((x) => ['accountid', 'boid', 'dpid', 'clientcode', 'clientid', 'demataccount'].includes(x));
  const lblCol = hdr.findIndex((x) => ['account', 'accountname', 'accountlabel'].includes(x));
  const dateCol = hdr.findIndex((x) => ['pricedate', 'priceasof', 'asof', 'asondate'].includes(x));
  const perRow = idCol >= 0 || lblCol >= 0;

  const merged = new Map();
  let skipped = 0;
  for (const r of rows.slice(hi + 1)) {
    const symbol = String(r[cols.symbol] ?? '').trim().toUpperCase();
    if (!symbol || r.some((c) => /^\s*(grand\s+)?total\b/i.test(String(c)))) continue;
    const qty = toNum(r[cols.qty]);
    if (!(qty > 0)) { skipped++; continue; }
    const a = toNum(get(r, 'avg')), ref = toNum(get(r, 'ref')), val = toNum(get(r, 'value'));
    const name = String(get(r, 'name') ?? '').trim();
    const isinCell = String(get(r, 'isin') ?? '').trim().toUpperCase();
    const isin = ISIN_RE.test(isinCell) ? isinCell : ISIN_RE.test(symbol) ? symbol : null;
    const h = { symbol: isin || symbol, qty, avg: a >= 0 ? a : null }; // ISIN is the most reliable key when present
    if (isin) h.isin = isin;
    if (perRow) {
      const id = String((idCol >= 0 && r[idCol]) || (lblCol >= 0 && r[lblCol]) || '').trim();
      h.account = id || null;
      h.accountLabel = id ? String((lblCol >= 0 && r[lblCol]) || id).trim() : null;
    }
    if (name) h.name = cleanName(name);
    if (ref > 0) h.refPrice = ref; else if (val > 0) h.refPrice = val / qty;
    const rowDate = dateCol >= 0 ? String(r[dateCol] ?? '').trim() : '';
    if (h.refPrice && (rowDate || asOn)) h.refDate = rowDate || asOn;
    addMerged(merged, h);
  }
  if (!merged.size) throw new Error('No valid rows found (need a quantity above 0).');
  const label = code ? accountLabel(brokerOf(pre), holder, code) : null;
  return { list: [...merged.values()], skipped, account: code, label };
}

// Combine repeated rows for the same stock, weighting the buy price by quantity.
function addMerged(map, h) {
  const key = (h.account ?? '') + '|' + h.symbol;
  const m = map.get(key);
  if (!m) return map.set(key, h);
  mergeInto(m, h);
}
function mergeInto(m, h) {
  const q = m.qty + h.qty;
  m.avg = m.avg != null && h.avg != null ? (m.avg * m.qty + h.avg * h.qty) / q : null;
  m.qty = q;
}

// ---------- PDF: DP holding statements (Geojit / IndusInd Money, NSDL, CDSL…) ----------
const ISIN_RE = /^IN[A-Z0-9]{9}\d$/;
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Rebuild text lines from pdf.js's positioned text runs.
async function pdfLines(buf) {
  if (!window.pdfjsLib) throw new Error('PDF reader did not load (offline?). Reload the page and try again.');
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const items = (await (await doc.getPage(p)).getTextContent()).items
      .filter((it) => it.str.trim())
      .map((it) => ({ s: it.str.trim(), x: it.transform[4], y: it.transform[5], w: it.width || 0 }))
      .sort((a, b) => b.y - a.y || a.x - b.x);
    let cur = null;
    for (const it of items) {
      if (cur && Math.abs(cur.y - it.y) < 3) cur.items.push(it);
      else { cur = { y: it.y, items: [it] }; lines.push(cur); }
    }
  }
  const sorted = lines.map((l) => l.items.sort((a, b) => a.x - b.x));
  // cells: neighbouring text runs separated by a visible gap are separate table columns
  const cells = sorted.map((items) => items.reduce((acc, it) => {
    const last = acc[acc.length - 1];
    if (last && it.x - last.end < 6) { last.s += ' ' + it.s; last.end = it.x + it.w; } else acc.push({ s: it.s, end: it.x + it.w });
    return acc;
  }, []).map((c) => c.s));
  const text = sorted.map((items) => items.map((i) => i.s).join(' ').replace(/\s+/g, ' '));
  text.cells = cells;
  return text;
}

// Account number, holder and statement date from the header of a DP statement.
// Which broker / depository participant a statement is from, judged from its letterhead.
const BROKERS = [[/geojit/i, 'Geojit'], [/indusind/i, 'IndusInd'], [/smc\s*global|smcindiaonline/i, 'SMC'], [/zerodha/i, 'Zerodha'],
  [/groww|nextbillion/i, 'Groww'], [/upstox|rksv/i, 'Upstox'], [/angel\s*(one|broking)/i, 'Angel One'], [/icici\s*sec|icicidirect/i, 'ICICI Direct'],
  [/hdfc\s*sec/i, 'HDFC Sec'], [/kotak\s*sec/i, 'Kotak'], [/motilal/i, 'Motilal Oswal'], [/sharekhan/i, 'Sharekhan'], [/5\s*paisa/i, '5paisa'],
  [/\bdhan\b|moneylicious/i, 'Dhan'], [/axis\s*sec|axisdirect/i, 'Axis Direct'], [/sbicap|sbi\s*sec/i, 'SBI Sec'], [/paytm\s*money/i, 'Paytm Money'],
  [/fyers/i, 'Fyers'], [/\biifl\b/i, 'IIFL'], [/edelweiss|nuvama/i, 'Nuvama'], [/\bnsdl\b/i, 'NSDL'], [/\bcdsl\b/i, 'CDSL']];
function brokerOf(headerText) {
  let best = null, at = Infinity;
  for (const [re, name] of BROKERS) { const i = headerText.search(re); if (i >= 0 && i < at) { at = i; best = name; } }
  return best;
}
// "IndusInd · Priya", falling back to the last digits of the account number.
function accountLabel(broker, holder, id) {
  const first = holder ? titleCase(holder.trim().split(/\s+/)[0]) : '';
  if (broker && first) return `${broker} · ${first}`;
  if (broker || first) return `${broker || first} …${String(id).slice(-4)}`;
  return id ? `…${String(id).slice(-4)}` : null;
}
const brokerPart = (label) => String(label || '').split(' · ')[0];

function statementInfo(lines) {
  const all = lines.join('\n');
  const id = (all.match(/\bDP\s*(?:ID)?\s*[:\-]?\s*(IN\d{6}[-\s]?\d{8})\b/)?.[1]    // NSDL: DP IN300239-12345678
    || all.match(/\bBO\s*ID\s*[:\-]?\s*(\d{8}\s?\d{8})\b/i)?.[1]                       // CDSL: Bo ID 12345678 12345678
    || all.match(/\bClient\s*ID\s*[:\-]?\s*(\d{8,16})\b/i)?.[1] || '').replace(/\s/g, '');
  const holder = (lines.find((l) => /^Name\s+\S/i.test(l)) || '').replace(/^Name\s+/i, '').replace(/\s+DP\b.*$/, '').trim();
  const asOn = all.match(/As\s*on(?:\s*Date)?\s*:?\s*(\d{1,2}-[A-Za-z]{3}-\d{4}|[A-Z][a-z]{2}\s+\d{1,2}\s+\d{4})/i)?.[1] || null;
  const label = id ? accountLabel(brokerOf(lines.slice(0, 15).join('\n')), holder, id) : null;
  return { account: id || null, label, asOn };
}

const cleanName = (n) => titleCase(n.replace(/^(Equity|Mutual Fund|Bond)\s+/i, '').replace(/[\s-]+EQ(?:TY|UITY)?(?:\b|\d).*$/i, '')
  .replace(/[\s-]+$/, '').replace(/\s+/g, ' ').trim());

// NSDL style (Geojit / IndusInd Money), one row per holding:
//   Equity INE002A01018 RELIANCE INDUSTRIES LIMITED 24.00 0.00 1335.40 32049.60 NSDL_NSE 11 Nov 2026
// i.e. ISIN, company name, then quantity, (pledged qty), rate, value. The name can wrap onto the next lines.
function parseNsdlRows(lines, asOn) {
  const NUM = '([\\d,]+(?:\\.\\d+)?)';
  const rowRe = new RegExp(`\\b(IN[A-Z0-9]{9}\\d)\\b\\s*(.*?)\\s+${NUM}\\s+${NUM}\\s+${NUM}(?:\\s+${NUM})?(?:\\s|$)`);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(rowRe);
    if (!m) continue;
    const [, isin, rawName, a, b, c, d] = m;
    const n = [a, b, c, d].map(toNum);
    // 4 numbers: qty, pledged, rate, value.  3 numbers: qty, rate, value.
    const [qty, rate, value] = d != null ? [n[0], n[2], n[3]] : [n[0], n[1], n[2]];
    let name = rawName;
    for (let j = i + 1; j < Math.min(i + 3, lines.length) && !rowRe.test(lines[j]); j++) {
      if (/generated|corporate identity|page|total/i.test(lines[j])) break;
      const frag = lines[j].replace(/\s*\bE?\s*\d{1,2}:\d{2}(:\d{2})?.*$/, '').replace(/\s+E$/, '').trim();
      if (frag) name += ' ' + frag;
    }
    if (qty > 0) out.push({ isin, name: cleanName(name), qty, refPrice: rate > 0 ? rate : value > 0 ? value / qty : null });
  }
  return out;
}

// CDSL style (IndusInd Securities and other CDSL DPs), three lines per holding:
//   ANGEL ONE-EQ1/-   INE732I01021
//   500  500  0  0  0  0  0  0  0          (current, free, frozen, pledged, … — first is the holding)
//   Value (Rs.) : 169000
function parseCdslRows(lines) {
  const out = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const m = lines[i].match(/^(.*?)\s*\b(IN[A-Z0-9]{9}\d)$/);
    const q = lines[i + 1].match(/^([\d,]+(?:\.\d+)?)(?:\s|$)/);
    if (!m || !q) continue;
    const qty = toNum(q[1]);
    let value = null;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const v = lines[j].match(/Value\s*\(Rs\.?\)\s*:?\s*([\d,]+(?:\.\d+)?)/i);
      if (v) { value = toNum(v[1]); break; }
      if (j > i + 1 && /\bIN[A-Z0-9]{9}\d$/.test(lines[j])) break;
    }
    if (qty > 0) out.push({ isin: m[2], name: cleanName(m[1] || m[2]), qty, refPrice: value > 0 ? value / qty : null });
  }
  return out;
}

function parseDpStatement(lines) {
  const info = statementInfo(lines);
  let rows = parseNsdlRows(lines);
  if (!rows.length) rows = parseCdslRows(lines);
  if (!rows.length && lines.cells) {
    // Not a DP statement layout we know: read the PDF as a table (Symbol / Qty / Avg price … columns).
    try {
      const t = rowsToHoldings(lines.cells);
      return { ...t, account: t.account || info.account, label: t.label || info.label };
    } catch {}
  }
  const merged = new Map();
  for (const r of rows) addMerged(merged, { symbol: r.isin, ...r, avg: null, refDate: info.asOn });
  if (!merged.size) throw new Error('No holdings found in this PDF. If it is a scanned image or a photo, download the statement as PDF/Excel/CSV from your broker instead.');
  return { list: [...merged.values()], skipped: 0, account: info.account, label: info.label };
}

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s(&/-])([a-z])/g, (m, p, c) => p + c.toUpperCase());

// Read any holdings file: the format is detected from the contents, so the file name / extension doesn't matter.
async function readFile(file) {
  const buf = await file.arrayBuffer();
  const b = new Uint8Array(buf.slice(0, 8));
  const head = String.fromCharCode(...b);
  if (head.startsWith('%PDF')) return parseDpStatement(await pdfLines(buf));
  if ((b[0] === 0x50 && b[1] === 0x4b) || (b[0] === 0xd0 && b[1] === 0xcf)) return readWorkbook(buf, 'array'); // xlsx/xlsm/ods (zip), old .xls
  if (/^(\x89PNG|\xFF\xD8\xFF|GIF8|RIFF|....ftyp)/.test(head)) throw new Error('That is a photo/image. Upload the statement as PDF, Excel or CSV instead.');
  const text = (b[0] === 0xff && b[1] === 0xfe ? new TextDecoder('utf-16le') : b[0] === 0xfe && b[1] === 0xff ? new TextDecoder('utf-16be') : new TextDecoder())
    .decode(buf).replace(/^\uFEFF/, '');
  if (/^\s*</.test(text) && /<table/i.test(text)) return readWorkbook(text, 'string'); // "Excel" exports that are really HTML tables
  if (/^\s*[[{]/.test(text)) {
    try {
      let data = JSON.parse(text);
      if (!Array.isArray(data)) data = data.holdings || data.data || Object.values(data).find(Array.isArray) || [];
      const keys = [...new Set(data.flatMap((o) => Object.keys(o || {})))];
      return rowsToHoldings([keys, ...data.map((o) => keys.map((k) => o[k] ?? ''))]);
    } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
  }
  return rowsToHoldings(parseCSV(text));
}

function readWorkbook(data, type) {
  if (!window.XLSX) throw new Error('Spreadsheet reader did not load (offline?). Connect to the internet and try again.');
  const wb = XLSX.read(data, { type });
  let err;
  for (const name of wb.SheetNames) { // first sheet with a recognisable holdings table
    try { return rowsToHoldings(XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' })); } catch (e) { err = e; }
  }
  throw err || new Error('This workbook has no sheets.');
}

async function importFile(file) {
  if (!file) return;
  try {
    const { list, skipped, account = null, label = null } = await readFile(file);
    for (const h of list) if (!('account' in h)) Object.assign(h, { account, accountLabel: label });
    // Only the holdings of the account(s) in this file are replaced; other demat accounts stay.
    const ids = new Set(list.map((h) => h.account ?? null));
    const same = holdings.filter((h) => ids.has(h.account ?? null));
    const others = holdings.filter((h) => !ids.has(h.account ?? null));
    const where = ids.size > 1 ? ` in ${ids.size} accounts` : account ? ` in account ${label}` : others.length ? ' that did not come from a DP statement' : '';
    if (same.length && !confirm(`Replace the ${same.length} holdings${where} with ${list.length} from "${file.name}"?\n\n`
      + `Buy prices you've already entered are kept for stocks that are still in the new file.${others.length ? ' Your other accounts are not changed.' : ''}`)) return;
    // A new statement usually has fresh quantities but no buy prices: keep the ones the user entered.
    let kept = 0;
    for (const h of list) {
      if (h.avg != null) continue;
      const old = same.find((o) => (o.account ?? null) === (h.account ?? null) && (o.symbol === h.symbol || (h.isin && o.isin === h.isin)));
      if (old?.avg != null) { h.avg = old.avg; kept++; }
    }
    holdings = [...others, ...list]; quotes = {}; prevPrices = {};
    if (others.length || ids.size > 1) prefs.account = 'all';
    save();
    const verb = same.length || ids.size > 1 ? 'Loaded' : others.length ? `Added account ${label || ''} with` : 'Loaded';
    toast(`${verb} ${list.length} holdings${skipped ? `, skipped ${skipped} invalid rows` : ''}${kept ? `, kept ${kept} buy prices` : ''}.`);
    showView(); refresh(); loadAnalysis(); loadFundamentals();
  } catch (e) { toast(e.message, 6000); }
}

// ---------- quotes ----------
async function refresh() {
  if (!holdings.length) return;
  $('refreshBtn').disabled = true;
  try {
    const syms = holdings.map((h) => h.symbol);
    const res = await fetch('/api/quotes?symbols=' + encodeURIComponent(syms.join(',')));
    if (!res.ok) throw new Error('Quote server error ' + res.status);
    const data = await res.json();
    for (const s of syms) if (quotes[s]?.price != null) prevPrices[s] = quotes[s].price;
    quotes = data.quotes || {};
    try { localStorage.setItem(LS_QUOTES, JSON.stringify({ at: data.at, quotes })); } catch {}
    $('demoBadge').hidden = !data.mock;
    $('lastUpdated').textContent = 'Updated ' + new Date(data.at).toLocaleTimeString('en-IN');
    render();
  } catch (e) {
    const last = load(LS_QUOTES, null)?.at;
    $('lastUpdated').textContent = (navigator.onLine ? 'Update failed' : 'Offline') + (last ? ` — prices from ${new Date(last).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : '');
    console.error(e);
  } finally {
    $('refreshBtn').disabled = false;
  }
}

function schedule() {
  clearInterval(timer);
  const s = Number(prefs.refresh);
  if (s > 0) timer = setInterval(() => { if (!document.hidden) refresh(); updateMarketStatus(); }, s * 1000);
}

// NSE equity session: Mon–Fri 09:15–15:30 IST (exchange holidays not accounted for).
function updateMarketStatus() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date()).map((p) => [p.type, p.value]));
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  const open = !['Sat', 'Sun'].includes(parts.weekday) && mins >= 555 && mins < 930;
  const el = $('marketStatus');
  el.textContent = open ? '● Market open' : 'Market closed';
  el.classList.toggle('open', open);
}

// ---------- rendering ----------
const PALETTE = ['#0f766e', '#2563eb', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#65a30d', '#dc2626', '#4f46e5', '#9ca3af'];

function accounts() {
  const m = new Map();
  for (const h of holdings) {
    const k = h.account ?? '';
    const a = m.get(k) || { id: k, label: h.accountLabel || (k ? '…' + k.slice(-4) : 'Other holdings'), count: 0 };
    a.count++; m.set(k, a);
  }
  return [...m.values()];
}
const selectedAccount = () => (prefs.account && prefs.account !== 'all' && accounts().some((a) => a.id === prefs.account) ? prefs.account : 'all');
const inView = (h) => selectedAccount() === 'all' || (h.account ?? '') === selectedAccount();

function renderAccounts() {
  const list = accounts(), sel = $('acctSel');
  sel.hidden = list.length < 2;
  const opts = [`<option value="all">All accounts (${holdings.length})</option>`]
    .concat(list.map((a) => `<option value="${esc(a.id)}">${esc(a.label)} (${a.count})</option>`)).join('');
  if (sel.innerHTML !== opts) sel.innerHTML = opts;
  sel.value = selectedAccount();
}

function computeRows() {
  const multi = selectedAccount() === 'all' && accounts().length > 1;
  const rows = holdings.map((h, i) => [h, i]).filter(([h]) => inView(h)).map(([h, i]) => {
    const q = quotes[h.symbol] || {};
    const live = q.price != null;
    const price = live ? q.price : h.refPrice ?? null; // fall back to the statement's price
    const invested = h.avg != null ? h.qty * h.avg : null;
    const current = price != null ? h.qty * price : null;
    const resolved = ISIN_RE.test(h.symbol) && q.symbol && !q.error && !ISIN_RE.test(q.symbol.split('.')[0]);
    const display = resolved ? q.symbol.replace(/\.NS$/, '').replace(/^(.*)\.BO$/, 'BSE:$1')
      : ISIN_RE.test(h.symbol) && h.name ? h.name.replace(/\s+(Limited|Ltd\.?)$/i, '') : h.symbol;
    return {
      fd: fund?.items?.[h.symbol] || null, ...fundFields(fund?.items?.[h.symbol]), fg: fundGrade(fund?.items?.[h.symbol]),
      an: analysis?.items?.[h.symbol] || null, sig: analysis?.items?.[h.symbol]?.signal || null,
      sigScore: analysis?.items?.[h.symbol]?.score ?? (analysis?.items?.[h.symbol] ? -99 : null),
      i, ...h, q, live, price, invested, current, display, key: resolved ? display : h.symbol, name: resolved ? q.name || h.name : h.name || q.name, acctTag: multi ? h.accountLabel || 'Other' : '',
      changePct: live ? q.changePct : null, dayPnl: live && q.change != null ? q.change * h.qty : null,
      pnl: current != null && invested != null ? current - invested : null,
      pnlPct: current != null && invested ? ((current - invested) / invested) * 100 : null,
    };
  });
  const totalCur = rows.reduce((a, r) => a + (r.current ?? r.invested ?? 0), 0);
  rows.forEach((r) => (r.weight = totalCur ? ((r.current ?? r.invested ?? 0) / totalCur) * 100 : 0));
  return rows;
}

// Editable buy-price box used in the table and on the phone cards.
const avgInput = (r) => `<input class="avgin${r.avg == null ? ' empty' : ''}" data-avg="${r.i}" type="number" inputmode="decimal" step="any" min="0"
  value="${r.avg != null ? Number(r.avg.toFixed(2)) : ''}" placeholder="Add" title="Average buy price — type to change" aria-label="Average buy price for ${esc(r.display)}">`;

function sparkSVG(pts, up) {
  if (!pts || pts.length < 2) return '';
  const w = 64, h = 20, min = Math.min(...pts), max = Math.max(...pts), rng = max - min || 1;
  const d = pts.map((p, i) => `${((i / (pts.length - 1)) * w).toFixed(1)},${(h - 2 - ((p - min) / rng) * (h - 4)).toFixed(1)}`).join(' ');
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${d}" fill="none" stroke="var(--${up ? 'up' : 'down'})" stroke-width="1.5"/></svg>`;
}

function render() {
  renderAccounts();
  const rows = computeRows();
  const live = rows.filter((r) => r.live);
  const withCost = rows.filter((r) => r.invested != null);
  const costed = withCost.filter((r) => r.current != null);
  const current = rows.reduce((a, r) => a + (r.current ?? r.invested ?? 0), 0);
  const invested = withCost.reduce((a, r) => a + r.invested, 0);
  const pnl = costed.reduce((a, r) => a + r.pnl, 0);
  const pnlBase = costed.reduce((a, r) => a + r.invested, 0);
  const day = live.reduce((a, r) => a + (r.dayPnl || 0), 0);
  const prevVal = live.reduce((a, r) => a + r.current, 0) - day;
  const missing = rows.length - withCost.length;

  $('kCurrent').textContent = fmt(current);
  $('kCount').textContent = `${rows.length} stocks` + (live.length < rows.length ? ` · ${rows.length - live.length} not live` : '');
  $('kInvested').textContent = withCost.length ? fmt(invested) : '—';
  $('kInvested').nextElementSibling.textContent = missing ? `${missing} of ${rows.length} without buy price` : 'cost basis';
  $('kPnl').textContent = costed.length ? signed(pnl) : '—'; $('kPnl').className = 'value ' + cls(pnl);
  $('kPnlPct').textContent = pnlBase ? pct((pnl / pnlBase) * 100) + (missing ? ` · on ${costed.length} stocks` : '') : 'add buy prices to see P&L';
  $('kPnlPct').className = 'sub ' + (pnlBase ? cls(pnl) : 'muted');
  const banner = $('costBanner');
  banner.hidden = !missing;
  if (missing) banner.innerHTML = `<span><b>${missing} holding${missing > 1 ? 's have' : ' has'} no average buy price</b> <span class="muted">— DP statements don't include it. Type it in the <b>Buy price</b> box next to each stock to see P&amp;L. Buy prices are kept when you upload a newer statement.</span></span>`;
  $('kDay').textContent = signed(day); $('kDay').className = 'value ' + cls(day);
  $('kDayPct').textContent = prevVal ? pct((day / prevVal) * 100) : ''; $('kDayPct').className = 'sub ' + cls(day);
  document.title = `${signed(day, inr0)} · My Portfolio`;

  // allocation
  // One slice per holding; a stock held in several accounts gets the broker added to its name.
  const seen = {};
  for (const r of rows) { const k = r.isin || r.display; seen[k] = (seen[k] || 0) + 1; }
  const byW = rows.map((r) => ({ display: seen[r.isin || r.display] > 1 ? `${r.display} (${brokerPart(r.accountLabel) || 'other'})` : r.display, weight: r.weight }))
    .sort((a, b) => b.weight - a.weight);
  const top = byW.slice(0, 9);
  const rest = byW.slice(9).reduce((a, r) => a + r.weight, 0);
  const segs = top.map((r, i) => ({ label: r.display, w: r.weight, c: PALETTE[i] }));
  if (rest > 0) segs.push({ label: `Others (${byW.length - 9})`, w: rest, c: PALETTE[9] });
  $('allocBar').innerHTML = segs.map((s) => `<span style="width:${s.w}%;background:${s.c}" title="${esc(s.label)} ${s.w.toFixed(1)}%"></span>`).join('');
  $('allocLegend').innerHTML = segs.map((s) => `<span><i style="background:${s.c}"></i>${esc(s.label)} <span class="muted">${s.w.toFixed(1)}%</span></span>`).join('');

  renderAnalysis(rows);

  // table
  const f = norm($('search').value);
  const k = prefs.sortKey, dir = prefs.sortAsc ? 1 : -1;
  const sf = prefs.sigFilter;
  const view = rows.filter((r) => (!f || norm(r.symbol + r.display + (r.name || '')).includes(f)) && (!sf || sigGroup(r.sig) === sf)).sort((a, b) => {
    const x = k === 'symbol' ? a.display : a[k], y = k === 'symbol' ? b.display : b[k];
    if (typeof x === 'string') return x.localeCompare(y) * dir;
    return ((x ?? -Infinity) - (y ?? -Infinity)) * dir;
  });
  const maxW = Math.max(...rows.map((r) => r.weight), 1);

  if (document.activeElement?.classList.contains('avgin')) return; // user is typing a buy price
  $('holdings').querySelector('tbody').innerHTML = view.map((r) => {
    const prev = prevPrices[r.symbol];
    const flash = prev != null && r.price != null && prev !== r.price ? (r.price > prev ? 'flash-up' : 'flash-down') : '';
    const sub = `<div class="nm" title="${esc(r.isin || '')}">${r.acctTag ? `<span class="acct">${esc(r.acctTag)}</span> ` : ''}${esc(r.name || '')}</div>` + (r.q.error ? `<div class="err">⚠ ${esc(r.q.error)}</div>` : '');
    const avgCell = `<td>${avgInput(r)}</td>`;
    const stale = r.price != null && !r.live ? `<span class="stale">statement${r.refDate ? ' ' + esc(r.refDate) : ''}</span>` : '';
    return `<tr class="hl-${highlight(r)}">
      <td class="l"><div class="sym">${esc(r.display)} <button class="infobtn" data-info="${r.i}" title="Company details">ⓘ</button></div>${sub}</td>
      <td>${num.format(r.qty)}</td>
      ${avgCell}
      <td class="${flash}" title="${r.q.dayLow != null ? `Day ${fmt(r.q.dayLow)} – ${fmt(r.q.dayHigh)}\n52w ${fmt(r.q.low52)} – ${fmt(r.q.high52)}` : ''}"><b>${fmt(r.price)}</b>${stale}</td>
      <td><span class="chg ${cls(r.changePct)}">${pct(r.changePct)}</span></td>
      <td>${sparkSVG(r.q.spark, (r.q.change ?? 0) >= 0)}</td>
      <td>${fmt(r.invested)}</td>
      <td>${fmt(r.current)}</td>
      <td class="${cls(r.pnl)}">${signed(r.pnl)}</td>
      <td class="${cls(r.pnl)}">${pct(r.pnlPct)}</td>
      <td>${r.weight.toFixed(1)}%<span class="wbar"><b style="width:${(r.weight / maxW) * 100}%"></b></span></td>
      <td>${sigBadge(r)}</td>
      <td><button class="btn icon" data-edit="${r.i}" title="Edit">✎</button> <button class="btn icon" data-del="${r.i}" title="Remove">×</button></td>
    </tr>`;
  }).join('');

  // Phone layout: one card per holding.
  $('cards').innerHTML = view.map((r) => {
    const prev = prevPrices[r.symbol];
    const flash = prev != null && r.price != null && prev !== r.price ? (r.price > prev ? 'flash-up' : 'flash-down') : '';
    const stale = r.price != null && !r.live ? ' <span class="muted small">(stmt)</span>' : '';
    const cost = `<label class="costin"><span class="muted">Buy ₹</span>${avgInput(r)}${r.invested != null ? `<span class="muted small">Inv ${fmt(r.invested, inr0)}</span>` : ''}</label>`;
    return `<div class="hcard hl-${highlight(r)}" data-card="${r.i}">
      <div class="r1"><div><div class="sym">${esc(r.display)} ${sigBadge(r)} <button class="infobtn" data-info="${r.i}" title="Company details">ⓘ</button></div><div class="nm">${r.acctTag ? `<span class="acct">${esc(r.acctTag)}</span> ` : ''}${esc(r.name || '')}</div></div>
        <div class="val">${fmt(r.current)}</div></div>
      <div class="r2"><span class="muted">${num.format(r.qty)} × <b class="${flash}" style="color:var(--text)">${fmt(r.price)}</b>${stale}</span>
        <span class="${cls(r.changePct)}">${r.dayPnl != null ? signed(r.dayPnl, inr0) + ' ' : ''}<span class="chg ${cls(r.changePct)}">${pct(r.changePct)}</span></span></div>
      <div class="r3">${cost}<span class="${cls(r.pnl)}">${r.pnl != null ? `${signed(r.pnl, inr0)} (${pct(r.pnlPct)})` : ''}</span></div>
      ${prefs.view === 'fund' ? fundLine(r) : ''}
      ${r.q.error && !r.live ? `<div class="err">⚠ ${esc(r.q.error)}</div>` : ''}
    </div>`;
  }).join('');
  renderFundTable(view);
  const hlm = prefs.hl || 'fund';
  $('hlLegend').innerHTML = hlm === 'off' ? '' : `<span class="hlkey good"></span>${hlm === 'trend' ? 'Strong trend' : hlm === 'both' ? 'Good + strong' : 'Good'}
    <span class="hlkey poor"></span>${hlm === 'trend' ? 'Weak trend' : hlm === 'both' ? 'Poor + weak' : 'Poor'}`;
  const fv = prefs.view === 'fund';
  $('viewPrices').classList.toggle('on', !fv); $('viewFund').classList.toggle('on', fv);
  $('pricesWrap').hidden = fv; $('fundWrap').hidden = !fv;
  $('sortSel').value = ['current', 'changePct', 'pnl', 'pnlPct', 'symbol', 'sigScore', 'fPe', 'fRoe', 'fDe', 'fDy'].includes(k) ? k : 'current';
  const chip = $('sigFilterChip');
  chip.hidden = !sf;
  if (sf) chip.innerHTML = `<span class="small muted">Showing</span> <button class="sig ${sf}" data-sigfilter="">${SIG[sf].icon} ${SIG[sf].label} only ✕</button> <span class="small muted">${view.length} stocks</span>`;

  document.querySelectorAll('#holdings th[data-k]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.k === k);
    th.classList.toggle('asc', th.dataset.k === k && prefs.sortAsc);
  });
}

// ---------- analysis ----------
const SIG = {
  strong: { label: 'Strong', icon: '▲', color: 'var(--strong)' },
  neutral: { label: 'Neutral', icon: '◆', color: 'var(--neutral)' },
  weak: { label: 'Weak', icon: '▼', color: 'var(--weak)' },
  inactive: { label: 'Not trading', icon: '⏸', color: 'var(--inactive)' },
};
const sigGroup = (s) => (s === 'nodata' ? 'inactive' : s);
function sigBadge(r) {
  if (!r.sig) return analysisLoading || !analysis ? '<span class="sig pending">…</span>' : '';
  const g = SIG[sigGroup(r.sig)];
  const title = r.an?.score != null ? `Score ${r.an.score > 0 ? '+' : ''}${r.an.score} — tap for reasons` : 'Tap for details';
  return `<button class="sig ${sigGroup(r.sig)}" data-sig="${r.i}" title="${title}">${g.icon} ${g.label}</button>`;
}

async function loadAnalysis(force = false) {
  if (!holdings.length || analysisLoading) return;
  const syms = [...new Set(holdings.map((h) => h.symbol))];
  const fresh = analysis && Date.now() - analysis.at < 4 * 3600e3 && syms.every((s) => analysis.items?.[s]);
  if (fresh && !force) return renderAnalysis();
  analysisLoading = true; renderAnalysis();
  try {
    const res = await fetch('/api/analysis?symbols=' + encodeURIComponent(syms.join(',')));
    if (!res.ok) throw new Error('Analysis server error ' + res.status);
    const data = await res.json();
    analysis = { at: data.at, bench: data.bench, items: data.items, mock: data.mock };
    try { localStorage.setItem(LS_ANALYSIS, JSON.stringify(analysis)); } catch {}
  } catch (e) {
    console.error(e);
    if (!analysis) $('anaBody').textContent = 'Analysis is unavailable right now (' + e.message + '). It will retry later.';
    analysisLoading = false; return;
  }
  analysisLoading = false;
  render();
}

function renderAnalysis(rows = computeRows()) {
  const body = $('anaBody');
  $('anaUpdated').textContent = analysisLoading ? 'Updating…' : analysis ? 'Updated ' + new Date(analysis.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  if (!analysis) { body.innerHTML = portfolioFundamentals(rows) + `<p class="muted small">${analysisLoading ? 'Analysing price trends — fetching a year of prices for each stock…' : ''}</p>`; return; }
  body.classList.remove('muted', 'small');

  // Market
  const b = analysis.bench || {};
  const trend = { up: ['up', 'Uptrend', 'above its 200-day average'], mixed: ['', 'Mixed', 'above its 200-day average, but the 50-day is below the 200-day'], down: ['down', 'Downtrend', 'below its 200-day average'] }[b.trend];
  const mkt = b.last ? `<div class="anamkt"><b>Market (${esc(b.name)})</b> <span>${num.format(b.last)}</span>
    ${trend ? `<span class="${trend[0]}">● ${trend[1]}</span> <span class="muted small">${trend[2]}</span>` : ''}
    <span class="small">1M <span class="${cls(b.ret1m)}">${pct(b.ret1m)}</span> · 3M <span class="${cls(b.ret3m)}">${pct(b.ret3m)}</span> · 1Y <span class="${cls(b.ret1y)}">${pct(b.ret1y)}</span></span></div>`
    : `<div class="anamkt muted small">Market data unavailable${b.error ? ': ' + esc(b.error) : ''}</div>`;

  // Distribution by value
  const total = rows.reduce((a, r) => a + (r.current ?? r.invested ?? 0), 0) || 1;
  const groups = {};
  for (const r of rows) {
    if (!r.sig) continue;
    const g = sigGroup(r.sig);
    groups[g] = groups[g] || { n: 0, v: 0 };
    groups[g].n++; groups[g].v += r.current ?? r.invested ?? 0;
  }
  const order = ['strong', 'neutral', 'weak', 'inactive'].filter((g) => groups[g]);
  const bar = `<div class="anabar">${order.map((g) => `<span style="width:${(groups[g].v / total) * 100}%;background:${SIG[g].color}" title="${SIG[g].label}: ${((groups[g].v / total) * 100).toFixed(1)}% of value"></span>`).join('')}</div>`;
  const legend = `<div class="analegend">${order.map((g) => `<button class="sig ${g}${prefs.sigFilter === g ? ' on' : ''}" data-sigfilter="${g}" title="Show only these">${SIG[g].icon} ${groups[g].n} ${SIG[g].label} · ${((groups[g].v / total) * 100).toFixed(0)}% of value</button>`).join('')}</div>`;

  // Needs attention: weak/not-trading holdings that matter, concentration, deep losses still falling
  const att = [];
  for (const r of rows) {
    const val = r.current ?? r.invested ?? 0;
    if (r.weight >= 15) att.push({ r, w: r.weight + 100, why: `${r.weight.toFixed(0)}% of the portfolio in one stock` });
    else if (r.sig === 'weak' && r.pnlPct != null && r.pnlPct < -25) att.push({ r, w: r.weight + 50, why: `Weak trend, ${pct(r.pnlPct)} vs your buy price` });
    else if (r.sig === 'weak' && r.weight >= 2) att.push({ r, w: r.weight + 20, why: `Weak trend, ${r.weight.toFixed(1)}% of portfolio` });
    else if (sigGroup(r.sig) === 'inactive' && val > 0) att.push({ r, w: r.weight, why: `Not trading — ${fmt(val, inr0)} at the last price` });
  }
  att.sort((a, b) => b.w - a.w);
  const strong = rows.filter((r) => r.sig === 'strong').sort((a, b) => b.sigScore - a.sigScore || b.weight - a.weight);
  const li = (r, why) => `<li data-sig="${r.i}"><span>${sigBadge(r)} <b>${esc(r.display)}</b>${r.acctTag ? ` <span class="acct">${esc(r.acctTag)}</span>` : ''}</span><span class="why">${why}</span></li>`;
  const cols = `<div class="anacols">
    <div><h3>⚠ Needs attention</h3>${att.length ? `<ul>${att.slice(0, 8).map((a) => li(a.r, a.why)).join('')}</ul>` : '<p class="muted small">Nothing stands out.</p>'}</div>
    <div><h3>✓ Strongest trends</h3>${strong.length ? `<ul>${strong.slice(0, 8).map((r) => li(r, `score +${r.sigScore}${r.an?.ind?.ret1y != null ? ` · 1Y ${pct(r.an.ind.ret1y)}` : ''}`)).join('')}</ul>` : '<p class="muted small">None right now.</p>'}</div>
  </div>`;
  body.innerHTML = mkt + portfolioFundamentals(rows) + bar + legend + cols + (analysis.mock ? '<p class="small warn">Demo mode: these signals use simulated prices.</p>' : '');
}

// ---------- fundamentals ----------
const FIN_SECTOR = /financial/i;
function fundFields(f) {
  if (!f || f.error) return { sector: null, fMcap: null, fPe: null, fPb: null, fRoe: null, fDe: null, fPm: null, fRg: null, fEg: null, fDy: null, fProm: null };
  return { sector: f.sector || (f.type === 'ETF' ? 'ETF' : null), fMcap: f.marketCap, fPe: f.pe ?? (f.eps < 0 ? -1 : null), fPb: f.pb, fRoe: f.roe,
    fDe: f.debtToEquity, fPm: f.profitMargin, fRg: f.revenueGrowth, fEg: f.earningsGrowth, fDy: f.dividendYield ?? 0, fProm: f.promoters };
}
// Rule-of-thumb colouring (facts, not verdicts)
// Fundamentals quality grade from the company's own numbers (same thresholds as the colours).
function fundGrade(f) {
  if (!f || f.error || f.type === 'ETF') return null;
  const R = [], add = (p, t) => R.push({ pts: p, text: t });
  const fin = FIN_SECTOR.test(f.sector || '');
  if (f.pe == null && f.eps != null && f.eps < 0) add(-2, 'Loss-making (negative earnings over the last 12 months)');
  if (f.roe != null) { if (f.roe >= 15) add(1, `ROE ${f.roe.toFixed(1)}% (15% or more)`); else if (f.roe < 8) add(-1, `ROE ${f.roe.toFixed(1)}% (below 8%)`); }
  if (f.debtToEquity != null && !fin) { if (f.debtToEquity <= 0.5) add(1, `Low debt: debt/equity ${f.debtToEquity.toFixed(2)}`); else if (f.debtToEquity > 1.5) add(-1, `High debt: debt/equity ${f.debtToEquity.toFixed(2)}`); }
  if (f.profitMargin != null) { if (f.profitMargin >= 15) add(1, `Profit margin ${f.profitMargin.toFixed(1)}% (15% or more)`); else if (f.profitMargin < 0) add(-1, `Negative profit margin (${f.profitMargin.toFixed(1)}%)`); }
  if (f.revenueGrowth != null) { if (f.revenueGrowth >= 10) add(1, `Sales growing ${f.revenueGrowth.toFixed(1)}%`); else if (f.revenueGrowth < 0) add(-1, `Sales shrinking ${f.revenueGrowth.toFixed(1)}%`); }
  if (f.earningsGrowth != null) { if (f.earningsGrowth >= 10) add(1, `Profit growing ${f.earningsGrowth.toFixed(1)}%`); else if (f.earningsGrowth < 0) add(-1, `Profit falling ${f.earningsGrowth.toFixed(1)}%`); }
  if (!R.length) return null;
  const pts = R.reduce((a, r) => a + r.pts, 0);
  return { grade: pts >= 2 ? 'good' : pts <= -2 ? 'poor' : 'avg', pts, reasons: R };
}
const GRADE = { good: 'Good fundamentals', avg: 'Average fundamentals', poor: 'Poor fundamentals' };
// Which colour a stock gets, depending on the "Colour by" choice.
function highlight(r) {
  const mode = prefs.hl || 'fund';
  const fq = r.fg?.grade, tr = r.sig === 'strong' ? 'good' : r.sig === 'weak' ? 'poor' : r.sig ? 'avg' : null;
  if (mode === 'off') return '';
  if (mode === 'fund') return fq === 'good' || fq === 'poor' ? fq : '';
  if (mode === 'trend') return tr === 'good' || tr === 'poor' ? tr : '';
  return fq && fq === tr && fq !== 'avg' ? fq : ''; // both agree
}

function fcls(k, v, f) {
  if (v == null || !isFinite(v)) return '';
  switch (k) {
    case 'pe': return v < 0 ? 'down' : '';
    case 'roe': return v >= 15 ? 'up' : v < 8 ? 'down' : '';
    case 'de': return FIN_SECTOR.test(f?.sector || '') ? '' : v <= 0.5 ? 'up' : v > 1.5 ? 'down' : '';
    case 'pm': return v < 0 ? 'down' : v >= 15 ? 'up' : '';
    case 'gr': return v >= 10 ? 'up' : v < 0 ? 'down' : '';
    case 'dy': return v >= 2 ? 'up' : '';
    default: return '';
  }
}
const nf1 = (v, suf = '') => (v == null || !isFinite(v) ? '—' : `${v.toFixed(Math.abs(v) >= 100 ? 0 : 1)}${suf}`);
const crores = (v) => (v == null ? '—' : v >= 1e12 ? `₹${num.format(Math.round(v / 1e7))} Cr` : `₹${(v / 1e7).toLocaleString('en-IN', { maximumFractionDigits: v >= 1e10 ? 0 : 1 })} Cr`);
// Rough SEBI-style bands (the official lists rank by size: top 100 large, next 150 mid).
const capBand = (v) => (v == null ? '' : v >= 1e12 ? 'Large cap' : v >= 3e11 ? 'Mid cap' : v >= 5e10 ? 'Small cap' : 'Micro cap');
const gradeTag = (g) => (g ? `<span class="grade ${g.grade}" title="Fundamentals score ${g.pts > 0 ? '+' : ''}${g.pts}">${g.grade === 'good' ? '● Good' : g.grade === 'poor' ? '● Poor' : '● Avg'}</span>` : '');
const peText = (f) => (f?.pe != null ? nf1(f.pe) : f?.eps != null && f.eps < 0 ? 'Loss' : '—');

function fundLine(r) {
  const f = r.fd;
  if (!f) return fundLoading ? '<div class="fund muted">Loading fundamentals…</div>' : '';
  if (f.error) return `<div class="fund muted">No company data (${esc(f.error)})</div>`;
  const it = (k, v, c) => `<span>${k} <b class="${c}">${v}</b></span>`;
  return `<div class="fund"><span class="sec">${gradeTag(r.fg)} ${esc([f.sector, capBand(f.marketCap)].filter(Boolean).join(' · ') || f.type || '')}</span>
    ${it('P/E', peText(f), fcls('pe', f.pe ?? (f.eps < 0 ? -1 : null)))}${it('P/B', nf1(f.pb), '')}${it('ROE', nf1(f.roe, '%'), fcls('roe', f.roe))}
    ${it('D/E', nf1(f.debtToEquity), fcls('de', f.debtToEquity, f))}${it('Margin', nf1(f.profitMargin, '%'), fcls('pm', f.profitMargin))}
    ${it('Sales gr.', nf1(f.revenueGrowth, '%'), fcls('gr', f.revenueGrowth))}${it('Div', nf1(f.dividendYield ?? 0, '%'), fcls('dy', f.dividendYield))}</div>`;
}

function renderFundTable(view) {
  const td = (v, c = '') => `<td class="${c}">${v}</td>`;
  $('fundTable').querySelector('tbody').innerHTML = view.map((r) => {
    const f = r.fd;
    const name = `<td class="l"><div class="sym">${esc(r.display)} <button class="infobtn" data-info="${r.i}" title="Company details">ⓘ</button></div><div class="nm">${r.acctTag ? `<span class="acct">${esc(r.acctTag)}</span> ` : ''}${esc(r.name || '')}</div></td>`;
    if (!f || f.error) return `<tr>${name}<td class="l muted small" colspan="11">${f?.error ? 'No company data — ' + esc(f.error) : fundLoading ? 'Loading…' : '—'}</td></tr>`;
    return `<tr class="hl-${highlight(r)}">${name}
      <td class="l"><div class="sec" title="${esc(f.industry || '')}">${gradeTag(r.fg)} ${esc(f.sector || f.type || '—')}</div><div class="nm">${esc(f.industry || '')}</div></td>
      <td>${crores(f.marketCap)}<span class="cap">${capBand(f.marketCap)}</span></td>
      ${td(peText(f), fcls('pe', r.fPe))}${td(nf1(f.pb))}${td(nf1(f.roe, '%'), fcls('roe', f.roe))}${td(nf1(f.debtToEquity), fcls('de', f.debtToEquity, f))}
      ${td(nf1(f.profitMargin, '%'), fcls('pm', f.profitMargin))}${td(nf1(f.revenueGrowth, '%'), fcls('gr', f.revenueGrowth))}${td(nf1(f.earningsGrowth, '%'), fcls('gr', f.earningsGrowth))}
      ${td(nf1(f.dividendYield ?? 0, '%'), fcls('dy', f.dividendYield))}${td(nf1(f.promoters, '%'))}</tr>`;
  }).join('');
  document.querySelectorAll('#fundTable th[data-k]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.k === prefs.sortKey);
    th.classList.toggle('asc', th.dataset.k === prefs.sortKey && prefs.sortAsc);
  });
}

async function loadFundamentals(force = false) {
  if (!holdings.length || fundLoading) return;
  const syms = [...new Set(holdings.map((h) => h.symbol))];
  const fresh = fund && Date.now() - fund.at < 24 * 3600e3 && syms.every((s) => fund.items?.[s]);
  if (fresh && !force) return;
  fundLoading = true; render();
  try {
    const res = await fetch('/api/fundamentals?symbols=' + encodeURIComponent(syms.join(',')));
    if (!res.ok) throw new Error('Fundamentals server error ' + res.status);
    const data = await res.json();
    fund = { at: data.at, items: data.items, mock: data.mock };
    try { localStorage.setItem(LS_FUND, JSON.stringify(fund)); } catch {}
  } catch (e) { console.error(e); toast('Fundamentals unavailable right now: ' + e.message, 5000); }
  fundLoading = false; render();
}

// Portfolio-level fundamentals for the Analysis card: sector mix, value-weighted P/E, dividend yield.
function portfolioFundamentals(rows) {
  const withF = rows.filter((r) => r.fd && !r.fd.error);
  if (!withF.length) return fundLoading ? '<div class="anasec muted small">Loading company fundamentals…</div>' : '';
  const val = (r) => r.current ?? r.invested ?? 0;
  const total = rows.reduce((a, r) => a + val(r), 0) || 1;
  const sec = new Map();
  for (const r of rows) { const k = r.fd && !r.fd.error ? r.fd.sector || (r.fd.type === 'ETF' ? 'ETF / Index' : 'Other') : 'Unknown'; sec.set(k, (sec.get(k) || 0) + val(r)); }
  const secs = [...sec].sort((a, b) => b[1] - a[1]);
  const COLORS = ['#0f766e', '#2563eb', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#65a30d', '#dc2626', '#4f46e5', '#9ca3af', '#a16207', '#be123c'];
  // Value-weighted P/E = total value ÷ total earnings attributable (profitable companies only)
  const profitable = withF.filter((r) => r.fd.pe > 0);
  const pv = profitable.reduce((a, r) => a + val(r), 0), earn = profitable.reduce((a, r) => a + val(r) / r.fd.pe, 0);
  const loss = withF.filter((r) => r.fd.pe == null && r.fd.eps < 0);
  const divInc = withF.reduce((a, r) => a + val(r) * (r.fd.dividendYield || 0) / 100, 0);
  const roeRows = withF.filter((r) => r.fd.roe != null), roeW = roeRows.reduce((a, r) => a + val(r), 0);
  const roe = roeW ? roeRows.reduce((a, r) => a + r.fd.roe * val(r), 0) / roeW : null;
  return `<div class="anasec"><h3>Fundamentals of your portfolio</h3>
    <div class="anafund">
      <span>P/E (value-weighted) <b>${earn ? (pv / earn).toFixed(1) : '—'}</b></span>
      <span>ROE (value-weighted) <b class="${fcls('roe', roe)}">${nf1(roe, '%')}</b></span>
      <span>Dividend yield <b>${((divInc / total) * 100).toFixed(2)}%</b> <span class="muted small">≈ ${fmt(divInc, inr0)}/yr</span></span>
      <span>Loss-making <b class="${loss.length ? 'down' : ''}">${loss.length}</b> <span class="muted small">of ${withF.length}</span></span>
      <span>Grades: <b class="up">${rows.filter((r) => r.fg?.grade === 'good').length} good</b> · <b>${rows.filter((r) => r.fg?.grade === 'avg').length} average</b> · <b class="down">${rows.filter((r) => r.fg?.grade === 'poor').length} poor</b></span>
    </div>
    <div class="sectorbar">${secs.map(([k, v], i) => `<span style="width:${(v / total) * 100}%;background:${COLORS[i % COLORS.length]}" title="${esc(k)} ${((v / total) * 100).toFixed(1)}%"></span>`).join('')}</div>
    <div class="legend">${secs.map(([k, v], i) => `<span><i style="background:${COLORS[i % COLORS.length]}"></i>${esc(k)} <span class="muted">${((v / total) * 100).toFixed(1)}%</span></span>`).join('')}</div>
  </div>`;
}

// Company details popup: fundamentals, price trend (if analysed) and your position.
function openDetails(i) {
  const r = computeRows().find((x) => x.i === i);
  if (!r) return;
  const kv = (k, v, t = '') => `<div title="${t}"><span>${k}</span>${v}</div>`;
  const f = r.fd && !r.fd.error ? r.fd : null;
  const g = r.sig ? SIG[sigGroup(r.sig)] : null;
  const d = r.an?.ind || {};
  $('sigBody').innerHTML = `<h3>${esc(r.display)} ${g ? `<span class="sig ${sigGroup(r.sig)}">${g.icon} ${g.label}${r.an.score != null ? ` · ${r.an.score > 0 ? '+' : ''}${r.an.score}` : ''}</span>` : ''}</h3>
    <div class="muted small">${esc(r.name || '')}${r.acctTag ? ' · ' + esc(r.acctTag) : ''}${r.isin ? ' · ' + esc(r.isin) : ''}</div>
    <h4 class="dsec">Fundamentals ${gradeTag(r.fg)}</h4>
    ${r.fg ? `<ul>${r.fg.reasons.map((x) => `<li><b class="${x.pts > 0 ? 'up' : 'down'}">${x.pts > 0 ? '+' + x.pts : x.pts}</b><span>${esc(x.text)}</span></li>`).join('')}</ul>` : ''}
    ${f ? `<div class="muted small">${esc([f.sector, f.industry, capBand(f.marketCap)].filter(Boolean).join(' · '))}${f.employees ? ` · ${num.format(f.employees)} employees` : ''}</div>
    ${f.about ? `<p class="about">${esc(f.about)}${f.about.length >= 600 ? '…' : ''}</p>` : ''}
    <div class="kv">
      ${kv('Market cap', crores(f.marketCap))}${kv('P/E', `<b class="${fcls('pe', r.fPe)}">${peText(f)}</b>`, 'Price ÷ earnings per share')}${kv('P/B', nf1(f.pb), 'Price ÷ book value per share')}
      ${kv('EPS (12m)', f.eps != null ? fmt(f.eps) : '—')}${kv('Book value / share', f.bookValue != null ? fmt(f.bookValue) : '—')}${kv('EV / EBITDA', nf1(f.evEbitda))}
      ${kv('ROE', `<b class="${fcls('roe', f.roe)}">${nf1(f.roe, '%')}</b>`, 'Profit ÷ shareholders\' equity')}${kv('ROA', nf1(f.roa, '%'))}${kv('Profit margin', `<b class="${fcls('pm', f.profitMargin)}">${nf1(f.profitMargin, '%')}</b>`)}
      ${kv('Operating margin', nf1(f.operatingMargin, '%'))}${kv('Sales growth', `<b class="${fcls('gr', f.revenueGrowth)}">${nf1(f.revenueGrowth, '%')}</b>`, 'Latest quarter vs a year ago')}${kv('Profit growth', `<b class="${fcls('gr', f.earningsGrowth)}">${nf1(f.earningsGrowth, '%')}</b>`, 'Latest quarter vs a year ago')}
      ${kv('Debt / equity', `<b class="${fcls('de', f.debtToEquity, f)}">${nf1(f.debtToEquity)}</b>`)}${kv('Total debt', crores(f.totalDebt))}${kv('Cash', crores(f.totalCash))}
      ${kv('Current ratio', nf1(f.currentRatio))}${kv('Revenue (12m)', crores(f.revenue))}${kv('Free cash flow', crores(f.freeCashflow))}
      ${kv('Dividend yield', `<b class="${fcls('dy', f.dividendYield)}">${nf1(f.dividendYield ?? 0, '%')}</b>`)}${kv('Payout ratio', nf1(f.payoutRatio, '%'))}${kv('Beta', nf1(f.beta))}
      ${kv('Promoters / insiders', nf1(f.promoters, '%'))}${kv('Institutions', nf1(f.institutions, '%'))}${kv('Website', f.website ? `<a href="${esc(f.website)}" target="_blank" rel="noopener">${esc(f.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a>` : '—')}
    </div>` : `<p class="muted small">${r.fd?.error ? 'No company data: ' + esc(r.fd.error) : fundLoading ? 'Loading…' : 'Not loaded yet.'}</p>`}
    ${r.an ? `<h4 class="dsec">Price trend</h4>
    <ul>${(r.an.reasons || []).map((x) => `<li><b class="${x.pts > 0 ? 'up' : x.pts < 0 ? 'down' : 'muted'}">${x.pts > 0 ? '+' + x.pts : x.pts < 0 ? x.pts : '•'}</b><span>${esc(x.text)}</span></li>`).join('')}</ul>
    ${d.last ? `<div class="kv">
      ${kv('1 month', `<span class="${cls(d.ret1m)}">${pct(d.ret1m)}</span>`)}${kv('3 months', `<span class="${cls(d.ret3m)}">${pct(d.ret3m)}</span>`)}${kv('1 year', `<span class="${cls(d.ret1y)}">${pct(d.ret1y)}</span>`)}
      ${kv('50-day avg', fmt(d.sma50))}${kv('200-day avg', fmt(d.sma200))}${kv('52-week range', `${fmt(d.low52, inr0)} – ${fmt(d.high52, inr0)}`)}
    </div>` : ''}` : ''}
    <h4 class="dsec">Your holding</h4>
    <div class="kv">${kv('Quantity', num.format(r.qty))}${kv('Buy price', fmt(r.avg))}${kv('Current value', fmt(r.current, inr0))}
      ${kv('P&L', `<span class="${cls(r.pnl)}">${signed(r.pnl, inr0)} (${pct(r.pnlPct)})</span>`)}${kv('Portfolio weight', r.weight.toFixed(1) + '%')}</div>
    <p class="small muted">Source: Yahoo Finance. Figures can lag the latest quarterly results. For information only.</p>`;
  $('sigDlg').showModal();
}

function showView() {
  const has = holdings.length > 0;
  $('uploadSection').hidden = has;
  $('dashboard').hidden = !has;
  if (has) render();
}

// ---------- edit dialog ----------
function openEdit(i) {
  editingIndex = i;
  const f = $('editForm'), h = holdings[i] || { symbol: '', qty: '', avg: '' };
  $('editTitle').textContent = i >= 0 ? 'Edit holding' : 'Add holding';
  f.symbol.value = h.symbol; f.qty.value = h.qty; f.avg.value = h.avg ?? '';
  $('editTitle').textContent = i >= 0 ? (h.name || h.symbol) : 'Add holding';
  $('editDlg').showModal();
  if (i >= 0) { f.avg.focus(); f.avg.select(); }
}

$('editDlg').addEventListener('close', () => {
  if ($('editDlg').returnValue !== 'ok') return;
  const f = $('editForm');
  const a = f.avg.value.trim() === '' ? null : toNum(f.avg.value);
  const item = { symbol: f.symbol.value.trim().toUpperCase(), qty: toNum(f.qty.value), avg: a >= 0 ? a : null };
  if (!item.symbol || !(item.qty > 0)) return toast('Enter a symbol and a quantity.');
  if (editingIndex >= 0) {
    const old = holdings[editingIndex];
    // keep the statement details (name, ISIN, reference price) unless the stock itself changed
    holdings[editingIndex] = old.symbol === item.symbol || old.isin === item.symbol ? { ...old, ...item, symbol: old.symbol } : item;
  } else {
    const acct = selectedAccount() === 'all' ? null : selectedAccount();
    const label = acct ? accounts().find((a) => a.id === acct)?.label : null;
    const ex = holdings.find((h) => (h.account ?? null) === acct && (h.symbol === item.symbol || h.isin === item.symbol));
    if (ex) mergeInto(ex, item);
    else holdings.push({ ...item, account: acct, accountLabel: label });
  }
  save(); showView(); refresh(); loadAnalysis(); loadFundamentals();
});

// ---------- events ----------
$('fileInput').addEventListener('change', (e) => { importFile(e.target.files[0]); e.target.value = ''; });
$('fileInput2').addEventListener('change', (e) => { importFile(e.target.files[0]); e.target.value = ''; });
$('loadSampleBtn').addEventListener('click', async () => {
  const text = await (await fetch('sample-portfolio.csv')).text();
  importFile(new File([text], 'sample-portfolio.csv', { type: 'text/csv' }));
});

const dz = $('dropZone');
['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
document.addEventListener('drop', (e) => importFile(e.dataTransfer?.files?.[0]));

$('refreshBtn').addEventListener('click', refresh);
$('refreshSel').value = String(prefs.refresh);
$('refreshSel').addEventListener('change', (e) => { prefs.refresh = Number(e.target.value); save(); schedule(); });
$('search').addEventListener('input', render);
$('addBtn').addEventListener('click', () => openEdit(-1));
$('clearBtn').addEventListener('click', () => {
  const acct = selectedAccount();
  if (acct !== 'all') {
    const a = accounts().find((x) => x.id === acct);
    if (!confirm(`Remove the ${a.count} holdings in ${a.label} from this browser?`)) return;
    holdings = holdings.filter((h) => (h.account ?? '') !== acct); prefs.account = 'all';
  } else {
    if (!confirm('Remove all holdings (every account) from this browser?')) return;
    holdings = []; quotes = {};
  }
  save(); showView();
});
$('acctSel').addEventListener('change', (e) => { prefs.account = e.target.value; save(); render(); });
// ---------- download ----------
// One row per holding. Uploading the CSV or the Excel file back restores everything (accounts and buy prices included).
const EXPORT_COLS = ['Account', 'Account ID', 'Symbol', 'ISIN', 'Name', 'Quantity', 'Avg Price', 'LTP', 'Price Date', 'Day %',
  'Invested', 'Current', 'P&L', 'P&L %', 'Weight %'];
const r2 = (v, d = 2) => (v == null || !isFinite(v) ? null : Number(v.toFixed(d)));
function exportRows() {
  return computeRows().sort((a, b) => (a.accountLabel || '').localeCompare(b.accountLabel || '') || a.display.localeCompare(b.display))
    .map((r) => [r.accountLabel || '', r.account || '', r.key, r.isin || '', r.name || '', r.qty, r2(r.avg, 4), r2(r.price),
      r.live ? new Date(r.q.time || Date.now()).toLocaleDateString('en-IN') : r.refDate || '', r2(r.changePct),
      r2(r.invested), r2(r.current), r2(r.pnl), r2(r.pnlPct), r2(r.weight)]);
}
const fileStamp = () => {
  const acct = selectedAccount() === 'all' ? 'all-accounts' : (accounts().find((a) => a.id === selectedAccount())?.label || 'account');
  return `portfolio-${acct.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}-${new Date().toISOString().slice(0, 10)}`;
};

// Save a file. Installed iPhone apps can't download blobs, so offer the share sheet there (Save to Files, WhatsApp, Drive…).
async function deliver(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if ((standalone || ios) && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  toast(`Downloaded ${name}`);
}

function downloadCSV() {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [EXPORT_COLS, ...exportRows()].map((r) => r.map(q).join(','));
  deliver(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }), fileStamp() + '.csv'); // BOM so Excel shows ₹/· correctly
}

function downloadExcel() {
  if (!window.XLSX) { toast('Excel writer not available offline — downloading CSV instead.'); return downloadCSV(); }
  const rows = computeRows();
  // Summary: one line per account plus the total
  const groups = new Map();
  for (const r of rows) { const k = r.accountLabel || 'Other'; (groups.get(k) || groups.set(k, []).get(k)).push(r); }
  const sumUp = (label, rs) => {
    const inv = rs.reduce((a, r) => a + (r.invested ?? 0), 0);
    const cur = rs.reduce((a, r) => a + (r.current ?? r.invested ?? 0), 0);
    const costed = rs.filter((r) => r.pnl != null);
    const pnl = costed.reduce((a, r) => a + r.pnl, 0), base = costed.reduce((a, r) => a + r.invested, 0);
    const day = rs.reduce((a, r) => a + (r.dayPnl ?? 0), 0);
    return [label, rs.length, r2(inv), r2(cur), r2(pnl), base ? r2((pnl / base) * 100) : null, r2(day), rs.filter((r) => r.avg == null).length];
  };
  const summary = [['Account', 'Stocks', 'Invested', 'Current Value', 'P&L', 'P&L %', "Today's P&L", 'Without buy price']];
  for (const [k, rs] of [...groups].sort()) summary.push(sumUp(k, rs));
  if (groups.size > 1) summary.push(sumUp('TOTAL', rows));
  summary.push([], [`Prices as of ${new Date().toLocaleString('en-IN')}. Stocks without a live price use their statement price.`]);

  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet(summary);
  const ws2 = XLSX.utils.aoa_to_sheet([EXPORT_COLS, ...exportRows()]);
  const money = '#,##0.00', fmtCols = (ws, cols) => {
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let R = 1; R <= range.e.r; R++) for (const C of cols) { const c = ws[XLSX.utils.encode_cell({ r: R, c: C })]; if (c && c.t === 'n') c.z = money; }
  };
  fmtCols(ws1, [2, 3, 4, 5, 6]); fmtCols(ws2, [6, 7, 9, 10, 11, 12, 13, 14]);
  ws1['!cols'] = [22, 8, 14, 14, 14, 8, 12, 16].map((w) => ({ wch: w }));
  ws2['!cols'] = [20, 18, 14, 14, 32, 9, 11, 10, 12, 8, 13, 13, 13, 9, 9].map((w) => ({ wch: w }));
  ws2['!autofilter'] = { ref: ws2['!ref'] };
  XLSX.utils.book_append_sheet(wb, ws1, 'Summary');
  XLSX.utils.book_append_sheet(wb, ws2, 'Holdings');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  deliver(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fileStamp() + '.xlsx');
}

$('exportBtn').addEventListener('click', downloadCSV);
$('dlExcel').addEventListener('click', () => { closeMenus(); downloadExcel(); });
$('dlCsv').addEventListener('click', () => { closeMenus(); downloadCSV(); });
$('holdings').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-k]');
  if (th) {
    if (prefs.sortKey === th.dataset.k) prefs.sortAsc = !prefs.sortAsc;
    else { prefs.sortKey = th.dataset.k; prefs.sortAsc = th.dataset.k === 'symbol'; }
    save(); return render();
  }
  const ed = e.target.closest('[data-edit]');
  if (ed) return openEdit(Number(ed.dataset.edit));
  const del = e.target.closest('[data-del]');
  if (del) {
    const h = holdings[Number(del.dataset.del)];
    if (confirm(`Remove ${h.name || h.symbol}?`)) { holdings.splice(Number(del.dataset.del), 1); save(); showView(); }
  }
});
// Inline buy-price entry: type in the box and press Enter (or leave the box).
function commitAvg(input) {
  const i = Number(input.dataset.avg), v = input.value.trim(), h = holdings[i];
  if (!h) return;
  const n = v === '' ? null : toNum(v);
  if (n !== null && !(n >= 0)) return toast('Enter a valid price.');
  // the box shows 2 decimals; don't overwrite a more precise stored price unless it was really changed
  if (n === null ? h.avg != null : h.avg == null || Math.abs(n - h.avg) >= 0.005) { h.avg = n; save(); if (n != null) toast(`Buy price saved for ${h.name || h.symbol}`, 1500); }
  setTimeout(render);
}
for (const box of [$('holdings'), $('cards')]) {
  box.addEventListener('keydown', (e) => {
    if (!e.target.classList.contains('avgin')) return;
    if (e.key === 'Enter') { // save and jump to the next stock's box
      e.preventDefault();
      const next = e.target.closest('tr, .hcard')?.nextElementSibling?.querySelector('.avgin');
      if (next) next.focus(); else e.target.blur();
    }
    if (e.key === 'Escape') { const h = holdings[Number(e.target.dataset.avg)]; e.target.value = h?.avg ?? ''; e.target.blur(); }
  });
  box.addEventListener('change', (e) => { if (e.target.classList.contains('avgin')) commitAvg(e.target); });
  box.addEventListener('focusout', (e) => {
    if (!e.target.classList.contains('avgin')) return;
    commitAvg(e.target);
  });
}

// signal badges / analysis lists / filter chips
document.addEventListener('click', (e) => {
  const fb = e.target.closest('[data-sigfilter]');
  if (fb) { prefs.sigFilter = fb.dataset.sigfilter && prefs.sigFilter !== fb.dataset.sigfilter ? fb.dataset.sigfilter : null; save(); render(); return; }
  const sb = e.target.closest('[data-sig]');
  if (sb) { e.stopPropagation(); openDetails(Number(sb.dataset.sig)); return; }
  const ib = e.target.closest('[data-info]');
  if (ib) { e.stopPropagation(); openDetails(Number(ib.dataset.info)); }
}, true);
$('anaRefresh').addEventListener('click', () => { loadAnalysis(true); loadFundamentals(true); });
$('hlSel').value = prefs.hl || 'fund';
$('hlSel').addEventListener('change', (e) => { prefs.hl = e.target.value; save(); render(); });
$('viewPrices').addEventListener('click', () => { prefs.view = 'prices'; save(); render(); });
$('viewFund').addEventListener('click', () => { prefs.view = 'fund'; save(); render(); loadFundamentals(); });
$('fundTable').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-k]');
  if (!th) return;
  if (prefs.sortKey === th.dataset.k) prefs.sortAsc = !prefs.sortAsc;
  else { prefs.sortKey = th.dataset.k; prefs.sortAsc = ['symbol', 'sector', 'fPe', 'fPb', 'fDe'].includes(th.dataset.k); }
  save(); render();
});
$('sigDlg').addEventListener('click', (e) => { if (e.target === $('sigDlg')) $('sigDlg').close(); });

$('cards').addEventListener('click', (e) => {
  if (e.target.closest('.costin')) return; // typing a buy price, not opening the editor
  const c = e.target.closest('[data-card]');
  if (c) openEdit(Number(c.dataset.card));
});
$('sortSel').addEventListener('change', (e) => {
  prefs.sortKey = e.target.value; prefs.sortAsc = e.target.value === 'symbol'; save(); render();
});
// close the "More" menu after picking something / tapping elsewhere
const closeMenus = () => document.querySelectorAll('details.menu[open]').forEach((m) => (m.open = false));
document.addEventListener('click', (e) => {
  document.querySelectorAll('details.menu[open]').forEach((m) => {
    if (!m.contains(e.target) || e.target.closest('.menulist button')) m.open = false;
  });
});

// ---------- PWA: offline support + install ----------
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
}
let installEvt = null;
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
function installBanner(html) {
  if (standalone || prefs.installDismissed) return;
  const b = $('installBanner');
  b.innerHTML = `<span>${html}</span><span class="row">${installEvt ? '<button class="btn primary" data-install>Install</button>' : ''}<button class="btn" data-dismiss>Not now</button></span>`;
  b.hidden = false;
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); installEvt = e;
  $('installBtn').hidden = false;
  installBanner('<b>Install My Portfolio</b> <span class="muted">— add it to your home screen and open it like an app.</span>');
});
async function doInstall() {
  if (!installEvt) return;
  installEvt.prompt(); await installEvt.userChoice; installEvt = null;
  $('installBtn').hidden = true; $('installBanner').hidden = true;
}
$('installBtn').addEventListener('click', doInstall);
$('installBanner').addEventListener('click', (e) => {
  if (e.target.closest('[data-install]')) doInstall();
  if (e.target.closest('[data-dismiss]')) { prefs.installDismissed = true; save(); $('installBanner').hidden = true; }
});
if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone) {
  const tip = '<b>Install on iPhone:</b> <span class="muted">open this page in Safari, tap the Share button, then “Add to Home Screen”.</span>';
  $('installHint').innerHTML = tip; $('installHint').hidden = false;
  installBanner(tip);
}
window.addEventListener('online', refresh);

document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

function applyTheme() { if (prefs.theme) document.documentElement.dataset.theme = prefs.theme; else delete document.documentElement.dataset.theme; }
$('themeBtn').addEventListener('click', () => {
  const dark = prefs.theme ? prefs.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  prefs.theme = dark ? 'light' : 'dark'; save(); applyTheme();
});

// ---------- boot ----------
applyTheme();
if (cachedQuotes?.at) $('lastUpdated').textContent = 'Prices from ' + new Date(cachedQuotes.at).toLocaleTimeString('en-IN');
updateMarketStatus();
showView();
refresh();
schedule();
loadAnalysis();
loadFundamentals();
setInterval(() => { if (!document.hidden) loadAnalysis(); }, 30 * 60e3); // daily data: re-check every 30 min, refetches after 4h
