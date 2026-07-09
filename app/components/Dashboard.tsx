"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  HistoryPoint,
  MarketInfo,
  ProductOption,
  SnapshotRow,
} from "@/lib/queries";

interface Props {
  markets: MarketInfo[];
  snapshots: SnapshotRow[];
  products: ProductOption[];
  /** display name -> scraper registry key (from lib/scrapers) */
  marketKeys: Record<string, string>;
}

const ALL_MARKETS = "";
const MARKET_COLORS = ["#57944a", "#4a6d94", "#a05c94", "#b08430", "#c0603a"];

interface ProductGroup {
  key: string;
  productName: string;
  market: string;
  date: string;
  rows: SnapshotRow[];
}

type ScrapeStatus = "pending" | "running" | "done" | "failed";
interface TrackerEntry {
  key: string;
  name: string;
  status: ScrapeStatus;
  detail?: string;
  warnings?: number;
  startedAt?: number;
  durationMs?: number;
}

/** Roll a group's variant rows up into a summary for its header. */
function aggregate(rows: SnapshotRow[]) {
  const nums = (sel: (r: SnapshotRow) => number | null) =>
    rows.map(sel).filter((v): v is number => v != null);
  const lows = nums((r) => r.priceLow);
  const highs = nums((r) => r.priceHigh);
  const avgs = nums((r) => r.priceAvg);
  const counts = nums((r) => r.unitsSold);
  return {
    minLow: lows.length ? Math.min(...lows) : null,
    maxHigh: highs.length ? Math.max(...highs) : null,
    avgAvg: avgs.length ? avgs.reduce((a, b) => a + b, 0) / avgs.length : null,
    totalCount: counts.length ? counts.reduce((a, b) => a + b, 0) : null,
  };
}

const fmt = (n: number | null) => (n == null ? "—" : n.toFixed(2));

const STATUS_ICON: Record<ScrapeStatus, string> = {
  pending: "○",
  running: "",
  done: "✓",
  failed: "✕",
};

