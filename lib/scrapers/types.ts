/**
 * Shared contract for market scrapers. Each market gets its own module that
 * implements MarketScraper; the API route and UI only ever deal with these
 * types, never with market-specific details.
 */

export interface ScrapedPriceRow {
  /** Full product name as listed by the market, e.g. "APPLE GOLDEN DELICIOUS" */
  productName: string;
  /** Optional category if the market provides one */
  category?: string;
  /** Container / pack type, e.g. "Bag (13.5 kg)" */
  containerType: string;
  /** Mass or size in kg, if published */
  mass: number | null;
  /** Grade, e.g. "1M" — empty string when not graded */
  grade: string;
  /**
   * The market's COUNT column. At CT Market this is the fruit count per
   * container (a size designation, e.g. 120-count apples), not sales volume,
   * and distinguishes otherwise-identical rows.
   */
  unitsSold: number | null;
  priceLow: number | null;
  priceHigh: number | null;
  priceAvg: number | null;
}

export interface ScrapeResult {
  /** Display name of the market, stored on each snapshot */
  market: string;
  /** The trading date shown on the page, ISO format YYYY-MM-DD */
  date: string;
  rows: ScrapedPriceRow[];
  /** Non-fatal issues encountered while scraping (e.g. a search term that
   *  returned nothing) — surfaced in the API response for manual runs. */
  warnings?: string[];
}

export interface MarketScraper {
  /** Registry key used in the API, e.g. "ctmarket" */
  key: string;
  /** Display name of the market */
  marketName: string;
  scrape(): Promise<ScrapeResult>;
}
