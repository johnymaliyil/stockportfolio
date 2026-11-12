// Vercel serverless function: GET /api/fundamentals?symbols=RELIANCE,INE002A01018
const { MOCK } = require('../lib/quotes');
const { fundamentals } = require('../lib/fundamentals');

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const symbols = (url.searchParams.get('symbols') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 300);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (!symbols.length) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'Pass ?symbols=RELIANCE,TCS' })); }
  try {
    res.end(JSON.stringify({ mock: MOCK, at: Date.now(), ...(await fundamentals(symbols)) }));
  } catch (e) {
    res.statusCode = 500; res.end(JSON.stringify({ error: e.message }));
  }
};
