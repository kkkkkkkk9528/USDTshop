"use client";

import { Check, Copy, RefreshCw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * TRC20 addresses are 34 base58 characters and start with `T`.
 * The Store API only exposes `description` for payment methods (preferences are
 * not serialized), so the wallet address is read from the instructions text
 * that the backend keeps in sync with the connected integration.
 *
 * Every shopper-facing string comes from the active locale bundle, and fiat
 * amounts/rates are formatted with that locale. The backend stores only the
 * language-neutral address and any admin-authored notes in `description`.
 */
const TRC20_ADDRESS_PATTERN = /T[1-9A-HJ-NP-Za-km-z]{33}/;
const NETWORK_PATTERN = /\bUSDT\s*\(([A-Za-z0-9]{2,8})\)/;
const QUOTE_REFRESH_MS = 60_000;

type UsdtQuote = {
  currency: string;
  amount: string;
  amount_usdt: string;
  rate: string;
  rate_date: string;
  source: string;
  stale: boolean;
};

/** Backend failures are mapped to a message key so no English leaks through. */
type QuoteErrorKind = "invalid" | "unsupported" | "unavailable";

type UsdtPaymentDetailsProps = {
  description: string | null;
  /** Order total in the store's local currency, as returned by the Store API. */
  amount?: string | null;
  /** ISO 4217 code from cart.currency (region/market driven). */
  currency?: string | null;
};

function formatFiat(value: string, currency: string, locale: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return `${currency} ${value}`;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: "code",
    }).format(parsed);
  } catch {
    return `${currency} ${parsed.toFixed(2)}`;
  }
}

function formatRate(value: string, locale: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(parsed);
}

