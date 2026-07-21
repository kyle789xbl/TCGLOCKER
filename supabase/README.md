# Supabase Store Database

Project ref: `vfyipmvaejrnhrqckgvn`

This folder contains Supabase project notes and Edge Function source for the card store:

- `store_products`
- `store_basket_items`
- `store_orders`
- `store_order_items`
- `store_product_availability`
- RPC functions for reservations and checkout transitions

## Local Migration Archive

Historical migration SQL has been tucked out of the public test repo surface at:

`_archive/supabase-migrations-20260721/migrations/`

Move it back to `supabase/migrations/` only when actively working on database changes.

## Apply From CLI

Install and login to the Supabase CLI, then run:

```powershell
npx supabase login
npx supabase link --project-ref vfyipmvaejrnhrqckgvn
npx supabase db query --linked --file "supabase/migrations/<migration-file>.sql"
npx supabase db push
```

The SQL is idempotent for schema creation and product seeding, so it can be rerun while developing.

## Reservation Flow

1. Read stock from `store_product_availability`.
2. Add to basket with `reserve_store_item(product_id, quantity, session_id)`.
3. Update basket quantity with `set_store_item_quantity(product_id, quantity, session_id)`.
4. Before creating Stripe Checkout, call `begin_store_checkout(session_id, stripe_session_id)`.
5. From the Stripe webhook, call `complete_store_checkout(stripe_session_id, payment_intent_id, email)` with the service role key.
