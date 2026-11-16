import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import deMessages from "../../../../messages/de.json";
import enMessages from "../../../../messages/en.json";
import esMessages from "../../../../messages/es.json";
import frMessages from "../../../../messages/fr.json";
import plMessages from "../../../../messages/pl.json";
import { UsdtOrderPayment } from "../UsdtOrderPayment";

const ADDRESS = "TNxo2CSb5GATVcaJ7Z3QUnhaNNZqBC2Kd8";

const DETAILS = {
  order_number: "R1003",
  currency: "USD",
  amount: "2666.37",
  amount_usdt: "2666.37",
  rate: "1.0",
  rate_date: "2026-11-13",
  source: "Frankfurter (ECB)",
  stale: false,
  wallet_address: ADDRESS,
  network: "TRC20",
  notes: "Minimum transfer: 1 USDT",
  payment_status: "pending",
  confirmed: false,
  txid: null,
  expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  remaining_seconds: 900,
  payment_window_minutes: 15,
  expired: false,
  payment_state: "awaiting_chain_payment",
  order_canceled: false,
  late_deposit: null,
};

const MESSAGES = {
  en: enMessages,
  de: deMessages,
  es: esMessages,
  fr: frMessages,
  pl: plMessages,
} as const;
type TestLocale = keyof typeof MESSAGES;

const CJK = /[\u3400-\u9fff]/;

function stubDetails(
  payload: unknown = DETAILS,
  opts: { ok?: boolean; status?: number } = {},
) {
  const { ok = true, status = 200 } = opts;
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => payload,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderCard(locale: TestLocale) {
  return render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
      <UsdtOrderPayment cartId="cart_UkLWZg9DAJ" fallbackOrderNumber="R1003" />
    </NextIntlClientProvider>,
  );
}

