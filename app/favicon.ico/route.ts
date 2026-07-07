import { NextResponse } from "next/server";

// Return a tiny transparent icon payload so /favicon.ico never 404s.
const EMPTY_ICO = new Uint8Array([
  0, 0, 1, 0,
  1, 0,
  1, 1,
  0, 0,
  1, 0,
  32, 0,
  40, 1, 0, 0,
  22, 0, 0, 0,
  40, 0, 0, 0,
  1, 0, 0, 0,
  2, 0, 0, 0,
  1, 0,
  32, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  255, 255, 255, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
  255, 255, 255, 255,
  0,
  0,
]);

export const runtime = "nodejs";

export async function GET() {
  return new NextResponse(EMPTY_ICO, {
    headers: {
      "Content-Type": "image/x-icon",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
