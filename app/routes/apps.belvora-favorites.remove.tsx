import type {ActionFunctionArgs} from "react-router";
import {authenticate} from "../shopify.server";

export async function action({request}: ActionFunctionArgs) {
  const {admin} = await authenticate.public.appProxy(request);

  if (!admin) {
    return Response.json(
      {ok: false, error: "App bağlantısı bulunamadı."},
      {status: 401},
    );
  }

  const url = new URL(request.url);

  const customerNumericId =
    url.searchParams.get("logged_in_customer_id");

  if (!customerNumericId) {
    return Response.json(
      {ok: false, requiresLogin: true},
      {status: 401},
    );
  }

  const formData = await request.formData();
  const productId = formData.get("productId");

  if (typeof productId !== "string") {
    return Response.json(
      {ok: false, error: "Ürün ID bulunamadı."},
      {status: 400},
    );
  }

  const customerId =
    `gid://shopify/Customer/${customerNumericId}`;

  try {
    const queryResponse = await admin.graphql(
      `#graphql
        query CustomerFavorites($id: ID!) {
          customer(id: $id) {
            metafield(
              namespace: "custom"
              key: "favorite_products"
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
      },
    );

    const queryJson = await queryResponse.json();

    const raw =
      queryJson.data?.customer?.metafield?.value;

    let favorites: string[] = [];

    if (raw) {
      try {
        const parsed = JSON.parse(raw);

        if (Array.isArray(parsed)) {
          favorites = parsed;
        }
      } catch {}
    }

    const updatedFavorites =
      favorites.filter((id) => id !== productId);

    const mutationResponse = await admin.graphql(
      `#graphql
        mutation SaveFavorites(
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
              key: "favorite_products",
              type: "list.product_reference",
              value: JSON.stringify(updatedFavorites),
            },
          ],
        },
      },
    );

    const mutationJson =
      await mutationResponse.json();

    const errors =
      mutationJson.data?.metafieldsSet?.userErrors || [];

    if (errors.length) {
      throw new Error(
        errors.map((x: any) => x.message).join(", "),
      );
    }

    return Response.json({
      ok: true,
      isFavorite: false,
      favorites: updatedFavorites,
    });
  } catch (error) {
    console.error("Favorite remove error:", error);

    return Response.json(
      {ok: false, error: "Favoriden çıkarılamadı."},
      {status: 500},
    );
  }
}