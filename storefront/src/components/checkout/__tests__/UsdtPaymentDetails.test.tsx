import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import deMessages from "../../../../messages/de.json";
import enMessages from "../../../../messages/en.json";
import esMessages from "../../../../messages/es.json";
import frMessages from "../../../../messages/fr.json";
import plMessages from "../../../../messages/pl.json";
import { UsdtPaymentDetails } from "../UsdtPaymentDetails";

const ADDRESS = "TNxo2CSb5GATVcaJ7Z3QUnhaNNZqBC2Kd8";
// The Store API description is language-neutral now: network + address, then
// optional admin-authored notes. All shopper-facing copy comes from i18n.
const DESCRIPTION = `USDT (TRC20) ${ADDRESS}`;
const DESCRIPTION_WITH_NOTE = `${DESCRIPTION}\nNote from the shop`;

const MESSAGES = {
  en: enMessages,
  de: deMessages,
  es: esMessages,
  fr: frMessages,
  pl: plMessages,
} as const;

type TestLocale = keyof typeof MESSAGES;

const REMOVED_COPY = "汇率每 60 秒自动更新 · 请按此金额精确转账";
const CJK = /[\u3400-\u9fff]/;

function makeQuote(
  currency: string,
  amount: string,
  amountUsdt: string,
  rate: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    currency,
    amount,
    amount_usdt: amountUsdt,
    rate,
    rate_date: "2026-11-13",
    source: "Frankfurter (ECB)",
    stale: false,
    ...overrides,
  };
}

const CAD_QUOTE = makeQuote("CAD", "123.45", "86.58", "0.70136064");

