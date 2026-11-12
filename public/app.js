'use strict';

// ---------- state ----------
const LS_KEY = 'portfolio.v1';
const LS_PREF = 'portfolio.prefs.v1';
let holdings = load(LS_KEY, []);          // [{ symbol, qty, avg }]
let prefs = load(LS_PREF, { sortKey: 'current', sortAsc: false, refresh: 15, theme: null });
let quotes = {};                          // symbol -> quote
let prevPrices = {};                      // symbol -> last price, for flash animation
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
  symbol: ['symbol', 'tradingsymbol', 'instrument', 'stocksymbol', 'nsesymbol', 'scripcode', 'scrip', 'ticker', 'stock', 'stockname', 'security', 'company', 'companyname', 'name', 'bsecode', 'nsecode'],
  qty: ['quantity', 'qty', 'shares', 'noofshares', 'quantityavailable', 'availableqty', 'holdingqty', 'totalqty', 'netqty', 'units'],
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
  return cols;
}

function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  const delim = (text.split('\n')[0].match(/\t/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
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
  const n = parseFloat(String(v ?? '').replace(/[₹,\s]/g, '').replace(/^Rs\.?/i, ''));
  return isFinite(n) ? n : NaN;
};

function rowsToHoldings(rows) {
  // Broker exports often have a few title rows before the real header — scan for it.
  let hi = -1, cols;
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const c = findCols(rows[i]);
    if (c.symbol >= 0 && c.qty >= 0 && c.avg >= 0) { hi = i; cols = c; break; }
  }
  if (hi < 0) throw new Error('Could not find Symbol / Quantity / Avg price columns. Check the header row.');

  const merged = new Map();
  let skipped = 0;
  for (const r of rows.slice(hi + 1)) {
    const symbol = String(r[cols.symbol] ?? '').trim().toUpperCase();
    const qty = toNum(r[cols.qty]);
    const avg = toNum(r[cols.avg]);
    if (!symbol || /^(TOTAL|GRAND TOTAL)/.test(symbol)) continue;
    if (!(qty > 0) || !(avg >= 0)) { skipped++; continue; }
    const m = merged.get(symbol);
    if (m) { const q = m.qty + qty; m.avg = (m.avg * m.qty + avg * qty) / q; m.qty = q; }
    else merged.set(symbol, { symbol, qty, avg });
  }
  if (!merged.size) throw new Error('No valid rows found (need quantity > 0 and a price).');
  return { list: [...merged.values()], skipped };
}

async function readFile(file) {
  const isExcel = /\.(xlsx|xls)$/i.test(file.name);
  let rows;
  if (isExcel) {
    if (!window.XLSX) throw new Error('Excel reader did not load (offline?). Save the sheet as CSV and upload that.');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    // pick the first sheet that has a recognisable header
    for (const name of wb.SheetNames) {
      const r = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
      try { rowsToHoldings(r); rows = r; break; } catch {}
    }
    if (!rows) rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
  } else {
    rows = parseCSV((await file.text()).replace(/^﻿/, ''));
  }
  return rowsToHoldings(rows);
}

