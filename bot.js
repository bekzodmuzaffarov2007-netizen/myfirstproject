const { Telegraf, Markup } = require('telegraf');
const { google } = require('googleapis');

const BOT_TOKEN = process.env.BOT_TOKEN;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const KITCHEN_CHAT_ID = process.env.KITCHEN_CHAT_ID || '';
const WAITER_CHAT_ID = process.env.WAITER_CHAT_ID || '';
const MANAGER_TELEGRAM_IDS = new Set(
  String(process.env.MANAGER_TELEGRAM_IDS || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)
);

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');
if (!SHEET_ID) throw new Error('Missing GOOGLE_SHEET_ID');
if (!GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');

let credentials;
try {
  credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  if (credentials.private_key) {
    credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
  }
} catch (err) {
  throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
}

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });
const bot = new Telegraf(BOT_TOKEN);

const sessions = new Map();
const seenUpdates = new Map();

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
}

function money(n, currency = 'UZS') {
  return `${Number(n || 0).toLocaleString('en-US')} ${currency}`;
}

function truthy(v) {
  if (v === true) return true;
  return ['true', '1', 'yes', 'y'].includes(String(v || '').toLowerCase().trim());
}

async function readObjects(sheetName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A:Z`
  });
  const values = res.data.values || [];
  if (!values.length) return [];
  const headers = values[0];
  return values.slice(1)
    .filter(row => row.some(v => v !== ''))
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => obj[h] = row[i] ?? '');
      return obj;
    });
}

async function appendRow(sheetName, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A:Z`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });
}

async function updateOrderPaid(orderId, managerId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Orders!A:Z'
  });
  const values = res.data.values || [];
  if (!values.length) return null;

  const headers = values[0];
  const orderCol = headers.indexOf('order_id');
  const restaurantCol = headers.indexOf('restaurant_id');
  const tableCol = headers.indexOf('table_id');
  const totalCol = headers.indexOf('total');
  const statusCol = headers.indexOf('status');
  const paymentStatusCol = headers.indexOf('payment_status');
  const closedAtCol = headers.indexOf('closed_at');

  const rowIndex = values.findIndex((r, i) => i > 0 && String(r[orderCol]) === orderId);
  if (rowIndex < 1) return null;

  const row = values[rowIndex];
  const sheetRow = rowIndex + 1;

  const updates = [];
  if (statusCol >= 0) updates.push({ range: `Orders!${colLetter(statusCol)}${sheetRow}`, values: [['CLOSED']] });
  if (paymentStatusCol >= 0) updates.push({ range: `Orders!${colLetter(paymentStatusCol)}${sheetRow}`, values: [['PAID']] });
  if (closedAtCol >= 0) updates.push({ range: `Orders!${colLetter(closedAtCol)}${sheetRow}`, values: [[nowIso()]] });

  if (updates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: updates }
    });
  }

  await appendRow('Payments', [
    makeId('PAY'),
    row[restaurantCol] || '',
    orderId,
    row[tableCol] || '',
    Number(row[totalCol] || 0),
    'CASH',
    'CONFIRMED',
    String(managerId),
    nowIso()
  ]);

  return {
    restaurant_id: row[restaurantCol] || '',
    table_id: row[tableCol] || '',
    total: Number(row[totalCol] || 0)
  };
}

function colLetter(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

async function getTableByParam(param) {
  const tables = await readObjects('Tables');
  return tables.find(r => String(r.qr_start_param) === String(param) && truthy(r.active));
}

async function getRestaurant(id) {
  const restaurants = await readObjects('Restaurants');
  return restaurants.find(r => String(r.restaurant_id) === String(id) && truthy(r.active));
}

async function getMenu(restaurantId) {
  const menu = await readObjects('Menu');
  return menu
    .filter(r => String(r.restaurant_id) === String(restaurantId) && truthy(r.available))
    .map(r => ({
      ...r,
      price: Number(r.price || 0),
      sort_order: Number(r.sort_order || 0)
    }))
    .sort((a, b) => a.sort_order - b.sort_order);
}

function homeKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🍲 Menu', 'menu'), Markup.button.callback('🛒 Cart', 'cart')],
    [Markup.button.callback('🔔 Call waiter', 'waiter')],
    [Markup.button.callback('🧾 Ask for bill', 'bill')]
  ]);
}

