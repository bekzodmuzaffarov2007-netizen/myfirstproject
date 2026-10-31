const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

const {
  BOT_TOKEN,
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
  PUBLIC_URL = '',
  RENDER_EXTERNAL_URL = '',
  KITCHEN_CHAT_ID = '',
  WAITER_CHAT_ID = '',
  MANAGER_TELEGRAM_IDS = '',
  PORT = 10000,
} = process.env;

for (const [name, value] of Object.entries({ BOT_TOKEN, SUPABASE_URL, SUPABASE_SECRET_KEY })) {
  if (!value) throw new Error(`Missing environment variable: ${name}`);
}

const BASE_URL = (PUBLIC_URL || RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
if (!BASE_URL) throw new Error('Missing PUBLIC_URL or RENDER_EXTERNAL_URL');

const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

const managerIds = new Set(MANAGER_TELEGRAM_IDS.split(',').map(x => x.trim()).filter(Boolean));
const checkoutLocks = new Set();
const now = () => new Date().toISOString();
const makeId = p => `${p}-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
const money = (n, c = 'UZS') => `${Number(n || 0).toLocaleString('en-US')} ${c}`;

function check(error) { if (error) throw error; }

async function removeUiMessage(chatId, messageId) {
  if (!chatId || !messageId) return;
  try {
    await bot.telegram.deleteMessage(chatId, Number(messageId));
    return;
  } catch (_) {}

  try {
    await bot.telegram.editMessageReplyMarkup(chatId, Number(messageId), undefined, { inline_keyboard: [] });
  } catch (_) {}
}

async function display(ctx, text, markup) {
  const chatId = String(ctx.chat.id);
  let session = null;
  try { session = await getSession(chatId); } catch (_) {}

  const callbackMessageId = ctx.callbackQuery?.message?.message_id
    ? String(ctx.callbackQuery.message.message_id)
    : '';

  if (callbackMessageId) {
    if (session?.ui_message_id && String(session.ui_message_id) !== callbackMessageId) {
      await removeUiMessage(chatId, session.ui_message_id);
    }

    try {
      const edited = await ctx.editMessageText(text, markup);
      if (session) await saveSession(chatId, { ...session, ui_message_id: callbackMessageId });
      return edited;
    } catch (err) {
      const msg = String(err?.description || err?.message || '');
      if (msg.includes('message is not modified')) {
        if (session) await saveSession(chatId, { ...session, ui_message_id: callbackMessageId });
        return;
      }
      if (!msg.includes("message can't be edited") && !msg.includes('message to edit not found')) throw err;
      await removeUiMessage(chatId, callbackMessageId);
    }
  } else if (session?.ui_message_id) {
    await removeUiMessage(chatId, session.ui_message_id);
  }

  const sent = await ctx.reply(text, markup);
  if (session) {
    await saveSession(chatId, { ...session, ui_message_id: String(sent.message_id) });
  }
  return sent;
}

async function markUpdate(updateId) {
  if (updateId === undefined || updateId === null) return true;
  const { error } = await db.from('restaurant_processed_updates').insert({ update_id: updateId });
  if (!error) return true;
  if (error.code === '23505') return false;
  throw error;
}

async function getTableByParam(param) {
  const { data, error } = await db.from('restaurant_tables').select('*').eq('qr_start_param', param).eq('active', true).maybeSingle();
  check(error); return data;
}
async function getRestaurant(id) {
  const { data, error } = await db.from('restaurant_restaurants').select('*').eq('restaurant_id', id).eq('active', true).maybeSingle();
  check(error); return data;
}
async function getMenu(restaurantId) {
  const { data, error } = await db.from('restaurant_menu').select('*').eq('restaurant_id', restaurantId).eq('available', true).order('sort_order', { ascending: true });
  check(error); return data || [];
}
async function getSession(chatId) {
  const { data, error } = await db.from('restaurant_bot_sessions').select('*').eq('chat_id', String(chatId)).maybeSingle();
  check(error); return data;
}
async function saveSession(chatId, patch) {
  const payload = { chat_id: String(chatId), ...patch, updated_at: now() };
  const { data, error } = await db.from('restaurant_bot_sessions').upsert(payload, { onConflict: 'chat_id' }).select().single();
  check(error); return data;
}

function homeKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🍲 Menu', 'menu'), Markup.button.callback('🛒 Cart', 'cart')],
    [Markup.button.callback('🔔 Call waiter', 'waiter')],
    [Markup.button.callback('🧾 Ask for bill', 'bill')],
  ]);
}

async function showHome(ctx) {
  const s = await getSession(ctx.chat.id);
  if (!s) return display(ctx, 'Please scan your table QR code first.');
  const r = await getRestaurant(s.restaurant_id);
  return display(ctx, `🍽 ${r?.name || 'Restaurant'}\n📍 ${s.table_name}\n\nWhat would you like to do?`, homeKeyboard());
}

async function showMenu(ctx) {
  const s = await getSession(ctx.chat.id);
  if (!s) return display(ctx, 'Please scan your table QR code first.');
  const items = await getMenu(s.restaurant_id);
  const categories = [...new Set(items.map(x => x.category).filter(Boolean))];
  await saveSession(ctx.chat.id, { ...s, categories });
  if (!categories.length) return display(ctx, 'The menu is empty.');
  const kb = categories.map((c, i) => [Markup.button.callback(`🍽 ${c}`, `cat:${i}`)]);
  kb.push([Markup.button.callback('⬅️ Home', 'home')]);
  return display(ctx, 'Choose a category:', Markup.inlineKeyboard(kb));
}

async function showCategory(ctx, index) {
  const s = await getSession(ctx.chat.id);
  if (!s) return display(ctx, 'Please scan your table QR code first.');
  const category = (Array.isArray(s.categories) ? s.categories : [])[Number(index)];
  if (!category) return showMenu(ctx);
  const items = (await getMenu(s.restaurant_id)).filter(x => x.category === category);
  const kb = items.map(x => [Markup.button.callback(`${x.item_name} — ${money(x.price, x.currency)}`, `item:${x.menu_item_id}`)]);
  kb.push([Markup.button.callback('⬅️ Categories', 'menu')]);
  return display(ctx, `🍽 ${category}`, Markup.inlineKeyboard(kb));
}

async function showItem(ctx, itemId) {
  const s = await getSession(ctx.chat.id);
  if (!s) return display(ctx, 'Please scan your table QR code first.');
  const item = (await getMenu(s.restaurant_id)).find(x => String(x.menu_item_id) === String(itemId));
  if (!item) return display(ctx, 'This item is not available.');
  const qty = Number((s.cart || {})[itemId] || 0);
  return display(
    ctx,
    `${item.item_name}${item.description ? `\n${item.description}` : ''}\n\n💰 ${money(item.price, item.currency)}${qty ? `\n\n🛒 In cart: ${qty}` : ''}`,
    Markup.inlineKeyboard([
      [Markup.button.callback('➖', `itemdec:${item.menu_item_id}`), Markup.button.callback(`🛒 ${qty}`, 'noop'), Markup.button.callback('➕', `add:${item.menu_item_id}`)],
      [Markup.button.callback('🛒 View cart', 'cart')],
      [Markup.button.callback('⬅️ Menu', 'menu')],
    ])
  );
}

async function changeCart(ctx, itemId, delta) {
  const s = await getSession(ctx.chat.id);
  if (!s) return null;
  const cart = { ...(s.cart || {}) };
  const next = Math.max(0, Number(cart[itemId] || 0) + delta);
  if (next) cart[itemId] = next; else delete cart[itemId];
  return saveSession(ctx.chat.id, { ...s, cart });
}

async function showCart(ctx) {
  const s = await getSession(ctx.chat.id);
  if (!s) return display(ctx, 'Please scan your table QR code first.');
  const cart = s.cart || {};
  const ids = Object.keys(cart).filter(id => Number(cart[id]) > 0);
  if (!ids.length) {
    return display(ctx, '🛒 Your cart is empty.', Markup.inlineKeyboard([
      [Markup.button.callback('🍲 Open menu', 'menu')],
      [Markup.button.callback('⬅️ Home', 'home')],
    ]));
  }

  const menu = await getMenu(s.restaurant_id);
  let total = 0;
  const lines = ['🛒 Your cart', ''];
  const kb = [];
  for (const itemId of ids) {
    const item = menu.find(x => String(x.menu_item_id) === String(itemId));
    if (!item) continue;
    const qty = Number(cart[itemId]);
    const line = qty * Number(item.price);
    total += line;
    lines.push(`${qty} × ${item.item_name} — ${money(line, item.currency)}`);
    kb.push([
      Markup.button.callback('➖', `dec:${itemId}`),
      Markup.button.callback(`${item.item_name} × ${qty}`, 'noop'),
      Markup.button.callback('➕', `inc:${itemId}`),
    ]);
  }
  lines.push('', `Total: ${money(total)}`);
  kb.push([Markup.button.callback('✅ Place order', 'checkout')]);
  kb.push([Markup.button.callback('🗑 Clear cart', 'clear')]);
  kb.push([Markup.button.callback('⬅️ Menu', 'menu')]);
  return display(ctx, lines.join('\n'), Markup.inlineKeyboard(kb));
}

async function targetChat(restaurantId, type) {
  const r = await getRestaurant(restaurantId);
  if (type === 'kitchen') return KITCHEN_CHAT_ID || r?.kitchen_group_id || r?.telegram_group_id || '';
  return WAITER_CHAT_ID || r?.telegram_group_id || r?.manager_group_id || '';
}

async function createServiceRequest(ctx, type) {
  const s = await getSession(ctx.chat.id);
  if (!s) return display(ctx, 'Please scan your table QR code first.');
  const requestId = makeId('SRV');
  const { error } = await db.from('restaurant_service_requests').insert({
    request_id: requestId,
    restaurant_id: s.restaurant_id,
    table_id: s.table_id,
    customer_telegram_id: String(ctx.from.id),
    request_type: type,
    status: 'OPEN',
  });
  check(error);
  const target = await targetChat(s.restaurant_id, 'waiter');
  if (target) await bot.telegram.sendMessage(target, `${type === 'BILL' ? '🧾 BILL REQUEST' : '🔔 WAITER REQUEST'}\n📍 ${s.table_name}\n${requestId}`);
  return display(ctx, type === 'BILL' ? '🧾 Your bill request was sent.' : '🔔 A waiter has been notified.', homeKeyboard());
}

async function checkout(ctx) {
  const chatKey = String(ctx.chat.id);
  if (checkoutLocks.has(chatKey)) return;

  const s = await getSession(ctx.chat.id);
  if (!s) return display(ctx, 'Please scan your table QR code first.');

  const cart = { ...(s.cart || {}) };
  const selected = Object.keys(cart).filter(id => Number(cart[id]) > 0);
  if (!selected.length) return;

  checkoutLocks.add(chatKey);
  await display(ctx, '⏳ Placing your order…\n\nPlease wait a moment.');

  try {
    const menu = await getMenu(s.restaurant_id);
    const orderId = makeId('ORD');
    let total = 0;
    const itemRows = [];
    const kitchenLines = [];
    const customerLines = [];

    for (const itemId of selected) {
      const item = menu.find(x => String(x.menu_item_id) === String(itemId));
      if (!item) continue;
      const quantity = Number(cart[itemId]);
      const lineTotal = quantity * Number(item.price);
      total += lineTotal;
      itemRows.push({
        order_item_id: makeId('ITM'),
        order_id: orderId,
        restaurant_id: s.restaurant_id,
        menu_item_id: item.menu_item_id,
        item_name: item.item_name,
        quantity,
        unit_price: item.price,
        line_total: lineTotal,
        status: 'NEW',
      });
      kitchenLines.push(`${quantity} × ${item.item_name}`);
      customerLines.push(`${quantity} × ${item.item_name} — ${money(lineTotal, item.currency)}`);
    }

    if (!itemRows.length) {
      return display(ctx, '❌ These items are no longer available.', Markup.inlineKeyboard([[Markup.button.callback('🍲 Back to menu', 'menu')]]));
    }

    let result = await db.from('restaurant_orders').insert({
      order_id: orderId,
      restaurant_id: s.restaurant_id,
      table_id: s.table_id,
      customer_telegram_id: String(ctx.from.id),
      customer_name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || ctx.from.username || String(ctx.from.id),
      status: 'NEW',
      subtotal: total,
      total,
      payment_status: 'UNPAID',
    });
    check(result.error);

    result = await db.from('restaurant_order_items').insert(itemRows);
    check(result.error);

    const latest = await getSession(ctx.chat.id);
    await saveSession(ctx.chat.id, {
      ...(latest || s),
      cart: {},
      last_order_id: orderId,
    });

    const target = await targetChat(s.restaurant_id, 'kitchen');
    if (target) {
      await bot.telegram.sendMessage(target, `🔴 NEW ORDER ${orderId}\n📍 ${s.table_name}\n\n${kitchenLines.join('\n')}\n\n💰 ${money(total)}`);
    }

    return display(
      ctx,
      `✅ Order placed successfully!\n\n${customerLines.join('\n')}\n\n💰 Total: ${money(total)}\n📍 ${s.table_name}\n\nOrder: ${orderId}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('🍲 Order more', 'menu')],
        [Markup.button.callback('🏠 Home', 'home')],
      ])
    );
  } catch (err) {
    console.error('CHECKOUT ERROR', err);
    return display(
      ctx,
      '❌ The order was not completed. Your cart is still saved.\n\nPlease try again.',
      Markup.inlineKeyboard([
        [Markup.button.callback('🛒 Back to cart', 'cart')],
        [Markup.button.callback('🏠 Home', 'home')],
      ])
    );
  } finally {
    checkoutLocks.delete(chatKey);
  }
}

