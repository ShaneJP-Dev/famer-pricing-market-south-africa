import { getLatestSnapshots, getMarkets, getProducts } from "@/lib/queries";
import { scrapers } from "@/lib/scrapers";
import Dashboard from "./components/Dashboard";

export const dynamic = "force-dynamic";

export default function HomePage() {
  try {
    const markets = getMarkets();
    const snapshots = markets.length ? getLatestSnapshots() : [];
    const products = getProducts();
  // display name -> registry key, so the UI can target one market's scraper
    const marketKeys = Object.fromEntries(
      Object.values(scrapers).map((s) => [s.marketName, s.key])
    );

    return (
      <main>
        <Dashboard
          markets={markets}
          snapshots={snapshots}
          products={products}
          marketKeys={marketKeys}
        />
      </main>
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return (
      <main>
        <h1>Farm Market Prices</h1>
        <p className="subtitle">Server failed to load market data.</p>
        <p className="subtitle">{message}</p>
      </main>
    );
  }
}