async function importFile(file) {
  if (!file) return;
  try {
    const { list, skipped } = await readFile(file);
    if (holdings.length && !confirm(`Replace your current ${holdings.length} holdings with ${list.length} from "${file.name}"?`)) return;
    holdings = list; quotes = {}; prevPrices = {}; save();
    toast(`Loaded ${list.length} holdings${skipped ? `, skipped ${skipped} invalid rows` : ''}.`);
    showView(); refresh();
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
    $('demoBadge').hidden = !data.mock;
    $('lastUpdated').textContent = 'Updated ' + new Date(data.at).toLocaleTimeString('en-IN');
    render();
  } catch (e) {
    $('lastUpdated').textContent = 'Update failed — retrying';
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

function computeRows() {
  const rows = holdings.map((h, i) => {
    const q = quotes[h.symbol] || {};
    const price = q.price;
    const invested = h.qty * h.avg;
    const current = price != null ? h.qty * price : null;
    return {
      i, ...h, q, price, invested, current,
      changePct: q.changePct, dayPnl: q.change != null ? q.change * h.qty : null,
      pnl: current != null ? current - invested : null,
      pnlPct: current != null && invested ? ((current - invested) / invested) * 100 : null,
    };
  });
  const totalCur = rows.reduce((a, r) => a + (r.current ?? r.invested), 0);
  rows.forEach((r) => (r.weight = totalCur ? ((r.current ?? r.invested) / totalCur) * 100 : 0));
  return rows;
}

function sparkSVG(pts, up) {
  if (!pts || pts.length < 2) return '';
  const w = 64, h = 20, min = Math.min(...pts), max = Math.max(...pts), rng = max - min || 1;
  const d = pts.map((p, i) => `${((i / (pts.length - 1)) * w).toFixed(1)},${(h - 2 - ((p - min) / rng) * (h - 4)).toFixed(1)}`).join(' ');
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${d}" fill="none" stroke="var(--${up ? 'up' : 'down'})" stroke-width="1.5"/></svg>`;
}

function render() {
  const rows = computeRows();
  const priced = rows.filter((r) => r.current != null);
  const invested = rows.reduce((a, r) => a + r.invested, 0);
  const current = priced.reduce((a, r) => a + r.current, 0) + rows.filter((r) => r.current == null).reduce((a, r) => a + r.invested, 0);
  const pnl = current - invested;
  const day = priced.reduce((a, r) => a + (r.dayPnl || 0), 0);
  const prevVal = current - day;

  $('kCurrent').textContent = fmt(current);
  $('kCount').textContent = `${rows.length} stocks` + (priced.length < rows.length ? ` · ${rows.length - priced.length} without price` : '');
  $('kInvested').textContent = fmt(invested);
  $('kPnl').textContent = signed(pnl); $('kPnl').className = 'value ' + cls(pnl);
  $('kPnlPct').textContent = invested ? pct((pnl / invested) * 100) : ''; $('kPnlPct').className = 'sub ' + cls(pnl);
  $('kDay').textContent = signed(day); $('kDay').className = 'value ' + cls(day);
  $('kDayPct').textContent = prevVal ? pct((day / prevVal) * 100) : ''; $('kDayPct').className = 'sub ' + cls(day);
  document.title = `${signed(day, inr0)} · My Portfolio`;

  // allocation
  const byW = [...rows].sort((a, b) => b.weight - a.weight);
  const top = byW.slice(0, 9);
  const rest = byW.slice(9).reduce((a, r) => a + r.weight, 0);
  const segs = top.map((r, i) => ({ label: r.symbol, w: r.weight, c: PALETTE[i] }));
  if (rest > 0) segs.push({ label: `Others (${byW.length - 9})`, w: rest, c: PALETTE[9] });
  $('allocBar').innerHTML = segs.map((s) => `<span style="width:${s.w}%;background:${s.c}" title="${esc(s.label)} ${s.w.toFixed(1)}%"></span>`).join('');
  $('allocLegend').innerHTML = segs.map((s) => `<span><i style="background:${s.c}"></i>${esc(s.label)} <span class="muted">${s.w.toFixed(1)}%</span></span>`).join('');

  // table
  const f = norm($('search').value);
  const k = prefs.sortKey, dir = prefs.sortAsc ? 1 : -1;
  const view = rows.filter((r) => !f || norm(r.symbol + (r.q.name || '')).includes(f)).sort((a, b) => {
    const x = a[k], y = b[k];
    if (typeof x === 'string') return x.localeCompare(y) * dir;
    return ((x ?? -Infinity) - (y ?? -Infinity)) * dir;
  });
  const maxW = Math.max(...rows.map((r) => r.weight), 1);

  $('holdings').querySelector('tbody').innerHTML = view.map((r) => {
    const prev = prevPrices[r.symbol];
    const flash = prev != null && r.price != null && prev !== r.price ? (r.price > prev ? 'flash-up' : 'flash-down') : '';
    const sub = r.q.error ? `<div class="err">⚠ ${esc(r.q.error)}</div>` : `<div class="nm">${esc(r.q.name || '')}</div>`;
    return `<tr>
      <td class="l"><div class="sym">${esc(r.symbol)}</div>${sub}</td>
      <td>${num.format(r.qty)}</td>
      <td>${fmt(r.avg)}</td>
      <td class="${flash}" title="${r.q.dayLow != null ? `Day ${fmt(r.q.dayLow)} – ${fmt(r.q.dayHigh)}\n52w ${fmt(r.q.low52)} – ${fmt(r.q.high52)}` : ''}"><b>${fmt(r.price)}</b></td>
      <td><span class="chg ${cls(r.changePct)}">${pct(r.changePct)}</span></td>
      <td>${sparkSVG(r.q.spark, (r.q.change ?? 0) >= 0)}</td>
      <td>${fmt(r.invested)}</td>
      <td>${fmt(r.current)}</td>
      <td class="${cls(r.pnl)}">${signed(r.pnl)}</td>
      <td class="${cls(r.pnl)}">${pct(r.pnlPct)}</td>
      <td>${r.weight.toFixed(1)}%<span class="wbar"><b style="width:${(r.weight / maxW) * 100}%"></b></span></td>
      <td><button class="btn icon" data-edit="${r.i}" title="Edit">✎</button> <button class="btn icon" data-del="${r.i}" title="Remove">×</button></td>
    </tr>`;
  }).join('');

  document.querySelectorAll('#holdings th[data-k]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.k === k);
    th.classList.toggle('asc', th.dataset.k === k && prefs.sortAsc);
  });
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
  f.symbol.value = h.symbol; f.qty.value = h.qty; f.avg.value = h.avg;
  $('editDlg').showModal();
}

$('editDlg').addEventListener('close', () => {
  if ($('editDlg').returnValue !== 'ok') return;
  const f = $('editForm');
  const item = { symbol: f.symbol.value.trim().toUpperCase(), qty: toNum(f.qty.value), avg: toNum(f.avg.value) };
  if (!item.symbol || !(item.qty > 0) || !(item.avg >= 0)) return toast('Enter a symbol, quantity and price.');
  if (editingIndex >= 0) holdings[editingIndex] = item;
  else {
    const ex = holdings.find((h) => h.symbol === item.symbol);
    if (ex) { const q = ex.qty + item.qty; ex.avg = (ex.avg * ex.qty + item.avg * item.qty) / q; ex.qty = q; }
    else holdings.push(item);
  }
  save(); showView(); refresh();
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
  if (!confirm('Remove all holdings from this browser?')) return;
  holdings = []; quotes = {}; save(); showView();
});
$('exportBtn').addEventListener('click', () => {
  const rows = computeRows();
  const lines = [['Symbol', 'Quantity', 'Avg Price', 'LTP', 'Day %', 'Invested', 'Current', 'P&L', 'P&L %'].join(',')]
    .concat(rows.map((r) => [r.symbol, r.qty, r.avg.toFixed(2), r.price?.toFixed(2) ?? '', r.changePct?.toFixed(2) ?? '',
      r.invested.toFixed(2), r.current?.toFixed(2) ?? '', r.pnl?.toFixed(2) ?? '', r.pnlPct?.toFixed(2) ?? ''].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = `portfolio-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
});
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
    if (confirm(`Remove ${h.symbol}?`)) { holdings.splice(Number(del.dataset.del), 1); save(); showView(); }
  }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

function applyTheme() { if (prefs.theme) document.documentElement.dataset.theme = prefs.theme; else delete document.documentElement.dataset.theme; }
$('themeBtn').addEventListener('click', () => {
  const dark = prefs.theme ? prefs.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  prefs.theme = dark ? 'light' : 'dark'; save(); applyTheme();
});

// ---------- boot ----------
applyTheme();
updateMarketStatus();
showView();
refresh();
schedule();
