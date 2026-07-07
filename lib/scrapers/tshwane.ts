import { chromium, type Browser, type Page } from "playwright";
import * as cheerio from "cheerio";
import type { MarketScraper, ScrapedPriceRow, ScrapeResult } from "./types";

/**
 * Tshwane Fresh Produce Market (tfpm.tshwane.gov.za/ViewDailyStats.aspx).
 *
 * ⚠ LOCAL / TEST USE ONLY. Do not wire into a scheduler.
 *
 * This is a classic ASP.NET WebForms site with a three-level drill-down and a
 * WAF that blocks scripted postbacks (a raw fetch of the *search* works, but
 * the follow-up "Select" postbacks return HTTP 403), so we drive a real
 * headless browser via Playwright instead.
 *
 * Flow per commodity:
 *   1. Type a search term, Submit  → GridView1: matching PRODUCTS, each with a
 *      "Select" link (e.g. "tomato" → TOMATOES, TOMATOES COCKTAIL, …).
 *   2. Select a product           → GridView2: its item types
 *      (description / ID / GRADE / CONTAINER / MASS), each with "Select".
 *   3. Select an item             → a label/value detail card with PRODUCT,
 *      GRADE, CONTAINER, PROVINCE, MASS, LOWEST/HIGHEST/AVERAGE PRICE and
 *      QUANTITY SOLD. Only here are the actual prices exposed.
 *
 * Gotchas learned the hard way:
 *  - The search is case-insensitive but matches product names literally, and
 *    those names are SINGULAR ("POTATO …", "APPLE …", "ORANGE …"). Plural
 *    terms ("potatoes") match nothing — so we search singular stems.
 *  - The daily data is published once per day (the page notes a "Run at" time);
 *    before that run the search returns "No Results" for everything. When that
 *    happens this adapter reports it rather than inventing rows.
 *
 * Because every price needs its own page load, this is deliberately bounded:
 * we drill each product a commodity matches but cap the number of items per
 * commodity (MAX_ITEMS_PER_COMMODITY), which keeps a run to a few minutes.
 * Province is folded into the container field to keep same-grade/same-pack
 * items from different provinces distinct.
 */

const PAGE_URL = "https://tfpm.tshwane.gov.za/ViewDailyStats.aspx";
const MARKET_NAME = "Tshwane Market";
const NAV_TIMEOUT_MS = 30000;
const ITEM_DELAY_MS = 150;
const MAX_ITEMS_PER_COMMODITY = 40;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * Singular stems — product names on this site are singular, and the "Contains"
 * search matches them literally. Override for a targeted run by setting
 * TSHWANE_TERMS to a comma-separated list, e.g. TSHWANE_TERMS="marrow,pumpkin".
 */
const DEFAULT_SEARCH_TERMS = [
  "tomato", "potato", "onion", "cabbage", "carrot", "banana", "apple", "orange",
  "marrow", "pumpkin", "spinach", "lettuce", "pepper", "avocado", "mushroom",
  "brinjal", "cucumber", "gem",
];

const SEARCH_TERMS = process.env.TSHWANE_TERMS
  ? process.env.TSHWANE_TERMS.split(",").map((s) => s.trim()).filter(Boolean)
  : DEFAULT_SEARCH_TERMS;

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
};

const GRID1 = "#ContentPlaceHolder1_GridView1";
const GRID2 = "#ContentPlaceHolder1_GridView2";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseNumber(text: string | undefined): number | null {
  if (text === undefined) return null;
  const cleaned = text.replace(/[^\d.-]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** "…as at 06 July 2026" → "2026-07-06" */
function parsePageDate(html: string): string | null {
  const m = html.match(
    /(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i
  );
  if (!m) return null;
  return `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, "0")}`;
}

/** The level-3 detail card is a set of two-cell (label, value) rows. */
function parseDetail(html: string): Record<string, string> {
  const $ = cheerio.load(html);
  const out: Record<string, string> = {};
  $("tr").each((_, r) => {
    const cells = $(r).find("td");
    if (cells.length !== 2) return;
    const key = $(cells.get(0)).text().trim();
    const input = $(cells.get(1)).find("input");
    const value = input.length
      ? input.attr("value") ?? ""
      : $(cells.get(1)).text();
    if (key) out[key] = value.trim();
  });
  return out;
}

function detailToRow(d: Record<string, string>): ScrapedPriceRow | null {
  const name = (d.PRODUCT ?? "").trim();
  if (!name) return null;
  const container = (d.CONTAINER ?? "").trim();
  const province = (d.PROVINCE ?? "").trim();
  return {
    productName: name.toUpperCase(),
    containerType: [container, province].filter(Boolean).join(" · "),
    mass: parseNumber(d.MASS),
    grade: (d.GRADE ?? "").trim(),
    unitsSold: parseNumber(d["QUANTITY SOLD"]),
    priceLow: parseNumber(d["LOWEST PRICE"]),
    priceHigh: parseNumber(d["HIGHEST PRICE"]),
    priceAvg: parseNumber(d["AVERAGE PRICE"]),
  };
}

async function runSearch(page: Page, term: string): Promise<boolean> {
  await page.goto(PAGE_URL, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
  await page.fill("#ContentPlaceHolder1_txtItem", term);
  await Promise.all([
    page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS }).catch(() => {}),
    page.click("#ContentPlaceHolder1_BtnSubmit"),
  ]);
  // Either the product grid appears, or the page says "No Results".
  const grid = await page
    .waitForSelector(GRID1, { timeout: 8000 })
    .catch(() => null);
  return grid !== null;
}

/** Click the "Select" link in row `rowIndex` of a grid and wait for the nav. */
async function selectRow(page: Page, gridSelector: string, rowIndex: number) {
  await Promise.all([
    page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS }).catch(() => {}),
    page
      .locator(`${gridSelector} tr`)
      .nth(rowIndex + 1)
      .locator("a", { hasText: "Select" })
      .click(),
  ]);
}

