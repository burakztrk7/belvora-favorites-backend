import type {LoaderFunctionArgs} from "react-router";
import {useLoaderData} from "react-router";
import {authenticate} from "../shopify.server";

export async function loader({request}: LoaderFunctionArgs) {
  const {admin, session} = await authenticate.admin(request);

  const response = await admin.graphql(`
    query BackfillCustomers {
      customers(first: 50) {
        nodes {
          id
          firstName
          lastName

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
      name:
        [customer.firstName, customer.lastName]
          .filter(Boolean)
          .join(" ") || "İsimsiz müşteri",
      eligibleOrders: eligibleOrders.length,
      totalSpent: Math.round(totalSpent * 100) / 100,
      pointsToGive: Math.floor(totalSpent),
    };
  });

  return {
    ok: true,
    shop: session.shop,
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
      <h1>Belvora Club — Geçmiş Puan Önizlemesi</h1>

      <p>
        Bu sayfa yalnızca hesaplama yapar. Henüz müşterilere puan
        yazılmaz.
      </p>

      <pre
        style={{
          background: "#f5f5f5",
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