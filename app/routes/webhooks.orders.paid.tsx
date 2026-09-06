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
      `Sipariş ${rawOrderId}: müşteri yok, puan işlemi yapılmadı.`
    );

    return new Response("OK", {status: 200});
  }

  const orderId =
    `gid://shopify/Order/${rawOrderId}`;

  const customerId =
    `gid://shopify/Customer/${rawCustomerId}`;

  /*
   * ------------------------------------------------
   * 1. SİPARİŞTE KULLANILAN İNDİRİM KODLARINI BUL
   * ------------------------------------------------
   */

  const discountCodes: string[] = Array.isArray(
    order?.discount_codes
  )
    ? order.discount_codes
        .map((discount: any) =>
          String(discount?.code || "").trim()
        )
        .filter(Boolean)
    : [];

  const belvoraCode =
    discountCodes.find((code) =>
      code.toUpperCase().startsWith("BELVORA-")
    ) || null;

  console.log(
    `Sipariş ${order.name || orderId} indirim kodları:`,
    discountCodes
  );

  /*
   * ------------------------------------------------
   * 2. MEVCUT PUAN BAKİYESİNİ OKU
   * ------------------------------------------------
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

  let workingPoints = currentPoints;

  /*
   * ------------------------------------------------
   * 3. BELVORA CLUB ÖDÜLÜ KULLANILDIYSA
   *    PENDING → CONFIRMED
   * ------------------------------------------------
   */

  let confirmedReservation:
    | {
        id: string;
        points: number;
        discountCode: string | null;
      }
    | null = null;

  if (belvoraCode) {
    const pending =
      await prisma.rewardTransaction.findFirst({
        where: {
          customerId,
          type: "REDEEM",
          status: "PENDING",
          discountCode: belvoraCode,
        },
      });

    if (pending) {
      const pointsToRedeem =
        Math.abs(pending.points);

      /*
       * Güvenlik:
       * bakiye rezervasyon tutarından azsa negatife düşme.
       */
      workingPoints = Math.max(
        0,
        workingPoints - pointsToRedeem
      );

      confirmedReservation = {
        id: pending.id,
        points: pointsToRedeem,
        discountCode: pending.discountCode,
      };

      console.log(
        `🎁 ${belvoraCode}: ${pointsToRedeem} puan ödeme sonrası kullanılacak.`
      );
    } else {
      /*
       * Kod daha önce CONFIRMED olmuş olabilir.
       * Duplicate webhook durumunda yeniden düşürmemeliyiz.
       */
      const alreadyConfirmed =
        await prisma.rewardTransaction.findFirst({
          where: {
            customerId,
            type: "REDEEM",
            status: "CONFIRMED",
            discountCode: belvoraCode,
          },
        });

      if (alreadyConfirmed) {
        console.log(
          `Belvora ödülü ${belvoraCode} zaten CONFIRMED.`
        );
      } else {
        console.warn(
          `Belvora kodu bulundu ancak PENDING rezervasyon bulunamadı: ${belvoraCode}`
        );
      }
    }
  }

  /*
   * ------------------------------------------------
   * 4. BU SİPARİŞ DAHA ÖNCE PUAN KAZANDI MI?
   * ------------------------------------------------
   */

  const existingEarn =
    await prisma.rewardTransaction.findUnique({
      where: {
        orderId_type: {
          orderId,
          type: "ORDER_EARN",
        },
      },
    });

  /*
   * İndirim uygulandıktan sonraki ödenen sipariş tutarı.
   */
  const amount = Number(
    order.current_total_price ??
      order.total_price ??
      0
  );

  let pointsToEarn = 0;

  if (
    !existingEarn &&
    Number.isFinite(amount) &&
    amount > 0
  ) {
    pointsToEarn = Math.floor(amount);

    workingPoints += pointsToEarn;
  }

  /*
   * ------------------------------------------------
   * 5. DB İŞLEMLERİNİ HAZIRLA
   * ------------------------------------------------
   */

  let earnCreated = false;
  let reservationConfirmed = false;

  try {
    /*
     * Önce ödül rezervasyonunu CONFIRMED yap.
     */
    if (confirmedReservation) {
      await prisma.rewardTransaction.update({
        where: {
          id: confirmedReservation.id,
        },
        data: {
          status: "CONFIRMED",
          orderId,
          redeemedAt: new Date(),
          description:
            `${confirmedReservation.points} puan kullanıldı | ` +
            `${confirmedReservation.discountCode} | ` +
            `${order.name || orderId}`,
        },
      });

      reservationConfirmed = true;
    }

    /*
     * Sonra sipariş kazanç ledger kaydını oluştur.
     */
    if (!existingEarn && pointsToEarn > 0) {
      try {
        await prisma.rewardTransaction.create({
          data: {
            customerId,
            orderId,
            type: "ORDER_EARN",
            status: "CONFIRMED",
            points: pointsToEarn,
            description:
              `Sipariş ${order.name || rawOrderId}`,
          },
        });

        earnCreated = true;
      } catch (error: any) {
        /*
         * Aynı anda duplicate webhook geldiyse
         * unique constraint bizi korur.
         */
        if (error?.code !== "P2002") {
          throw error;
        }

        console.log(
          `Sipariş ${orderId} ORDER_EARN zaten oluşturulmuş.`
        );

        /*
         * Biz yukarıda puanı workingPoints'e eklemiştik.
         * Duplicate ise eklemeyi geri al.
         */
        workingPoints -= pointsToEarn;
        pointsToEarn = 0;
      }
    }

    /*
     * ------------------------------------------------
     * 6. SHOPIFY MÜŞTERİ BAKİYESİNİ TEK SEFERDE YAZ
     * ------------------------------------------------
     */

    if (
      reservationConfirmed ||
      earnCreated
    ) {
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
                  value: String(
                    Math.max(
                      0,
                      Math.floor(workingPoints)
                    )
                  ),
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
    }

  } catch (error) {
    /*
     * Shopify bakiyesi yazılamazsa
     * DB değişikliklerini mümkün olduğunca geri al.
     */

    if (earnCreated) {
      await prisma.rewardTransaction.deleteMany({
        where: {
          orderId,
          type: "ORDER_EARN",
        },
      });
    }

    if (
      reservationConfirmed &&
      confirmedReservation
    ) {
      await prisma.rewardTransaction.update({
        where: {
          id: confirmedReservation.id,
        },
        data: {
          status: "PENDING",
          orderId: null,
          redeemedAt: null,
        },
      });
    }

    throw error;
  }

  /*
   * ------------------------------------------------
   * 7. LOG
   * ------------------------------------------------
   */

  console.log(
    [
      `✅ ${order.name || orderId}`,
      belvoraCode
        ? `Belvora kodu: ${belvoraCode}`
        : "Belvora ödülü yok",
      confirmedReservation
        ? `-${confirmedReservation.points} puan kullanıldı`
        : "0 puan kullanıldı",
      pointsToEarn > 0
        ? `+${pointsToEarn} yeni puan`
        : "Yeni puan zaten işlenmiş / yok",
      `Yeni bakiye: ${Math.max(
        0,
        Math.floor(workingPoints)
      )}`,
    ].join(" | ")
  );

  return new Response("OK", {
    status: 200,
  });
};