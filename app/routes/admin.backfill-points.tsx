import prisma from "../db.server";
import type {LoaderFunctionArgs} from "react-router";
import {useLoaderData} from "react-router";
import {unauthenticated} from "../shopify.server";

export async function loader({request}: LoaderFunctionArgs) {
  const url = new URL(request.url);

  const secret = url.searchParams.get("secret");
  const expectedSecret = process.env.BACKFILL_SECRET;

  if (!expectedSecret) {
    throw new Response("BACKFILL_SECRET Railway'den gelmiyor", {
      status: 500,
    });
  }

  if (secret !== expectedSecret) {
    throw new Response("Yetkisiz erişim", {
      status: 401,
    });
  }

  const offlineSession = await prisma.session.findFirst({
    where: {
      isOnline: false,
    },
    orderBy: {
      id: "desc",
    },
  });

  if (!offlineSession?.shop) {
    throw new Response("Shopify offline session bulunamadı", {
      status: 500,
    });
  }

  const {admin} = await unauthenticated.admin(offlineSession.shop);

  const response = await admin.graphql(`
    query BackfillPreview {
      orders(
        first: 250
        sortKey: CREATED_AT
        reverse: true
      ) {
        nodes {
          id
          name
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
      }
    }
  `);

  const json = await response.json();

  if (json.errors?.length) {
    return {
      ok: false,
      errors: json.errors,
      customerCount: 0,
      customers: [],
    };
  }

  const orders = json.data?.orders?.nodes || [];

  const customerTotals = new Map<
    string,
    {
      customerId: string;
      eligibleOrders: number;
      totalSpent: number;
      pointsToGive: number;
    }
  >();

  for (const order of orders) {
    const customerId = order.customer?.id;

    if (!customerId) continue;
    if (order.cancelledAt) continue;

    const financialStatus = String(
      order.displayFinancialStatus || ""
    ).toUpperCase();

    const eligible =
      financialStatus === "PAID" ||
      financialStatus === "PARTIALLY_REFUNDED";

    if (!eligible) continue;

    const amount = Number(
      order.currentTotalPriceSet?.shopMoney?.amount || 0
    );

    if (!Number.isFinite(amount) || amount <= 0) continue;

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

  return {
    ok: true,
    customerCount: result.length,
    customers: result,
  };
}

export default function BackfillPreview() {
  const data = useLoaderData<typeof loader>();

  return (
    <main
      style={{
        fontFamily: "Arial, sans-serif",
        maxWidth: "1000px",
        margin: "40px auto",
        padding: "20px",
      }}
    >
      <h1>Belvora Club — Puan Önizlemesi</h1>

      <p>
        Bu ekran yalnızca geçmiş siparişlerden puan
        hesaplıyor. Henüz müşterilere puan yazılmıyor.
      </p>

      <p>
        Uygun müşteri sayısı:{" "}
        <strong>{data.customerCount}</strong>
      </p>

      <pre
        style={{
          background: "#f4f4f4",
          padding: "20px",
          borderRadius: "8px",
          overflow: "auto",
          whiteSpace: "pre-wrap",
        }}
      >
        {JSON.stringify(data, null, 2)}
      </pre>
    </main>
  );
}