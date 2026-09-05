import prisma from "../db.server";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
} from "react-router";
import {unauthenticated} from "../shopify.server";

type CustomerPoints = {
  customerId: string;
  eligibleOrders: number;
  totalSpent: number;
  pointsToGive: number;
};

async function getAdmin() {
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

  return admin;
}

function getSecret(request: Request) {
  const url = new URL(request.url);

  const suppliedSecret = url.searchParams.get("secret");
  const expectedSecret = process.env.BACKFILL_SECRET;

  if (!expectedSecret) {
    throw new Response("BACKFILL_SECRET tanımlı değil.", {
      status: 500,
    });
  }

  if (suppliedSecret !== expectedSecret) {
    throw new Response("Yetkisiz erişim.", {
      status: 401,
    });
  }

  return {
    secret: suppliedSecret,
    pathname: url.pathname,
  };
}

async function calculateBackfill(admin: any) {
  const allOrders: any[] = [];

  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const response = await admin.graphql(
      `
        query BelvoraBackfillOrders($cursor: String) {
          orders(
            first: 100
            after: $cursor
            sortKey: CREATED_AT
            reverse: false
          ) {
            nodes {
              id
              cancelledAt
              displayFinancialStatus

              currentTotalPriceSet {
                shopMoney {
                  amount
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
      throw new Error(
        json.errors
          .map((error: any) => error.message)
          .join(", ")
      );
    }

    const connection = json.data?.orders;

    allOrders.push(...(connection?.nodes || []));

    hasNextPage = Boolean(
      connection?.pageInfo?.hasNextPage
    );

    cursor =
      connection?.pageInfo?.endCursor || null;
  }

  const totals = new Map<string, CustomerPoints>();

  let eligibleOrderCount = 0;

  for (const order of allOrders) {
    const customerId = order.customer?.id;

    if (!customerId) continue;
    if (order.cancelledAt) continue;

    const status = String(
      order.displayFinancialStatus || ""
    ).toUpperCase();

    const eligible =
      status === "PAID" ||
      status === "PARTIALLY_REFUNDED";

    if (!eligible) continue;

    const amount = Number(
      order.currentTotalPriceSet?.shopMoney?.amount || 0
    );

    if (!Number.isFinite(amount) || amount <= 0) {
      continue;
    }

    eligibleOrderCount += 1;

    const current =
      totals.get(customerId) || {
        customerId,
        eligibleOrders: 0,
        totalSpent: 0,
        pointsToGive: 0,
      };

    current.eligibleOrders += 1;
    current.totalSpent += amount;

    totals.set(customerId, current);
  }

  const customers = Array.from(totals.values())
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
    scannedOrderCount: allOrders.length,
    eligibleOrderCount,
    customers,
  };
}

async function getExistingPoints(
  admin: any,
  customerIds: string[]
) {
  const pointMap = new Map<string, number>();

  for (let i = 0; i < customerIds.length; i += 50) {
    const ids = customerIds.slice(i, i + 50);

    const response = await admin.graphql(
      `
        query ExistingBelvoraPoints($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Customer {
              id

              metafield(
                namespace: "custom"
                key: "belvora_points"
              ) {
                value
              }
            }
          }
        }
      `,
      {
        variables: {
          ids,
        },
      }
    );

    const json = await response.json();

    if (json.errors?.length) {
      throw new Error(
        json.errors
          .map((error: any) => error.message)
          .join(", ")
      );
    }

    for (const customer of json.data?.nodes || []) {
      if (!customer?.id) continue;

      pointMap.set(
        customer.id,
        Number(customer.metafield?.value || 0)
      );
    }
  }

  return pointMap;
}

export async function loader({
  request,
}: LoaderFunctionArgs) {
  const {secret, pathname} = getSecret(request);

  const admin = await getAdmin();

  const calculation = await calculateBackfill(admin);

  const existingPoints = await getExistingPoints(
    admin,
    calculation.customers.map(
      (customer) => customer.customerId
    )
  );

  const customers = calculation.customers.map(
    (customer) => {
      const currentPoints =
        existingPoints.get(customer.customerId) || 0;

      return {
        ...customer,
        currentPoints,
        willApply: currentPoints <= 0,
      };
    }
  );

  const willApplyCount = customers.filter(
    (customer) => customer.willApply
  ).length;

  const skippedCount =
    customers.length - willApplyCount;

  const totalPointsToApply = customers
    .filter((customer) => customer.willApply)
    .reduce(
      (sum, customer) => sum + customer.pointsToGive,
      0
    );

  return {
    ok: true,

    actionUrl: `${pathname}?secret=${encodeURIComponent(
      secret || ""
    )}`,

    scannedOrderCount:
      calculation.scannedOrderCount,

    eligibleOrderCount:
      calculation.eligibleOrderCount,

    eligibleCustomerCount:
      customers.length,

    willApplyCount,
    skippedCount,
    totalPointsToApply,

    customers,
  };
}

export async function action({
  request,
}: ActionFunctionArgs) {
  getSecret(request);

  const formData = await request.formData();

  if (formData.get("intent") !== "apply-backfill") {
    throw new Response("Geçersiz işlem.", {
      status: 400,
    });
  }

  const admin = await getAdmin();

  const calculation = await calculateBackfill(admin);

  const existingPoints = await getExistingPoints(
    admin,
    calculation.customers.map(
      (customer) => customer.customerId
    )
  );

  const customersToWrite =
    calculation.customers.filter(
      (customer) =>
        (existingPoints.get(customer.customerId) || 0) <= 0
    );

  let written = 0;

  const skipped =
    calculation.customers.length -
    customersToWrite.length;

  const errors: string[] = [];

  for (let i = 0; i < customersToWrite.length; i += 20) {
    const batch = customersToWrite.slice(i, i + 20);

    const response = await admin.graphql(
      `
        mutation ApplyBelvoraPoints(
          $metafields: [MetafieldsSetInput!]!
        ) {
          metafieldsSet(metafields: $metafields) {
            metafields {
              id
              value
            }

            userErrors {
              field
              message
            }
          }
        }
      `,
      {
        variables: {
          metafields: batch.map((customer) => ({
            ownerId: customer.customerId,
            namespace: "custom",
            key: "belvora_points",
            type: "number_integer",
            value: String(customer.pointsToGive),
          })),
        },
      }
    );

    const json = await response.json();

    if (json.errors?.length) {
      errors.push(
        ...json.errors.map(
          (error: any) => error.message
        )
      );

      continue;
    }

    const userErrors =
      json.data?.metafieldsSet?.userErrors || [];

    if (userErrors.length) {
      errors.push(
        ...userErrors.map(
          (error: any) => error.message
        )
      );

      continue;
    }

    written += batch.length;
  }

  return {
    ok: errors.length === 0,
    written,
    skipped,
    totalEligible:
      calculation.customers.length,
    errors,
  };
}

export default function BackfillPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <main
      style={{
        fontFamily:
          'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        maxWidth: "1100px",
        margin: "40px auto",
        padding: "24px",
        color: "#2f2424",
      }}
    >
      <h1>
        Belvora Club — Geçmiş Puan Yükleme
      </h1>

      <p>
        1 TL uygun geçmiş harcama = 1 Belvora Puan.
      </p>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "12px",
          margin: "28px 0",
        }}
      >
        <Stat
          title="Taranan Sipariş"
          value={data.scannedOrderCount}
        />

        <Stat
          title="Uygun Sipariş"
          value={data.eligibleOrderCount}
        />

        <Stat
          title="Uygun Müşteri"
          value={data.eligibleCustomerCount}
        />

        <Stat
          title="Puan Yazılacak"
          value={data.willApplyCount}
        />

        <Stat
          title="Atlanacak"
          value={data.skippedCount}
        />

        <Stat
          title="Dağıtılacak Puan"
          value={data.totalPointsToApply}
        />
      </div>

      {actionData && (
        <div
          style={{
            padding: "18px",
            marginBottom: "24px",
            border: "1px solid #d8c9bf",
            borderRadius: "10px",
            background: "#fffaf7",
          }}
        >
          <strong>İşlem sonucu</strong>

          <p>
            Puan yazılan müşteri:{" "}
            {actionData.written}
          </p>

          <p>
            Atlanan müşteri:{" "}
            {actionData.skipped}
          </p>

          {actionData.errors?.length > 0 && (
            <pre>
              {JSON.stringify(
                actionData.errors,
                null,
                2
              )}
            </pre>
          )}
        </div>
      )}

      {data.willApplyCount > 0 && (
        <Form
          method="post"
          action={data.actionUrl}
        >
          <input
            type="hidden"
            name="intent"
            value="apply-backfill"
          />

          <button
            type="submit"
            style={{
              background: "#4a302f",
              color: "white",
              border: 0,
              borderRadius: "8px",
              padding: "13px 22px",
              fontSize: "15px",
              fontWeight: 600,
              cursor: "pointer",
              marginBottom: "28px",
            }}
          >
            Puanları Uygula
          </button>
        </Form>
      )}

      <p>
        <strong>Güvenlik:</strong>{" "}
        Mevcut Belvora Puanı 0'dan büyük olan
        müşteriler otomatik olarak atlanır.
      </p>

      <pre
        style={{
          background: "#f7f4f2",
          padding: "20px",
          borderRadius: "10px",
          overflow: "auto",
          whiteSpace: "pre-wrap",
          lineHeight: 1.45,
        }}
      >
        {JSON.stringify(
          data.customers,
          null,
          2
        )}
      </pre>
    </main>
  );
}

function Stat({
  title,
  value,
}: {
  title: string;
  value: number;
}) {
  return (
    <div
      style={{
        minWidth: "150px",
        padding: "16px",
        border: "1px solid #eadfd9",
        borderRadius: "10px",
        background: "#fffaf7",
      }}
    >
      <div
        style={{
          fontSize: "12px",
          opacity: 0.65,
          marginBottom: "6px",
        }}
      >
        {title}
      </div>

      <strong style={{fontSize: "22px"}}>
        {new Intl.NumberFormat("tr-TR").format(value)}
      </strong>
    </div>
  );
}