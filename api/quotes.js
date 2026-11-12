// Vercel / Netlify-style serverless function: GET /api/quotes?symbols=RELIANCE,INE002A01018
const { MOCK, getQuotes } = require('../lib/quotes');

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const symbols = (url.searchParams.get('symbols') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 300);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (!symbols.length) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'Pass ?symbols=RELIANCE,TCS' })); }
  try {
    res.end(JSON.stringify({ mock: MOCK, at: Date.now(), quotes: await getQuotes(symbols) }));
  } catch (e) {
    res.statusCode = 500; res.end(JSON.stringify({ error: e.message }));
  }
};