async function showHome(ctx) {
  const session = sessions.get(String(ctx.chat.id));
  if (!session) return ctx.reply('Please scan your table QR code first.');
  const restaurant = await getRestaurant(session.restaurant_id);
  const name = restaurant?.name || 'Restaurant';
  return ctx.reply(`🍽 ${name}\n📍 ${session.table_name}\n\nWhat would you like to do?`, homeKeyboard());
}

async function showMenu(ctx) {
  const session = sessions.get(String(ctx.chat.id));
  if (!session) return ctx.reply('Please scan your table QR code first.');
  const items = await getMenu(session.restaurant_id);
  const categories = [...new Set(items.map(i => i.category).filter(Boolean))];
  if (!categories.length) return ctx.reply('The menu is not available yet.');

  const keyboard = categories.map((cat, idx) => [Markup.button.callback(`🍽 ${cat}`, `cat:${idx}`)]);
  keyboard.push([Markup.button.callback('⬅️ Home', 'home')]);

  session.categories = categories;
  sessions.set(String(ctx.chat.id), session);
  return ctx.reply('Choose a category:', Markup.inlineKeyboard(keyboard));
}

async function showCategory(ctx, index) {
  const session = sessions.get(String(ctx.chat.id));
  if (!session) return ctx.reply('Please scan your table QR code first.');
  const category = session.categories?.[Number(index)];
  if (!category) return showMenu(ctx);
  const items = (await getMenu(session.restaurant_id)).filter(i => i.category === category);
  const keyboard = items.map(item => [Markup.button.callback(`${item.item_name} — ${money(item.price, item.currency || 'UZS')}`, `item:${item.menu_item_id}`)]);
  keyboard.push([Markup.button.callback('⬅️ Categories', 'menu')]);
  return ctx.reply(`🍽 ${category}`, Markup.inlineKeyboard(keyboard));
}

async function showItem(ctx, itemId, note = '') {
  const session = sessions.get(String(ctx.chat.id));
  if (!session) return ctx.reply('Please scan your table QR code first.');
  const item = (await getMenu(session.restaurant_id)).find(i => String(i.menu_item_id) === String(itemId));
  if (!item) return ctx.reply('This item is not available.');

  const text = `${item.item_name}\n${item.description ? item.description + '\n' : ''}\n💰 ${money(item.price, item.currency || 'UZS')}${note ? `\n\n${note}` : ''}`;
  return ctx.reply(text, Markup.inlineKeyboard([
    [Markup.button.callback('➕ Add to cart', `add:${item.menu_item_id}`)],
    [Markup.button.callback('🛒 View cart', 'cart')],
    [Markup.button.callback('⬅️ Menu', 'menu')]
  ]));
}

async function showCart(ctx) {
  const session = sessions.get(String(ctx.chat.id));
  if (!session) return ctx.reply('Please scan your table QR code first.');
  const cart = session.cart || {};
  const ids = Object.keys(cart).filter(id => Number(cart[id]) > 0);
  if (!ids.length) {
    return ctx.reply('🛒 Your cart is empty.', Markup.inlineKeyboard([
      [Markup.button.callback('🍲 Open menu', 'menu')],
      [Markup.button.callback('⬅️ Home', 'home')]
    ]));
  }

  const menu = await getMenu(session.restaurant_id);
  let total = 0;
  const lines = ['🛒 Your cart', ''];
  const keyboard = [];

  for (const id of ids) {
    const item = menu.find(i => String(i.menu_item_id) === String(id));
    if (!item) continue;
    const qty = Number(cart[id]);
    const lineTotal = qty * item.price;
    total += lineTotal;
    lines.push(`${qty} × ${item.item_name} — ${money(lineTotal, item.currency || 'UZS')}`);
    keyboard.push([
      Markup.button.callback(`➖ ${item.item_name}`, `dec:${id}`),
      Markup.button.callback('➕', `inc:${id}`)
    ]);
  }

  lines.push('', `Total: ${money(total, 'UZS')}`);
  keyboard.push([Markup.button.callback('✅ Place order', 'checkout')]);
  keyboard.push([Markup.button.callback('🗑 Clear cart', 'clear')]);
  keyboard.push([Markup.button.callback('⬅️ Menu', 'menu')]);

  return ctx.reply(lines.join('\n'), Markup.inlineKeyboard(keyboard));
}