function stubQuote(
  payload: unknown = CAD_QUOTE,
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

function renderCard(
  locale: TestLocale,
  props: Partial<ComponentProps<typeof UsdtPaymentDetails>> = {},
) {
  return render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
      <UsdtPaymentDetails
        description={DESCRIPTION}
        amount="123.45"
        currency="CAD"
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

describe("UsdtPaymentDetails", () => {
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
  ])("renders all card copy in %s and drops the 60-second hint", async (locale) => {
    stubQuote();
    const { container } = renderCard(locale);
    const copy = MESSAGES[locale].usdtPayment;

    await waitFor(() => expect(screen.getByText("86.58")).not.toBeNull());
    expect(screen.getByText(copy.amountToPay)).not.toBeNull();
    expect(screen.getByText(copy.transferHint)).not.toBeNull();
    expect(screen.getByText(copy.tapToCopy)).not.toBeNull();
    expect(
      screen.getByRole("button", { name: copy.copyAddress }),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: copy.copyAmount }),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: copy.refreshRate }),
    ).not.toBeNull();

    // No hardcoded Chinese and no removed hint in any locale.
    expect(container.textContent).not.toMatch(CJK);
    expect(container.textContent).not.toContain("60 秒");
    expect(container.textContent).not.toContain(REMOVED_COPY);
    expect(container.textContent).not.toContain("请按此金额精确转账");
  });

  const currencyCases = [
    { currency: "USD", amount: "100.00", usdt: "100.00", rate: "1.00000000" },
    { currency: "CAD", amount: "123.45", usdt: "86.58", rate: "0.70136064" },
    { currency: "GBP", amount: "100.00", usdt: "132.27", rate: "1.32266688" },
    { currency: "EUR", amount: "89.90", usdt: "99.36", rate: "1.10520430" },
    { currency: "JPY", amount: "5000", usdt: "31.25", rate: "0.00625000" },
    { currency: "PLN", amount: "249.99", usdt: "62.63", rate: "0.25053865" },
    { currency: "AUD", amount: "75.50", usdt: "51.23", rate: "0.67851866" },
  ];

  it.each(currencyCases)("converts $currency $amount into $usdt USDT", async ({
    currency,
    amount,
    usdt,
    rate,
  }) => {
    const fetchMock = stubQuote(makeQuote(currency, amount, usdt, rate));
    const { container } = renderCard("en", { amount, currency });

    await waitFor(() => expect(screen.getByText(usdt)).not.toBeNull());
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain(`amount=${amount}`);
    expect(url).toContain(`currency=${currency}`);
    expect(container.textContent).toContain(`USDT · TRC20`);
    expect(container.textContent).toContain(currency);
    expect(container.textContent).toContain("ECB 2026-11-13");
    // The QR always encodes only the wallet address, never an amount.
    expect(
      container.querySelector("svg[height='168'] title")?.textContent,
    ).toContain(ADDRESS);
  });

  it("formats fiat and rate numbers according to the active locale", async () => {
    stubQuote(makeQuote("EUR", "1234.50", "1364.00", "0.70136064"));
    const { container } = renderCard("de", {
      amount: "1234.50",
      currency: "EUR",
    });

    await waitFor(() => expect(screen.getByText("1364.00")).not.toBeNull());
    // Intl inserts a (narrow) no-break space before the currency code.
    expect(container.textContent).toMatch(/1\.234,50\s*EUR/u);
    expect(container.textContent).toContain("0,7014");
    expect(container.textContent).toContain("EZB 2026-11-13");
  });

  it("renders the QR code, puts the address below it, and copies on click", async () => {
    const fetchMock = stubQuote();
    const { container } = renderCard("en", { amount: null });

    const qr = container.querySelector("svg[height='168']");
    expect(qr).not.toBeNull();
    expect(qr?.querySelectorAll("path").length).toBeGreaterThan(0);
    expect(qr?.querySelector("title")?.textContent).toContain(ADDRESS);
    // No order amount => no FX request needed.
    expect(fetchMock).not.toHaveBeenCalled();

    const copyButton = screen.getByRole("button", {
      name: enMessages.usdtPayment.copyAddress,
    });
    expect(copyButton.textContent).toContain(ADDRESS);
    fireEvent.click(copyButton);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ADDRESS));
    await waitFor(() =>
      expect(screen.getByText(enMessages.usdtPayment.copied)).not.toBeNull(),
    );
  });

  it("keeps admin-authored notes and shows the localized stale-rate notice", async () => {
    stubQuote(
      makeQuote("CAD", "123.45", "86.58", "0.70136064", { stale: true }),
    );
    const { container } = renderCard("fr", {
      description: DESCRIPTION_WITH_NOTE,
    });

    await waitFor(() => expect(screen.getByText("86.58")).not.toBeNull());
    expect(container.textContent).toContain("Note from the shop");
    expect(container.textContent).toContain(frMessages.usdtPayment.staleRate);
    expect(container.textContent).not.toContain("收款地址");
  });

  it("refreshes the rate manually without showing the 60-second hint", async () => {
    const fetchMock = stubQuote();
    renderCard("en");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(
      screen.getByRole("button", { name: enMessages.usdtPayment.refreshRate }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/汇率每 60 秒/)).toBeNull();
  });

  it("localizes every FX failure instead of leaking backend English", async () => {
    const cases = [
      {
        status: 400,
        locale: "de",
        expected: deMessages.usdtPayment.quoteUnavailableInvalid,
      },
      {
        status: 422,
        locale: "fr",
        expected: frMessages.usdtPayment.quoteUnavailableCurrency,
      },
      {
        status: 502,
        locale: "es",
        expected: esMessages.usdtPayment.quoteUnavailable,
      },
    ] as const;

    for (const { status, locale, expected } of cases) {
      stubQuote({ error: "quote unavailable" }, { ok: false, status });
      const { container, unmount } = renderCard(locale, {
        amount: "123.45",
        currency: "XXX",
      });

      const text = expected.replace("{currency}", "XXX");
      await waitFor(() => expect(container.textContent).toContain(text));
      expect(container.textContent).not.toContain("quote unavailable");
      expect(container.textContent).not.toContain("86.58");
      expect(container.textContent).not.toMatch(CJK);
      unmount();
      vi.unstubAllGlobals();
    }
  });

  it("keeps the previous quote but shows a localized refresh warning", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => CAD_QUOTE,
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => ({ error: "quote unavailable" }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderCard("pl");

    await waitFor(() => expect(screen.getByText("86.58")).not.toBeNull());
    fireEvent.click(
      screen.getByRole("button", { name: plMessages.usdtPayment.refreshRate }),
    );
    await waitFor(() =>
      expect(container.textContent).toContain(
        plMessages.usdtPayment.quoteRefreshFailed,
      ),
    );
    expect(screen.getByText("86.58")).not.toBeNull();
  });

  it("falls back to plain text when no TRC20 address is present", () => {
    const { container } = renderCard("en", {
      description: "Offline payment instructions",
      amount: null,
    });
    expect(container.querySelector("svg[height='168']")).toBeNull();
    expect(screen.getByText("Offline payment instructions")).not.toBeNull();
  });
});
