"use client";

import {
  Check,
  Link2,
  MessageCircle,
  Send,
  Share2,
  Twitter,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

interface ShareProductProps {
  productName: string;
}

/**
 * Product share row. On devices with the Web Share API (most phones) the
 * first button opens the OS share sheet, which lets shoppers pick WhatsApp,
 * Telegram, SMS and anything else installed. Everywhere else we offer deep
 * links into WhatsApp / Telegram / X plus a copy-link button.
 *
 * The rich preview inside a chat (title, description, thumbnail, click
 * through to the product page) is rendered by the messenger itself from the
 * page's Open Graph meta tags — see generateProductMetadata().
 */
export function ShareProduct({ productName }: ShareProductProps) {
  const t = useTranslations("productShare");
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [hasNativeShare, setHasNativeShare] = useState(false);

  // `navigator.share` only exists on secure contexts, mostly mobile browsers.
  // Checking it after mount keeps SSR and the first client render identical.
  useEffect(() => {
    setHasNativeShare(
      typeof navigator !== "undefined" && typeof navigator.share === "function",
    );
  }, []);

  useEffect(() => {
    if (!copied && !copyFailed) return;
    const timer = setTimeout(() => {
      setCopied(false);
      setCopyFailed(false);
    }, 2000);
    return () => clearTimeout(timer);
  }, [copied, copyFailed]);

  // Canonical path only: dropping ?category_id=… keeps chat previews and
  // re-shares pointing at the plain product page.
  const productUrl = useCallback((): string => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}${window.location.pathname}`;
  }, []);

  const openShareWindow = useCallback((url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
  }, []);

  const shareNative = useCallback(async () => {
    try {
      await navigator.share({
        title: productName,
        text: productName,
        url: productUrl(),
      });
    } catch (error) {
      // Dismissing the share sheet is not a failure; any other error falls
      // back to WhatsApp so the shopper still gets somewhere to share.
      if (error instanceof Error && error.name !== "AbortError") {
        openShareWindow(
          `https://wa.me/?text=${encodeURIComponent(`${productName} ${productUrl()}`)}`,
        );
      }
    }
  }, [productName, productUrl, openShareWindow]);

  const shareWhatsapp = useCallback(() => {
    openShareWindow(
      `https://wa.me/?text=${encodeURIComponent(`${productName} ${productUrl()}`)}`,
    );
  }, [productName, productUrl, openShareWindow]);

  const shareTelegram = useCallback(() => {
    openShareWindow(
      `https://t.me/share/url?url=${encodeURIComponent(productUrl())}&text=${encodeURIComponent(productName)}`,
    );
  }, [productName, productUrl, openShareWindow]);

  const shareX = useCallback(() => {
    openShareWindow(
      `https://twitter.com/intent/tweet?url=${encodeURIComponent(productUrl())}&text=${encodeURIComponent(productName)}`,
    );
  }, [productName, productUrl, openShareWindow]);

  const copyLink = useCallback(async () => {
    const url = productUrl();
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard API needs a secure context too; fall back to execCommand.
      const textArea = document.createElement("textarea");
      textArea.value = url;
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(textArea);
      if (!ok) {
        setCopyFailed(true);
        return;
      }
    }
    setCopied(true);
  }, [productUrl]);

  const iconButtonClass =
    "inline-flex h-9 w-9 items-center justify-center rounded-full border border-gray-200 text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900";

  return (
    <div className="flex items-center gap-1.5">
      <span className="mr-0.5 text-sm font-medium text-gray-600">
        {t("share")}
      </span>
      {hasNativeShare ? (
        <button
          type="button"
          onClick={() => void shareNative()}
          title={t("shareNative")}
          aria-label={t("shareNative")}
          className={iconButtonClass}
        >
          <Share2 className="h-4 w-4" strokeWidth={1.8} />
        </button>
      ) : null}
      <button
        type="button"
        onClick={shareWhatsapp}
        title={t("shareWhatsapp")}
        aria-label={t("shareWhatsapp")}
        className={iconButtonClass}
      >
        <MessageCircle className="h-4 w-4" strokeWidth={1.8} />
      </button>
      <button
        type="button"
        onClick={shareTelegram}
        title={t("shareTelegram")}
        aria-label={t("shareTelegram")}
        className={iconButtonClass}
      >
        <Send className="h-4 w-4" strokeWidth={1.8} />
      </button>
      <button
        type="button"
        onClick={shareX}
        title={t("shareX")}
        aria-label={t("shareX")}
        className={iconButtonClass}
      >
        <Twitter className="h-4 w-4" strokeWidth={1.8} />
      </button>
      <button
        type="button"
        onClick={() => void copyLink()}
        title={copied ? t("copied") : t("copyLink")}
        aria-label={copied ? t("copied") : t("copyLink")}
        className={iconButtonClass}
      >
        {copied ? (
          <Check className="h-4 w-4 text-green-600" strokeWidth={2} />
        ) : (
          <Link2 className="h-4 w-4" strokeWidth={1.8} />
        )}
      </button>
      {copied ? (
        <span className="text-xs text-green-700" role="status">
          {t("copied")}
        </span>
      ) : null}
      {copyFailed ? (
        <span className="text-xs text-red-700" role="status">
          {t("copyFailed")}
        </span>
      ) : null}
    </div>
  );
}
