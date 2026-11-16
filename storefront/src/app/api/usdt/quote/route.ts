import { NextResponse } from "next/server";

const AMOUNT_PATTERN = /^\d{1,12}(?:\.\d{1,4})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Server-side proxy for the Spree USDT exchange-rate quote. The browser never
 * talks to Rails directly, and the amount comes from the same service the
 * automatic deposit sweep uses, so the checkout always shows the exact USDT
 * amount the system waits for on-chain.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const amount = (searchParams.get("amount") ?? "").trim();
  const currency = (searchParams.get("currency") ?? "USD").trim().toUpperCase();

  if (!AMOUNT_PATTERN.test(amount) || !CURRENCY_PATTERN.test(currency)) {
    return NextResponse.json(
      { error: "invalid amount or currency" },
      { status: 400 },
    );
  }

  const baseUrl = (
    process.env.SPREE_API_URL ?? "http://127.0.0.1:3000"
  ).replace(/\/$/, "");
  const upstream = new URL("/api/v3/store/usdt/quote", baseUrl);
  upstream.searchParams.set("amount", amount);
  upstream.searchParams.set("currency", currency);

  try {
    const response = await fetch(upstream, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      headers: { Accept: "application/json" },
    });
    const payload: unknown = await response.json();

    if (!response.ok) {
      const message =
        typeof payload === "object" &&
        payload !== null &&
        "error" in payload &&
        typeof payload.error === "string"
          ? payload.error
          : "quote unavailable";
      return NextResponse.json(
        { error: message },
        { status: response.status === 422 ? 422 : 502 },
      );
    }

    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "quote unavailable" }, { status: 502 });
  }
}
