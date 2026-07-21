import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

type BasketLine = {
  product_id: string;
  quantity: number;
  status: string;
  expires_at: string;
};

type Product = {
  id: string;
  name: string;
  price_pence: number;
  image_url: string;
  is_active: boolean;
};

type CheckoutLineItem = {
  product: Product;
  quantity: number;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

function stripeFormValue(params: URLSearchParams, key: string, value: string | number | boolean | undefined | null) {
  if (value === undefined || value === null || value === "") return;
  params.append(key, String(value));
}

async function createStripeSession(args: {
  stripeSecretKey: string;
  lineItems: Array<{ product: Product; quantity: number }>;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  shippingPence: number;
  pendingId: string;
}) {
  const params = new URLSearchParams();
  stripeFormValue(params, "mode", "payment");
  stripeFormValue(params, "success_url", args.successUrl);
  stripeFormValue(params, "cancel_url", args.cancelUrl);
  stripeFormValue(params, "client_reference_id", args.pendingId);
  stripeFormValue(params, "customer_email", args.customerEmail);
  stripeFormValue(params, "metadata[pending_checkout_id]", args.pendingId);
  stripeFormValue(params, "payment_intent_data[metadata][pending_checkout_id]", args.pendingId);

  args.lineItems.forEach((line, index) => {
    stripeFormValue(params, `line_items[${index}][quantity]`, line.quantity);
    stripeFormValue(params, `line_items[${index}][price_data][currency]`, "gbp");
    stripeFormValue(params, `line_items[${index}][price_data][unit_amount]`, line.product.price_pence);
    stripeFormValue(params, `line_items[${index}][price_data][product_data][name]`, line.product.name);
    stripeFormValue(params, `line_items[${index}][price_data][product_data][images][0]`, line.product.image_url);
  });

  if (args.shippingPence > 0) {
    stripeFormValue(params, "shipping_options[0][shipping_rate_data][type]", "fixed_amount");
    stripeFormValue(params, "shipping_options[0][shipping_rate_data][fixed_amount][amount]", args.shippingPence);
    stripeFormValue(params, "shipping_options[0][shipping_rate_data][fixed_amount][currency]", "gbp");
    stripeFormValue(params, "shipping_options[0][shipping_rate_data][display_name]", "Delivery fee");
  }

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.stripeSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || "Stripe session creation failed");
  }

  return data;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");

  if (!supabaseUrl || !anonKey || !serviceKey || !stripeSecretKey) {
    return jsonResponse({ error: "Stripe checkout is not configured on the server." }, 500);
  }

  const authHeader = request.headers.get("Authorization") || "";
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } }
  });
  const serviceClient = createClient(supabaseUrl, serviceKey);

  try {
    const { sessionId, successUrl, cancelUrl } = await request.json();
    if (!sessionId || !successUrl || !cancelUrl) {
      return jsonResponse({ error: "sessionId, successUrl, and cancelUrl are required." }, 400);
    }

    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) throw new Error("Sign in before checkout.");

    const { data: profile, error: profileError } = await userClient
      .from("store_customers")
      .select("*")
      .eq("user_id", userData.user.id)
      .single();
    if (profileError) throw profileError;

    const pendingId = `pending_${crypto.randomUUID()}`;
    const { data: checkoutRows, error: checkoutError } = await userClient.rpc("begin_store_checkout", {
      p_session_id: sessionId,
      p_stripe_session_id: pendingId
    });
    if (checkoutError) throw checkoutError;

    const checkout = Array.isArray(checkoutRows) ? checkoutRows[0] : checkoutRows;
    if (!checkout || Number(checkout.reservation_count) <= 0) {
      throw new Error("No basket lines are available for checkout.");
    }
    if (checkout.profit_pass === false) {
      throw new Error(checkout.profit_fail_reason || "Checkout profit rules blocked this basket.");
    }

    const { data: basketRows, error: basketError } = await userClient.rpc("list_store_basket", {
      p_session_id: sessionId
    });
    if (basketError) throw basketError;

    const basket = (basketRows || []).filter((line: BasketLine) => line.status === "checkout");
    const productIds = basket.map((line: BasketLine) => line.product_id);
    const { data: products, error: productsError } = await serviceClient
      .from("store_products")
      .select("id,name,price_pence,image_url,is_active")
      .in("id", productIds);
    if (productsError) throw productsError;

    const productMap = new Map((products || []).map((product: Product) => [product.id, product]));
    const lineItems = basket.map((line: BasketLine) => {
      const product = productMap.get(line.product_id) as Product | undefined;
      return {
        quantity: line.quantity,
        product
      };
    }).filter((line: { product?: Product }) => line.product) as CheckoutLineItem[];

    if (lineItems.length !== basket.length) {
      throw new Error("Some basket items are no longer available. Refresh basket before paying.");
    }

    for (const line of lineItems) {
      if (!line.product.is_active) {
        throw new Error(`${line.product.name} is no longer available.`);
      }
      if (line.quantity > 2) {
        throw new Error("Maximum 2 units per item.");
      }
    }

    const subtotalPence = Number(checkout.subtotal_pence || 0);
    const lineSubtotalPence = lineItems.reduce((total, line) => total + line.product.price_pence * line.quantity, 0);
    if (lineSubtotalPence !== subtotalPence) {
      throw new Error("Basket prices changed. Refresh basket before paying.");
    }

    const shippingPence = subtotalPence > 0 ? Number(checkout.checkout_fee_pence || 0) : 0;
    const totalPence = subtotalPence + shippingPence;

    const stripeSession = await createStripeSession({
      stripeSecretKey,
      lineItems,
      customerEmail: userData.user.email || profile.email,
      successUrl,
      cancelUrl,
      shippingPence,
      pendingId
    });

    const { error: updateError } = await serviceClient
      .from("store_basket_items")
      .update({ stripe_session_id: stripeSession.id })
      .eq("stripe_session_id", pendingId)
      .eq("status", "checkout");
    if (updateError) throw updateError;

    const { error: snapshotError } = await serviceClient.from("store_checkout_sessions").upsert({
      stripe_session_id: stripeSession.id,
      user_id: userData.user.id,
      session_id: sessionId,
      email: userData.user.email || profile.email,
      customer_name: profile.full_name,
      phone: profile.phone,
      address_line1: profile.address_line1,
      address_line2: profile.address_line2,
      city: profile.city,
      county: profile.county,
      postcode: profile.postcode,
      country: profile.country || "United Kingdom",
      subtotal_pence: subtotalPence,
      shipping_pence: shippingPence,
      discount_pence: 0,
      total_pence: totalPence
    });
    if (snapshotError) throw snapshotError;

    return jsonResponse({ id: stripeSession.id, url: stripeSession.url });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Checkout failed." }, 400);
  }
});
