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
    console.error("Admin API session bulunamadı.");
    return new Response("OK", {status: 200});
  }

  const order = payload as any;

  const rawOrderId = order?.id;
  const rawCustomerId = order?.customer?.id;

  if (!rawOrderId) {
    console.log("Sipariş ID bulunamadı.");
    return new Response("OK", {status: 200});
  }

  if (!rawCustomerId) {
    console.log(
      `Sipariş ${rawOrderId}: müşteri hesabı yok, puan yazılmadı.`
    );

    return new Response("OK", {status: 200});
  }

  const orderId = `gid://shopify/Order/${rawOrderId}`;
  const customerId =
    `gid://shopify/Customer/${rawCustomerId}`;

  /*
   * orders/paid zaten ödeme gerçekleştiğinde gelir.
   * Havale siparişi sadece oluşturulduğunda bu webhook gelmez.
   * Shopify'da ödeme "Paid" yapıldığında tetiklenir.
   */

  const amount = Number(
    order.current_total_price ??
      order.total_price ??
      0
  );

  if (!Number.isFinite(amount) || amount <= 0) {
    console.log(
      `Sipariş ${orderId}: geçerli tutar yok.`
    );

    return new Response("OK", {status: 200});
  }

  const pointsToEarn = Math.floor(amount);

  if (pointsToEarn <= 0) {
    return new Response("OK", {status: 200});
  }

  /*
   * AYNI SİPARİŞ İKİNCİ KEZ PUAN KAZANDIRMASIN
   */
  const existingTransaction =
    await prisma.rewardTransaction.findUnique({
      where: {
        orderId_type: {
          orderId,
          type: "ORDER_EARN",
        },
      },
    });

  if (existingTransaction) {
    console.log(
      `Sipariş ${orderId} daha önce puanlandırılmış.`
    );

    return new Response("OK", {status: 200});
  }

  /*
   * MÜŞTERİNİN MEVCUT PUANINI OKU
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
    console.error(
      "Customer GraphQL error:",
      customerJson.errors
    );

    throw new Error(
      customerJson.errors
        .map((e: any) => e.message)
        .join(", ")
    );
  }

  const currentPoints = Number(
    customerJson.data?.customer?.metafield?.value ||
      0
  );

  const newPoints =
    currentPoints + pointsToEarn;

  /*
   * Önce ledger kaydı oluştur.
   * Unique constraint duplicate webhook'u engeller.
   */
  try {
    await prisma.rewardTransaction.create({
      data: {
        customerId,
        orderId,
        type: "ORDER_EARN",
        points: pointsToEarn,
        description: `Sipariş #${
          order.name || rawOrderId
        }`,
      },
    });
  } catch (error: any) {
    /*
     * Aynı webhook aynı anda iki kere geldiyse
     * unique constraint burada engeller.
     */
    if (error?.code === "P2002") {
      console.log(
        `Sipariş ${orderId} zaten işlendi.`
      );

      return new Response("OK", {status: 200});
    }

    throw error;
  }

  /*
   * MÜŞTERİ PUANINI GÜNCELLE
   */
  try {
    const updateResponse = await admin.graphql(
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
      updateJson.data?.metafieldsSet
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
     * Shopify'a puan yazılamadıysa ledger kaydını
     * geri siliyoruz ki webhook tekrar geldiğinde
     * yeniden deneyebilsin.
     */
    await prisma.rewardTransaction.deleteMany({
      where: {
        orderId,
        type: "ORDER_EARN",
      },
    });

    throw error;
  }

  console.log(
    `✅ ${order.name || orderId}: +${pointsToEarn} puan. Yeni bakiye: ${newPoints}`
  );

  return new Response("OK", {status: 200});
};