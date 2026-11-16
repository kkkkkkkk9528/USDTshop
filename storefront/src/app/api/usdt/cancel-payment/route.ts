import { NextResponse } from "next/server";

const CART_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CART_TOKEN_COOKIE = "_spree_cart_token";
const CART_ID_COOKIE = "_spree_cart_token_id";

/**
 * Cancel an unpaid USDT order and put its items back in the cart.
 *
 * Rails returns the restored cart's prefixed id and token; this route writes
 * them into the storefront's cart cookies so a plain visit to /cart shows the
 * basket again (the cookies are normally cleared once checkout completes).
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
  const upstream = new URL("/api/v3/store/usdt/cancel_payment", baseUrl);
  upstream.searchParams.set("cart_id", cartId);

  const headers: Record<string, string> = { Accept: "application/json" };
  const token = request.headers.get("x-spree-token");
  if (token) headers["x-spree-token"] = token;

  try {
    const response = await fetch(upstream, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
      headers,
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      return NextResponse.json(payload, {
        status: response.status,
        headers: { "Cache-Control": "no-store" },
      });
    }

    const result = NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
    // A silent (timeout-triggered) restore must not overwrite the cart the
    // shopper is currently using in this browser. Only an explicit
    // "Back to cart" / "Cancel payment" action re-points the cookies.
    const silent = searchParams.get("silent") === "1";
    const data = payload as { cart_id?: string; cart_token?: string };
    if (!silent && data.cart_id && data.cart_token) {
      const opts = {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax" as const,
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      };
      result.cookies.set(CART_ID_COOKIE, data.cart_id, opts);
      result.cookies.set(CART_TOKEN_COOKIE, data.cart_token, opts);
    }
    return result;
  } catch {
    return NextResponse.json(
      { error: "cancel payment unavailable" },
      { status: 502 },
    );
  }
}
