import type { Store } from "@spree/sdk";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getStore, storeSeoTitle } from "@/lib/data/store";
import { SOCIAL_IMAGE_PATH } from "@/lib/seo";
import { getStoreUrl } from "@/lib/store";

/**
 * The store's meta description from the Store API, falling back to the
 * storefront's translated tagline so pages always carry a description.
 */
export async function storeMetaDescription(
  store: Store,
  locale: string,
): Promise<string> {
  if (store.meta_description) return store.meta_description;
  const t = await getTranslations({
    locale: locale as Locale,
    namespace: "footer",
  });
  return t("description");
}

function normalizeOpenGraphLocale(locale: string): string {
  const parts = locale.split(/[-_]/);
  if (parts.length < 2) return locale;
  return `${parts[0].toLowerCase()}_${parts[1].toUpperCase()}`;
}

interface StoreMetadataParams {
  locale: string;
}

/**
 * Cache the Store API lookup used by metadata under Cache Components.
 * `locale` is a primitive argument, so Next.js includes it in the cache key
 * automatically — unlike the removed remote cache that served one language
 * to every locale. Keeping only this fetch cached (instead of the whole
 * metadata function) leaves next-intl's request-bound getTranslations() in
 * the uncached fallback path where it is allowed.
 */
async function getCachedStore(locale: string): Promise<Store> {
  "use cache";
  return getStore(locale);
}

export async function generateStoreMetadata({
  locale,
}: StoreMetadataParams): Promise<Metadata> {
  const store = await getCachedStore(locale);
  const seoTitle = storeSeoTitle(store);
  const storeUrl = getStoreUrl();
  const metaDescription = await storeMetaDescription(store, locale);
  const metaKeywords = process.env.STORE_META_KEYWORDS;
  const twitter = process.env.STORE_TWITTER;

  let metadataBaseSpread: Partial<{ metadataBase: URL }> = {};
  if (storeUrl) {
    try {
      metadataBaseSpread = { metadataBase: new URL(storeUrl) };
    } catch {
      metadataBaseSpread = {};
    }
  }

  return {
    ...metadataBaseSpread,
    title: {
      template: `%s | ${seoTitle}`,
      default: seoTitle,
    },
    description: metaDescription,
    ...(metaKeywords ? { keywords: metaKeywords } : {}),
    openGraph: {
      siteName: store.name,
      locale: normalizeOpenGraphLocale(locale),
      type: "website",
      images: [SOCIAL_IMAGE_PATH],
    },
    twitter: {
      card: "summary_large_image",
      ...(twitter
        ? {
            site: twitter.startsWith("@") ? twitter : `@${twitter}`,
          }
        : {}),
    },
  };
}
