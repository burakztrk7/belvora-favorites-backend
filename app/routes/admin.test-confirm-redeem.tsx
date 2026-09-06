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

export async function loader({
  request,
}: LoaderFunctionArgs) {
  const {secret, apply} = checkSecret(request);

  const pending =
    await prisma.rewardTransaction.findFirst({
      where: {
        type: "REDEEM",
        status: "PENDING",
      },
      orderBy: {
        createdAt: "desc",
      },
    });

  if (!pending) {
    return {
      ok: false,
      message:
        "Aktif PENDING Belvora Club ödülü bulunamadı.",
    };
  }

  if (apply !== "yes") {
    return {
      ok: true,
      preview: true,
      pending,
      applyUrl:
        `/admin/test-confirm-redeem` +
        `?secret=${encodeURIComponent(secret || "")}` +
        `&apply=yes`,
    };
  }

  const admin = await getAdmin();

  const customerResponse = await admin.graphql(
    `
      query TestRedeemCustomer($id: ID!) {
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
        id: pending.customerId,
      },
    }
  );

  const customerJson =
    await customerResponse.json();

  if (customerJson.errors?.length) {
    throw new Error(
      customerJson.errors
        .map((e: any) => e.message)
        .join(", ")
    );
  }

  const currentPoints = Number(
    customerJson.data?.customer
      ?.metafield?.value || 0
  );

  const pointsToRemove =
    Math.abs(pending.points);

  const newPoints = Math.max(
    0,
    currentPoints - pointsToRemove
  );

  /*
   * Önce PENDING kaydı CONFIRMED yap.
   * Test olduğu için sahte bir test orderId kullanmıyoruz.
   */
  await prisma.rewardTransaction.update({
    where: {
      id: pending.id,
    },
    data: {
      status: "CONFIRMED",
      redeemedAt: new Date(),
      description:
        `${pointsToRemove} puan kullanıldı | TEST | ` +
        `${pending.discountCode || "kod yok"}`,
    },
  });

  try {
    const updateResponse = await admin.graphql(
      `
        mutation TestSetBelvoraPoints(
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
              ownerId: pending.customerId,
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

    if (updateJson.errors?.length) {
      throw new Error(
        JSON.stringify(updateJson.errors)
      );
    }

    const userErrors =
      updateJson.data?.metafieldsSet?.userErrors || [];

    if (userErrors.length > 0) {
      throw new Error(
        JSON.stringify(userErrors)
      );
    }

  } catch (error) {
    /*
     * Shopify puanı yazılamazsa test kaydını tekrar PENDING'e al.
     */
    await prisma.rewardTransaction.update({
      where: {
        id: pending.id,
      },
      data: {
        status: "PENDING",
        redeemedAt: null,
      },
    });

    throw error;
  }

  return {
    ok: true,
    applied: true,

    discountCode:
      pending.discountCode,

    pointsRemoved:
      pointsToRemove,

    oldBalance:
      currentPoints,

    newBalance:
      newPoints,
  };
}

export default function TestConfirmRedeem() {
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
        Belvora Club — Redemption Confirm Test
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
            marginTop: "20px",
            padding: "12px 20px",
            background: "#4a302f",
            color: "#fff",
            textDecoration: "none",
            borderRadius: "8px",
          }}
        >
          PENDING Ödülü CONFIRMED Yap
        </a>
      )}
    </main>
  );
}