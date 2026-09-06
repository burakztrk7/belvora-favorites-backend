import type {ActionFunctionArgs} from "react-router";
import prisma from "../db.server";
import {authenticate} from "../shopify.server";

const REWARDS = {
  1000: {
    points: 1000,
    discount: 50,
    minimumCart: 750,
  },
  2000: {
    points: 2000,
    discount: 120,
    minimumCart: 1250,
  },
  3000: {
    points: 3000,
    discount: 200,
    minimumCart: 1750,
  },
  5000: {
    points: 5000,
    discount: 400,
    minimumCart: 2500,
  },
} as const;

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function createDiscountCode() {
  const random =
    Math.random().toString(36).slice(2, 9).toUpperCase();

  return `BELVORA-${random}`;
}

export const action = async ({
  request,
}: ActionFunctionArgs) => {
  const proxy =
    await authenticate.public.appProxy(request);

  const url = new URL(request.url);

  const rawCustomerId =
    url.searchParams.get("logged_in_customer_id");

  if (!rawCustomerId) {
    return json(
      {
        ok: false,
        error: "LOGIN_REQUIRED",
        message: "Puan kullanmak için giriş yapmalısınız.",
      },
      401
    );
  }

  const customerId =
    `gid://shopify/Customer/${rawCustomerId}`;

  const formData = await request.formData();

  const selectedPoints = Number(
    formData.get("points") || 0
  );

  const cartTotal = Number(
    formData.get("cartTotal") || 0
  );

  const reward =
    REWARDS[
      selectedPoints as keyof typeof REWARDS
    ];

  if (!reward) {
    return json(
      {
        ok: false,
        error: "INVALID_REWARD",
        message: "Geçersiz ödül seçimi.",
      },
      400
    );
  }

  if (
    !Number.isFinite(cartTotal) ||
    cartTotal < reward.minimumCart
  ) {
    return json(
      {
        ok: false,
        error: "MINIMUM_CART",
        message: `Bu ödül için minimum sepet tutarı ${reward.minimumCart} TL.`,
        minimumCart: reward.minimumCart,
      },
      400
    );
  }

  /*
   * App proxy authentication request'in gerçekten
   * Shopify üzerinden geldiğini doğrular.
   */
  const offlineSession =
    await prisma.session.findFirst({
      where: {
        isOnline: false,
      },
      orderBy: {
        id: "desc",
      },
    });

  if (!offlineSession?.shop) {
    return json(
      {
        ok: false,
        error: "NO_SESSION",
      },
      500
    );
  }

  const {unauthenticated} =
    await import("../shopify.server");

  const {admin} =
    await unauthenticated.admin(
      offlineSession.shop
    );

  /*
   * GERÇEK PUANI SHOPIFY'DAN OKU
   */
  const customerResponse = await admin.graphql(
    `
      query BelvoraRedeemCustomer($id: ID!) {
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

  if (customerJson.errors?.length) {
    return json(
      {
        ok: false,
        error: "CUSTOMER_QUERY_ERROR",
        details: customerJson.errors,
      },
      500
    );
  }

  if (!customerJson.data?.customer) {
    return json(
      {
        ok: false,
        error: "CUSTOMER_NOT_FOUND",
      },
      404
    );
  }

  const currentPoints = Number(
    customerJson.data.customer.metafield?.value ||
      0
  );

  if (currentPoints < reward.points) {
    return json(
      {
        ok: false,
        error: "NOT_ENOUGH_POINTS",
        message: "Yeterli Belvora Puanınız yok.",
        currentPoints,
      },
      400
    );
  }

  const newPoints =
    currentPoints - reward.points;

  const code = createDiscountCode();

  const now = new Date();

  const expiresAt = new Date(
    now.getTime() +
      24 * 60 * 60 * 1000
  );

  /*
   * SHOPIFY'DA İNDİRİM OLUŞTUR
   */
  const discountResponse = await admin.graphql(
    `
      mutation CreateBelvoraReward(
        $input: DiscountCodeBasicInput!
      ) {
        discountCodeBasicCreate(
          basicCodeDiscount: $input
        ) {
          codeDiscountNode {
            id
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
        input: {
          title:
            `Belvora Club - ${reward.points} Puan`,

          code,

          startsAt: now.toISOString(),

          endsAt: expiresAt.toISOString(),

          customerSelection: {
            customers: {
              add: [customerId],
            },
          },

          customerGets: {
            value: {
              discountAmount: {
                amount: reward.discount,
                appliesOnEachItem: false,
              },
            },

            items: {
              all: true,
            },
          },

          minimumRequirement: {
            subtotal: {
              greaterThanOrEqualToSubtotal:
                String(reward.minimumCart),
            },
          },

          combinesWith: {
            orderDiscounts: false,
            productDiscounts: false,
            shippingDiscounts: false,
          },

          usageLimit: 1,

          appliesOncePerCustomer: true,
        },
      },
    }
  );

  const discountJson =
    await discountResponse.json();

  if (discountJson.errors?.length) {
    return json(
      {
        ok: false,
        error: "DISCOUNT_GRAPHQL_ERROR",
        details: discountJson.errors,
      },
      500
    );
  }

  const discountErrors =
    discountJson.data
      ?.discountCodeBasicCreate
      ?.userErrors || [];

  if (discountErrors.length) {
    return json(
      {
        ok: false,
        error: "DISCOUNT_USER_ERROR",
        details: discountErrors,
      },
      400
    );
  }

  const discountId =
    discountJson.data
      ?.discountCodeBasicCreate
      ?.codeDiscountNode
      ?.id;

  /*
   * LEDGER'A REDEEM YAZ
   *
   * orderId boş çünkü henüz checkout siparişe dönüşmedi.
   * Böylece birden fazla redemption kaydı tutulabilir.
   */
  const transaction =
    await prisma.rewardTransaction.create({
      data: {
        customerId,
        orderId: null,
        type: "REDEEM",
        points: -reward.points,
        description:
          `${reward.points} puan → ${reward.discount} TL | ${code}`,
      },
    });

  /*
   * BAKİYEYİ DÜŞ
   */
  try {
    const pointsResponse =
      await admin.graphql(
        `
          mutation SetBelvoraPoints(
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

    const pointsJson =
      await pointsResponse.json();

    const errors = [
      ...(pointsJson.errors || []),
      ...(pointsJson.data
        ?.metafieldsSet
        ?.userErrors || []),
    ];

    if (errors.length) {
      throw new Error(
        JSON.stringify(errors)
      );
    }
  } catch (error) {
    /*
     * PUAN YAZIMI BAŞARISIZ OLURSA
     * LEDGER REDEEM KAYDINI GERİ AL.
     */
    await prisma.rewardTransaction.delete({
      where: {
        id: transaction.id,
      },
    });

    throw error;
  }

  return json({
    ok: true,

    reward: {
      pointsUsed: reward.points,
      discountAmount: reward.discount,
      minimumCart: reward.minimumCart,
    },

    discount: {
      id: discountId,
      code,
    },

    oldPoints: currentPoints,
    newPoints,
  });
};