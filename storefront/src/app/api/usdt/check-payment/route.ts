import { NextResponse } from "next/server";

const CART_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * "I have paid" — ask Rails to run the on-chain sweep now instead of waiting
 * for the next scheduled minute. The storefront then polls faster until the
 * transfer is confirmed (or the window closes).
 */
export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const cartId = (searchParams.get("cart_id") ?? "").trim();

  if (!CART_ID_PATTERN.test(cartId)) {
    return NextResponse.json({ error: "invalid cart id" }, { status: 400 });
  }

  const baseUrl = (
    process.env.SPREE_API_URL ?? "http://127.0.0.1:3000"
  ).replace(/\/$/, "");
  const upstream = new URL("/api/v3/store/usdt/check_payment", baseUrl);
  upstream.searchParams.set("cart_id", cartId);

  const headers: Record<string, string> = { Accept: "application/json" };
  const token = request.headers.get("x-spree-token");
  if (token) headers["x-spree-token"] = token;

  try {
    const response = await fetch(upstream, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      headers,
    });
    const payload: unknown = await response.json();

    return NextResponse.json(payload, {
      status: response.ok ? 200 : response.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "payment check unavailable" },
      { status: 502 },
    );
  }
}
