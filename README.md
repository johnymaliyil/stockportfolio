# Stock Portfolio Tracker (NSE / BSE)

Upload your holdings and track them with live Indian market prices.

## Use it on your phone (PWA)

The app is a Progressive Web App: once it's hosted on an `https://` address you can install it on your home screen,
and it opens full-screen like a normal app. It shows the last prices it fetched when you're offline.

### 1. Host it (free)

It needs a small server that fetches the prices (browsers aren't allowed to call the price source directly). Either:

- **Vercel** (recommended, no cold starts): sign in at vercel.com with GitHub → *Add New… → Project* → pick this repo →
  *Deploy*. There's nothing to configure; `vercel.json` and `api/quotes.js` are already set up.
- **Render**: render.com → *New → Web Service* → pick this repo → Build command `npm install`, Start command `npm start`, and choose the free instance.
  The free tier goes to sleep when idle, so the first open after a while takes ~1 minute.

You'll get an address like `https://stockportfolio-xyz.vercel.app`.

### 2. Install it

- **Android (Chrome):** open the address, then tap *Install* in the banner (or ⋮ → *Install app*).
- **iPhone (Safari):** open the address, tap *Share* → *Add to Home Screen*.

### 3. Load your holdings

Open the app and upload your statement PDFs or Excel reports, or a CSV (see below). Each phone/browser keeps its own
copy of the portfolio (in local storage, nothing is stored on the server), so to move your data and typed-in buy prices
between devices use **More → Export CSV (backup)** on one and upload that file on the other.

> Don't commit your statements or portfolio files to this repository — it is public. `.gitignore` already excludes
> PDFs, Excel files and `my-portfolio*.csv`.

## Run it on a computer

Requires Node.js 18 or newer. There are no packages to install.

```bash
npm start          # http://localhost:3000, live prices
npm run demo       # simulated prices, works offline
PORT=8080 npm start
```

## What you can upload

Tap **⬆ Upload** and pick any file. The format is worked out from the file's contents, so a missing or wrong
extension doesn't matter:

- **DP holding statement PDFs** from NSDL participants (e.g. Geojit) and CDSL participants (e.g. IndusInd Securities).
  Other PDFs that contain a holdings table (symbol, quantity, …) are read as a table.
- **Excel**: `.xls`, `.xlsx`, `.xlsm`, `.ods`, including the "Excel" downloads some brokers make that are really HTML tables.
  Letterhead rows above the table are skipped, and client code, name and report date are read from them (e.g. SMC Global reports).
- **CSV / TSV / TXT**, separated by commas, tabs, semicolons or `|`, in UTF-8 or UTF-16. This includes backups exported from this app.
- Photos or scans can't be read. Download the statement as PDF, Excel or CSV instead.

The file needs a symbol or ISIN column and a quantity column. An average buy price column is optional.
Column names are matched loosely (`Symbol`/`Instrument`/`Scrip`/`ISIN`, `Qty`/`Quantity`/`Total Qty`, `Avg. cost`/`Buy Price`, …),
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

Each statement is tied to its account (DP / BO ID or client code) and named after the broker and holder, e.g. *Geojit · Ravi*.
A stock held in two accounts is shown once per account, with the broker in its name. Uploading a statement replaces **only that account's**
holdings, so you can load every family account and switch between them, or view them combined, with the account picker in the
header. A newer statement for the same account updates quantities and keeps the buy prices you typed in.

### Backup / restore

**More → Export CSV (backup)** writes every holding with its account, ISIN, quantity, buy price and latest price.
Uploading that file restores it exactly, accounts included. It also works as a template: fill in the *Avg Price* column
in Excel or Google Sheets and upload it to set all buy prices at once.

### Buy prices

Depository statements don't include what you paid. Every stock has a **Buy price** box, in the table and on the phone cards. Type a price, or change or clear one, and press Enter.
Enter saves it and moves you to the next stock. Without a buy price a holding still counts towards the current value and today's change, but not towards P&L.

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

`lib/quotes.js` (used by `local-server.js` locally and `api/quotes.js` on Vercel) maps ISINs to NSE symbols using NSE's published equity and ETF lists (refreshed every 12 hours), proxies Yahoo Finance's chart API (`/api/quotes?symbols=RELIANCE,TCS`), caches each symbol
for 5 seconds and fetches 8 at a time. NSE/BSE quotes from this source are near real-time, but they can
lag the exchange by a little and are for personal tracking only. The "market open" badge goes by NSE
hours (Mon–Fri 09:15–15:30 IST) and does not know about exchange holidays.