describe("UsdtOrderPayment", () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each<TestLocale>([
    "en",
    "de",
    "es",
    "fr",
    "pl",
  ])("renders order number, amount, QR and address in %s", async (locale) => {
    stubDetails();
    const { container } = renderCard(locale);
    const copy = MESSAGES[locale].usdtPayment;

    await waitFor(() => expect(screen.getByText("2666.37")).not.toBeNull());
    expect(screen.getByText(copy.settlementTitle)).not.toBeNull();
    expect(screen.getByText(copy.awaitingPayment)).not.toBeNull();
    expect(screen.getByText(copy.amountToPay)).not.toBeNull();
    expect(screen.getByText(copy.iHavePaid)).not.toBeNull();
    expect(screen.getByText(copy.cancelPayment)).not.toBeNull();
    expect(container.textContent).toContain("R1003");
    expect(
      container.querySelector("svg[height='168'] title")?.textContent,
    ).toContain(ADDRESS);
    expect(
      screen.getByRole("button", { name: copy.copyAddress }).textContent,
    ).toContain(ADDRESS);
    expect(container.textContent).toContain("Minimum transfer: 1 USDT");
    expect(container.textContent).toContain("USDT · TRC20");
    expect(container.textContent).not.toMatch(CJK);
    expect(container.textContent).not.toContain("汇率每 60 秒");
    expect(container.textContent).not.toContain("请按此金额精确转账");
  });

  it("copies both the address and the USDT amount", async () => {
    stubDetails();
    renderCard("en");
    await waitFor(() => expect(screen.getByText("2666.37")).not.toBeNull());

    fireEvent.click(
      screen.getByRole("button", {
        name: enMessages.usdtPayment.copyAddress,
      }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ADDRESS));

    fireEvent.click(
      screen.getByRole("button", { name: enMessages.usdtPayment.copyAmount }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("2666.37"));
  });

  it("shows the confirmed state without asking for another transfer", async () => {
    stubDetails({
      ...DETAILS,
      confirmed: true,
      payment_status: "completed",
      txid: "abc123def456",
    });
    const { container } = renderCard("en");

    await waitFor(() =>
      expect(
        screen.getByText(enMessages.usdtPayment.paymentConfirmed),
      ).not.toBeNull(),
    );
    expect(container.querySelector("svg[height='168']")).toBeNull();
    expect(
      screen.queryByText(enMessages.usdtPayment.awaitingPayment),
    ).toBeNull();
    expect(container.textContent).toContain("abc123def456");
    expect(screen.getByText("2666.37")).not.toBeNull();
  });

  it("localizes the failure state and offers a retry", async () => {
    const fetchMock = stubDetails(
      { error: "unavailable" },
      { ok: false, status: 502 },
    );
    renderCard("fr");

    await waitFor(() =>
      expect(
        screen.getByText(frMessages.usdtPayment.detailsUnavailable),
      ).not.toBeNull(),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: frMessages.usdtPayment.refreshDetails,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("formats fiat amounts and rates with the active locale", async () => {
    stubDetails({
      ...DETAILS,
      currency: "EUR",
      amount: "1234.50",
      rate: "0.70136064",
    });
    const { container } = renderCard("de");

    await waitFor(() =>
      expect(
        screen.getByText(deMessages.usdtPayment.settlementTitle),
      ).not.toBeNull(),
    );
    expect(container.textContent).toMatch(/1\.234,50\s*EUR/u);
    expect(container.textContent).toContain("0,7014");
    expect(container.textContent).toContain("EZB 2026-11-13");
  });

  it("shows a localized stale-rate notice", async () => {
    stubDetails({ ...DETAILS, stale: true });
    renderCard("es");

    await waitFor(() =>
      expect(screen.getByText(esMessages.usdtPayment.staleRate)).not.toBeNull(),
    );
  });

  it("shows a live countdown while the payment window is open", async () => {
    stubDetails();
    const { container } = renderCard("en");
    await waitFor(() => expect(screen.getByText("2666.37")).not.toBeNull());
    expect(container.textContent).toContain("Time left:");
    expect(container.textContent).toMatch(/[0-9]{2}:[0-9]{2}/u);
  });

  it("replaces the QR code with a cancellation notice when the window closes", async () => {
    stubDetails({
      ...DETAILS,
      expired: true,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      remaining_seconds: 0,
      order_canceled: true,
      payment_status: "void",
      payment_state: "expired",
    });
    const { container } = renderCard("en");
    await waitFor(() =>
      expect(
        screen.getByText(enMessages.usdtPayment.windowExpiredTitle),
      ).not.toBeNull(),
    );
    expect(
      screen.getByText(enMessages.usdtPayment.windowExpiredNote),
    ).not.toBeNull();
    expect(
      screen.getByText(enMessages.usdtPayment.paymentCanceled),
    ).not.toBeNull();
    expect(container.querySelector("svg[height='168']")).toBeNull();
    expect(container.textContent).not.toContain("Minimum transfer: 1 USDT");
  });

  it("warns about a transfer detected after the window closed", async () => {
    stubDetails({
      ...DETAILS,
      expired: true,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      remaining_seconds: 0,
      late_deposit: { txid: "late-tx-1", amount: "3.18" },
    });
    renderCard("fr");
    await waitFor(() =>
      expect(
        screen.getByText(frMessages.usdtPayment.lateDepositNote),
      ).not.toBeNull(),
    );
  });

  it("notifies the payment page once the chain confirms the transfer", async () => {
    const onConfirmed = vi.fn();
    stubDetails({
      ...DETAILS,
      confirmed: true,
      payment_status: "completed",
    });
    render(
      <NextIntlClientProvider locale="en" messages={MESSAGES.en}>
        <UsdtOrderPayment cartId="cart_UkLWZg9DAJ" onConfirmed={onConfirmed} />
      </NextIntlClientProvider>,
    );
    await waitFor(() => expect(onConfirmed).toHaveBeenCalled());
  });
  it("asks the backend to check the chain immediately and keeps the buttons usable", async () => {
    const fetchMock = stubDetails();
    renderCard("en");
    await waitFor(() => expect(screen.getByText("2666.37")).not.toBeNull());

    fireEvent.click(
      screen.getByRole("button", {
        name: enMessages.usdtPayment.iHavePaid,
      }),
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) =>
          String(call[0]).includes("/api/usdt/check-payment"),
        ),
      ).toBe(true),
    );
    // A transfer that never shows up must not leave the page in a permanent
    // "checking" state: both actions stay available for a retry or an exit.
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: enMessages.usdtPayment.iHavePaid,
        }),
      ).toHaveProperty("disabled", false),
    );
    expect(
      screen.getByRole("button", {
        name: enMessages.usdtPayment.cancelPayment,
      }),
    ).toHaveProperty("disabled", false);
  });

  it("surfaces a failed on-chain check instead of spinning forever", async () => {
    const fetchMock = vi.fn().mockImplementation((input: string | URL) => {
      if (String(input).includes("/api/usdt/check-payment")) {
        return Promise.resolve({
          ok: false,
          status: 502,
          json: async () => ({ error: "unavailable" }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => DETAILS,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderCard("en");
    await waitFor(() => expect(screen.getByText("2666.37")).not.toBeNull());

    fireEvent.click(
      screen.getByRole("button", {
        name: enMessages.usdtPayment.iHavePaid,
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(enMessages.usdtPayment.actionFailed),
      ).not.toBeNull(),
    );
    expect(
      screen.getByRole("button", {
        name: enMessages.usdtPayment.cancelPayment,
      }),
    ).toHaveProperty("disabled", false);
  });

  it("shows the 30s not-detected notice without locking the actions", async () => {
    vi.useFakeTimers();
    try {
      stubDetails();
      renderCard("en");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name: enMessages.usdtPayment.iHavePaid,
          }),
        );
        await vi.advanceTimersByTimeAsync(0);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_500);
      });

      expect(
        screen.getByText(enMessages.usdtPayment.paymentNotDetected),
      ).not.toBeNull();
      expect(
        screen.getByRole("button", {
          name: enMessages.usdtPayment.iHavePaid,
        }),
      ).toHaveProperty("disabled", false);
      expect(
        screen.getByRole("button", {
          name: enMessages.usdtPayment.cancelPayment,
        }),
      ).toHaveProperty("disabled", false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns to the cart after the shopper cancels the payment", async () => {
    const onCanceled = vi.fn();
    stubDetails();
    render(
      <NextIntlClientProvider locale="en" messages={MESSAGES.en}>
        <UsdtOrderPayment cartId="cart_UkLWZg9DAJ" onCanceled={onCanceled} />
      </NextIntlClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("2666.37")).not.toBeNull());

    fireEvent.click(
      screen.getByRole("button", {
        name: enMessages.usdtPayment.cancelPayment,
      }),
    );
    await waitFor(() => expect(onCanceled).toHaveBeenCalled());
  });

  it("offers a localized way back to the cart when the window has closed", async () => {
    stubDetails({
      ...DETAILS,
      expired: true,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      remaining_seconds: 0,
      order_canceled: true,
    });
    renderCard("de");
    await waitFor(() =>
      expect(
        screen.getByText(deMessages.usdtPayment.windowExpiredTitle),
      ).not.toBeNull(),
    );
    expect(
      screen.getByRole("button", {
        name: deMessages.usdtPayment.backToCart,
      }),
    ).not.toBeNull();
    expect(
      screen.getByText(deMessages.usdtPayment.cartRestoredNote),
    ).not.toBeNull();
  });
});
