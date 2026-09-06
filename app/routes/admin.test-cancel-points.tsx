import type {LoaderFunctionArgs} from "react-router";
import {useLoaderData} from "react-router";
import prisma from "../db.server";
import {unauthenticated} from "../shopify.server";

async function getAdmin() {
  const offlineSession = await prisma.session.findFirst({
    where: {isOnline: false},
    orderBy: {id: "desc"},
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
    orderId: url.searchParams.get("orderId"),
    apply: url.searchParams.get("apply"),
    secret: supplied,
  };
}

export async function loader({
  request,
}: LoaderFunctionArgs) {
  const {orderId, apply, secret} =
    checkSecret(request);

  if (!orderId) {
    return {
      ok: false,
      message:
        "URL'ye orderId ekle. Örn: ?secret=XXX&orderId=gid://shopify/Order/123",
    };
  }

  const earn =
    await prisma.rewardTransaction.findUnique({
      where: {
        orderId_type: {
          orderId,
          type: "ORDER_EARN",
        },
      },
    });

  if (!earn) {
    return {
      ok: false,
      message:
        "Bu sipariş için ORDER_EARN bulunamadı.",
    };
  }

  const existingCancel =
    await prisma.rewardTransaction.findUnique({
      where: {
        orderId_type: {
          orderId,
          type: "ORDER_CANCEL",
        },
      },
    });

  if (existingCancel) {
    return {
      ok: true,
      alreadyApplied: true,
      message:
        "Bu siparişin puanı zaten geri alınmış.",
      earn,
    };
  }

  if (apply !== "yes") {
    return {
      ok: true,
      preview: true,
      earn,
      applyUrl:
        `/admin/test-cancel-points` +
        `?secret=${encodeURIComponent(secret || "")}` +
        `&orderId=${encodeURIComponent(orderId)}` +
        `&apply=yes`,
    };
  }

  const admin = await getAdmin();

  const customerId = earn.customerId;
  const pointsToRemove = Math.abs(earn.points);

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
        id: customerId,
      },
    }
  );

  const customerJson =
    await customerResponse.json();

  const currentPoints = Number(
    customerJson.data?.customer?.metafield?.value ||
      0
  );

  const newPoints = Math.max(
    0,
    currentPoints - pointsToRemove
  );

  await prisma.rewardTransaction.create({
    data: {
      customerId,
      orderId,
      type: "ORDER_CANCEL",
      points: -pointsToRemove,
      description:
        "Manuel iptal testi",
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
              ownerId: customerId,
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

    const userErrors =
      updateJson.data?.metafieldsSet
        ?.userErrors || [];

    if (
      updateJson.errors?.length ||
      userErrors.length
    ) {
      throw new Error(
        JSON.stringify({
          errors: updateJson.errors,
          userErrors,
        })
      );
    }
  } catch (error) {
    await prisma.rewardTransaction.deleteMany({
      where: {
        orderId,
        type: "ORDER_CANCEL",
      },
    });

    throw error;
  }

  return {
    ok: true,
    applied: true,
    pointsRemoved: pointsToRemove,
    oldBalance: currentPoints,
    newBalance: newPoints,
  };
}

export default function TestCancelPoints() {
  const data = useLoaderData<typeof loader>();

  return (
    <main
      style={{
        fontFamily: "Arial, sans-serif",
        maxWidth: "800px",
        margin: "40px auto",
        padding: "20px",
      }}
    >
      <h1>Belvora Club — İptal Testi</h1>

      <pre
        style={{
          background: "#f5f5f5",
          padding: "20px",
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
          İptal Puanını Geri Al
        </a>
      )}
    </main>
  );
}