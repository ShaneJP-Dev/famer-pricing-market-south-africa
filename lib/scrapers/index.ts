import type { MarketScraper } from "./types";
import { ctmarketScraper } from "./ctmarket";
import { tshwaneScraper } from "./tshwane";
import { joburgScraper } from "./joburg";
import { eastlondonScraper } from "./eastlondon";
import { durbanScraper } from "./durban";

/**
 * Registry of available market scrapers, keyed by API name.
 *
 * ⚠ Every market except ctmarket is LOCAL / TEST USE ONLY — Joburg blocks bots,
 * Tshwane's and Durban's robots.txt disallow automated access, and East London
 * exposes an unauthenticated endpoint. None are wired to a scheduler; see each
 * adapter's header comment.
 */
export const scrapers: Record<string, MarketScraper> = {
  [ctmarketScraper.key]: ctmarketScraper,
  [tshwaneScraper.key]: tshwaneScraper,
  [joburgScraper.key]: joburgScraper,
  [eastlondonScraper.key]: eastlondonScraper,
  [durbanScraper.key]: durbanScraper,
};

export type { MarketScraper, ScrapeResult, ScrapedPriceRow } from "./types";
