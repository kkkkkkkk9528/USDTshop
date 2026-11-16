import { NextResponse } from "next/server";

const CART_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Server-side proxy for the post-checkout USDT settlement details.
 *
 * The amount returned here is the exact rate snapshot the automatic on-chain
 * deposit sweep freezes on the payment, so the number the shopper sees next to
 * their order number is the number the system waits for on Tron.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const cartId = (searchParams.get("cart_id") ?? "").trim();

  if (!CART_ID_PATTERN.test(cartId)) {
    return NextResponse.json({ error: "invalid cart id" }, { status: 400 });
  }

  const baseUrl = (
    process.env.SPREE_API_URL ?? "http://127.0.0.1:3000"
  ).replace(/\/$/, "");
  const upstream = new URL("/api/v3/store/usdt/order_payment", baseUrl);
  upstream.searchParams.set("cart_id", cartId);

  const headers: Record<string, string> = { Accept: "application/json" };
  const token = request.headers.get("x-spree-token");
  if (token) headers["x-spree-token"] = token;

  try {
    const response = await fetch(upstream, {
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
      { error: "payment details unavailable" },
      { status: 502 },
    );
  }
}
