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

  const order = payload as any;

  if (!order?.id || !order?.customer?.id) {
    return new Response("OK", {status: 200});
  }

  const orderId =
    `gid://shopify/Order/${order.id}`;

  const customerId =
    `gid://shopify/Customer/${order.customer.id}`;

  /*
   * ------------------------------------------------
   * 1. SİPARİŞTEN KAZANILAN PUANI BUL
   * ------------------------------------------------
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

  /*
   * Daha önce kısmi iadelerde kaç puan
   * zaten geri alınmış?
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

  const alreadyRefundedPoints =
    Math.abs(
      previousRefunds._sum.points || 0
    );

  const remainingEarnPoints = earn
    ? Math.max(
        0,
        earn.points - alreadyRefundedPoints
      )
    : 0;

  /*
   * ------------------------------------------------
   * 2. BU SİPARİŞTE KULLANILAN CLUB PUANINI BUL
   * ------------------------------------------------
   */

  const redeemed =
    await prisma.rewardTransaction.findFirst({
      where: {
        orderId,
        customerId,
        type: "REDEEM",
        status: "CONFIRMED",
      },
    });

  const redeemedPoints = redeemed
    ? Math.abs(redeemed.points)
    : 0;

  /*
   * ------------------------------------------------
   * 3. DAHA ÖNCE İPTAL İŞLENDİ Mİ?
   * ------------------------------------------------
   */

  const existingCancel =
    await prisma.rewardTransaction.findFirst({
      where: {
        orderId,
        type: "ORDER_CANCEL",
      },
    });

  const existingRestore =
    await prisma.rewardTransaction.findFirst({
      where: {
        orderId,
        type: "REDEEM_RESTORE",
      },
    });

  const earnPointsToRemove =
    existingCancel
      ? 0
      : remainingEarnPoints;

  const redeemPointsToRestore =
    existingRestore
      ? 0
      : redeemedPoints;

  /*
   * Hiçbir işlem kalmadıysa çık.
   */
  if (
    earnPointsToRemove <= 0 &&
    redeemPointsToRestore <= 0
  ) {
    console.log(
      `Sipariş ${orderId}: iptal puan işlemleri zaten tamamlanmış.`
    );

    return new Response("OK", {
      status: 200,
    });
  }

  /*
   * ------------------------------------------------
   * 4. MEVCUT BAKİYE
   * ------------------------------------------------
   */

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

  /*
   * Kazanılan puanı geri al,
   * kullanılan Club puanını geri ver.
   */
  const newPoints =
    Math.max(
      0,
      currentPoints - earnPointsToRemove
    ) + redeemPointsToRestore;

  let cancelCreated = false;
  let restoreCreated = false;

  try {
    /*
     * ------------------------------------------------
     * 5. KAZANILAN PUANI GERİ AL
     * ------------------------------------------------
     */

    if (
      earn &&
      earnPointsToRemove > 0 &&
      !existingCancel
    ) {
      await prisma.rewardTransaction.create({
        data: {
          customerId,
          orderId,
          type: "ORDER_CANCEL",
          status: "CONFIRMED",
          points: -earnPointsToRemove,
          description:
            `İptal edilen sipariş ${order.name || order.id}`,
        },
      });

      cancelCreated = true;
    }

    /*
     * ------------------------------------------------
     * 6. HARCANAN CLUB PUANINI GERİ VER
     * ------------------------------------------------
     */

    if (
      redeemed &&
      redeemPointsToRestore > 0 &&
      !existingRestore
    ) {
      await prisma.rewardTransaction.create({
        data: {
          customerId,
          orderId,
          type: "REDEEM_RESTORE",
          status: "CONFIRMED",
          points: redeemPointsToRestore,
          description:
            `İptal nedeniyle Club puanı iade edildi | ${
              order.name || order.id
            }`,
        },
      });

      restoreCreated = true;
    }

    /*
     * ------------------------------------------------
     * 7. SHOPIFY BAKİYESİNİ GÜNCELLE
     * ------------------------------------------------
     */

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

    if (updateJson.errors?.length) {
      throw new Error(
        JSON.stringify(updateJson.errors)
      );
    }

    const userErrors =
      updateJson.data
        ?.metafieldsSet
        ?.userErrors || [];

    if (userErrors.length > 0) {
      throw new Error(
        JSON.stringify(userErrors)
      );
    }

  } catch (error) {
    /*
     * Shopify bakiyesi yazılamazsa
     * oluşturduğumuz ledger kayıtlarını geri al.
     */

    if (cancelCreated) {
      await prisma.rewardTransaction.deleteMany({
        where: {
          orderId,
          type: "ORDER_CANCEL",
        },
      });
    }

    if (restoreCreated) {
      await prisma.rewardTransaction.deleteMany({
        where: {
          orderId,
          type: "REDEEM_RESTORE",
        },
      });
    }

    throw error;
  }

  console.log(
    [
      `✅ ${order.name || orderId} iptal edildi`,
      `-${earnPointsToRemove} kazanılmış puan`,
      `+${redeemPointsToRestore} kullanılan Club puanı iade`,
      `Yeni bakiye: ${newPoints}`,
    ].join(" | ")
  );

  return new Response("OK", {
    status: 200,
  });
};