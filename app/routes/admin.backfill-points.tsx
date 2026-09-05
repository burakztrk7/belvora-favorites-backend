import type {LoaderFunctionArgs} from "react-router";
import {useLoaderData} from "react-router";
import {unauthenticated} from "../shopify.server";

export async function loader({request}: LoaderFunctionArgs) {
  const url = new URL(request.url);

  const secret = url.searchParams.get("secret");
  const expectedSecret = process.env.BACKFILL_SECRET;

  if (!expectedSecret || secret !== expectedSecret) {
    throw new Response("Yetkisiz erişim", {status: 401});
  }

  const shop = process.env.SHOP_DOMAIN;

  if (!shop) {
    throw new Response("SHOP_DOMAIN tanımlı değil", {status: 500});
  }

  const {admin} = await unauthenticated.admin(shop);

  const response = await admin.graphql(`
    query BackfillPreview {
      customers(first: 50) {
        nodes {
          id

          orders(first: 100) {
            nodes {
              id
              name
              cancelledAt
              displayFinancialStatus

              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
            }
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
      customers: [],
    };
  }

  const customers = json.data?.customers?.nodes || [];

  const result = customers.map((customer: any) => {
    const eligibleOrders = (customer.orders?.nodes || []).filter(
      (order: any) => {
        const paid =
          order.displayFinancialStatus === "PAID" ||
          order.displayFinancialStatus === "PARTIALLY_REFUNDED";

        return paid && !order.cancelledAt;
      }
    );

    const totalSpent = eligibleOrders.reduce(
      (sum: number, order: any) =>
        sum + Number(order.totalPriceSet?.shopMoney?.amount || 0),
      0
    );

    return {
      customerId: customer.id,
      eligibleOrders: eligibleOrders.length,
      totalSpent: Number(totalSpent.toFixed(2)),
      pointsToGive: Math.floor(totalSpent),
    };
  });

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
        maxWidth: "900px",
        margin: "40px auto",
        padding: "20px",
      }}
    >
      <h1>Belvora Club — Puan Önizlemesi</h1>

      <p>
        Henüz hiçbir müşteriye puan yazılmıyor.
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