async function createServiceRequest(ctx, type) {
  const session = sessions.get(String(ctx.chat.id));
  if (!session) return ctx.reply('Please scan your table QR code first.');

  const id = makeId('SRV');
  await appendRow('ServiceRequests', [
    id,
    session.restaurant_id,
    session.table_id,
    String(ctx.from.id),
    type,
    nowIso(),
    'OPEN',
    '',
    ''
  ]);

  const target = WAITER_CHAT_ID || KITCHEN_CHAT_ID;
  if (target) {
    await bot.telegram.sendMessage(target, `${type === 'BILL' ? '🧾 BILL REQUEST' : '🔔 WAITER REQUEST'}\n📍 ${session.table_name}\nRequest: ${id}`);
  }

  return ctx.reply(type === 'BILL' ? '🧾 Your bill request was sent.' : '🔔 A waiter has been notified.');
}

async function checkout(ctx) {
  const chatId = String(ctx.chat.id);
  const session = sessions.get(chatId);
  if (!session) return ctx.reply('Please scan your table QR code first.');

  const cart = session.cart || {};
  const ids = Object.keys(cart).filter(id => Number(cart[id]) > 0);
  if (!ids.length) return showCart(ctx);

  const menu = await getMenu(session.restaurant_id);
  const orderId = makeId('ORD');
  const createdAt = nowIso();
  let total = 0;
  const orderItems = [];
  const kitchenLines = [];

  for (const id of ids) {
    const item = menu.find(i => String(i.menu_item_id) === String(id));
    if (!item) continue;
    const qty = Number(cart[id]);
    const lineTotal = qty * item.price;
    total += lineTotal;
    orderItems.push([
      makeId('ITM'),
      orderId,
      session.restaurant_id,
      item.menu_item_id,
      item.item_name,
      qty,
      item.price,
      lineTotal,
      'NEW',
      '',
      createdAt
    ]);
    kitchenLines.push(`${qty} × ${item.item_name}`);
  }

  if (!orderItems.length) return ctx.reply('The selected items are no longer available.');

  await appendRow('Orders', [
    orderId,
    session.restaurant_id,
    session.table_id,
    String(ctx.from.id),
    [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || ctx.from.username || String(ctx.from.id),
    createdAt,
    'NEW',
    total,
    total,
    'UNPAID',
    '',
    '',
    ''
  ]);

  for (const row of orderItems) await appendRow('OrderItems', row);

  session.cart = {};
  session.last_order_id = orderId;
  sessions.set(chatId, session);

  if (KITCHEN_CHAT_ID) {
    await bot.telegram.sendMessage(
      KITCHEN_CHAT_ID,
      `🔴 NEW ORDER ${orderId}\n📍 ${session.table_name}\n\n${kitchenLines.join('\n')}\n\n💰 ${money(total, 'UZS')}`
    );
  }

  return ctx.reply(`✅ Order ${orderId} received.\n\n📍 ${session.table_name}\n💰 Total: ${money(total, 'UZS')}\n\nThe kitchen has received your order.`, homeKeyboard());
}

bot.use(async (ctx, next) => {
  const id = ctx.update?.update_id;
  if (id !== undefined) {
    const key = String(id);
    if (seenUpdates.has(key)) return;
    seenUpdates.set(key, Date.now());
    if (seenUpdates.size > 5000) {
      const cutoff = Date.now() - 6 * 60 * 60 * 1000;
      for (const [k, ts] of seenUpdates) if (ts < cutoff) seenUpdates.delete(k);
    }
  }
  return next();
});

bot.start(async ctx => {
  const param = String(ctx.startPayload || '').trim();
  const table = await getTableByParam(param);
  if (!table) return ctx.reply('Welcome 👋\n\nPlease scan the QR code on your table to start ordering.');

  sessions.set(String(ctx.chat.id), {
    restaurant_id: table.restaurant_id,
    table_id: table.table_id,
    table_name: table.table_name,
    cart: {}
  });

  return showHome(ctx);
});

bot.command('menu', showMenu);

bot.command('paid', async ctx => {
  const userId = String(ctx.from.id);
  if (!MANAGER_TELEGRAM_IDS.has(userId)) return ctx.reply('You are not authorized to confirm payments.');
  const orderId = String(ctx.message.text || '').split(/\s+/)[1] || '';
  if (!orderId) return ctx.reply('Use: /paid ORDER_ID');

  const order = await updateOrderPaid(orderId, userId);
  if (!order) return ctx.reply('Order not found.');
  return ctx.reply(`✅ ${orderId} marked PAID.`);
});

bot.action('home', async ctx => { await ctx.answerCbQuery(); return showHome(ctx); });
bot.action('menu', async ctx => { await ctx.answerCbQuery(); return showMenu(ctx); });
bot.action('cart', async ctx => { await ctx.answerCbQuery(); return showCart(ctx); });
bot.action('waiter', async ctx => { await ctx.answerCbQuery(); return createServiceRequest(ctx, 'WAITER'); });
bot.action('bill', async ctx => { await ctx.answerCbQuery(); return createServiceRequest(ctx, 'BILL'); });
bot.action('clear', async ctx => {
  await ctx.answerCbQuery();
  const s = sessions.get(String(ctx.chat.id));
  if (s) { s.cart = {}; sessions.set(String(ctx.chat.id), s); }
  return showCart(ctx);
});
bot.action('checkout', async ctx => { await ctx.answerCbQuery(); return checkout(ctx); });

bot.action(/^cat:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  return showCategory(ctx, ctx.match[1]);
});

