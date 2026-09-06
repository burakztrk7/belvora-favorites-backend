import type {ActionFunctionArgs} from "react-router";
import prisma from "../db.server";
import {authenticate, unauthenticated} from "../shopify.server";

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
    Math.random().toString(36).slice(2, 10).toUpperCase();

  return `BELVORA-${random}`;
}

export const action = async ({
  request,
}: ActionFunctionArgs) => {
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);

  const rawCustomerId =
    url.searchParams.get("logged_in_customer_id");

  if (!rawCustomerId) {
    return json(
      {
        ok: false,
        error: "LOGIN_REQUIRED",
        message:
          "Puan kullanmak için giriş yapmalısınız.",
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
        message:
          `Bu ödül için minimum sepet tutarı ${reward.minimumCart} TL.`,
      },
      400
    );
  }

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

  const {admin} = await unauthenticated.admin(
    offlineSession.shop
  );

  /*
   * SÜRESİ DOLMUŞ REZERVASYONLARI KAPAT
   */
  const now = new Date();

  await prisma.rewardTransaction.updateMany({
    where: {
      customerId,
      type: "REDEEM",
      status: "PENDING",
      expiresAt: {
        lt: now,
      },
    },
    data: {
      status: "EXPIRED",
    },
  });

  /*
   * MÜŞTERİNİN GERÇEK PUAN BAKİYESİNİ OKU
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

  /*
   * AKTİF REZERVASYONLARI BUL
   */
  const pendingReservations =
    await prisma.rewardTransaction.findMany({
      where: {
        customerId,
        type: "REDEEM",
        status: "PENDING",
        expiresAt: {
          gt: now,
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

  /*
   * Aynı ödül zaten oluşturulduysa
   * yeni kod üretme, mevcut kodu döndür.
   */
  const samePending =
    pendingReservations.find(
      (item) =>
        Math.abs(item.points) === reward.points &&
        item.discountCode
    );

  if (samePending) {
    return json({
      ok: true,
      reused: true,

      reward: {
        pointsUsed: reward.points,
        discountAmount: reward.discount,
        minimumCart: reward.minimumCart,
      },

      discount: {
        code: samePending.discountCode,
      },

      currentPoints,
      reservedPoints: reward.points,
      availablePoints:
        currentPoints - reward.points,
    });
  }

  /*
   * Aynı anda birden fazla aktif ödül
   * oluşturulmasını şimdilik engelliyoruz.
   */
  /*
 * FARKLI BİR ÖDÜL SEÇİLDİYSE
 * ESKİ PENDING ÖDÜLÜ İPTAL ET.
 */
if (pendingReservations.length > 0) {
  for (const oldPending of pendingReservations) {
    if (!oldPending.discountCode) continue;

    try {
      const lookupResponse = await admin.graphql(
        `
          query FindBelvoraDiscount($code: String!) {
            codeDiscountNodeByCode(code: $code) {
              id
            }
          }
        `,
        {
          variables: {
            code: oldPending.discountCode,
          },
        }
      );

      const lookupJson = await lookupResponse.json();

      const discountNodeId =
        lookupJson.data?.codeDiscountNodeByCode?.id;

      if (discountNodeId) {
        const deleteResponse = await admin.graphql(
          `
            mutation DeleteBelvoraDiscount($id: ID!) {
              discountCodeDelete(id: $id) {
                deletedCodeDiscountId

                userErrors {
                  field
                  message
                }
              }
            }
          `,
          {
            variables: {
              id: discountNodeId,
            },
          }
        );

        const deleteJson = await deleteResponse.json();

        const deleteErrors =
          deleteJson.data?.discountCodeDelete?.userErrors || [];

        if (deleteJson.errors?.length || deleteErrors.length) {
          console.error(
            "Eski Belvora kodu silinemedi:",
            oldPending.discountCode,
            deleteJson.errors,
            deleteErrors
          );
        }
      }
    } catch (error) {
      console.error(
        "Eski Belvora ödülü temizlenirken hata:",
        error
      );
    }

    await prisma.rewardTransaction.update({
      where: {
        id: oldPending.id,
      },
      data: {
        status: "REPLACED",
      },
    });
  }
}

  const reservedPoints = 0;

const availablePoints = currentPoints;

  if (availablePoints < reward.points) {
    return json(
      {
        ok: false,
        error: "NOT_ENOUGH_POINTS",
        message:
          "Yeterli kullanılabilir Belvora Puanınız yok.",
        currentPoints,
        availablePoints,
      },
      400
    );
  }

  const code = createDiscountCode();

  const expiresAt = new Date(
    now.getTime() +
      24 * 60 * 60 * 1000
  );

  /*
   * ÖNCE PENDING REZERVASYON OLUŞTUR
   * PUAN METAFIELD'DAN HENÜZ DÜŞMEZ.
   */
  const pending =
    await prisma.rewardTransaction.create({
      data: {
        customerId,
        orderId: null,
        type: "REDEEM",
        points: -reward.points,
        status: "PENDING",
        discountCode: code,
        expiresAt,
        description:
          `${reward.points} puan rezervasyonu → ${reward.discount} TL`,
      },
    });

  try {
    /*
     * SHOPIFY'DA MÜŞTERİYE ÖZEL
     * TEK KULLANIMLIK İNDİRİM OLUŞTUR
     */
    const discountResponse =
      await admin.graphql(
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

              context: {
                customers: {
                  add: [customerId],
                },
              },

              customerGets: {
                value: {
                  discountAmount: {
                    amount: String(
                      reward.discount
                    ),
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
                    String(
                      reward.minimumCart
                    ),
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
      throw new Error(
        JSON.stringify(
          discountJson.errors
        )
      );
    }

    const userErrors =
      discountJson.data
        ?.discountCodeBasicCreate
        ?.userErrors || [];

    if (userErrors.length > 0) {
      throw new Error(
        JSON.stringify(userErrors)
      );
    }

  } catch (error) {
    /*
     * İndirim oluşturulamazsa rezervasyonu sil.
     */
    await prisma.rewardTransaction.delete({
      where: {
        id: pending.id,
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
      code,
    },

    currentPoints,

    reservedPoints: reward.points,

    availablePoints:
      currentPoints - reward.points,

    expiresAt:
      expiresAt.toISOString(),
  });
};