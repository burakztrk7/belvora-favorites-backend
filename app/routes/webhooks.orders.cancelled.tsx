import type {ActionFunctionArgs} from "react-router";
import prisma from "../db.server";
import {authenticate} from "../shopify.server";

export const action = async ({request}: ActionFunctionArgs) => {
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

  const orderId = `gid://shopify/Order/${order.id}`;
  const customerId = `gid://shopify/Customer/${order.customer.id}`;

  const earnTransaction =
    await prisma.rewardTransaction.findUnique({
      where: {
        orderId_type: {
          orderId,
          type: "ORDER_EARN",
        },
      },
    });

  // Bu sipariş daha önce puan kazandırmamışsa yapılacak bir şey yok.
  if (!earnTransaction) {
    console.log(
      `Sipariş ${orderId}: geri alınacak ORDER_EARN bulunamadı.`
    );
    return new Response("OK", {status: 200});
  }

  // Aynı iptal ikinci kez puan düşürmesin.
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
    console.log(
      `Sipariş ${orderId}: iptal puan düşümü zaten işlendi.`
    );
    return new Response("OK", {status: 200});
  }

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

  const customerJson = await customerResponse.json();

  const currentPoints = Number(
    customerJson.data?.customer?.metafield?.value || 0
  );

  const pointsToRemove = Math.abs(earnTransaction.points);

  const newPoints = Math.max(
    0,
    currentPoints - pointsToRemove
  );

  try {
    await prisma.rewardTransaction.create({
      data: {
        customerId,
        orderId,
        type: "ORDER_CANCEL",
        points: -pointsToRemove,
        description: `İptal edilen sipariş #${
          order.name || order.id
        }`,
      },
    });
  } catch (error: any) {
    if (error?.code === "P2002") {
      return new Response("OK", {status: 200});
    }

    throw error;
  }

  try {
    const updateResponse = await admin.graphql(
      `
        mutation UpdatePoints(
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

    const updateJson = await updateResponse.json();

    if (updateJson.errors?.length) {
      throw new Error(
        updateJson.errors
          .map((e: any) => e.message)
          .join(", ")
      );
    }

    const userErrors =
      updateJson.data?.metafieldsSet?.userErrors || [];

    if (userErrors.length > 0) {
      throw new Error(
        userErrors
          .map((e: any) => e.message)
          .join(", ")
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

  console.log(
    `✅ ${order.name || orderId}: -${pointsToRemove} puan. Yeni bakiye: ${newPoints}`
  );

  return new Response("OK", {status: 200});
};