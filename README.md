# Stock Portfolio Tracker (NSE / BSE)

Upload your holdings and track them with live Indian market prices.

## Run it

Requires Node.js 18 or newer. There are no packages to install.

```bash
npm start          # http://localhost:3000, live prices
npm run demo       # simulated prices, works offline
PORT=8080 npm start
```

## What you can upload

- **DP holding statement PDFs**, from NSDL depository participants (e.g. Geojit / IndusInd Money) and from CDSL ones
  (e.g. IndusInd Securities). These list ISIN, quantity and the previous close.
- **Broker holdings reports in Excel** (`.xlsx` / `.xlsm`), for example SMC Global. The broker's letterhead rows above the table
  are skipped. Client code, name and report date are read from them.
- **Any CSV / Excel file** with a symbol or ISIN column and a quantity column. An average buy price column is optional.
  Column names are matched loosely (`Symbol`/`Instrument`/`ISIN`, `Qty`/`Quantity`/`Total Qty`, `Avg. cost`/`Buy Price`, …),
  so Zerodha, Groww, Upstox and similar exports work.

```csv
Symbol,Quantity,Avg Price
RELIANCE,10,2450.50
NSE:TCS,5,3520
BSE:500325,2,2400
INE002A01018,4,
```

| You write                      | Looked up as   |
|--------------------------------|----------------|
| `RELIANCE`, `NSE:RELIANCE`, `RELIANCE-EQ` | `RELIANCE.NS` (NSE) |
| `BSE:500325`, `500325`         | `500325.BO` (BSE) |
| `INE002A01018` (ISIN)          | NSE symbol from NSE's equity and ETF lists, else Yahoo search |

### Several demat accounts

Each statement is tied to its account (DP / BO ID or client code). Uploading a statement replaces **only that account's**
holdings, so you can load every family account and switch between them, or view them combined, with the account picker in the
header. A newer statement for the same account updates quantities and keeps the buy prices you typed in.

### Buy prices

Depository statements don't include what you paid. Type it into the **Avg cost** box in the table and press Enter, which moves
you to the next row. Without a buy price a holding still counts towards the current value and today's change, but not towards P&L.

If a stock has no live price (for example unlisted or delisted shares), the price from the statement is used and marked as such.

The portfolio is stored in your browser's localStorage. It is never sent to the server; only the
symbols/ISINs are, so their prices can be fetched.

## What you get

- Current value, invested amount, total P&L and today's P&L, with percentages
- Combined or per-account view across several demat accounts
- Per-stock LTP, day % change, an intraday sparkline, P&L and portfolio weight, in a sortable, filterable table
- Allocation bar
- Auto-refresh every 5s / 15s / 30s / 1m (paused while the tab is hidden), and price-change flashes
- Add, edit and remove holdings by hand; export to CSV; light and dark themes

## How prices work

`server.js` maps ISINs to NSE symbols using NSE's published equity and ETF lists (refreshed every 12 hours), proxies Yahoo Finance's chart API (`/api/quotes?symbols=RELIANCE,TCS`), caches each symbol
for 5 seconds and fetches 8 at a time. NSE/BSE quotes from this source are near real-time, but they can
lag the exchange by a little and are for personal tracking only. The "market open" badge goes by NSE
hours (Mon–Fri 09:15–15:30 IST) and does not know about exchange holidays.
