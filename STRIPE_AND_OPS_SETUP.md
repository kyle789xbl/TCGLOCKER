# Stripe and Offline Ops Setup

## What is already wired

- Storefront checkout calls the `create-stripe-checkout` Supabase Edge Function.
- Basket stock is still first-come-first-serve:
  - Adding to basket reserves stock for 10 minutes.
  - Starting Stripe checkout moves reserved lines into a 10-minute checkout hold.
  - Stripe webhook completes the order and deducts final stock.
- `OFFLINE_ADMIN.HTML` adds/updates products and adjusts stock.
- `OFFLINE_SHIPMENTPANEL.HTML` processes paid orders, tracking, completion, and order issues.
- Admin pages require Supabase Auth and the `store_admins` allow-list.

## Stripe secrets

Set these Supabase Edge Function secrets:

```bash
supabase secrets set STRIPE_SECRET_KEY=sk_live_or_test_xxx
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_xxx
```

## eBay procurement secrets

The shipment panel `Order cards` button uses the `search-ebay-procurement` Edge Function to load live eBay UK fixed-price/new listings without exposing eBay keys in the browser.

Set these Supabase Edge Function secrets:

```bash
supabase secrets set EBAY_CLIENT_ID=your_ebay_client_id
supabase secrets set EBAY_CLIENT_SECRET=your_ebay_client_secret
supabase secrets set EBAY_MARKETPLACE_ID=EBAY_GB
```

Until those are set and the function is deployed, the shipment panel still shows direct eBay search links for each order item.

The webhook URL to add in Stripe is:

```text
https://vfyipmvaejrnhrqckgvn.supabase.co/functions/v1/stripe-webhook
```

Listen for:

- `checkout.session.completed`
- `checkout.session.expired`

## Deploy functions

This machine currently does not have the Supabase CLI installed. Once installed/logged in:

```bash
supabase functions deploy create-stripe-checkout --project-ref vfyipmvaejrnhrqckgvn
supabase functions deploy stripe-webhook --project-ref vfyipmvaejrnhrqckgvn
supabase functions deploy search-ebay-procurement --project-ref vfyipmvaejrnhrqckgvn
```

## Admin access

The migration added `kyle789xbl@gmail.com` as an owner if that Supabase Auth user exists.

To add another admin later:

```sql
insert into public.store_admins(user_id, email, role)
select id, email, 'ops'
from auth.users
where lower(email) = lower('person@example.com')
on conflict (user_id) do update
set email = excluded.email;
```

## Local pages

- Stock/product admin: `OFFLINE_ADMIN.HTML`
- Shipments/order issues: `OFFLINE_SHIPMENTPANEL.HTML`
- Storefront: `index.html?v=anime-live-19`
