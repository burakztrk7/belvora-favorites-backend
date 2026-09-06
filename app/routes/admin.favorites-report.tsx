import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret");

  if (!process.env.BACKFILL_SECRET || secret !== process.env.BACKFILL_SECRET) {
    return Response.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  try {
    const offlineSession = await prisma.session.findFirst({
      where: {
        isOnline: false,
      },
      orderBy: {
        id: "desc",
      },
    });

    if (!offlineSession) {
      return Response.json(
        { ok: false, error: "Offline Shopify session bulunamadı." },
        { status: 500 },
      );
    }

    const shop = offlineSession.shop;
    const accessToken = offlineSession.accessToken;

    if (!accessToken) {
      return Response.json(
        { ok: false, error: "Shopify access token bulunamadı." },
        { status: 500 },
      );
    }

    const query = `
      query CustomersWithFavorites($cursor: String) {
        customers(first: 100, after: $cursor) {
          edges {
            cursor
            node {
              id
              displayName
              firstName
              lastName
              email
              numberOfOrders
              amountSpent {
                amount
                currencyCode
              }
              metafield(namespace: "custom", key: "favorite_products") {
                id
                type
                value
                references(first: 100) {
                  nodes {
                    ... on Product {
                      id
                      title
                      handle
                      status
                      featuredImage {
                        url
                      }
                    }
                  }
                }
              }
            }
          }

          pageInfo {
            hasNextPage
          }
        }
      }
    `;

    let cursor: string | null = null;
    let hasNextPage = true;

    const customersWithFavorites: any[] = [];

    while (hasNextPage) {
      const response = await fetch(
        `https://${shop}/admin/api/2026-07/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({
            query,
            variables: {
              cursor,
            },
          }),
        },
      );

      const result = await response.json();

      if (!response.ok || result.errors) {
        console.error("Shopify GraphQL error:", result);

        return Response.json(
          {
            ok: false,
            error: "Shopify GraphQL isteği başarısız.",
            details: result.errors ?? result,
          },
          { status: 500 },
        );
      }

      const edges = result.data?.customers?.edges ?? [];

      for (const edge of edges) {
        const customer = edge.node;
        const favoriteProducts =
          customer.metafield?.references?.nodes?.filter(Boolean) ?? [];

        if (favoriteProducts.length === 0) {
          continue;
        }

        customersWithFavorites.push({
          customerId: customer.id,
          name:
            customer.displayName ||
            [customer.firstName, customer.lastName]
              .filter(Boolean)
              .join(" ") ||
            "İsimsiz müşteri",
          email: customer.email ?? null,
          numberOfOrders: customer.numberOfOrders ?? 0,
          amountSpent: customer.amountSpent ?? null,
          favoriteCount: favoriteProducts.length,
          favorites: favoriteProducts.map((product: any) => ({
            productId: product.id,
            title: product.title,
            handle: product.handle,
            status: product.status,
            image: product.featuredImage?.url ?? null,
            storefrontUrl: product.handle
              ? `https://belvoraluxe.com/products/${product.handle}`
              : null,
          })),
        });
      }

      hasNextPage =
        result.data?.customers?.pageInfo?.hasNextPage ?? false;

      cursor =
        edges.length > 0
          ? edges[edges.length - 1].cursor
          : null;

      if (!cursor) {
        hasNextPage = false;
      }
    }

    customersWithFavorites.sort(
      (a, b) => b.favoriteCount - a.favoriteCount,
    );

    const productStats = new Map<
      string,
      {
        productId: string;
        title: string;
        handle: string | null;
        count: number;
      }
    >();

    for (const customer of customersWithFavorites) {
      for (const product of customer.favorites) {
        const existing = productStats.get(product.productId);

        if (existing) {
          existing.count += 1;
        } else {
          productStats.set(product.productId, {
            productId: product.productId,
            title: product.title,
            handle: product.handle,
            count: 1,
          });
        }
      }
    }

    const mostFavoritedProducts = Array.from(
      productStats.values(),
    ).sort((a, b) => b.count - a.count);

    return Response.json({
      ok: true,
      summary: {
        customersWithFavorites: customersWithFavorites.length,
        totalFavoriteSelections: customersWithFavorites.reduce(
          (sum, customer) => sum + customer.favoriteCount,
          0,
        ),
        uniqueFavoritedProducts: mostFavoritedProducts.length,
      },
      mostFavoritedProducts,
      customers: customersWithFavorites,
    });
  } catch (error) {
    console.error("Favorites report error:", error);

    return Response.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Bilinmeyen hata oluştu.",
      },
      { status: 500 },
    );
  }
}

export default function FavoritesReport() {
  return null;
}