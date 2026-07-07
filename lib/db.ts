import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const PROJECT_DB_DIR = path.join(process.cwd(), "data");
const PROJECT_DB_PATH = path.join(PROJECT_DB_DIR, "farm-market.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL UNIQUE,
  category TEXT
);

CREATE TABLE IF NOT EXISTS price_snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id     INTEGER NOT NULL REFERENCES products(id),
  market         TEXT NOT NULL,
  date           TEXT NOT NULL,
  container_type TEXT NOT NULL DEFAULT '',
  mass           REAL,
  grade          TEXT NOT NULL DEFAULT '',
  units_sold     INTEGER,
  price_low      REAL,
  price_high     REAL,
  price_avg      REAL,
  scraped_at     TEXT NOT NULL
);

-- One row per product variant per market per day. units_sold and mass are
-- part of the key: at CT Market the COUNT column is the fruit count per
-- container (a size designation, e.g. 120- vs 135-count apples), and some
-- container names (e.g. "BAG / POCKET") come in several masses (3/7/10 kg),
-- so rows can share product+container+grade and still be distinct listings.
-- COALESCE maps NULL to a sentinel so re-scrapes don't duplicate such rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_snapshots
  ON price_snapshots (product_id, market, date, container_type, grade,
                      COALESCE(units_sold, -1), COALESCE(mass, -1));

CREATE INDEX IF NOT EXISTS idx_snapshots_product_date
  ON price_snapshots (product_id, date);
CREATE INDEX IF NOT EXISTS idx_snapshots_date
  ON price_snapshots (date);
`;

function open(): DatabaseSync {
  const dbPath = resolveDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  // WAL is ideal locally; if unavailable in some runtimes, continue with
  // SQLite defaults so reads still work.
  try {
    db.exec("PRAGMA journal_mode = WAL;");
  } catch {
    db.exec("PRAGMA journal_mode = DELETE;");
  }

  db.exec(SCHEMA);
  return db;
}

function resolveDbPath(): string {
  if (!process.env.VERCEL) {
    return PROJECT_DB_PATH;
  }

  // Vercel functions run with ephemeral writable storage under /tmp.
  const tmpDir = path.join("/tmp", "farm-market");
  const tmpDbPath = path.join(tmpDir, "farm-market.db");
  fs.mkdirSync(tmpDir, { recursive: true });

  // Seed the ephemeral DB from the committed project DB when available.
  if (!fs.existsSync(tmpDbPath) && fs.existsSync(PROJECT_DB_PATH)) {
    fs.copyFileSync(PROJECT_DB_PATH, tmpDbPath);
  }

  return tmpDbPath;
}

// Reuse one connection across dev-server hot reloads
const globalForDb = globalThis as unknown as { __farmMarketDb?: DatabaseSync };

export function getDb(): DatabaseSync {
  if (!globalForDb.__farmMarketDb) {
    try {
      globalForDb.__farmMarketDb = open();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to initialize SQLite database: ${detail}`);
    }
  }
  return globalForDb.__farmMarketDb;
}
