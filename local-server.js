// Indian stock portfolio tracker — zero-dependency Node server (Node 18+).
// Serves the PWA from ./public and proxies live NSE/BSE quotes (browsers can't call Yahoo directly because of CORS).
//
//   node local-server.js            -> live quotes
//   MOCK=1 node local-server.js     -> simulated quotes (offline demo)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { MOCK, getQuotes } = require('./lib/quotes');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.csv': 'text/csv',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

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
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' };
    if (/sw\.js$|\.html$|\.webmanifest$/.test(file)) headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log(`Portfolio tracker running at http://localhost:${PORT}${MOCK ? '  (MOCK prices)' : ''}`);
});
