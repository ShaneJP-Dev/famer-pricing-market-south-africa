import { NextRequest, NextResponse } from "next/server";
import { scrapers } from "@/lib/scrapers";
import { storeScrapeResult } from "@/lib/store";

export const dynamic = "force-dynamic";

interface MarketRunResult {
  ok: boolean;
  market: string;
  date?: string;
  rowsParsed?: number;
  inserted?: number;
  updated?: number;
  warnings?: string[];
  error?: string;
}

async function runScrape(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("market");
  if (key && !scrapers[key]) {
    return NextResponse.json(
      { error: `Unknown market "${key}"`, available: Object.keys(scrapers) },
      { status: 404 }
    );
  }
  const selected = key ? [scrapers[key]] : Object.values(scrapers);

  const results: MarketRunResult[] = [];
  for (const scraper of selected) {
    try {
      const result = await scraper.scrape();
      const stats = storeScrapeResult(result);
      results.push({ ok: true, ...stats, warnings: result.warnings });
    } catch (err) {
      results.push({
        ok: false,
        market: scraper.marketName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const anyOk = results.some((r) => r.ok);
  return NextResponse.json(
    { ok: anyOk, results },
    { status: anyOk ? 200 : 502 }
  );
}

export async function POST(req: NextRequest) {
  return runScrape(req);
}

// GET supported too, so a scrape can be triggered from the browser
export async function GET(req: NextRequest) {
  return runScrape(req);
}
