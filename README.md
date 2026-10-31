# Restaurant Telegram Bot

A Node.js Telegram restaurant ordering bot using Google Sheets as the database.

## What it does

- QR deep links identify the restaurant table.
- Customer sees menu categories and items.
- Cart supports add/remove quantities.
- Orders are saved to `Orders` and `OrderItems` in Google Sheets.
- `Call waiter` and `Ask for bill` are saved to `ServiceRequests` and can alert staff chats.
- Kitchen can receive new order alerts.
- Authorized managers can mark cash orders paid with `/paid ORDER_ID`.
- Telegram webhook is acknowledged immediately to avoid repeated update delivery.

## Google Sheet

Spreadsheet ID:

`1AmyCexh3sQEDMpXYFfLNZcP4qHSrlKOBPq1r3BGfP-E`

The service account used by the bot must have Editor access to this spreadsheet.

## Required environment variables

- `BOT_TOKEN` — Telegram BotFather token.
- `GOOGLE_SHEET_ID` — spreadsheet ID above.
- `GOOGLE_SERVICE_ACCOUNT_JSON` — the entire Google service-account JSON credential as one environment variable.
- `PUBLIC_URL` — deployed service URL, e.g. `https://restaurant-telegram-bot.onrender.com`.

Optional:

- `KITCHEN_CHAT_ID`
- `WAITER_CHAT_ID`
- `MANAGER_TELEGRAM_IDS` — comma-separated Telegram numeric user IDs.

## Deploy on Render

1. Create/sign in to Render.
2. Choose **New → Blueprint** and connect this GitHub repo.
3. Render reads `render.yaml` automatically.
4. Enter the environment variables above.
5. Deploy.
6. Set `PUBLIC_URL` to the final Render service URL and redeploy once.
7. The app automatically removes the old Telegram webhook and registers `PUBLIC_URL/telegram`.

## Google service account

1. In Google Cloud Console, create a project or choose an existing one.
2. Enable **Google Sheets API**.
3. Create a **Service Account**.
4. Create a JSON key for that service account.
5. Copy the service-account email address.
6. Share the Restaurant Automation MVP Google Sheet with that email as **Editor**.
7. Put the full JSON key contents into Render as `GOOGLE_SERVICE_ACCOUNT_JSON`.

Never commit the BotFather token or service-account JSON into GitHub.

## Test

Use the Table 1 deep link:

`https://t.me/restoranboshqaruvi_bot?start=R0001_T001`

Health endpoint:

`/health`