export const tshwaneScraper: MarketScraper = {
  key: "tshwane",
  marketName: MARKET_NAME,
  async scrape(): Promise<ScrapeResult> {
    const warnings: string[] = [];
    const merged = new Map<string, ScrapedPriceRow>();
    let date: string | null = null;
    let browser: Browser | null = null;

    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ userAgent: USER_AGENT });

      for (const term of SEARCH_TERMS) {
        try {
          const hasProducts = await runSearch(page, term);
          if (!hasProducts) {
            warnings.push(`"${term}": no products (search returned no results)`);
            continue;
          }
          date = date ?? parsePageDate(await page.content());

          const productCount = await page
            .$$eval(`${GRID1} tr`, (trs) => trs.length - 1)
            .catch(() => 0);

          // Drill every product this commodity matched (e.g. "marrow" →
          // Marrows Dark Green + Light Green), bounded per commodity so a
          // term with many products can't run away.
          let itemsForCommodity = 0;
          for (let p = 0; p < productCount; p++) {
            if (itemsForCommodity >= MAX_ITEMS_PER_COMMODITY) {
              warnings.push(
                `"${term}": stopped at product ${p}/${productCount} (item cap ${MAX_ITEMS_PER_COMMODITY})`
              );
              break;
            }
            // A fresh search restores the product list; select product p from it.
            if (p > 0 && !(await runSearch(page, term))) break;
            await selectRow(page, GRID1, p);
            await page.waitForSelector(GRID2, { timeout: NAV_TIMEOUT_MS });

            const itemCount = await page
              .$$eval(`${GRID2} tr`, (trs) => trs.length - 1)
              .catch(() => 0);

            for (let i = 0; i < itemCount; i++) {
              if (itemsForCommodity >= MAX_ITEMS_PER_COMMODITY) break;
              try {
                await selectRow(page, GRID2, i);
                await page
                  .waitForFunction(
                    () => /AVERAGE PRICE/.test(document.body.innerText),
                    { timeout: NAV_TIMEOUT_MS }
                  )
                  .catch(() => {});
                const row = detailToRow(parseDetail(await page.content()));
                if (row) {
                  const key = [
                    row.productName, row.containerType, row.grade,
                    row.unitsSold ?? "", row.mass ?? "",
                  ].join("|");
                  merged.set(key, row);
                  itemsForCommodity++;
                }
                // Return to the item grid to select the next one.
                await page.goBack({ waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS }).catch(() => {});
                if (!(await page.$(GRID2))) {
                  warnings.push(`"${term}" product ${p}: lost item list after item ${i}`);
                  break;
                }
                await sleep(ITEM_DELAY_MS);
              } catch (err) {
                warnings.push(
                  `"${term}" product ${p} item ${i}: ${err instanceof Error ? err.message : String(err)}`
                );
                break;
              }
            }
          }
        } catch (err) {
          warnings.push(
            `"${term}": ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      if (merged.size === 0) {
        throw new Error(
          `${MARKET_NAME}: no rows scraped (${warnings.join("; ")}). ` +
            `The daily data may not be published yet — it is loaded once per day.`
        );
      }
      if (!date) date = new Date().toISOString().slice(0, 10);

      return {
        market: MARKET_NAME,
        date,
        rows: [...merged.values()],
        warnings: warnings.length ? warnings : undefined,
      };
    } finally {
      await browser?.close().catch(() => {});
    }
  },
};

// Exported for unit testing the pure parsing logic.
export { parseDetail, detailToRow, parsePageDate };
