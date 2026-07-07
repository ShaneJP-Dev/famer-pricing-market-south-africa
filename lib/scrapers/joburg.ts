import { chromium, type Browser, type Page } from "playwright";
import * as cheerio from "cheerio";
import type { MarketScraper, ScrapedPriceRow, ScrapeResult } from "./types";

/**
 * Joburg Market (joburgmarket.co.za).
 *
 * ⚠ LOCAL / TEST USE ONLY. The site has bot protection (a plain fetch returns
 * HTTP 409 intermittently), so this adapter drives a headless Chromium via
 * Playwright rather than fetching. Do not wire it into a scheduler.
 *
 * The daily-prices landing page only shows a per-commodity *summary* (total
 * value / qty / kg). The actual price breakdown — container, unit mass, grade
 * and average/highest price — lives in the drill-down view
 *   dailyprices.php?commodity=<id>&containerall=2
 * which lists one row per (container, variety/class/size/count/colour). We
 * resolve the 8 target commodity ids from the dropdown on the landing page,
 * then visit each drill-down and keep only rows that actually traded.
 *
 * Note: the site publishes an Average and a Highest price but no Lowest, so
 * priceLow is always null for this market.
 */

const BASE = "https://joburgmarket.co.za/jhb-market/dailyprices.php";
const MARKET_NAME = "Joburg Market";
const NAV_TIMEOUT_MS = 45000;
const REQUEST_DELAY_MS = 800;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Commodity names to pull (matched case-insensitively against the dropdown). */
const TARGET_COMMODITIES = [
  "TOMATOES",
  "POTATOES",
  "ONIONS",
  "CABBAGE",
  "CARROTS",
  "BANANAS",
  "APPLES",
  "ORANGES",
];

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
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

/** "This information is for 6 July 2026" → "2026-07-06" */
function parsePageDate(html: string): string {
  const m = html.match(
    /(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i
  );
  if (!m) {
    throw new Error(
      `${MARKET_NAME}: could not find the trading date on the page — layout may have changed`
    );
  }
  const [, day, monthName, year] = m;
  return `${year}-${MONTHS[monthName.toLowerCase()]}-${day.padStart(2, "0")}`;
}

/** Map "value=ID">NAME" dropdown options to a name→id lookup. */
function parseCommodityMap(html: string): Map<string, string> {
  const $ = cheerio.load(html);
  const map = new Map<string, string>();
  $("select[name='commodity'] option").each((_, opt) => {
    const id = ($(opt).attr("value") ?? "").trim();
    const name = $(opt).text().trim();
    if (id && name) map.set(name.toUpperCase(), id);
  });
  return map;
}

interface JoburgColumns {
  container?: number;
  mass?: number;
  combination?: number;
  qtySold?: number;
  average?: number;
  highest?: number;
}

/**
 * Parse a containerall=2 drill-down page for one commodity into rows.
 * Columns are matched by header text so a layout reshuffle doesn't silently
 * misalign values.
 */
export function parseContainerStats(
  html: string,
  productName: string
): ScrapedPriceRow[] {
  const $ = cheerio.load(html);
  const rows: ScrapedPriceRow[] = [];

  $("table.alltable").each((_, table) => {
    const $table = $(table);
    const headers = $table
      .find("thead th, tr:first-child th")
      .map((_, th) => $(th).text().trim().toLowerCase())
      .get();
    if (headers.length === 0) return;

    const cols: JoburgColumns = {};
    headers.forEach((h, i) => {
      if (cols.container === undefined && /container/.test(h)) cols.container = i;
      else if (cols.mass === undefined && /unit mass|mass/.test(h)) cols.mass = i;
      else if (cols.combination === undefined && /combination|variety|class/.test(h)) cols.combination = i;
      else if (cols.qtySold === undefined && /qty sold/.test(h)) cols.qtySold = i;
      else if (cols.average === undefined && /^average$/.test(h)) cols.average = i;
      else if (cols.highest === undefined && /^highest price$/.test(h)) cols.highest = i;
    });
    // Not the price-detail grid (e.g. the summary table) — skip it.
    if (cols.container === undefined || cols.average === undefined) return;

    $table.find("tr").each((_, tr) => {
      const cells = $(tr)
        .find("td")
        .map((_, td) => $(td).text().trim())
        .get();
      if (cells.length < headers.length) return;

      const cell = (i: number | undefined) => (i === undefined ? "" : cells[i] ?? "");
      const qtySold = parseNumber(cell(cols.qtySold));
      // Keep only rows that actually traded — the grid lists every possible
      // variety/pack combination, most with zero sales.
      if (!qtySold || qtySold <= 0) return;

      rows.push({
        productName,
        containerType: cell(cols.container),
        mass: parseNumber(cell(cols.mass)),
        grade: cell(cols.combination),
        unitsSold: qtySold,
        priceLow: null, // not published by this market
        priceHigh: parseNumber(cell(cols.highest)),
        priceAvg: parseNumber(cell(cols.average)),
      });
    });
  });

  return rows;
}

async function loadHtml(page: Page, url: string): Promise<string> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  // The price table is server-rendered; wait for it (or the date banner) so we
  // don't read a half-built DOM.
  await page
    .waitForSelector("table.alltable", { timeout: NAV_TIMEOUT_MS })
    .catch(() => {});
  return page.content();
}

export const joburgScraper: MarketScraper = {
  key: "joburg",
  marketName: MARKET_NAME,
  async scrape(): Promise<ScrapeResult> {
    const warnings: string[] = [];
    let browser: Browser | null = null;

    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ userAgent: USER_AGENT });

      const landingHtml = await loadHtml(page, BASE);
      const date = parsePageDate(landingHtml);
      const commodityMap = parseCommodityMap(landingHtml);
      if (commodityMap.size === 0) {
        throw new Error(
          `${MARKET_NAME}: commodity dropdown was empty — the site may be ` +
            `blocking automated access (bot protection)`
        );
      }

      const merged = new Map<string, ScrapedPriceRow>();
      for (const [i, name] of TARGET_COMMODITIES.entries()) {
        const id = commodityMap.get(name);
        if (!id) {
          warnings.push(`"${name}": not offered by this market today`);
          continue;
        }
        if (i > 0) await sleep(REQUEST_DELAY_MS);
        try {
          const url = `${BASE}?commodity=${encodeURIComponent(id)}&containerall=2`;
          const html = await loadHtml(page, url);
          const rows = parseContainerStats(html, name);
          if (rows.length === 0) {
            warnings.push(`"${name}": no traded rows in the price grid`);
            continue;
          }
          for (const row of rows) {
            const key = [
              row.productName, row.containerType, row.grade,
              row.unitsSold ?? "", row.mass ?? "",
            ].join("|");
            merged.set(key, row);
          }
        } catch (err) {
          warnings.push(
            `"${name}": ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      if (merged.size === 0) {
        throw new Error(
          `${MARKET_NAME}: no rows for any commodity (${warnings.join("; ")})`
        );
      }

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
