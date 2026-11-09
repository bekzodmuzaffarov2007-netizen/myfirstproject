# Restaurant Telegram Bot

Node.js Telegram restaurant ordering bot backed by Supabase.

## What it does

- QR deep links identify the restaurant table.
- Customer sees menu categories and items.
- Cart supports add/remove quantities.
- Orders and order items are saved in Supabase.
- `Call waiter` and `Ask for bill` are saved in Supabase and can alert staff chats.
- Kitchen can receive new order alerts.
- Authorized managers can mark cash orders paid with `/paid ORDER_ID`.
- Telegram webhook is acknowledged immediately to avoid repeated update delivery.
- The customer UI edits/replaces one active Telegram message instead of leaving old button screens behind.

## Database

Supabase stores:

- restaurants
- tables
- menu
- bot sessions/cart state
- orders
- order items
- service requests
- payments
- staff
- processed Telegram updates

## Required Render environment variables

- `BOT_TOKEN` — Telegram BotFather token.
- `SUPABASE_URL` — Supabase project URL.
- `SUPABASE_SECRET_KEY` — backend-only Supabase secret key.

Optional:

- `KITCHEN_CHAT_ID`
- `WAITER_CHAT_ID`
- `MANAGER_TELEGRAM_IDS` — comma-separated Telegram numeric user IDs.

Render provides `RENDER_EXTERNAL_URL` automatically, so `PUBLIC_URL` is not required.

## Deploy on Render

Render should auto-deploy commits from the default branch. The app registers its Telegram webhook at `<render-url>/telegram` on startup.

## Test

Table 1:

`https://t.me/restoranboshqaruvi_bot?start=R0001_T001`

Health endpoint:

`/health`

## Current build marker

`checkout-db-commit-success-v3-2026-10-31`

This marker commit exists to force Render to deploy the checkout fix where a successfully persisted Supabase order can no longer be reported to the customer as a failed order because of a later Telegram UI or staff-notification error.

Never commit Telegram tokens or Supabase secret keys to GitHub.


## RestaurantOS browser QR trial (proposed feature branch)

This branch adds a **browser-based** QR menu and a shared staff console, while leaving the Telegram bot routes intact.

- Customer QR link: \`https://YOUR-RENDER-URL/qr/R0001_T001\` (example using the existing QR start parameter). This opens in a phone browser without Telegram.
- Staff console: \`https://YOUR-RENDER-URL/staff\`; kitchen can mark PREPARING / READY, waiters SERVED, cashier can confirm cash payment and managers can see order totals.
- Both flows use the same Supabase restaurant, table, menu, order, order-item and payment tables as the existing bot.
- New Render environment variable **STAFF_DASHBOARD_KEY**: generate a long random secret (32+ bytes) and share it securely with trusted pilot staff. The staff page prompts for it. Without this variable the staff API is disabled.
- Optional **RESTAURANT_ID** defaults to \`R0001\`.
- Menu item availability and prices are always loaded from Supabase when the customer submits the cart; the browser cannot set prices.
- Kitchen/waiter screens are refreshed with the Open Dashboard button; automatic live push and receipt printing are not implemented in this branch.

**Pilot limitations:** A shared staff key does not provide individual role accountability. Before distributing this product to other restaurants, implement per-user staff login, role-scoped actions, atomic SQL transactions for order/payment writes, proper audit logs, and stronger anti-abuse protection. Printing, ingredient inventory, expense tracking, and reporting upgrades are planned but **not included** in this code change. Test in staging before merging and deploying. No public QR codes should be printed before end-to-end testing.
