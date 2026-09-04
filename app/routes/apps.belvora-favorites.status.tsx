import type {LoaderFunctionArgs} from "react-router";
import {authenticate} from "../shopify.server";

export async function loader({request}: LoaderFunctionArgs) {
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

  const productId = url.searchParams.get("productId");

  if (!customerNumericId) {
    return Response.json({
      ok: true,
      loggedIn: false,
      isFavorite: false,
    });
  }

  if (!productId) {
    return Response.json(
      {ok: false, error: "Ürün ID bulunamadı."},
      {status: 400},
    );
  }

  const customerId =
    `gid://shopify/Customer/${customerNumericId}`;

  try {
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

    const raw =
      json.data?.customer?.metafield?.value;

    let favorites: string[] = [];

    if (raw) {
      try {
        const parsed = JSON.parse(raw);

        if (Array.isArray(parsed)) {
          favorites = parsed;
        }
      } catch {}
    }

    return Response.json({
      ok: true,
      loggedIn: true,
      isFavorite: favorites.includes(productId),
    });
  } catch (error) {
    console.error("Favorite status error:", error);

    return Response.json(
      {ok: false, error: "Favori durumu alınamadı."},
      {status: 500},
    );
  }
}