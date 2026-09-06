import type {LoaderFunctionArgs} from "react-router";
import prisma from "../db.server";
import {authenticate} from "../shopify.server";

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export const loader = async ({
  request,
}: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);

  const rawCustomerId =
    url.searchParams.get("logged_in_customer_id");

  if (!rawCustomerId) {
    return json(
      {
        ok: false,
        error: "LOGIN_REQUIRED",
      },
      401
    );
  }

  const customerId =
    `gid://shopify/Customer/${rawCustomerId}`;

  /*
   * Süresi dolmuş PENDING kayıtları temizle.
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
   * Aktif ödül
   */
  const activeReward =
    await prisma.rewardTransaction.findFirst({
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
   * Son hareketler
   */
  const transactions =
    await prisma.rewardTransaction.findMany({
      where: {
        customerId,
        status: {
          in: ["CONFIRMED", "EXPIRED", "REPLACED"],
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 20,
    });

  const history = transactions.map((item) => ({
    id: item.id,
    type: item.type,
    points: item.points,
    status: item.status,
    description: item.description,
    discountCode: item.discountCode,
    createdAt: item.createdAt,
    redeemedAt: item.redeemedAt,
  }));

  return json({
    ok: true,

    activeReward: activeReward
      ? {
          id: activeReward.id,
          points: Math.abs(activeReward.points),
          discountCode:
            activeReward.discountCode,
          expiresAt:
            activeReward.expiresAt,
          createdAt:
            activeReward.createdAt,
          description:
            activeReward.description,
        }
      : null,

    history,
  });
};