import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
}

async function verifyStripeSignature(rawBody: string, signatureHeader: string | null, secret: string) {
  if (!signatureHeader) return false;

  const parts = Object.fromEntries(signatureHeader.split(",").map((part) => {
    const [key, value] = part.split("=");
    return [key, value];
  }));

  if (!parts.t || !parts.v1) return false;
  const expected = await hmacSha256(secret, `${parts.t}.${rawBody}`);
  return expected === parts.v1;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");

  if (!supabaseUrl || !serviceKey || !webhookSecret) {
    return jsonResponse({ error: "Stripe webhook is not configured." }, 500);
  }

  const rawBody = await request.text();
  const verified = await verifyStripeSignature(rawBody, request.headers.get("stripe-signature"), webhookSecret);
  if (!verified) return jsonResponse({ error: "Invalid Stripe signature." }, 401);

  const event = JSON.parse(rawBody);
  const serviceClient = createClient(supabaseUrl, serviceKey);

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const { error } = await serviceClient.rpc("complete_store_checkout", {
        p_stripe_session_id: session.id,
        p_stripe_payment_intent_id: session.payment_intent || null,
        p_email: session.customer_details?.email || session.customer_email || null
      });
      if (error) throw error;
    }

    if (event.type === "checkout.session.expired") {
      const session = event.data.object;
      await serviceClient
        .from("store_basket_items")
        .update({ status: "expired" })
        .eq("stripe_session_id", session.id)
        .eq("status", "checkout");
    }

    return jsonResponse({ received: true });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Webhook failed." }, 400);
  }
});