async function authorizedManager(userId) {
  if (managerIds.has(String(userId))) return true;
  const { data, error } = await db.from('restaurant_staff').select('staff_id').eq('telegram_user_id', String(userId)).eq('active', true).in('role', ['OWNER', 'MANAGER', 'CASHIER']).limit(1);
  check(error); return Boolean(data?.length);
}

async function markPaid(orderId, managerId) {
  const { data: order, error } = await db.from('restaurant_orders').select('*').eq('order_id', orderId).maybeSingle();
  check(error); if (!order) return false;
  let result = await db.from('restaurant_orders').update({ status: 'CLOSED', payment_status: 'PAID', closed_at: now() }).eq('order_id', orderId);
  check(result.error);
  result = await db.from('restaurant_payments').insert({
    payment_id: makeId('PAY'), restaurant_id: order.restaurant_id, order_id: order.order_id,
    table_id: order.table_id, amount: order.total, method: 'CASH', status: 'CONFIRMED', confirmed_by: String(managerId),
  });
  check(result.error); return true;
}

bot.start(async ctx => {
  const param = String(ctx.startPayload || '').trim();
  const table = await getTableByParam(param);
  if (!table) return ctx.reply('Welcome 👋\n\nPlease scan the QR code on your table to start ordering.');

  const existing = await getSession(ctx.chat.id);
  const sameTable = existing && String(existing.table_id || '') === String(table.table_id);

  await saveSession(ctx.chat.id, {
    ...(existing || {}),
    restaurant_id: table.restaurant_id,
    table_id: table.table_id,
    table_name: table.table_name,
    customer_telegram_id: String(ctx.from.id),
    customer_name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || ctx.from.username || String(ctx.from.id),
    cart: sameTable ? (existing.cart || {}) : {},
    categories: sameTable ? (existing.categories || []) : [],
    last_order_id: existing?.last_order_id || null,
    ui_message_id: existing?.ui_message_id || null,
  });
  return showHome(ctx);
});