bot.action(/^item:(.+)$/, async ctx => {
  await ctx.answerCbQuery();
  return showItem(ctx, ctx.match[1]);
});

bot.action(/^add:(.+)$/, async ctx => {
  await ctx.answerCbQuery('Added ✅');
  const id = ctx.match[1];
  const s = sessions.get(String(ctx.chat.id));
  if (!s) return;
  s.cart = s.cart || {};
  s.cart[id] = Number(s.cart[id] || 0) + 1;
  sessions.set(String(ctx.chat.id), s);
  return showItem(ctx, id, 'Added to cart ✅');
});

bot.action(/^inc:(.+)$/, async ctx => {
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const s = sessions.get(String(ctx.chat.id));
  if (s) {
    s.cart = s.cart || {};
    s.cart[id] = Number(s.cart[id] || 0) + 1;
    sessions.set(String(ctx.chat.id), s);
  }
  return showCart(ctx);
});

bot.action(/^dec:(.+)$/, async ctx => {
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const s = sessions.get(String(ctx.chat.id));
  if (s) {
    s.cart = s.cart || {};
    const next = Math.max(0, Number(s.cart[id] || 0) - 1);
    if (next === 0) delete s.cart[id]; else s.cart[id] = next;
    sessions.set(String(ctx.chat.id), s);
  }
  return showCart(ctx);
});

bot.catch(err => console.error('Bot error:', err));

(async () => {
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  await bot.launch({ dropPendingUpdates: true });
  console.log('Restaurant bot started with long polling.');
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
