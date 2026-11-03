# Restaurant System v1

Las Vegas is the pilot restaurant. The architecture is multi-restaurant from day one.

## Staff flow

1. Waiter opens staff interface and selects room/divan/table.
2. Waiter adds menu items and sends the order.
3. Kitchen sees NEW orders and changes them to COOKING then READY.
4. Waiter receives READY status and serves the table.
5. Cashier/manager closes the bill after receiving payment.
6. Every important change is stored in the audit/event log.
7. Daily reports are generated from confirmed payments and closed orders.

## Interfaces

- Waiter: Telegram Mini App / mobile web interface.
- Kitchen: full-screen web dashboard on a tablet or PC.
- Cashier/manager: web dashboard plus Telegram notifications.
- Owner: reporting dashboard and automatic Telegram summary.

## Core data

Existing tables:
- restaurant_restaurants
- restaurant_staff
- restaurant_tables
- restaurant_menu
- restaurant_orders
- restaurant_order_items
- restaurant_payments
- restaurant_service_requests
- restaurant_daily_report_runs

System v1 additions:
- restaurant_printers: receipt/kitchen printer configuration.
- restaurant_devices: registered kitchen/cashier/tablet devices.
- restaurant_order_events: immutable-style audit trail for order state and staff actions.

## Order states

Recommended order status flow:

NEW -> ACCEPTED -> COOKING -> READY -> SERVED -> CLOSED

Exceptions:

CANCELLED, VOIDED

Payment status:

UNPAID -> PAID

Refunds/voids must be separate events and require manager authorization.

## Printer strategy

Phase 1 uses browser print for an 80mm thermal printer connected to cashier/kitchen PC or Android device.
Phase 2 adds direct ESC/POS network/USB printing through a local print bridge where required.

The backend must generate a printer-neutral receipt payload so different printer models can be supported without changing order logic.

## Security

- The Supabase secret/service key stays only on the backend.
- Staff clients must never receive the secret key.
- Restaurant ID is required on restaurant-owned data.
- Manager-only actions: payment confirmation, void, refund, price override, staff management.
- Every manager-sensitive action is written to restaurant_order_events.

## Pilot scope for Las Vegas

- 7 rooms: 1-xona through 7-xona.
- 10 divan seats/areas.
- Waiter order entry.
- Kitchen queue.
- Ready notification.
- Manager payment confirmation.
- 80mm bill receipt.
- Daily sales report.
- Menu and price management.

## Commercial direction

The same backend should support many restaurants. Each restaurant gets its own staff, menu, tables, devices, printers and reports, separated by restaurant_id.