bot.command('menu', showMenu);
bot.command('paid', async ctx => {
  if (!(await authorizedManager(ctx.from.id))) return ctx.reply('You are not authorized to confirm payments.');
  const orderId = String(ctx.message.text || '').split(/\s+/)[1] || '';
  if (!orderId) return ctx.reply('Use: /paid ORDER_ID');
  return ctx.reply((await markPaid(orderId, ctx.from.id)) ? `✅ ${orderId} marked PAID.` : 'Order not found.');
});

bot.action('noop', async ctx => { await ctx.answerCbQuery(); });
bot.action('home', async ctx => { await ctx.answerCbQuery(); return showHome(ctx); });
bot.action('menu', async ctx => { await ctx.answerCbQuery(); return showMenu(ctx); });
bot.action('cart', async ctx => { await ctx.answerCbQuery(); return showCart(ctx); });
bot.action('waiter', async ctx => { await ctx.answerCbQuery(); return createServiceRequest(ctx, 'WAITER'); });
bot.action('bill', async ctx => { await ctx.answerCbQuery(); return createServiceRequest(ctx, 'BILL'); });
bot.action('checkout', async ctx => { await ctx.answerCbQuery('Placing order…'); return checkout(ctx); });
bot.action('clear', async ctx => {
  await ctx.answerCbQuery();
  const s = await getSession(ctx.chat.id);
  if (s) await saveSession(ctx.chat.id, { ...s, cart: {} });
  return showCart(ctx);
});
bot.action(/^cat:(\d+)$/, async ctx => { await ctx.answerCbQuery(); return showCategory(ctx, ctx.match[1]); });
bot.action(/^item:(.+)$/, async ctx => { await ctx.answerCbQuery(); return showItem(ctx, ctx.match[1]); });
bot.action(/^add:(.+)$/, async ctx => { await ctx.answerCbQuery('Added ✅'); await changeCart(ctx, ctx.match[1], 1); return showItem(ctx, ctx.match[1]); });
bot.action(/^itemdec:(.+)$/, async ctx => { await ctx.answerCbQuery(); await changeCart(ctx, ctx.match[1], -1); return showItem(ctx, ctx.match[1]); });
bot.action(/^inc:(.+)$/, async ctx => { await ctx.answerCbQuery(); await changeCart(ctx, ctx.match[1], 1); return showCart(ctx); });
bot.action(/^dec:(.+)$/, async ctx => { await ctx.answerCbQuery(); await changeCart(ctx, ctx.match[1], -1); return showCart(ctx); });

bot.catch(err => console.error('BOT ERROR', err));

app.get('/', (_req, res) => res.status(200).send('Restaurant bot is running'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));
app.post('/telegram', (req, res) => {
  res.status(200).send('OK');
  (async () => {
    try {
      if (!(await markUpdate(req.body?.update_id))) return;
      await bot.handleUpdate(req.body);
    } catch (err) {
      console.error('UPDATE ERROR', err);
    }
  })();
});

app.listen(PORT, async () => {
  const webhook = `${BASE_URL}/telegram`;
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.telegram.setWebhook(webhook, { drop_pending_updates: true, allowed_updates: ['message', 'callback_query'] });
    console.log(`Listening on ${PORT}`);
    console.log(`Telegram webhook: ${webhook}`);
  } catch (err) {
    console.error('WEBHOOK SETUP ERROR', err);
  }
});
