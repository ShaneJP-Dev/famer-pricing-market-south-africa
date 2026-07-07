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
  const [scrapeMessage, setScrapeMessage] = useState<string | null>(null);

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

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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

  async function triggerScrape() {
    setScraping(true);
    setScrapeMessage(null);
    try {
      const url =
        market === ALL_MARKETS || !marketKeys[market]
          ? "/api/scrape"
          : `/api/scrape?market=${encodeURIComponent(marketKeys[market])}`;
      const res = await fetch(url, { method: "POST" });
      const data = await res.json();
      if (data.results) {
        const parts = data.results.map((r: Record<string, unknown>) =>
          r.ok
            ? `${r.market} ${r.date}: ${r.inserted} new, ${r.updated} updated` +
              (Array.isArray(r.warnings) && r.warnings.length
                ? ` (${r.warnings.length} warning${r.warnings.length > 1 ? "s" : ""})`
                : "")
            : `${r.market}: FAILED — ${r.error}`
        );
        setScrapeMessage(parts.join(" · "));
        router.refresh();
      } else {
        setScrapeMessage(`Scrape failed: ${data.error ?? "unknown error"}`);
      }
    } catch (err) {
      setScrapeMessage(`Scrape failed: ${String(err)}`);
    } finally {
      setScraping(false);
    }
  }

  if (markets.length === 0) {
    return (
      <div className="card">
        <div className="empty">
          <p>No price data yet.</p>
          <p>
            <button className="scrape" onClick={triggerScrape} disabled={scraping}>
              {scraping ? "Scraping…" : "Run first scrape"}
            </button>
          </p>
          <p>
            or call <code>POST /api/scrape</code> manually.
          </p>
          {scrapeMessage && <p>{scrapeMessage}</p>}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <h2>
          Latest prices
          {market !== ALL_MARKETS &&
            ` — ${market} (${latestDateFor(market) ?? "no data yet"})`}
        </h2>
        {market === ALL_MARKETS && (
          <p className="subtitle">
            {markets
              .map((m) => `${m.market}: ${m.latestDate}`)
              .join(" · ")}
          </p>
        )}
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
          <button className="scrape" onClick={triggerScrape} disabled={scraping}>
            {scraping
              ? "Scraping…"
              : market === ALL_MARKETS
                ? "Scrape all markets"
                : `Scrape ${market}`}
          </button>
        </div>
        {scrapeMessage && <p className="subtitle">{scrapeMessage}</p>}
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
                      <td className="num">{fmt(a.avgAvg)}</td>
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
      </div>

      <div className="card">
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
        <p className="subtitle">
          One point per market per trading date: prices aggregated across all
          pack sizes and grades. “All markets” compares average prices; a
          single market also shows its low/high band.
        </p>
      </div>
    </>
  );
}
