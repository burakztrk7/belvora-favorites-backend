import type {LoaderFunctionArgs} from "react-router";
import {useLoaderData} from "react-router";
import prisma from "../db.server";
import {unauthenticated} from "../shopify.server";

function checkSecret(request: Request) {
  const url = new URL(request.url);

  const supplied = url.searchParams.get("secret");
  const expected = process.env.BACKFILL_SECRET;

  if (!expected || supplied !== expected) {
    throw new Response("Yetkisiz.", {
      status: 401,
    });
  }

  return {
    secret: supplied,
    apply: url.searchParams.get("apply"),
    reset: url.searchParams.get("reset"),
    amount: Number(url.searchParams.get("amount") || 300),
  };
}

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
    throw new Response("Offline session bulunamadı.", {
      status: 500,
    });
  }

  const {admin} = await unauthenticated.admin(
    offlineSession.shop
  );

  return admin;
}

async function findTestableEarn() {
  const earns = await prisma.rewardTransaction.findMany({
    where: {
      type: "ORDER_EARN",
      status: "CONFIRMED",
      orderId: {
        not: null,
      },
    },
    orderBy: {
      createdAt: "desc",
    },
    take: 50,
  });

  for (const earn of earns) {
    if (!earn.orderId) continue;

    const cancel = await prisma.rewardTransaction.findFirst({
      where: {
        orderId: earn.orderId,
        type: "ORDER_CANCEL",
        status: "CONFIRMED",
      },
    });

    if (!cancel) {
      return earn;
    }
  }

  return null;
}

