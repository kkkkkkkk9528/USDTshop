"use client";

import { Check, CircleCheckBig, Clock3, Copy, RefreshCw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Post-checkout USDT settlement card, rendered on the order-placed page next
 * to the order number and order details — NOT on the checkout page, where the
 * shopper should only have to pick "USDT (Tether)".
 *
 * Every value comes from Spree's order-level USDT endpoint. In particular the
 * amount is the frozen rate snapshot that CheckDepositsJob writes to the
 * payment and DepositVerifier matches on Tron, so a correctly paid order can
 * never get stuck because the page and the sweep disagreed by a cent.
 */
type OrderPaymentDetails = {
  order_number: string;
  currency: string;
  amount: string;
  amount_usdt: string;
  rate: string;
  rate_date: string;
  source: string;
  stale: boolean;
  wallet_address: string;
  network: string;
  notes: string | null;
  payment_status: string;
  confirmed: boolean;
  txid: string | null;
  /** Absolute UTC deadline — refreshing the page never restarts the window. */
  expires_at: string;
  remaining_seconds: number;
  payment_window_minutes: number;
  expired: boolean;
  payment_state:
    | "awaiting_chain_payment"
    | "confirmed"
    | "expired"
    | "canceled";
  order_canceled: boolean;
  late_deposit: { txid?: string; amount?: string } | null;
};

type UsdtOrderPaymentProps = {
  /** Prefixed cart id from the thank-you page URL. */
  cartId: string;
  /** Shown if the backend has not reported a number yet. */
  fallbackOrderNumber?: string | null;
  /** Called once when the on-chain transfer is confirmed. */
  onConfirmed?: () => void;
  /** Called after the unpaid order is canceled and the cart is restored. */
  onCanceled?: () => void;
};

const POLL_MS = 60_000;
const POLL_FAST_MS = 5_000;
const NOT_DETECTED_AFTER_MS = 30_000;

/**
 * Shared button sizing so the payment actions keep the storefront's Button
 * colours (primary / outline) while staying compact on small screens.
 */
const ACTION_BUTTON_CLASS =
  "h-10 w-full gap-2 rounded-lg text-xs sm:h-11 sm:text-sm";

function formatCountdown(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

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

export function UsdtOrderPayment({
  cartId,
  fallbackOrderNumber,
  onConfirmed,
  onCanceled,
}: UsdtOrderPaymentProps) {
  const t = useTranslations("usdtPayment");
  const locale = useLocale();
  const [details, setDetails] = useState<OrderPaymentDetails | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState<"address" | "amount" | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // `checking` keeps the 5s poll and the 30s "not detected" notice on until
  // the chain confirms or the window closes. `submitting` only spans the one
  // POST, so the buttons never get stuck showing a permanent spinner.
  const [checking, setChecking] = useState(false);
  const [checkAttempt, setCheckAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [notDetected, setNotDetected] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [actionError, setActionError] = useState(false);
  const aliveRef = useRef(true);
  const onConfirmedRef = useRef(onConfirmed);
  const onCanceledRef = useRef(onCanceled);
  const restoreAttemptedRef = useRef(false);

  useEffect(() => {
    onConfirmedRef.current = onConfirmed;
  }, [onConfirmed]);

  useEffect(() => {
    onCanceledRef.current = onCanceled;
  }, [onCanceled]);

  useEffect(() => {
    if (!details?.confirmed) return;
    onConfirmedRef.current?.();
  }, [details?.confirmed]);

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/usdt/order-payment?cart_id=${encodeURIComponent(cartId)}`,
        { cache: "no-store" },
      );
      const data: unknown = await response.json();
      if (!aliveRef.current) return;

      const okay =
        response.ok &&
        typeof data === "object" &&
        data !== null &&
        "amount_usdt" in data &&
        "wallet_address" in data;
      if (okay) {
        setDetails(data as OrderPaymentDetails);
        setFailed(false);
      } else {
        setFailed(true);
      }
    } catch {
      if (aliveRef.current) setFailed(true);
    } finally {
      if (aliveRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [cartId]);

  const deadlineMs = details ? Date.parse(details.expires_at) : Number.NaN;
  const remainingSeconds = details
    ? Number.isFinite(deadlineMs)
      ? Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000))
      : Math.max(0, details.remaining_seconds ?? 0)
    : 0;
  const expired =
    Boolean(details?.expired) ||
    (details !== null && !details.confirmed && remainingSeconds === 0);

  // Confirmation and window expiry are terminal: stop the fast poll and clear
  // the "still checking" affordances so nothing keeps spinning on a dead order.
  useEffect(() => {
    if (!details?.confirmed && !expired) return;
    setChecking(false);
    setSubmitting(false);
    setNotDetected(false);
  }, [details?.confirmed, expired]);

  // Tick locally so the countdown keeps moving between the 60s polls. The
  // deadline itself always comes from the server.
  useEffect(() => {
    if (!details || details.confirmed || expired) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [details, expired]);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    return () => {
      aliveRef.current = false;
    };
  }, [load]);

  // Fast (5s) polling after "I have paid" until the sweep confirms the
  // transfer or the 15-minute window closes. An expired order is never polled.
  useEffect(() => {
    if (!details || details.confirmed || expired) return;
    const timer = setInterval(
      () => void load(),
      checking ? POLL_FAST_MS : POLL_MS,
    );
    return () => clearInterval(timer);
  }, [details, expired, checking, load]);

  // Each "I have paid" press restarts the 30s grace period, so a second check
  // gets its own notice instead of inheriting the previous one.
  useEffect(() => {
    if (!checking || checkAttempt === 0 || details?.confirmed || expired) {
      setNotDetected(false);
      return;
    }
    const timer = setTimeout(() => setNotDetected(true), NOT_DETECTED_AFTER_MS);
    return () => clearTimeout(timer);
  }, [checking, checkAttempt, details?.confirmed, expired]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async (text: string, field: "address" | "amount") => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
    }
    setCopied(field);
  };

  const refresh = () => {
    setRefreshing(true);
    void load();
  };

  const postAction = useCallback(
    async (path: string, silent = false) => {
      const suffix = silent ? "&silent=1" : "";
      const response = await fetch(
        `${path}?cart_id=${encodeURIComponent(cartId)}${suffix}`,
        { method: "POST", cache: "no-store" },
      );
      return response.ok;
    },
    [cartId],
  );

  // "I have paid" enqueues one on-chain sweep right away, then switches the
  // page to the 5s poll. The POST itself is short-lived: even when no transfer
  // is found the button becomes pressable again and "Cancel payment" stays
  // available, instead of both being locked behind a permanent spinner.
  const checkNow = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    setChecking(true);
    setCheckAttempt((n) => n + 1);
    setNotDetected(false);
    setActionError(false);
    try {
      const ok = await postAction("/api/usdt/check-payment");
      if (!ok) setActionError(true);
    } catch {
      setActionError(true);
    } finally {
      setSubmitting(false);
    }
    await load();
  }, [submitting, postAction, load]);

  const cancelPayment = useCallback(
    async (silent = false) => {
      if (canceling) return;
      setCanceling(true);
      setActionError(false);
      try {
        const ok = await postAction("/api/usdt/cancel-payment", silent);
        if (!ok) {
          setActionError(true);
          return;
        }
        if (!silent) onCanceledRef.current?.();
      } catch {
        setActionError(true);
      } finally {
        setCanceling(false);
      }
    },
    [canceling, postAction],
  );

  // An expired order already has its items back in the cart on the server.
  // This silent call also re-points the browser's cart cookies at them, so
  // the basket is waiting even if the shopper never presses the button.
  useEffect(() => {
    if (!expired || details?.confirmed || restoreAttemptedRef.current) return;
    restoreAttemptedRef.current = true;
    void cancelPayment(true);
  }, [expired, details?.confirmed, cancelPayment]);

  if (loading && !details) {
    return (
      <section className="animate-pulse rounded-lg border border-gray-200 bg-white p-4 sm:rounded-xl sm:p-6">
        <div className="mx-auto h-4 w-32 rounded bg-gray-200 sm:h-5 sm:w-40" />
        <div className="mx-auto mt-3 h-14 w-full max-w-[16rem] rounded-lg bg-gray-100 sm:mt-4 sm:h-16 sm:max-w-xs sm:rounded-xl" />
        <div className="mx-auto mt-4 h-32 w-32 rounded-lg bg-gray-100 sm:mt-5 sm:h-40 sm:w-40 sm:rounded-xl" />
      </section>
    );
  }

  if (!details) {
    return (
      <section className="rounded-lg border border-gray-200 bg-white p-4 text-center sm:rounded-xl sm:p-6">
        <p className="text-xs text-gray-700 sm:text-sm">
          {t("detailsUnavailable")}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={refresh}
          aria-label={t("refreshDetails")}
          className="mt-3 gap-1.5 rounded-lg text-xs sm:text-sm"
        >
          <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.8} />
          {t("refreshDetails")}
        </Button>
      </section>
    );
  }

  const address = details.wallet_address;
  const orderNumber = details.order_number || fallbackOrderNumber;

  return (
    <section
      aria-label={t("settlementTitle")}
      className="overflow-hidden rounded-lg border border-gray-200 bg-white sm:rounded-xl"
    >
      <div className="flex items-start justify-between gap-2 border-b border-gray-200 px-4 py-3 sm:gap-3 sm:px-6 sm:py-4">
        <div className="min-w-0">
          <h2 className="text-base font-medium text-gray-900 sm:text-lg">
            {t("settlementTitle")}
          </h2>
          {orderNumber ? (
            <p className="mt-1 text-xs text-gray-500">
              {t("orderNumberLabel", { number: orderNumber })}
            </p>
          ) : null}
          <p className="mt-1 text-xs tracking-wide text-gray-500">
            {t("networkLabel", { network: details.network })}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5 sm:gap-2">
          <button
            type="button"
            onClick={refresh}
            title={t("refreshDetails")}
            aria-label={t("refreshDetails")}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
              strokeWidth={1.8}
            />
          </button>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium sm:gap-1.5 sm:px-2.5 sm:py-1 sm:text-xs ${
              details.confirmed
                ? "bg-green-50 text-green-700"
                : expired
                  ? "bg-red-50 text-red-700"
                  : "bg-amber-50 text-amber-700"
            }`}
          >
            {details.confirmed ? (
              <CircleCheckBig className="h-3.5 w-3.5" strokeWidth={2} />
            ) : (
              <Clock3 className="h-3.5 w-3.5" strokeWidth={2} />
            )}
            {details.confirmed
              ? t("paymentConfirmed")
              : expired
                ? t("paymentCanceled")
                : t("awaitingPayment")}
          </span>
        </div>
      </div>

      <div className="flex w-full flex-col items-center px-4 py-4 sm:px-6 sm:py-5">
        {expired && !details.confirmed ? (
          <div className="w-full max-w-md rounded-lg border border-gray-200 bg-gray-50 p-4 text-center sm:rounded-xl sm:p-6">
            <p className="text-base font-semibold text-gray-900 sm:text-lg">
              {t("windowExpiredTitle")}
            </p>
            <p className="mt-1.5 text-xs text-gray-600 leading-5 sm:mt-2 sm:text-sm sm:leading-6">
              {t("windowExpiredNote")}
            </p>
            {details.late_deposit ? (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-amber-800 text-xs leading-5">
                {t("lateDepositNote")}
              </p>
            ) : null}
            <Button
              type="button"
              onClick={() => void cancelPayment(false)}
              disabled={canceling}
              className={`mt-4 ${ACTION_BUTTON_CLASS}`}
            >
              {t("backToCart")}
            </Button>
            <p className="mt-2 text-gray-500 text-xs">
              {t("cartRestoredNote")}
            </p>
            {actionError ? (
              <p className="mt-2 text-red-700 text-xs">{t("actionFailed")}</p>
            ) : null}
          </div>
        ) : details.confirmed ? (
          <div className="text-center">
            <p className="text-xl font-semibold text-gray-900 tabular-nums sm:text-2xl">
              {details.amount_usdt}{" "}
              <span className="font-medium text-gray-700 text-sm">USDT</span>
            </p>
            <p className="mt-1 text-gray-600 text-xs">
              ≈ {formatFiat(details.amount, details.currency, locale)}
            </p>
            {details.txid ? (
              <p className="mt-2 break-all font-mono text-[11px] text-gray-400">
                {details.txid}
              </p>
            ) : null}
          </div>
        ) : (
          <>
            <div className="mb-4 w-full max-w-[16rem] rounded-lg border border-gray-200 bg-gray-50 p-3 text-center sm:mb-5 sm:max-w-xs sm:rounded-xl sm:p-4">
              <p className="mb-1.5 inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800 text-[11px] tabular-nums sm:mb-2 sm:px-2.5 sm:py-1 sm:text-xs">
                <Clock3 className="h-3 w-3 sm:h-3.5 sm:w-3.5" strokeWidth={2} />
                {t("timeRemaining", {
                  time: formatCountdown(remainingSeconds),
                })}
              </p>
              <p className="text-[11px] font-medium tracking-wide text-gray-600 sm:text-xs">
                {t("amountToPay")}
              </p>
              <div className="mt-0.5 flex items-center justify-center gap-1.5 sm:mt-1 sm:gap-2">
                <span className="text-2xl font-semibold text-gray-900 tabular-nums sm:text-3xl">
                  {details.amount_usdt}
                </span>
                <span className="font-medium text-gray-700 text-xs sm:text-sm">
                  USDT
                </span>
                <button
                  type="button"
                  onClick={() => void copy(details.amount_usdt, "amount")}
                  title={
                    copied === "amount" ? t("amountCopied") : t("copyAmount")
                  }
                  aria-label={
                    copied === "amount" ? t("amountCopied") : t("copyAmount")
                  }
                  className="rounded p-1 text-gray-400 hover:bg-white hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
                >
                  {copied === "amount" ? (
                    <Check className="h-4 w-4 text-green-600" strokeWidth={2} />
                  ) : (
                    <Copy className="h-4 w-4" strokeWidth={1.8} />
                  )}
                </button>
              </div>
              <p className="mt-0.5 text-[11px] text-gray-600 sm:mt-1 sm:text-xs">
                ≈ {formatFiat(details.amount, details.currency, locale)}
              </p>
              <p className="mt-2 text-[11px] text-gray-500 leading-4">
                {t("rateLine", {
                  currency: details.currency,
                  rate: formatRate(details.rate, locale),
                  date: details.rate_date,
                })}
              </p>
              {details.stale ? (
                <p className="mt-1 text-[11px] text-amber-700">
                  {t("staleRate")}
                </p>
              ) : null}
              {failed ? (
                <p className="mt-1 text-[11px] text-amber-700">
                  {t("quoteRefreshFailed")}
                </p>
              ) : null}
            </div>

            <div className="rounded-lg border border-gray-200 bg-white p-2 shadow-sm sm:rounded-xl sm:p-3">
              <QRCodeSVG
                value={address}
                size={168}
                level="M"
                bgColor="#ffffff"
                fgColor="#111827"
                title={t("qrTitle", { address })}
                className="h-[140px] w-[140px] sm:h-[168px] sm:w-[168px]"
              />
            </div>

            <button
              type="button"
              onClick={() => void copy(address, "address")}
              title={
                copied === "address" ? t("addressCopied") : t("copyAddress")
              }
              aria-label={
                copied === "address" ? t("addressCopied") : t("copyAddress")
              }
              className="group mt-2.5 flex w-full max-w-[16rem] items-start gap-1.5 rounded-lg border border-transparent px-1.5 py-1.5 text-left hover:border-gray-200 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 sm:mt-3 sm:max-w-xs sm:gap-2 sm:px-2 sm:py-2"
            >
              <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-gray-900 leading-4 sm:text-[13px] sm:leading-5">
                {address}
              </span>
              {copied === "address" ? (
                <Check
                  className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-green-600 sm:h-4 sm:w-4"
                  strokeWidth={2}
                />
              ) : (
                <Copy
                  className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-gray-400 group-hover:text-gray-900 sm:h-4 sm:w-4"
                  strokeWidth={1.8}
                />
              )}
            </button>
            <p className="text-[11px] text-gray-400 sm:text-xs">
              {copied === "address" ? t("copied") : t("tapToCopy")}
            </p>

            <p className="mt-3 w-full text-center text-[11px] text-gray-500 leading-4 sm:mt-4 sm:text-xs sm:leading-5">
              {t("awaitingNote")}
            </p>

            <div className="mt-4 flex w-full max-w-[16rem] flex-col gap-1.5 sm:mt-5 sm:max-w-xs sm:gap-2">
              <Button
                type="button"
                onClick={() => void checkNow()}
                disabled={submitting || canceling}
                className={ACTION_BUTTON_CLASS}
              >
                {submitting ? (
                  <RefreshCw
                    className="h-3.5 w-3.5 animate-spin sm:h-4 sm:w-4"
                    strokeWidth={2}
                  />
                ) : (
                  <Check
                    className="h-3.5 w-3.5 sm:h-4 sm:w-4"
                    strokeWidth={2}
                  />
                )}
                {submitting ? t("checkingPayment") : t("iHavePaid")}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void cancelPayment(false)}
                disabled={canceling}
                className={ACTION_BUTTON_CLASS}
              >
                {t("cancelPayment")}
              </Button>
              {notDetected ? (
                <p className="text-amber-700 text-xs leading-5">
                  {t("paymentNotDetected")}
                </p>
              ) : null}
              {actionError ? (
                <p className="text-red-700 text-xs leading-5">
                  {t("actionFailed")}
                </p>
              ) : null}
            </div>
          </>
        )}

        {!expired && details.notes ? (
          <p className="mt-2.5 w-full whitespace-pre-line text-center text-xs text-gray-600 sm:mt-3 sm:text-sm">
            {details.notes}
          </p>
        ) : null}
      </div>
    </section>
  );
}
