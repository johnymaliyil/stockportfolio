# Stock Portfolio Tracker (NSE / BSE)

Upload your holdings and track them with live Indian market prices.

## Run it

Requires Node.js 18 or newer. There are no packages to install.

```bash
npm start          # http://localhost:3000, live prices
npm run demo       # simulated prices, works offline
PORT=8080 npm start
```

## Upload format

A CSV or Excel (.xlsx) file with a symbol, a quantity and an average buy price. Column names are matched
loosely (`Symbol`/`Instrument`/`Stock`, `Qty`/`Quantity`/`Shares`, `Avg. cost`/`Average Price`/`Buy Price`, …),
so holdings exports from Zerodha Console, Groww, Upstox and most other brokers load as they are.
Title rows above the header are skipped, and repeated symbols are merged using a weighted average.

```csv
Symbol,Quantity,Avg Price
RELIANCE,10,2450.50
NSE:TCS,5,3520
BSE:500325,2,2400
```

| You write                      | Looked up as   |
|--------------------------------|----------------|
| `RELIANCE`, `NSE:RELIANCE`, `RELIANCE-EQ` | `RELIANCE.NS` (NSE) |
| `BSE:500325`, `500325`         | `500325.BO` (BSE) |
| `INFY.NS`, `INFY.BO`           | used as given  |

The portfolio is stored in your browser's localStorage. It is never sent to the server; only the
symbols are, so their prices can be fetched.

## What you get

- Current value, invested amount, total P&L and today's P&L, with percentages
- Per-stock LTP, day % change, an intraday sparkline, P&L and portfolio weight, in a sortable, filterable table
- Allocation bar
- Auto-refresh every 5s / 15s / 30s / 1m (paused while the tab is hidden), and price-change flashes
- Add, edit and remove holdings by hand; export to CSV; light and dark themes

## How prices work

`server.js` proxies Yahoo Finance's chart API (`/api/quotes?symbols=RELIANCE,TCS`), caches each symbol
for 5 seconds and fetches 8 at a time. NSE/BSE quotes from this source are near real-time, but they can
lag the exchange by a little and are for personal tracking only. The "market open" badge goes by NSE
hours (Mon–Fri 09:15–15:30 IST) and does not know about exchange holidays.