export async function loader({
  request,
}: LoaderFunctionArgs) {
  const {secret, apply, reset, amount} =
    checkSecret(request);

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    return {
      ok: false,
      message: "Geçersiz test iade tutarı.",
    };
  }

  const earn = await findTestableEarn();

  if (!earn || !earn.orderId) {
    return {
      ok: false,
      message:
        "İptal edilmemiş, puan kazandırmış test edilebilir sipariş bulunamadı.",
    };
  }

  const orderId = earn.orderId;

  const testReference =
    `TEST_REFUND:${orderId}:${Math.floor(amount)}`;

  const existingTest =
    await prisma.rewardTransaction.findFirst({
      where: {
        referenceId: testReference,
        type: "ORDER_REFUND",
      },
    });

  const previousRefunds =
    await prisma.rewardTransaction.aggregate({
      where: {
        orderId,
        type: "ORDER_REFUND",
        status: "CONFIRMED",
      },
      _sum: {
        points: true,
      },
    });

  const alreadyRemoved =
    Math.abs(
      previousRefunds._sum.points || 0
    );

  const remainingEarnPoints =
    Math.max(
      0,
      earn.points - alreadyRemoved
    );

  /*
   * TESTİ GERİ AL
   */
  if (reset === "yes" && existingTest) {
    const admin = await getAdmin();

    const customerResponse = await admin.graphql(
      `
        query CustomerPoints($id: ID!) {
          customer(id: $id) {
            id
            metafield(
              namespace: "custom"
              key: "belvora_points"
            ) {
              value
            }
          }
        }
      `,
      {
        variables: {
          id: existingTest.customerId,
        },
      }
    );

    const customerJson =
      await customerResponse.json();

    const currentPoints = Number(
      customerJson.data?.customer
        ?.metafield?.value || 0
    );

    const pointsToRestore =
      Math.abs(existingTest.points);

    const newPoints =
      currentPoints + pointsToRestore;

    const updateResponse = await admin.graphql(
      `
        mutation RestorePoints(
          $metafields: [MetafieldsSetInput!]!
        ) {
          metafieldsSet(
            metafields: $metafields
          ) {
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
          metafields: [
            {
              ownerId: existingTest.customerId,
              namespace: "custom",
              key: "belvora_points",
              type: "number_integer",
              value: String(newPoints),
            },
          ],
        },
      }
    );

    const updateJson =
      await updateResponse.json();

    const errors = [
      ...(updateJson.errors || []),
      ...(updateJson.data
        ?.metafieldsSet
        ?.userErrors || []),
    ];

    if (errors.length) {
      throw new Error(
        JSON.stringify(errors)
      );
    }

    await prisma.rewardTransaction.delete({
      where: {
        id: existingTest.id,
      },
    });

    return {
      ok: true,
      reset: true,
      pointsRestored: pointsToRestore,
      oldBalance: currentPoints,
      newBalance: newPoints,
    };
  }

  /*
   * DAHA ÖNCE AYNI TEST YAPILDIYSA
   * İKİNCİ KEZ DÜŞME.
   */
  if (existingTest) {
    return {
      ok: true,
      alreadyApplied: true,
      message:
        "Aynı test refund daha önce işlendi. İkinci kez puan düşmedi.",
      existingTest,

      resetUrl:
        `/admin/test-refund-points` +
        `?secret=${encodeURIComponent(secret || "")}` +
        `&amount=${encodeURIComponent(String(amount))}` +
        `&reset=yes`,
    };
  }

  const pointsToRemove =
    Math.min(
      Math.floor(amount),
      remainingEarnPoints
    );

  if (pointsToRemove <= 0) {
    return {
      ok: false,
      message:
        "Bu siparişten geri alınabilecek puan kalmamış.",
      earn,
      alreadyRemoved,
    };
  }

  /*
   * ÖNİZLEME
   */
  if (apply !== "yes") {
    return {
      ok: true,
      preview: true,

      orderId,
      customerId: earn.customerId,

      orderEarnPoints:
        earn.points,

      previousRefundPoints:
        alreadyRemoved,

      remainingEarnPoints,

      simulatedRefundAmount:
        amount,

      pointsToRemove,

      applyUrl:
        `/admin/test-refund-points` +
        `?secret=${encodeURIComponent(secret || "")}` +
        `&amount=${encodeURIComponent(String(amount))}` +
        `&apply=yes`,
    };
  }

  /*
   * TEST REFUND'U UYGULA
   */
  const admin = await getAdmin();

  const customerResponse = await admin.graphql(
    `
      query CustomerPoints($id: ID!) {
        customer(id: $id) {
          id
          metafield(
            namespace: "custom"
            key: "belvora_points"
          ) {
            value
          }
        }
      }
    `,
    {
      variables: {
        id: earn.customerId,
      },
    }
  );

  const customerJson =
    await customerResponse.json();

  const currentPoints = Number(
    customerJson.data?.customer
      ?.metafield?.value || 0
  );

  const newPoints =
    Math.max(
      0,
      currentPoints - pointsToRemove
    );

  const transaction =
    await prisma.rewardTransaction.create({
      data: {
        customerId: earn.customerId,
        orderId,
        referenceId: testReference,
        type: "ORDER_REFUND",
        status: "CONFIRMED",
        points: -pointsToRemove,
        description:
          `TEST kısmi iade | ${amount} TL`,
      },
    });

  try {
    const updateResponse = await admin.graphql(
      `
        mutation UpdatePoints(
          $metafields: [MetafieldsSetInput!]!
        ) {
          metafieldsSet(
            metafields: $metafields
          ) {
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
          metafields: [
            {
              ownerId: earn.customerId,
              namespace: "custom",
              key: "belvora_points",
              type: "number_integer",
              value: String(newPoints),
            },
          ],
        },
      }
    );

    const updateJson =
      await updateResponse.json();

    const errors = [
      ...(updateJson.errors || []),
      ...(updateJson.data
        ?.metafieldsSet
        ?.userErrors || []),
    ];

    if (errors.length) {
      throw new Error(
        JSON.stringify(errors)
      );
    }
  } catch (error) {
    await prisma.rewardTransaction.delete({
      where: {
        id: transaction.id,
      },
    });

    throw error;
  }

  return {
    ok: true,
    applied: true,

    orderId,
    simulatedRefundAmount:
      amount,

    pointsRemoved:
      pointsToRemove,

    oldBalance:
      currentPoints,

    newBalance:
      newPoints,

    secondRunShouldNotDeductAgain:
      true,

    resetUrl:
      `/admin/test-refund-points` +
      `?secret=${encodeURIComponent(secret || "")}` +
      `&amount=${encodeURIComponent(String(amount))}` +
      `&reset=yes`,
  };
}

export default function TestRefundPoints() {
  const data = useLoaderData<typeof loader>();

  return (
    <main
      style={{
        fontFamily: "Arial, sans-serif",
        maxWidth: "850px",
        margin: "40px auto",
        padding: "20px",
      }}
    >
      <h1>
        Belvora Club — Refund Test
      </h1>

      <pre
        style={{
          padding: "20px",
          background: "#f5f5f5",
          borderRadius: "10px",
          overflow: "auto",
        }}
      >
        {JSON.stringify(data, null, 2)}
      </pre>

      {data.preview && data.applyUrl && (
        <a
          href={data.applyUrl}
          style={{
            display: "inline-block",
            padding: "12px 20px",
            background: "#4a302f",
            color: "#fff",
            textDecoration: "none",
            borderRadius: "8px",
          }}
        >
          300 TL Kısmi İadeyi Test Et
        </a>
      )}

      {data.resetUrl && (
        <a
          href={data.resetUrl}
          style={{
            display: "inline-block",
            marginLeft: "12px",
            padding: "12px 20px",
            background: "#777",
            color: "#fff",
            textDecoration: "none",
            borderRadius: "8px",
          }}
        >
          Testi Geri Al
        </a>
      )}
    </main>
  );
}