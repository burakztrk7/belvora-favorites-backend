import type {ActionFunctionArgs} from "react-router";
import {authenticate} from "../shopify.server";

const NAMESPACE = "custom";
const KEY = "favorite_products";

export async function action({request}: ActionFunctionArgs) {
  const {admin} = await authenticate.public.appProxy(request);

  if (!admin) {
    return Response.json(
      {ok: false, error: "App bağlantısı bulunamadı."},
      {status: 401},
    );
  }

  const url = new URL(request.url);
  const customerNumericId = url.searchParams.get("logged_in_customer_id");

  if (!customerNumericId) {
    return Response.json(
      {ok: false, requiresLogin: true},
      {status: 401},
    );
  }

  const formData = await request.formData();
  const productId = formData.get("productId");

  if (
    typeof productId !== "string" ||
    !productId.startsWith("gid://shopify/Product/")
  ) {
    return Response.json(
      {ok: false, error: "Geçersiz ürün."},
      {status: 400},
    );
  }

  const customerId = `gid://shopify/Customer/${customerNumericId}`;

  try {
    const currentFavorites = await getFavorites(admin, customerId);

    if (currentFavorites.includes(productId)) {
      return Response.json({
        ok: true,
        isFavorite: true,
        favorites: currentFavorites,
      });
    }

    const updatedFavorites = [...currentFavorites, productId];

    await saveFavorites(admin, customerId, updatedFavorites);

    return Response.json({
      ok: true,
      isFavorite: true,
      favorites: updatedFavorites,
    });
  } catch (error) {
    console.error("Favorite add error:", error);

    return Response.json(
      {ok: false, error: "Favori eklenemedi."},
      {status: 500},
    );
  }
}

async function getFavorites(admin: any, customerId: string) {
  const response = await admin.graphql(
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

  const json = await response.json();

  const raw = json.data?.customer?.metafield?.value;

  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveFavorites(
  admin: any,
  customerId: string,
  favorites: string[],
) {
  const response = await admin.graphql(
    `#graphql
      mutation SaveFavorites($metafields: [MetafieldsSetInput!]!) {
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
            namespace: NAMESPACE,
            key: KEY,
            type: "list.product_reference",
            value: JSON.stringify(favorites),
          },
        ],
      },
    },
  );

  const json = await response.json();

  const errors = json.data?.metafieldsSet?.userErrors || [];

  if (errors.length) {
    throw new Error(errors.map((x: any) => x.message).join(", "));
  }
}