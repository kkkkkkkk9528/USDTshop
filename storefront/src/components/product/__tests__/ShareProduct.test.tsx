import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import deMessages from "../../../../messages/de.json";
import enMessages from "../../../../messages/en.json";
import esMessages from "../../../../messages/es.json";
import frMessages from "../../../../messages/fr.json";
import plMessages from "../../../../messages/pl.json";
import { ShareProduct } from "../ShareProduct";

const MESSAGES = {
  en: enMessages,
  de: deMessages,
  es: esMessages,
  fr: frMessages,
  pl: plMessages,
} as const;

type TestLocale = keyof typeof MESSAGES;

function renderShare(locale: TestLocale) {
  return render(
    <NextIntlClientProvider messages={MESSAGES[locale]} locale={locale}>
      <ShareProduct productName="Personal Blender" />
    </NextIntlClientProvider>,
  );
}

const openMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("open", openMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ShareProduct", () => {
  it("renders the WhatsApp deep link with the product name and URL", () => {
    renderShare("en");
    const button = screen.getByRole("button", {
      name: enMessages.productShare.shareWhatsapp,
    });
    expect(button).not.toBeNull();
    fireEvent.click(button);
    expect(window.open).toHaveBeenCalledTimes(1);
    const [url] = openMock.mock.calls[0];
    expect(String(url)).toContain("https://wa.me/?text=");
    expect(String(url)).toContain("Personal%20Blender");
  });

  it("opens the Telegram and X share intents", () => {
    renderShare("en");
    fireEvent.click(
      screen.getByRole("button", {
        name: enMessages.productShare.shareTelegram,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: enMessages.productShare.shareX }),
    );
    const urls = openMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((u) => u.startsWith("https://t.me/share/url?url="))).toBe(
      true,
    );
    expect(
      urls.some((u) => u.startsWith("https://twitter.com/intent/tweet?url=")),
    ).toBe(true);
  });

  it("copies the canonical product URL to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderShare("en");
    fireEvent.click(
      screen.getByRole("button", { name: enMessages.productShare.copyLink }),
    );
    await screen.findByText(enMessages.productShare.copied);
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("keeps every share label translated across the five locales", () => {
    for (const locale of Object.keys(MESSAGES) as TestLocale[]) {
      const { unmount } = renderShare(locale);
      expect(
        screen.getByRole("button", {
          name: MESSAGES[locale].productShare.shareWhatsapp,
        }),
      ).not.toBeNull();
      unmount();
    }
  });
});
