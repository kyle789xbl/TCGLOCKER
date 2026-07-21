const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const CANCEL_EMAIL_FROM = Deno.env.get("CANCEL_EMAIL_FROM") || "tcglocker <orders@tcglocker.com>";

type Json = Record<string, unknown>;

function jsonResponse(body: Json, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type"
    }
  });
}

async function supabaseRest(path: string, init: RequestInit = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      Prefer: "return=representation",
      ...(init.headers || {})
    }
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.message || data?.error || text || "Supabase request failed");
  return data;
}

async function createStripeRefund(paymentIntentId: string, amountPence: number, orderRef: string) {
  const params = new URLSearchParams();
  params.set("payment_intent", paymentIntentId);
  params.set("amount", String(amountPence));
  params.set("reason", "requested_by_customer");
  params.set("metadata[order_ref]", orderRef);
  params.set("metadata[cancel_reason]", "internal_stock_issue");

  const response = await fetch("https://api.stripe.com/v1/refunds", {
    method: "POST",
    headers: {
      authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: params
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "Stripe refund failed");
  return data;
}

async function sendCancellationEmail(order: Json) {
  if (!RESEND_API_KEY || !order.cancellation_email_to || !order.cancellation_email_body) {
    return { skipped: true };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${RESEND_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      from: CANCEL_EMAIL_FROM,
      to: [String(order.cancellation_email_to)],
      subject: String(order.cancellation_email_subject || "Your tcglocker order refund"),
      text: String(order.cancellation_email_body)
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data?.message || "Cancellation email failed");
  return data;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return jsonResponse({});
  if (request.method !== "POST") return jsonResponse({ error: "POST required" }, 405);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !STRIPE_SECRET_KEY) {
    return jsonResponse({ error: "Refund function is missing Supabase or Stripe secrets." }, 500);
  }

  try {
    const { orderId } = await request.json();
    if (!orderId) return jsonResponse({ error: "orderId is required" }, 400);

    const [order] = await supabaseRest(
      `store_orders?id=eq.${encodeURIComponent(orderId)}&select=id,order_ref,stripe_payment_intent_id,refund_amount_pence,refund_status,cancellation_email_to,cancellation_email_subject,cancellation_email_body,cancellation_email_status`
    );

    if (!order) return jsonResponse({ error: "Order not found" }, 404);
    if (order.refund_status !== "stripe_refund_ready") {
      return jsonResponse({ error: `Order refund is not ready. Current status: ${order.refund_status}` }, 409);
    }
    if (!order.stripe_payment_intent_id) {
      return jsonResponse({ error: "Order has no Stripe PaymentIntent." }, 409);
    }

    await supabaseRest(`store_orders?id=eq.${encodeURIComponent(orderId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        refund_status: "requested",
        refund_requested_at: new Date().toISOString(),
        refund_error: null
      })
    });

    const refund = await createStripeRefund(
      order.stripe_payment_intent_id,
      Number(order.refund_amount_pence || 0),
      order.order_ref || order.id
    );

    let emailResult: Json = { skipped: true };
    let cancellationEmailStatus = String(order.cancellation_email_status || "queued");
    try {
      emailResult = await sendCancellationEmail(order);
      if (!(emailResult as { skipped?: boolean }).skipped) cancellationEmailStatus = "sent";
    } catch (emailError) {
      cancellationEmailStatus = "failed";
      await supabaseRest(`store_orders?id=eq.${encodeURIComponent(orderId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          cancellation_email_status: "failed",
          refund_error: emailError instanceof Error ? emailError.message : "Cancellation email failed"
        })
      });
    }

    await supabaseRest(`store_orders?id=eq.${encodeURIComponent(orderId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        refund_status: refund.status === "succeeded" ? "succeeded" : "pending",
        stripe_refund_id: refund.id,
        refund_completed_at: refund.status === "succeeded" ? new Date().toISOString() : null,
        status: refund.status === "succeeded" ? "refunded" : "cancelled",
        cancellation_email_status: cancellationEmailStatus
      })
    });

    return jsonResponse({ refund, email: emailResult });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Refund failed" }, 500);
  }
});
