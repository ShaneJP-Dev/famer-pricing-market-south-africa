import * as cheerio from "cheerio";
import type { MarketScraper, ScrapedPriceRow, ScrapeResult } from "./types";

const URL = "https://www.ctmarket.co.za/daily-prices/";
const MARKET_NAME = "Cape Town Market";

/**
 * The daily-prices page is WordPress + wpDataTables, but the table rows are
 * rendered server-side, so a plain fetch + HTML parse is enough.
 *
 * Columns: ITEM (code) | DESC (name) | CONTAINER | MASS | GRADE | COUNT |
 *          LOW PRICE | HIGH PRICE | AVERAGE PRICE
 * The trading date appears above the table as
 * "Daily Statistical Prices For DD/MM/YYYY Run at HH:MM:SS".
 */

function parseNumber(text: string): number | null {
  const cleaned = text.replace(/[^\d.-]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parsePageDate(html: string): string {
  const match = html.match(/Prices\s+For\s+(\d{2})\/(\d{2})\/(\d{4})/i);
  if (!match) {
    throw new Error(
      `${MARKET_NAME}: could not find the trading date on the page — layout may have changed`
    );
  }
  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
}

export function parseDailyPrices(html: string): ScrapeResult {
  const $ = cheerio.load(html);
  const date = parsePageDate(html);

  const rows: ScrapedPriceRow[] = [];
  $("table.wpDataTable tbody tr").each((_, tr) => {
    const cells = $(tr)
      .find("td")
      .map((_, td) => $(td).text().trim())
      .get();
    if (cells.length < 9) return;

    const [, name, container, mass, grade, count, low, high, avg] = cells;
    if (!name) return;

    rows.push({
      productName: name,
      containerType: container,
      mass: parseNumber(mass),
      grade,
      unitsSold: parseNumber(count),
      priceLow: parseNumber(low),
      priceHigh: parseNumber(high),
      priceAvg: parseNumber(avg),
    });
  });

  if (rows.length === 0) {
    throw new Error(
      `${MARKET_NAME}: no price rows found — table markup may have changed`
    );
  }

  return { market: MARKET_NAME, date, rows };
}

export const ctmarketScraper: MarketScraper = {
  key: "ctmarket",
  marketName: MARKET_NAME,
  async scrape() {
    const res = await fetch(URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) farm-market-poc/0.1",
      },
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`${MARKET_NAME}: fetch failed with HTTP ${res.status}`);
    }
    return parseDailyPrices(await res.text());
  },
};
