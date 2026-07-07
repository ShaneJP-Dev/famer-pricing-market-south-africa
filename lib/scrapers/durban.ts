import * as cheerio from "cheerio";
import type { MarketScraper, ScrapedPriceRow, ScrapeResult } from "./types";

/**
 * Durban Fresh Produce Market (durbanmarkets.durban.gov.za).
 *
 * ⚠ LOCAL / TEST USE ONLY (consistent with the other non-ctmarket adapters).
 * The site has no robots.txt (it 404s), so nothing is disallowed, but this
 * stays a manual/test adapter and is not wired to a scheduler.
 *
 * The landing page renders the full daily table server-side — every commodity
 * in one <table class="TFtable">, so a single plain fetch gets everything (no
 * search, no pagination, no CSV export needed).
 *
 * Columns: Commodities | Weight (Kg) | Size Grade | Container | Province |
 *          Low Price | High Price | Average Price | Sales Total |
 *          Total Qty Sold | Total Kg Sold | Stock On Hand | Date
 * Province is folded into the container field because the same commodity/pack
 * trades from several provinces on the same day — keeping it distinguishes
 * otherwise-identical rows.
 */

const URL = "https://durbanmarkets.durban.gov.za/";
const MARKET_NAME = "Durban Market";

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function parseNumber(text: string): number | null {
  const cleaned = text.replace(/[^\d.-]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** "06/Jul/2026" → "2026-07-06" */
function parseRowDate(text: string): string | null {
  const m = text.trim().match(/(\d{1,2})\/([A-Za-z]{3})[A-Za-z]*\/(\d{4})/);
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  if (!mon) return null;
  return `${m[3]}-${mon}-${m[1].padStart(2, "0")}`;
}

interface DurbanColumns {
  product?: number;
  weight?: number;
  grade?: number;
  container?: number;
  province?: number;
  low?: number;
  high?: number;
  avg?: number;
  qtySold?: number;
  date?: number;
}

function mapColumns(headers: string[]): DurbanColumns | null {
  const cols: DurbanColumns = {};
  headers.forEach((raw, i) => {
    const h = raw.trim().toLowerCase();
    if (cols.product === undefined && /commodit/.test(h)) cols.product = i;
    else if (cols.weight === undefined && /weight|kg/.test(h)) cols.weight = i;
    else if (cols.grade === undefined && /grade/.test(h)) cols.grade = i;
    else if (cols.container === undefined && /container/.test(h)) cols.container = i;
    else if (cols.province === undefined && /province/.test(h)) cols.province = i;
    else if (cols.low === undefined && /low/.test(h)) cols.low = i;
    else if (cols.high === undefined && /high/.test(h)) cols.high = i;
    else if (cols.avg === undefined && /average|avg/.test(h)) cols.avg = i;
    else if (cols.qtySold === undefined && /qty sold/.test(h)) cols.qtySold = i;
    else if (cols.date === undefined && /date/.test(h)) cols.date = i;
  });
  if (cols.product === undefined || cols.avg === undefined) return null;
  return cols;
}

export interface ParsedDurban {
  rows: ScrapedPriceRow[];
  date: string | null;
}

export function parseDailyTable(html: string): ParsedDurban {
  const $ = cheerio.load(html);
  const table = $("table.TFtable").first();
  if (table.length === 0) {
    throw new Error(
      `${MARKET_NAME}: price table (table.TFtable) not found — layout may have changed`
    );
  }

  const trs = table.find("tr").toArray();
  const headerCells = $(trs[0])
    .find("th, td")
    .map((_, c) => $(c).text().trim())
    .get();
  const cols = mapColumns(headerCells);
  if (!cols) {
    throw new Error(
      `${MARKET_NAME}: could not map table columns from header [${headerCells.join(", ")}]`
    );
  }

  const rows: ScrapedPriceRow[] = [];
  let date: string | null = null;
  const cellAt = (cells: string[], i: number | undefined) =>
    i === undefined ? "" : (cells[i] ?? "").trim();

  for (const tr of trs.slice(1)) {
    const cells = $(tr)
      .find("td")
      .map((_, td) => $(td).text().trim())
      .get();
    if (cells.length < headerCells.length) continue;

    const name = cellAt(cells, cols.product);
    if (!name) continue;

    if (date === null) date = parseRowDate(cellAt(cells, cols.date));

    const container = cellAt(cells, cols.container);
    const province = cellAt(cells, cols.province);
    const containerType = [container, province].filter(Boolean).join(" · ");

    rows.push({
      productName: name.toUpperCase(),
      containerType,
      mass: parseNumber(cellAt(cells, cols.weight)),
      grade: cellAt(cells, cols.grade),
      unitsSold: parseNumber(cellAt(cells, cols.qtySold)),
      priceLow: parseNumber(cellAt(cells, cols.low)),
      priceHigh: parseNumber(cellAt(cells, cols.high)),
      priceAvg: parseNumber(cellAt(cells, cols.avg)),
    });
  }

  return { rows, date };
}

export const durbanScraper: MarketScraper = {
  key: "durban",
  marketName: MARKET_NAME,
  async scrape(): Promise<ScrapeResult> {
    const res = await fetch(URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`${MARKET_NAME}: fetch failed with HTTP ${res.status}`);
    }

    const { rows, date } = parseDailyTable(await res.text());
    if (rows.length === 0) {
      throw new Error(`${MARKET_NAME}: no price rows found in the table`);
    }
    if (!date) {
      throw new Error(`${MARKET_NAME}: could not determine the trading date`);
    }

    return { market: MARKET_NAME, date, rows };
  },
};
