import type {LoaderFunctionArgs} from "react-router";
import {authenticate} from "../shopify.server";

export async function loader({request}: LoaderFunctionArgs) {
  const {admin, session} = await authenticate.admin(request);

  const response = await admin.graphql(`
    query BackfillCustomers {
      customers(first: 50) {
        nodes {
          id
          email
          firstName
          lastName

          orders(first: 100) {
            nodes {
              id
              name
              cancelledAt
              financialStatus

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

  const customers = json.data?.customers?.nodes || [];

  const result = customers.map((customer: any) => {
    const eligibleOrders = (customer.orders?.nodes || []).filter((order: any) => {
      const paid =
        order.financialStatus === "PAID" ||
        order.financialStatus === "PARTIALLY_REFUNDED";

      const notCancelled = !order.cancelledAt;

      return paid && notCancelled;
    });

    const totalSpent = eligibleOrders.reduce(
      (sum: number, order: any) =>
        sum + Number(order.totalPriceSet?.shopMoney?.amount || 0),
      0
    );

    return {
      customerId: customer.id,
      email: customer.email,
      name: [customer.firstName, customer.lastName]
        .filter(Boolean)
        .join(" "),
      eligibleOrders: eligibleOrders.length,
      totalSpent,
      pointsToGive: Math.floor(totalSpent),
    };
  });

  return Response.json({
    ok: true,
    shop: session.shop,
    customers: result,
  });
}