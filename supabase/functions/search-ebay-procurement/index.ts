import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

type OrderItem = {
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price_pence: number;
  line_total_pence: number;
};

type SupplierProduct = {
  product_id: string;
  last_price_pence: number | null;
  supplier_product_id: string | null;
  source_url: string | null;
};

type EbayAmount = {
  value?: string;
  currency?: string;
};

type EbaySummary = {
  itemId?: string;
  legacyItemId?: string;
  title?: string;
  itemWebUrl?: string;
  image?: { imageUrl?: string };
  price?: EbayAmount;
  shippingOptions?: Array<{ shippingCost?: EbayAmount; type?: string }>;
  condition?: string;
  seller?: { username?: string; feedbackPercentage?: string; feedbackScore?: number };
  itemLocation?: { country?: string; city?: string };
  buyingOptions?: string[];
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

function penceFromAmount(amount?: EbayAmount | null) {
  if (!amount || amount.currency !== "GBP") return null;
  const value = Number(amount.value);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function cheapestShippingPence(item: EbaySummary) {
  const costs = (item.shippingOptions || [])
    .map((option) => penceFromAmount(option.shippingCost))
    .filter((value): value is number => Number.isFinite(value));
  if (!costs.length) return 0;
  return Math.min(...costs);
}

function scoreListing(query: string, item: EbaySummary) {
  const title = String(item.title || "").toLowerCase();
  const tokens = query
    .toLowerCase()
    .replace(/\b(pokemon|tcg|trading|card|game)\b/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);

  const uniqueTokens = Array.from(new Set(tokens));
  if (!uniqueTokens.length) return 0;
  const hits = uniqueTokens.filter((token) => title.includes(token)).length;
  return Math.round((hits / uniqueTokens.length) * 100);
}

async function getEbayToken(clientId: string, clientSecret: string) {
  const credentials = btoa(`${clientId}:${clientSecret}`);
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "https://api.ebay.com/oauth/api_scope"
  });

  const response = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data?.error_description || data?.error || "Could not get eBay token.");
  return String(data.access_token || "");
}

async function searchEbayListings(args: {
  accessToken: string;
  marketplaceId: string;
  query: string;
  limit: number;
}) {
  const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
  url.searchParams.set("q", args.query);
  url.searchParams.set("limit", String(args.limit));
  url.searchParams.set("filter", "buyingOptions:{FIXED_PRICE},conditions:{NEW}");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "X-EBAY-C-MARKETPLACE-ID": args.marketplaceId,
      Accept: "application/json"
    }
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data?.errors?.[0]?.message || data?.message || "eBay search failed.");
  return Array.isArray(data.itemSummaries) ? data.itemSummaries as EbaySummary[] : [];
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ebayClientId = Deno.env.get("EBAY_CLIENT_ID");
  const ebayClientSecret = Deno.env.get("EBAY_CLIENT_SECRET");
  const marketplaceId = Deno.env.get("EBAY_MARKETPLACE_ID") || "EBAY_GB";

  if (!supabaseUrl || !anonKey || !serviceKey) {
    return jsonResponse({ error: "Supabase function environment is not configured." }, 500);
  }

  const authHeader = request.headers.get("Authorization") || "";
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } }
  });
  const serviceClient = createClient(supabaseUrl, serviceKey);

  try {
    const { orderId, limit = 8 } = await request.json();
    if (!orderId) return jsonResponse({ error: "orderId is required." }, 400);

    const { data: isAdmin, error: adminError } = await userClient.rpc("is_store_admin");
    if (adminError || !isAdmin) return jsonResponse({ error: "Admin access required." }, 403);

    const { data: order, error: orderError } = await serviceClient
      .from("store_orders")
      .select("id,order_number,order_ref,total_pence,email,customer_name,created_at")
      .eq("id", orderId)
      .single();
    if (orderError) throw orderError;

    const { data: orderItems, error: itemsError } = await serviceClient
      .from("store_order_items")
      .select("product_id,product_name,quantity,unit_price_pence,line_total_pence")
      .eq("order_id", orderId)
      .order("created_at", { ascending: true });
    if (itemsError) throw itemsError;

    const productIds = (orderItems || []).map((item: OrderItem) => item.product_id);
    const { data: supplierRows, error: supplierError } = await serviceClient
      .from("store_supplier_products")
      .select("product_id,last_price_pence,supplier_product_id,source_url")
      .in("product_id", productIds.length ? productIds : [""]);
    if (supplierError) throw supplierError;

    if (!ebayClientId || !ebayClientSecret) {
      return jsonResponse({
        configured: false,
        error: "Add EBAY_CLIENT_ID and EBAY_CLIENT_SECRET Supabase secrets to load live eBay listings.",
        order,
        lines: orderItems || []
      });
    }

    const supplierMap = new Map((supplierRows || []).map((row: SupplierProduct) => [row.product_id, row]));
    const accessToken = await getEbayToken(ebayClientId, ebayClientSecret);
    const lines = [];

    for (const item of (orderItems || []) as OrderItem[]) {
      const supplier = supplierMap.get(item.product_id) as SupplierProduct | undefined;
      const summaries = await searchEbayListings({
        accessToken,
        marketplaceId,
        query: item.product_name,
        limit: Math.max(1, Math.min(Number(limit) || 8, 20))
      });

      const magicPricePence = supplier?.last_price_pence ?? null;
      const listings = summaries.map((summary) => {
        const pricePence = penceFromAmount(summary.price);
        const shippingPence = cheapestShippingPence(summary);
        const totalPence = pricePence === null ? null : pricePence + shippingPence;
        return {
          item_id: summary.itemId || "",
          legacy_item_id: summary.legacyItemId || "",
          title: summary.title || "",
          url: summary.itemWebUrl || "",
          image_url: summary.image?.imageUrl || "",
          condition: summary.condition || "",
          price_pence: pricePence,
          shipping_pence: shippingPence,
          total_pence: totalPence,
          currency: summary.price?.currency || "GBP",
          seller: summary.seller?.username || "",
          feedback_percentage: summary.seller?.feedbackPercentage || "",
          feedback_score: summary.seller?.feedbackScore ?? null,
          location: [summary.itemLocation?.city, summary.itemLocation?.country].filter(Boolean).join(", "),
          match_score: scoreListing(item.product_name, summary),
          beats_magic: totalPence !== null && magicPricePence !== null ? totalPence < magicPricePence : null,
          margin_gain_pence: totalPence !== null && magicPricePence !== null ? magicPricePence - totalPence : null
        };
      }).sort((a, b) => {
        const aTotal = a.total_pence ?? Number.MAX_SAFE_INTEGER;
        const bTotal = b.total_pence ?? Number.MAX_SAFE_INTEGER;
        return b.match_score - a.match_score || aTotal - bTotal;
      });

      lines.push({
        product_id: item.product_id,
        product_name: item.product_name,
        quantity: item.quantity,
        unit_price_pence: item.unit_price_pence,
        magic_price_pence: magicPricePence,
        magic_source_url: supplier?.source_url || "",
        listings
      });
    }

    return jsonResponse({ configured: true, marketplace_id: marketplaceId, order, lines });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "eBay procurement search failed." }, 400);
  }
});
