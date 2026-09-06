import type {ActionFunctionArgs} from "react-router";
import prisma from "../db.server";
import {authenticate} from "../shopify.server";

export const action = async ({
  request,
}: ActionFunctionArgs) => {
  const {payload, shop, topic, admin} =
    await authenticate.webhook(request);

  console.log(`Webhook received: ${topic} for ${shop}`);

  if (!admin) {
    return new Response("OK", {status: 200});
  }

  const refund = payload as any;

  const rawRefundId = refund?.id;
  const rawOrderId = refund?.order_id;

  if (!rawRefundId || !rawOrderId) {
    console.log("Refund veya order ID bulunamadı.");
    return new Response("OK", {status: 200});
  }

  const refundId =
    `gid://shopify/Refund/${rawRefundId}`;

  const orderId =
    `gid://shopify/Order/${rawOrderId}`;

  /*
   * Aynı refund ikinci kez işlenmesin.
   */
  const existingRefund =
    await prisma.rewardTransaction.findUnique({
      where: {
        referenceId_type: {
          referenceId: refundId,
          type: "ORDER_REFUND",
        },
      },
    });

  if (existingRefund) {
    console.log(
      `Refund ${refundId} zaten puan sisteminde işlendi.`
    );

    return new Response("OK", {status: 200});
  }

  /*
   * Sipariş daha önce puan kazandırmış mı?
   */
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
    console.log(
      `Sipariş ${orderId} için ORDER_EARN yok. Puan düşülmedi.`
    );

    return new Response("OK", {status: 200});
  }

  /*
   * Sipariş tamamen iptal edildiyse puan zaten
   * ORDER_CANCEL ile geri alınmış olabilir.
   */
  const cancel =
    await prisma.rewardTransaction.findUnique({
      where: {
        orderId_type: {
          orderId,
          type: "ORDER_CANCEL",
        },
      },
    });

  if (cancel) {
    console.log(
      `Sipariş ${orderId} zaten iptal nedeniyle puan düşümü almış.`
    );

    return new Response("OK", {status: 200});
  }

  /*
   * Refund tutarını Shopify GraphQL'den kesin olarak oku.
   * totalRefundedSet, refund üzerindeki toplam iade tutarını verir.
   */
  const refundResponse = await admin.graphql(
    `
      query BelvoraRefundAmount($id: ID!) {
        refund(id: $id) {
          id

          totalRefundedSet {
            shopMoney {
              amount
              currencyCode
            }
          }

          order {
            id
            customer {
              id
            }
          }
        }
      }
    `,
    {
      variables: {
        id: refundId,
      },
    }
  );

  const refundJson = await refundResponse.json();

  if (refundJson.errors?.length) {
    throw new Error(
      refundJson.errors
        .map((e: any) => e.message)
        .join(", ")
    );
  }

  const refundData = refundJson.data?.refund;

  if (!refundData) {
    console.log(`Refund ${refundId} bulunamadı.`);
    return new Response("OK", {status: 200});
  }

  const customerId =
    refundData.order?.customer?.id;

  if (!customerId) {
    console.log(
      `Refund ${refundId}: müşteri bulunamadı.`
    );

    return new Response("OK", {status: 200});
  }

  const refundAmount = Number(
    refundData.totalRefundedSet
      ?.shopMoney?.amount || 0
  );

  if (
    !Number.isFinite(refundAmount) ||
    refundAmount <= 0
  ) {
    console.log(
      `Refund ${refundId}: geçerli iade tutarı yok.`
    );

    return new Response("OK", {status: 200});
  }

  /*
   * 1 TL = 1 puan
   */
  const rawPointsToRemove =
    Math.floor(refundAmount);

  /*
   * Güvenlik:
   * toplam refund puanı, siparişin kazandırdığı
   * puandan fazla olamasın.
   */
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

  const maxRemainingRefundPoints =
    Math.max(
      0,
      earn.points - alreadyRemoved
    );

  const pointsToRemove =
    Math.min(
      rawPointsToRemove,
      maxRemainingRefundPoints
    );

  if (pointsToRemove <= 0) {
    console.log(
      `Refund ${refundId}: geri alınacak puan kalmamış.`
    );

    return new Response("OK", {status: 200});
  }

  /*
   * Mevcut müşteri bakiyesini oku.
   */
  const customerResponse = await admin.graphql(
    `
      query BelvoraCustomerPoints($id: ID!) {
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

  const newPoints =
    Math.max(
      0,
      currentPoints - pointsToRemove
    );

  /*
   * Önce ledger kaydını yaz.
   */
  try {
    await prisma.rewardTransaction.create({
      data: {
        customerId,
        orderId,
        referenceId: refundId,
        type: "ORDER_REFUND",
        status: "CONFIRMED",
        points: -pointsToRemove,
        description:
          `İade ${refundId} | ${refundAmount} TL`,
      },
    });
  } catch (error: any) {
    if (error?.code === "P2002") {
      console.log(
        `Refund ${refundId} zaten işlendi.`
      );

      return new Response("OK", {
        status: 200,
      });
    }

    throw error;
  }

  /*
   * Sonra müşteri bakiyesini güncelle.
   */
  try {
    const updateResponse =
      await admin.graphql(
        `
          mutation UpdateBelvoraPoints(
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

    if (updateJson.errors?.length) {
      throw new Error(
        updateJson.errors
          .map((e: any) => e.message)
          .join(", ")
      );
    }

    const userErrors =
      updateJson.data
        ?.metafieldsSet
        ?.userErrors || [];

    if (userErrors.length > 0) {
      throw new Error(
        userErrors
          .map((e: any) => e.message)
          .join(", ")
      );
    }
  } catch (error) {
    /*
     * Shopify bakiyesi yazılamazsa ledger kaydını geri al.
     */
    await prisma.rewardTransaction.deleteMany({
      where: {
        referenceId: refundId,
        type: "ORDER_REFUND",
      },
    });

    throw error;
  }

  console.log(
    [
      `✅ Refund ${refundId}`,
      `Sipariş: ${orderId}`,
      `İade: ${refundAmount} TL`,
      `-${pointsToRemove} puan`,
      `Yeni bakiye: ${newPoints}`,
    ].join(" | ")
  );

  return new Response("OK", {
    status: 200,
  });
};