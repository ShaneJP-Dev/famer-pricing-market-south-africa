import { NextRequest, NextResponse } from "next/server";
import { getProductHistory } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const idParam = req.nextUrl.searchParams.get("productId");
  const productId = Number(idParam);
  if (!idParam || !Number.isInteger(productId)) {
    return NextResponse.json(
      { error: "productId query param is required" },
      { status: 400 }
    );
  }
  return NextResponse.json(getProductHistory(productId));
}