export default function Dashboard({
  markets,
  snapshots,
  products,
  marketKeys,
}: Props) {
  const router = useRouter();
  const [market, setMarket] = useState<string>(ALL_MARKETS);
  const [filter, setFilter] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<number | "">(
    products[0]?.id ?? ""
  );
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [scraping, setScraping] = useState(false);
  const [tracker, setTracker] = useState<TrackerEntry[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // ticks once a second while scraping so the running market's timer updates
  const [, setTick] = useState(0);

  useEffect(() => {
    if (selectedProduct === "") return;
    let cancelled = false;
    fetch(`/api/history?productId=${selectedProduct}`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setHistory(data);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProduct]);

  useEffect(() => {
    if (!scraping) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [scraping]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return snapshots.filter(
      (s) =>
        (market === ALL_MARKETS || s.market === market) &&
        (!q || s.productName.toLowerCase().includes(q))
    );
  }, [snapshots, filter, market]);

  // Group the flat snapshot rows by market + product, so one product with many
  // pack/grade variants becomes a single collapsible group instead of a wall
  // of rows. filtered is already ordered by product/container/grade.
  const groups = useMemo(() => {
    const map = new Map<string, ProductGroup>();
    for (const s of filtered) {
      const key = `${s.market}||${s.productName}`;
      let g = map.get(key);
      if (!g) {
        g = { key, productName: s.productName, market: s.market, date: s.date, rows: [] };
        map.set(key, g);
      }
      g.rows.push(s);
    }
    return [...map.values()];
  }, [filtered]);

  const toggleGroup = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  // Markets that actually have data (used for chart lines).
  const marketNames = markets.map((m) => m.market);
  // Every registered market, so the selector lists all of them even before a
  // market has been scraped. Registry order first, then any data-only markets.
  const allMarketNames = [
    ...Object.keys(marketKeys),
    ...marketNames.filter((n) => !(n in marketKeys)),
  ];
  const latestDateFor = (name: string) =>
    markets.find((m) => m.market === name)?.latestDate ?? null;
  const latestDate = markets.reduce(
    (max, m) => (m.latestDate > max ? m.latestDate : max),
    ""
  );

  // Chart data: one avg-price line per market when viewing all markets;
  // avg/low/high for a single market. Pivot rows into one object per date.
  const chartData = useMemo(() => {
    const relevant =
      market === ALL_MARKETS
        ? history
        : history.filter((h) => h.market === market);
    const byDate = new Map<string, Record<string, number | string | null>>();
    for (const h of relevant) {
      if (!byDate.has(h.date)) byDate.set(h.date, { date: h.date });
      const entry = byDate.get(h.date)!;
      if (market === ALL_MARKETS) {
        entry[h.market] = h.priceAvg;
      } else {
        entry.priceAvg = h.priceAvg;
        entry.priceLow = h.priceLow;
        entry.priceHigh = h.priceHigh;
      }
    }
    return [...byDate.values()].sort((a, b) =>
      String(a.date).localeCompare(String(b.date))
    );
  }, [history, market]);

  /**
   * Scrape markets one at a time so the tracker shows real per-market progress.
   * Targets all registered markets, or just the selected one.
   */
  async function runScrape() {
    if (scraping) return;
    const targets: [string, string][] =
      market === ALL_MARKETS || !marketKeys[market]
        ? Object.entries(marketKeys)
        : [[market, marketKeys[market]]];

    setScraping(true);
    let entries: TrackerEntry[] = targets.map(([name, key]) => ({
      key,
      name,
      status: "pending",
    }));
    setTracker(entries);

    const patch = (i: number, next: Partial<TrackerEntry>) => {
      entries = entries.map((e, j) => (j === i ? { ...e, ...next } : e));
      setTracker([...entries]);
    };

    for (let i = 0; i < entries.length; i++) {
      patch(i, { status: "running", startedAt: Date.now() });
      const start = Date.now();
      try {
        const res = await fetch(
          `/api/scrape?market=${encodeURIComponent(entries[i].key)}`,
          { method: "POST" }
        );
        const data = await res.json();
        const r = data.results?.[0];
        const durationMs = Date.now() - start;
        if (r?.ok) {
          patch(i, {
            status: "done",
            detail: `${r.rowsParsed} rows · ${r.inserted} new · ${r.updated} updated`,
            warnings: Array.isArray(r.warnings) ? r.warnings.length : 0,
            durationMs,
          });
        } else {
          patch(i, {
            status: "failed",
            detail: r?.error ?? data.error ?? "Scrape failed",
            durationMs,
          });
        }
      } catch (err) {
        patch(i, {
          status: "failed",
          detail: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - start,
        });
      }
      // pull fresh data into the page as each market lands
      router.refresh();
    }

    setScraping(false);
    router.refresh();
  }

  const doneCount = tracker
    ? tracker.filter((e) => e.status === "done" || e.status === "failed").length
    : 0;
  const progressPct = tracker ? (doneCount / tracker.length) * 100 : 0;

  const scrapeLabel = scraping
    ? "Scraping…"
    : market === ALL_MARKETS
      ? "Scrape all markets"
      : `Scrape ${market}`;

  return (
    <>
      <header className="app-header">
        <div className="app-title">
          <h1>Farm Market Prices</h1>
          <p className="subtitle">
            Daily fresh produce prices — multi-market aggregator
          </p>
        </div>
        <button className="scrape-btn" onClick={runScrape} disabled={scraping}>
          {scraping ? <span className="spinner" aria-hidden /> : <span className="scrape-icon">⟳</span>}
          {scrapeLabel}
        </button>
      </header>

      <div className="stats-grid">
        <div className="stat">
          <span className="stat-label">Markets</span>
          <span className="stat-value">{markets.length}</span>
          <span className="stat-sub">{marketNames.join(" · ") || "none yet"}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Products</span>
          <span className="stat-value">{products.length}</span>
          <span className="stat-sub">tracked across markets</span>
        </div>
        <div className="stat">
          <span className="stat-label">Price points</span>
          <span className="stat-value">{snapshots.length}</span>
          <span className="stat-sub">latest trading day</span>
        </div>
        <div className="stat">
          <span className="stat-label">Last updated</span>
          <span className="stat-value stat-date">{latestDate || "—"}</span>
          <span className="stat-sub">most recent data</span>
        </div>
      </div>

      {tracker && (
        <div className="card tracker">
          <div className="tracker-head">
            <h2>Scrape progress</h2>
            <span className="subtitle">
              {doneCount}/{tracker.length} markets
              {scraping ? " · running…" : " · complete"}
            </span>
          </div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
          <ul className="tracker-list">
            {tracker.map((e) => {
              const elapsed =
                e.status === "running" && e.startedAt
                  ? (Date.now() - e.startedAt) / 1000
                  : e.durationMs != null
                    ? e.durationMs / 1000
                    : null;
              return (
                <li key={e.key} className={`tracker-item ${e.status}`}>
                  <span className="status-dot">
                    {e.status === "running" ? (
                      <span className="spinner spinner-sm" aria-hidden />
                    ) : (
                      STATUS_ICON[e.status]
                    )}
                  </span>
                  <span className="tracker-name">{e.name}</span>
                  <span className="tracker-detail">
                    {e.detail ??
                      (e.status === "running"
                        ? "scraping…"
                        : e.status === "pending"
                          ? "waiting"
                          : "")}
                    {e.warnings ? (
                      <span className="warn-pill">
                        {e.warnings} warning{e.warnings > 1 ? "s" : ""}
                      </span>
                    ) : null}
                  </span>
                  {elapsed != null && (
                    <span className="tracker-time">{elapsed.toFixed(1)}s</span>
                  )}
                </li>
              );
            })}
          </ul>
          {scraping && (
            <p className="tracker-note">
              Joburg and Tshwane drive a headless browser, so they take longer —
              you can keep browsing the table while they run.
            </p>
          )}
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>
            Latest prices
            {market !== ALL_MARKETS &&
              ` — ${market} (${latestDateFor(market) ?? "no data yet"})`}
          </h2>
          <div className="controls">
            <select value={market} onChange={(e) => setMarket(e.target.value)}>
              <option value={ALL_MARKETS}>All markets</option>
              {allMarketNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                  {latestDateFor(name) ? "" : " (no data yet)"}
                </option>
              ))}
            </select>
            <input
              type="search"
              placeholder="Filter products…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
        </div>

        {markets.length === 0 ? (
          <div className="empty">
            <p>No price data yet.</p>
            <p>Click “Scrape all markets” above to fetch today’s prices.</p>
          </div>
        ) : (
          <>
            <div className="group-bar">
              <span className="subtitle">
                {groups.length} product{groups.length === 1 ? "" : "s"} ·{" "}
                {filtered.length} row{filtered.length === 1 ? "" : "s"}
              </span>
              {groups.length > 0 && (
                <span className="group-actions">
                  <button
                    type="button"
                    onClick={() => setExpanded(new Set(groups.map((g) => g.key)))}
                  >
                    Expand all
                  </button>
                  <button type="button" onClick={() => setExpanded(new Set())}>
                    Collapse all
                  </button>
                </span>
              )}
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Market</th>
                    <th>Container / variant</th>
                    <th className="num">Mass (kg)</th>
                    <th>Grade</th>
                    <th className="num">Count</th>
                    <th className="num">Low (R)</th>
                    <th className="num">High (R)</th>
                    <th className="num">Avg (R)</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => {
                    const a = aggregate(g.rows);
                    const open = expanded.has(g.key);
                    return (
                      <Fragment key={g.key}>
                        <tr
                          className="group-header"
                          onClick={() => toggleGroup(g.key)}
                        >
                          <td>
                            <span className="chev">{open ? "▾" : "▸"}</span>
                            {g.productName}
                            <span className="badge">{g.rows.length}</span>
                          </td>
                          <td>{g.market}</td>
                          <td className="muted">
                            {g.rows.length} variant{g.rows.length === 1 ? "" : "s"}
                          </td>
                          <td className="num muted">—</td>
                          <td className="muted">—</td>
                          <td className="num">{a.totalCount ?? "—"}</td>
                          <td className="num">{fmt(a.minLow)}</td>
                          <td className="num">{fmt(a.maxHigh)}</td>
                          <td className="num strong">{fmt(a.avgAvg)}</td>
                        </tr>
                        {open &&
                          g.rows.map((s) => (
                            <tr key={s.id} className="variant-row">
                              <td className="variant-cell" />
                              <td />
                              <td>{s.containerType}</td>
                              <td className="num">{s.mass ?? "—"}</td>
                              <td>{s.grade || "—"}</td>
                              <td className="num">{s.unitsSold ?? "—"}</td>
                              <td className="num">{s.priceLow ?? "—"}</td>
                              <td className="num">{s.priceHigh ?? "—"}</td>
                              <td className="num">{s.priceAvg ?? "—"}</td>
                            </tr>
                          ))}
                      </Fragment>
                    );
                  })}
                  {groups.length === 0 && (
                    <tr>
                      <td colSpan={9} className="empty">
                        No rows match the current filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {markets.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>Price history{market !== ALL_MARKETS && ` — ${market}`}</h2>
            <div className="controls">
              <select
                value={selectedProduct}
                onChange={(e) => setSelectedProduct(Number(e.target.value))}
              >
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={chartData} margin={{ top: 8, right: 24, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e0e5dd" />
                <XAxis dataKey="date" fontSize={12} />
                <YAxis
                  fontSize={12}
                  label={{ value: "R", angle: -90, position: "insideLeft" }}
                />
                <Tooltip />
                <Legend />
                {market === ALL_MARKETS ? (
                  marketNames.map((name, i) => (
                    <Line
                      key={name}
                      type="monotone"
                      dataKey={name}
                      name={name}
                      stroke={MARKET_COLORS[i % MARKET_COLORS.length]}
                      strokeWidth={2}
                      dot={{ r: 3 }}
                      connectNulls
                    />
                  ))
                ) : (
                  // note: an array, not a fragment — recharts ignores children
                  // wrapped in fragments
                  [
                    <Line
                      key="avg"
                      type="monotone"
                      dataKey="priceAvg"
                      name="Average"
                      stroke="#57944a"
                      strokeWidth={2}
                      dot={{ r: 3 }}
                    />,
                    <Line
                      key="low"
                      type="monotone"
                      dataKey="priceLow"
                      name="Low"
                      stroke="#8fb4d9"
                      strokeDasharray="4 3"
                      dot={{ r: 2 }}
                    />,
                    <Line
                      key="high"
                      type="monotone"
                      dataKey="priceHigh"
                      name="High"
                      stroke="#d98f8f"
                      strokeDasharray="4 3"
                      dot={{ r: 2 }}
                    />,
                  ]
                )}
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p className="subtitle">
              {selectedProduct === ""
                ? "No products available yet."
                : "No history for this product in the selected market yet."}
            </p>
          )}
          <p className="subtitle chart-note">
            One point per market per trading date: prices aggregated across all
            pack sizes and grades. “All markets” compares average prices; a
            single market also shows its low/high band.
          </p>
        </div>
      )}
    </>
  );
}
