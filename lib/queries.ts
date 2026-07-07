import { getDb } from "./db";

export interface SnapshotRow {
  id: number;
  productId: number;
  productName: string;
  market: string;
  date: string;
  containerType: string;
  mass: number | null;
  grade: string;
  unitsSold: number | null;
  priceLow: number | null;
  priceHigh: number | null;
  priceAvg: number | null;
}

export interface ProductOption {
  id: number;
  name: string;
  snapshotCount: number;
}

export interface HistoryPoint {
  market: string;
  date: string;
  priceLow: number | null;
  priceHigh: number | null;
  priceAvg: number | null;
}

export interface MarketInfo {
  market: string;
  latestDate: string;
}

/**
 * node:sqlite returns rows as null-prototype objects, which Next.js refuses
 * to pass from server to client components — copy them into plain objects.
 */
function plain<T>(rows: unknown[]): T[] {
  return rows.map((r) => ({ ...(r as object) })) as T[];
}

/** Markets present in the data, each with its most recent trading date. */
export function getMarkets(): MarketInfo[] {
  const rows = getDb()
    .prepare(
      `SELECT market, MAX(date) AS latestDate
       FROM price_snapshots
       GROUP BY market
       ORDER BY market`
    )
    .all();
  return plain<MarketInfo>(rows);
}

/**
 * The latest day's rows for every market (each market's own most recent
 * date — markets don't necessarily publish on the same day).
 */
export function getLatestSnapshots(): SnapshotRow[] {
  const rows = getDb()
    .prepare(
      `SELECT s.id, s.product_id AS productId, p.name AS productName,
              s.market, s.date, s.container_type AS containerType, s.mass,
              s.grade, s.units_sold AS unitsSold, s.price_low AS priceLow,
              s.price_high AS priceHigh, s.price_avg AS priceAvg
       FROM price_snapshots s
       JOIN products p ON p.id = s.product_id
       JOIN (SELECT market, MAX(date) AS d FROM price_snapshots GROUP BY market) latest
         ON latest.market = s.market AND latest.d = s.date
       ORDER BY p.name, s.market, s.container_type, s.grade`
    )
    .all();
  return plain<SnapshotRow>(rows);
}

export function getProducts(): ProductOption[] {
  const rows = getDb()
    .prepare(
      `SELECT p.id, p.name, COUNT(s.id) AS snapshotCount
       FROM products p
       JOIN price_snapshots s ON s.product_id = p.id
       GROUP BY p.id
       ORDER BY p.name`
    )
    .all();
  return plain<ProductOption>(rows);
}

/**
 * Price history for one product: one point per market per trading date,
 * aggregated across containers/grades (min of lows, max of highs, mean of
 * averages). The client splits the series by market.
 */
export function getProductHistory(productId: number): HistoryPoint[] {
  const rows = getDb()
    .prepare(
      `SELECT market, date,
              MIN(price_low)  AS priceLow,
              MAX(price_high) AS priceHigh,
              ROUND(AVG(price_avg), 2) AS priceAvg
       FROM price_snapshots
       WHERE product_id = ?
       GROUP BY market, date
       ORDER BY date, market`
    )
    .all(productId);
  return plain<HistoryPoint>(rows);
}
