import * as cheerio from "cheerio";
import type { MarketScraper, ScrapedPriceRow, ScrapeResult } from "./types";

/**
 * East London / Buffalo City Metro Fresh Produce Market
 * (buffalocity.gov.za/bcmm-freshmarket).
 *
 * ⚠ LOCAL / TEST USE ONLY. Prove-the-pattern adapter; do not schedule.
 *
 * The landing page's price table is not in the initial HTML — a "search by
 * product" form POSTs to prices.php and the results come back as an
 * add-to-cart product listing. The underlying endpoint is:
 *   POST https://www.buffalocity.gov.za/bcmm-freshmarket/prices.php
 *   body: desc_search=<term>&search=
 * Each result product is a set of hidden inputs keyed by a numeric id:
 *   #name<id>, #product_description<id>, #code<id>, #price<id>
 * so we read those rather than a <table>. Like Tshwane this is a per-product
 * search, so we loop the same commodity list and merge.
 *
 * Note (observed 2026-07-06): the product database is currently empty — every
 * search returns a byte-identical page with a JS "empty results" alert — so a
 * populated listing could not be observed. The parser therefore keys off the
 * documented input-id scheme and reports "no results" cleanly when empty.
 * The site publishes a single price per product, so priceLow/High/Avg are all
 * set to that price.
 */

const ENDPOINT = "https://www.buffalocity.gov.za/bcmm-freshmarket/prices.php";
const MARKET_NAME = "East London Market";
const REQUEST_DELAY_MS = 1200;

const SEARCH_TERMS = [
  "tomato",
  "potato",
  "onion",
  "cabbage",
  "carrot",
  "banana",
  "apple",
  "orange",
];

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseNumber(text: string): number | null {
  const cleaned = text.replace(/[^\d.-]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a prices.php response into rows. Products are hidden inputs whose ids
 * share a numeric suffix: #name123, #product_description123, #code123,
 * #price123. We pivot on the #name<id> inputs.
 */
export function parsePriceListing(html: string): ScrapedPriceRow[] {
  const $ = cheerio.load(html);
  const rows: ScrapedPriceRow[] = [];

  $("input[id^='name']").each((_, el) => {
    const id = ($(el).attr("id") ?? "").replace(/^name/, "");
    if (!id) return;
    const val = (sel: string) =>
      ($(sel).attr("value") ?? $(sel).val() ?? "").toString().trim();

    const name = val(`#name${id}`);
    if (!name) return;
    const description = val(`#product_description${id}`);
    const price = parseNumber(val(`#price${id}`));

    rows.push({
      productName: name.toUpperCase(),
      // Description carries the grade/container detail for this market.
      containerType: description,
      mass: null,
      grade: "",
      unitsSold: null,
      // Single published price → same low/high/avg.
      priceLow: price,
      priceHigh: price,
      priceAvg: price,
    });
  });

  return rows;
}

async function searchTerm(term: string): Promise<string> {
  const body = new URLSearchParams({ desc_search: term, search: "" });
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`${MARKET_NAME}: POST for "${term}" failed with HTTP ${res.status}`);
  }
  return res.text();
}

export const eastlondonScraper: MarketScraper = {
  key: "eastlondon",
  marketName: MARKET_NAME,
  async scrape(): Promise<ScrapeResult> {
    const warnings: string[] = [];
    const merged = new Map<string, ScrapedPriceRow>();
    // The site shows no trading date on the results, so this market is stamped
    // with the day the scrape ran.
    const date = new Date().toISOString().slice(0, 10);

    for (const [i, term] of SEARCH_TERMS.entries()) {
      if (i > 0) await sleep(REQUEST_DELAY_MS);
      try {
        const html = await searchTerm(term);
        if (/empty results/i.test(html)) {
          warnings.push(`"${term}": site reported no results`);
          continue;
        }
        const rows = parsePriceListing(html);
        if (rows.length === 0) {
          warnings.push(
            `"${term}": response had no recognizable product listing — layout may have changed`
          );
          continue;
        }
        for (const row of rows) {
          const key = [row.productName, row.containerType].join("|");
          merged.set(key, row);
        }
      } catch (err) {
        warnings.push(
          `"${term}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    if (merged.size === 0) {
      throw new Error(
        `${MARKET_NAME}: no rows for any search term (${warnings.join("; ")}). ` +
          `The market's product database may currently be empty.`
      );
    }

    return {
      market: MARKET_NAME,
      date,
      rows: [...merged.values()],
      warnings: warnings.length ? warnings : undefined,
    };
  },
};