export function UsdtPaymentDetails({
  description,
  amount,
  currency,
}: UsdtPaymentDetailsProps) {
  const t = useTranslations("usdtPayment");
  const locale = useLocale();
  const [copiedField, setCopiedField] = useState<"address" | "amount" | null>(
    null,
  );
  const [quote, setQuote] = useState<UsdtQuote | null>(null);
  const [quoteError, setQuoteError] = useState<QuoteErrorKind | null>(null);
  const [loadingQuote, setLoadingQuote] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const currencyCode = (currency ?? "USD").trim().toUpperCase() || "USD";
  const payableAmount = useMemo(() => {
    if (!amount) return null;
    const trimmed = amount.trim();
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? trimmed : null;
  }, [amount]);

  // The quote comes from the backend FX service, which is also what the
  // automatic on-chain deposit sweep uses to decide whether a payment arrived.
  // Never compute the amount in the browser: a different rounding here would
  // make a correctly paid order stay pending forever.
  const loadQuote = useCallback(async () => {
    if (!payableAmount) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const params = new URLSearchParams({
        amount: payableAmount,
        currency: currencyCode,
      });
      const response = await fetch(`/api/usdt/quote?${params}`, {
        signal: controller.signal,
        cache: "no-store",
      });
      const data: unknown = await response.json();
      if (controller.signal.aborted) return;

      const usdtAmount =
        typeof data === "object" && data !== null && "amount_usdt" in data
          ? (data as UsdtQuote).amount_usdt
          : undefined;

      if (response.ok && typeof usdtAmount === "string") {
        setQuote(data as UsdtQuote);
        setQuoteError(null);
      } else {
        // 400 = invalid amount, 422 = unsupported currency, otherwise the
        // upstream FX service is unavailable. Keep the previous quote if any.
        setQuoteError(
          response.status === 400
            ? "invalid"
            : response.status === 422
              ? "unsupported"
              : "unavailable",
        );
      }
    } catch {
      if (!controller.signal.aborted) setQuoteError("unavailable");
    } finally {
      if (!controller.signal.aborted) {
        setLoadingQuote(false);
        setRefreshing(false);
      }
    }
  }, [payableAmount, currencyCode]);

  useEffect(() => {
    if (!payableAmount) {
      setLoadingQuote(false);
      return;
    }

    void loadQuote();
    const timer = setInterval(() => {
      setRefreshing(true);
      void loadQuote();
    }, QUOTE_REFRESH_MS);

    return () => {
      clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [payableAmount, loadQuote]);

  useEffect(() => {
    if (!copiedField) return;
    const timer = setTimeout(() => setCopiedField(null), 2000);
    return () => clearTimeout(timer);
  }, [copiedField]);

  const copy = async (text: string, field: "address" | "amount") => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API needs a secure context; keep a fallback for http:// hosts.
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
    }
    setCopiedField(field);
  };

  const address = description?.match(TRC20_ADDRESS_PATTERN)?.[0] ?? null;
  const network =
    description?.match(NETWORK_PATTERN)?.[1]?.toUpperCase() ?? "TRC20";

  // No recognizable address: fall back to the plain instructions text.
  if (!address) {
    return description ? (
      <p className="whitespace-pre-line text-sm text-gray-600">{description}</p>
    ) : null;
  }

  // Anything other than the address line is admin-authored notes.
  const instructions = description
    ?.split("\n")
    .filter((line) => !line.includes(address))
    .join("\n")
    .trim();

  const unavailableMessage =
    quoteError === "unsupported"
      ? t("quoteUnavailableCurrency", { currency: currencyCode })
      : quoteError === "invalid"
        ? t("quoteUnavailableInvalid")
        : t("quoteUnavailable");

  return (
    <div className="flex w-full flex-col items-center">
      <p className="mb-3 text-xs font-medium tracking-wide text-gray-500">
        {t("networkLabel", { network })}
      </p>

      <div className="mb-4 w-full max-w-xs rounded-xl border border-blue-200 bg-blue-50/70 p-4 text-center">
        <p className="text-xs font-medium tracking-wide text-blue-700">
          {t("amountToPay")}
        </p>

        {quote ? (
          <>
            <div className="mt-1 flex items-center justify-center gap-2">
              <span className="font-semibold text-3xl text-gray-900 tabular-nums">
                {quote.amount_usdt}
              </span>
              <span className="font-medium text-gray-700 text-sm">USDT</span>
              <button
                type="button"
                onClick={() => void copy(quote.amount_usdt, "amount")}
                title={
                  copiedField === "amount" ? t("amountCopied") : t("copyAmount")
                }
                aria-label={
                  copiedField === "amount" ? t("amountCopied") : t("copyAmount")
                }
                className="rounded p-1 text-gray-400 transition-colors hover:bg-white hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                {copiedField === "amount" ? (
                  <Check className="h-4 w-4 text-green-600" strokeWidth={2} />
                ) : (
                  <Copy className="h-4 w-4" strokeWidth={1.8} />
                )}
              </button>
            </div>

            <p className="mt-1 text-gray-600 text-xs">
              ≈ {formatFiat(quote.amount, quote.currency, locale)}
            </p>

            <div className="mt-2 flex items-center justify-center gap-1">
              <p className="text-[11px] text-gray-500 leading-4">
                {t("rateLine", {
                  currency: quote.currency,
                  rate: formatRate(quote.rate, locale),
                  date: quote.rate_date,
                })}
              </p>
              <button
                type="button"
                onClick={() => {
                  setRefreshing(true);
                  void loadQuote();
                }}
                title={t("refreshRate")}
                aria-label={t("refreshRate")}
                className="rounded p-0.5 text-gray-400 hover:bg-white hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                <RefreshCw
                  className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`}
                  strokeWidth={1.8}
                />
              </button>
            </div>

            {quote.stale ? (
              <p className="mt-1 text-[11px] text-amber-700">
                {t("staleRate")}
              </p>
            ) : null}
            {quoteError ? (
              <p className="mt-1 text-[11px] text-amber-700">
                {t("quoteRefreshFailed")}
              </p>
            ) : null}
          </>
        ) : quoteError ? (
          <p className="mt-2 text-red-700 text-xs leading-5">
            {unavailableMessage}
          </p>
        ) : loadingQuote ? (
          <p className="mt-2 text-gray-500 text-xs">{t("loadingRate")}</p>
        ) : (
          <p className="mt-2 text-gray-500 text-xs">{t("amountUnavailable")}</p>
        )}
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
        <QRCodeSVG
          value={address}
          size={168}
          level="M"
          bgColor="#ffffff"
          fgColor="#111827"
          title={t("qrTitle", { address })}
        />
      </div>

      <button
        type="button"
        onClick={() => void copy(address, "address")}
        title={
          copiedField === "address" ? t("addressCopied") : t("copyAddress")
        }
        aria-label={
          copiedField === "address" ? t("addressCopied") : t("copyAddress")
        }
        className="group mt-3 flex w-full max-w-xs items-start gap-2 rounded-lg border border-transparent px-2 py-2 text-left transition-colors hover:border-gray-200 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        <span className="min-w-0 flex-1 break-all font-mono text-[13px] text-gray-900 leading-5">
          {address}
        </span>
        {copiedField === "address" ? (
          <Check
            className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-600"
            strokeWidth={2}
          />
        ) : (
          <Copy
            className="mt-0.5 h-4 w-4 flex-shrink-0 text-gray-400 transition-colors group-hover:text-blue-600"
            strokeWidth={1.8}
          />
        )}
      </button>
      <p className="text-gray-400 text-xs">
        {copiedField === "address" ? t("copied") : t("tapToCopy")}
      </p>

      <p className="mt-3 w-full text-center text-gray-500 text-xs leading-5">
        {t("transferHint")}
      </p>

      {instructions ? (
        <p className="mt-2 w-full whitespace-pre-line text-gray-600 text-sm">
          {instructions}
        </p>
      ) : null}
    </div>
  );
}
