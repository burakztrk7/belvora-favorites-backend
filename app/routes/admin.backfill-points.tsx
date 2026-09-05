import prisma from "../db.server";
import type {LoaderFunctionArgs} from "react-router";
import {useLoaderData} from "react-router";
import {unauthenticated} from "../shopify.server";

type CustomerPoints = {
  customerId: string;
  eligibleOrders: number;
  totalSpent: number;
  pointsToGive: number;
};

export async function loader({request}: LoaderFunctionArgs) {
  // --------------------------------------------------
  // 1. SECRET KONTROLÜ
  // --------------------------------------------------

  const url = new URL(request.url);

  const secret = url.searchParams.get("secret");
  const expectedSecret = process.env.BACKFILL_SECRET;

  if (!expectedSecret) {
    throw new Response("BACKFILL_SECRET tanımlı değil.", {
      status: 500,
    });
  }

  if (secret !== expectedSecret) {
    throw new Response("Yetkisiz erişim.", {
      status: 401,
    });
  }

  // --------------------------------------------------
  // 2. SHOPIFY OFFLINE SESSION BUL
  // --------------------------------------------------

  const offlineSession = await prisma.session.findFirst({
    where: {
      isOnline: false,
    },
    orderBy: {
      id: "desc",
    },
  });

  if (!offlineSession?.shop) {
    throw new Response("Shopify offline session bulunamadı.", {
      status: 500,
    });
  }

  const {admin} = await unauthenticated.admin(
    offlineSession.shop
  );

  // --------------------------------------------------
  // 3. TÜM SİPARİŞLERİ PAGINATION İLE ÇEK
  // --------------------------------------------------

  const allOrders: any[] = [];

  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const response = await admin.graphql(
      `
        query BelvoraLoyaltyOrders($cursor: String) {
          orders(
            first: 100
            after: $cursor
            sortKey: CREATED_AT
            reverse: false
          ) {
            nodes {
              id
              name
              createdAt
              cancelledAt
              displayFinancialStatus

              currentTotalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }

              customer {
                id
              }
            }

            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      {
        variables: {
          cursor,
        },
      }
    );

    const json = await response.json();

    if (json.errors?.length) {
      return {
        ok: false,
        errors: json.errors,
        scannedOrderCount: allOrders.length,
        eligibleOrderCount: 0,
        customerCount: 0,
        totalPointsToGive: 0,
        customers: [],
      };
    }

    const connection = json.data?.orders;

    const nodes = connection?.nodes || [];

    allOrders.push(...nodes);

    hasNextPage = Boolean(
      connection?.pageInfo?.hasNextPage
    );

    cursor =
      connection?.pageInfo?.endCursor || null;
  }

  // --------------------------------------------------
  // 4. UYGUN SİPARİŞLERİ MÜŞTERİYE GÖRE TOPLA
  // --------------------------------------------------

  const customerTotals = new Map<string, CustomerPoints>();

  let eligibleOrderCount = 0;

  for (const order of allOrders) {
    const customerId = order.customer?.id;

    // Müşteriye bağlı olmayan siparişi geç
    if (!customerId) {
      continue;
    }

    // İptal edilmiş siparişi geç
    if (order.cancelledAt) {
      continue;
    }

    const financialStatus = String(
      order.displayFinancialStatus || ""
    ).toUpperCase();

    // Sadece ödenmiş siparişler
    const isEligible =
      financialStatus === "PAID" ||
      financialStatus === "PARTIALLY_REFUNDED";

    if (!isEligible) {
      continue;
    }

    // İadeler sonrası mevcut sipariş tutarı
    const amount = Number(
      order.currentTotalPriceSet?.shopMoney?.amount || 0
    );

    if (!Number.isFinite(amount) || amount <= 0) {
      continue;
    }

    eligibleOrderCount += 1;

    const current =
      customerTotals.get(customerId) || {
        customerId,
        eligibleOrders: 0,
        totalSpent: 0,
        pointsToGive: 0,
      };

    current.eligibleOrders += 1;
    current.totalSpent += amount;

    customerTotals.set(customerId, current);
  }

  // --------------------------------------------------
  // 5. PUANI HESAPLA
  // 1 TL = 1 PUAN
  // --------------------------------------------------

  const result = Array.from(customerTotals.values())
    .map((customer) => {
      const totalSpent = Number(
        customer.totalSpent.toFixed(2)
      );

      return {
        customerId: customer.customerId,
        eligibleOrders: customer.eligibleOrders,
        totalSpent,
        pointsToGive: Math.floor(totalSpent),
      };
    })
    .filter((customer) => customer.pointsToGive > 0)
    .sort((a, b) => b.pointsToGive - a.pointsToGive);

  const totalPointsToGive = result.reduce(
    (sum, customer) => sum + customer.pointsToGive,
    0
  );

  // --------------------------------------------------
  // 6. SADECE ÖNİZLEME
  // HENÜZ METAFIELD YAZMIYORUZ
  // --------------------------------------------------

  return {
    ok: true,

    scannedOrderCount: allOrders.length,
    eligibleOrderCount,

    customerCount: result.length,

    totalPointsToGive,

    customers: result,
  };
}

export default function BackfillPreview() {
  const data = useLoaderData<typeof loader>();

  return (
    <main
      style={{
        fontFamily:
          'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        maxWidth: "1100px",
        margin: "40px auto",
        padding: "24px",
        color: "#241b1b",
      }}
    >
      <h1
        style={{
          marginBottom: "8px",
        }}
      >
        Belvora Club — Puan Önizlemesi
      </h1>

      <p>
        Bu ekran yalnızca hesaplama yapıyor.
        Henüz hiçbir müşterinin puan bakiyesi değiştirilmiyor.
      </p>

      {"scannedOrderCount" in data && (
        <div
          style={{
            display: "flex",
            gap: "16px",
            flexWrap: "wrap",
            margin: "28px 0",
          }}
        >
          <StatBox
            title="Taranan Sipariş"
            value={data.scannedOrderCount}
          />

          <StatBox
            title="Uygun Sipariş"
            value={data.eligibleOrderCount}
          />

          <StatBox
            title="Puan Alacak Müşteri"
            value={data.customerCount}
          />

          <StatBox
            title="Toplam Dağıtılacak Puan"
            value={data.totalPointsToGive}
          />
        </div>
      )}

      <pre
        style={{
          background: "#f7f4f2",
          padding: "22px",
          borderRadius: "12px",
          overflow: "auto",
          whiteSpace: "pre-wrap",
          lineHeight: "1.5",
        }}
      >
        {JSON.stringify(data, null, 2)}
      </pre>
    </main>
  );
}

function StatBox({
  title,
  value,
}: {
  title: string;
  value: number;
}) {
  return (
    <div
      style={{
        minWidth: "180px",
        padding: "18px",
        border: "1px solid #eadfd9",
        borderRadius: "12px",
        background: "#fffaf7",
      }}
    >
      <div
        style={{
          fontSize: "13px",
          opacity: 0.65,
          marginBottom: "6px",
        }}
      >
        {title}
      </div>

      <strong
        style={{
          fontSize: "24px",
        }}
      >
        {new Intl.NumberFormat("tr-TR").format(value)}
      </strong>
    </div>
  );
}