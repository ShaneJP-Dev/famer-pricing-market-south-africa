# Farm Market Prices (PoC)

Minimal Next.js app that scrapes daily fresh produce prices from South African
fresh produce markets, stores them in SQLite, and renders them with a
price-history chart. Proof of concept for a larger multi-market aggregator.

Markets:

- **Cape Town Market** (`ctmarket`) — [ctmarket.co.za/daily-prices](https://www.ctmarket.co.za/daily-prices/),
  server-rendered wpDataTables table, full list in one fetch. The only market
  wired for straightforward automated fetching.
- **Tshwane Market** (`tshwane`) — [tfpm.tshwane.gov.za](https://tfpm.tshwane.gov.za/ViewDailyStats.aspx),
  ASP.NET WebForms with a three-level drill-down (search → product → item →
  price detail), driven via headless Chromium (Playwright). A raw fetch of the
  *search* works, but the follow-up "Select" postbacks are blocked by the site's
  WAF (HTTP 403), so a real browser is required. Notes: the search matches
  **singular** product names (search "potato", not "potatoes"); the daily data
  is **published once per day** (before that run every search returns "No
  Results"); and because each price needs its own page load, this adapter is
  bounded — it scrapes the primary product per commodity, capped per commodity,
  so a run takes a few minutes. Province is folded into the container field.
- **Joburg Market** (`joburg`) — [joburgmarket.co.za](https://joburgmarket.co.za/jhb-market/dailyprices.php),
  driven via headless Chromium (Playwright) because the site has intermittent
  bot protection (HTTP 409). Loops the 8 commodities and reads each one's
  `containerall=2` drill-down. Publishes Average + Highest price but **no
  Lowest**, so `priceLow` is null for this market.
- **East London / Buffalo City Market** (`eastlondon`) —
  [buffalocity.gov.za/bcmm-freshmarket](https://www.buffalocity.gov.za/bcmm-freshmarket),
  per-product search that POSTs to `prices.php`; results are an add-to-cart
  listing rather than a table.
- **Durban Market** (`durban`) — [durbanmarkets.durban.gov.za](https://durbanmarkets.durban.gov.za/),
  a plain fetch: the landing page renders the full daily table (all commodities,
  ~800 rows) server-side, so one request gets everything. Includes a Province
  column, which is folded into the container field to keep same-pack rows from
  different provinces distinct.

**⚠ Local / test use only for everything except Cape Town.** Joburg blocks
bots; Tshwane's WAF blocks scripted postbacks; East London exposes an
unauthenticated endpoint. (Durban has no robots.txt at all — it 404s — so
nothing is disallowed, but it's kept in the same test-only bucket.) None of
these are wired to a scheduler, and they should not be. Each adapter is
isolated in its own file, so one market failing (or its site changing) doesn't
affect the others — the API returns per-market results.

Observed on 2026-07-06: Cape Town, Joburg, Durban and Tshwane return real data.
East London answers "no results" to every query (its product database appears
empty right now), so that adapter reports a clear error rather than inventing
rows. Note Tshwane's data is published once per day — before that daily run,
its search returns "No Results" for everything.

## Stack

- **Next.js 15** (App Router) + TypeScript
- **SQLite** via Node's built-in `node:sqlite` module — no native build step,
  no ORM. Requires **Node.js 22.5+** (tested on Node 24).
- **cheerio** for HTML parsing, **recharts** for the chart
- **Playwright** (headless Chromium) for the Joburg adapter only. After
  `npm install`, run `npx playwright install chromium` once to fetch the
  browser binary.

The `dev`/`start` scripts set `NODE_USE_SYSTEM_CA=1` (via cross-env): the
Tshwane site serves an incomplete TLS certificate chain, and Node's bundled
CA store can't verify it without help from the OS certificate store.

## Run it

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. On first run the database is empty — click
**Run first scrape** on the page, or trigger it manually:

## Trigger a scrape manually

```bash
# while the dev server is running:
curl -X POST http://localhost:3000/api/scrape                     # all markets
curl -X POST "http://localhost:3000/api/scrape?market=ctmarket"   # one market
# markets: ctmarket | tshwane | joburg | eastlondon | durban
# or: npm run scrape
# GET works too, so you can just open it in a browser:
#   http://localhost:3000/api/scrape
```

Joburg and Tshwane launch a headless browser; Joburg takes ~30–60s and Tshwane
a few minutes (it visits one page per price), so an "all markets" run is slow.

Response (one entry per market; `ok` at the top level is true if at least one
market succeeded):

```json
{ "ok": true, "results": [
  { "ok": true, "market": "Cape Town Market", "date": "2026-07-06",
    "rowsParsed": 603, "inserted": 603, "updated": 0 },
  { "ok": true, "market": "Tshwane Market", "date": "2026-07-06",
    "rowsParsed": 94, "inserted": 94, "updated": 0 },
  { "ok": false, "market": "East London Market",
    "error": "East London Market: no rows for any search term (...)" }
] }
```

Scraping is **idempotent** — re-running for the same day updates the existing
rows (the market re-publishes figures during the day) instead of duplicating
them. Uniqueness is per
`(product, market, date, container, grade, count, mass)`: one product trades
in several pack sizes and grades on the same day; the market's COUNT column is
a fruit-count-per-container size designation (e.g. 120- vs 135-count apples),
not sales volume; and some container names (e.g. "BAG / POCKET") come in
several masses — so all of these distinguish rows.

The database lives at `data/farm-market.db` (git-ignored). Delete the file to
start fresh; the schema is recreated automatically.

## Project layout

```
lib/
  scrapers/
    types.ts        # MarketScraper contract — market-agnostic
    ctmarket.ts     # Cape Town Market (plain fetch + HTML table parse)
    tshwane.ts      # Tshwane Market (Playwright WebForms drill-down)
    joburg.ts       # Joburg Market (Playwright headless Chromium)
    eastlondon.ts   # East London / BCMM (POST prices.php per product)
    durban.ts       # Durban Market (plain fetch of server-rendered table)
    index.ts        # scraper registry, keyed by market
  db.ts             # SQLite connection + schema
  store.ts          # idempotent persistence of a ScrapeResult
  queries.ts        # read queries used by the page + history API
app/
  api/scrape/       # POST/GET /api/scrape[?market=<key>]
  api/history/      # GET /api/history?productId=N  (chart data, per market)
  page.tsx          # latest prices table (market selector) + history chart
```

Each adapter is self-contained; the API route and UI only touch the shared
`MarketScraper` / `ScrapeResult` types, never a market's specifics.

## Adding another market

1. Create `lib/scrapers/<market>.ts` implementing the `MarketScraper`
   interface from `lib/scrapers/types.ts` (fetch the source, return a
   `ScrapeResult` with an ISO date and normalized rows).
2. Register it in `lib/scrapers/index.ts`.
3. Trigger with `POST /api/scrape?market=<key>`. Storage, dedup, and the UI
   are already market-agnostic.

## Schema

- `products (id, name UNIQUE, category)`
- `price_snapshots (id, product_id, market, date, container_type, mass, grade,
  units_sold, price_low, price_high, price_avg, scraped_at)`
  with a unique index on `(product_id, market, date, container_type, grade,
  COALESCE(units_sold, -1), COALESCE(mass, -1))`

## Out of scope (for now)

Auth, deployment, scheduling. To collect history, run `/api/scrape` once per
trading day — a cron/scheduler can be added later.
