"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { use, useEffect, useState } from "react";
import { UsdtOrderPayment } from "@/components/order/UsdtOrderPayment";
import { Button } from "@/components/ui/button";
import { useCheckout } from "@/contexts/CheckoutContext";
import { extractBasePath } from "@/lib/utils/path";

interface PaymentPageProps {
  params: Promise<{
    id: string;
    country: string;
    locale: string;
  }>;
}

/**
 * The step between checkout and the thank-you page for crypto orders.
 *
 * The order already exists (and has a number), but it is not paid until a
 * confirmed TRC20 deposit is matched by the automatic sweep. Only then do
 * we advance to the order-placed confirmation page. A timed-out order stays
 * here with a cancellation notice instead of pretending to be complete.
 */
export default function PaymentPage({ params }: PaymentPageProps) {
  const { id: cartId } = use(params);
  const pathname = usePathname();
  const basePath = extractBasePath(pathname);
  const router = useRouter();
  const t = useTranslations("usdtPayment");
  const { setSummaryContent } = useCheckout();
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    setSummaryContent(null);
  }, [setSummaryContent]);

  useEffect(() => {
    if (!confirmed) return;
    const timer = setTimeout(
      () => router.replace(`${basePath}/order-placed/${cartId}`),
      2500,
    );
    return () => clearTimeout(timer);
  }, [confirmed, basePath, cartId, router]);

  return (
    <div className="mx-auto max-w-2xl px-4 py-5 sm:px-6 sm:py-8">
      <div className="mb-5 text-center sm:mb-8">
        <h1 className="mb-1.5 text-xl font-bold text-gray-900 sm:mb-2 sm:text-2xl">
          {t("paymentPageTitle")}
        </h1>
        <p className="text-xs text-gray-500 sm:text-sm">
          {t("paymentPageSubtitle")}
        </p>
      </div>

      <UsdtOrderPayment
        cartId={cartId}
        onConfirmed={() => setConfirmed(true)}
        onCanceled={() => router.replace(`${basePath}/cart`)}
      />

      {confirmed ? (
        <div className="mt-6 text-center">
          <Button asChild>
            <Link href={`${basePath}/order-placed/${cartId}`}>
              {t("viewOrderDetails")}
            </Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
