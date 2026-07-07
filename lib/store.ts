import { getDb } from "./db";
import type { ScrapeResult } from "./scrapers/types";

export interface StoreStats {
  market: string;
  date: string;
  rowsParsed: number;
  inserted: number;
  updated: number;
}

/**
 * Persist a scrape result. Idempotent: re-running for the same market+date
 * updates the existing rows (prices can be re-published during the day)
 * instead of inserting duplicates. Uniqueness is per
 * (product, market, date, container, grade, count, mass) — see the
 * uq_snapshots index in db.ts for why count and mass are included.
 */
export function storeScrapeResult(result: ScrapeResult): StoreStats {
  const db = getDb();

  const countBefore = (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM price_snapshots WHERE market = ? AND date = ?"
      )
      .get(result.market, result.date) as { c: number }
  ).c;

  const upsertProduct = db.prepare(
    `INSERT INTO products (name, category) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET category = COALESCE(excluded.category, category)
     RETURNING id`
  );

  const upsertSnapshot = db.prepare(
    `INSERT INTO price_snapshots
       (product_id, market, date, container_type, mass, grade,
        units_sold, price_low, price_high, price_avg, scraped_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product_id, market, date, container_type, grade,
                 COALESCE(units_sold, -1), COALESCE(mass, -1)) DO UPDATE SET
       price_low  = excluded.price_low,
       price_high = excluded.price_high,
       price_avg  = excluded.price_avg,
       scraped_at = excluded.scraped_at`
  );

  const scrapedAt = new Date().toISOString();

  db.exec("BEGIN");
  try {
    for (const row of result.rows) {
      const product = upsertProduct.get(
        row.productName,
        row.category ?? null
      ) as { id: number };
      upsertSnapshot.run(
        product.id,
        result.market,
        result.date,
        row.containerType,
        row.mass,
        row.grade,
        row.unitsSold,
        row.priceLow,
        row.priceHigh,
        row.priceAvg,
        scrapedAt
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const countAfter = (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM price_snapshots WHERE market = ? AND date = ?"
      )
      .get(result.market, result.date) as { c: number }
  ).c;

  const inserted = countAfter - countBefore;
  return {
    market: result.market,
    date: result.date,
    rowsParsed: result.rows.length,
    inserted,
    updated: result.rows.length - inserted,
  };
}
