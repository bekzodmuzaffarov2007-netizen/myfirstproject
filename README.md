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
