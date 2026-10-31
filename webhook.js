const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const { google } = require('googleapis');

const {
  BOT_TOKEN,
  GOOGLE_SHEET_ID: SHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_JSON,
  PUBLIC_URL,
  KITCHEN_CHAT_ID = '',
  WAITER_CHAT_ID = '',
  MANAGER_TELEGRAM_IDS = '',
  PORT = 10000,
} = process.env;

for (const [k, v] of Object.entries({ BOT_TOKEN, SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON, PUBLIC_URL })) {
  if (!v) throw new Error(`Missing environment variable: ${k}`);
}

const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, '\n');

const auth = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });
const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

const sessions = new Map();
const seen = new Set();
const managers = new Set(MANAGER_TELEGRAM_IDS.split(',').map(x => x.trim()).filter(Boolean));

const now = () => new Date().toISOString();
const id = p => `${p}-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
const yes = v => v === true || ['true', '1', 'yes', 'y'].includes(String(v || '').toLowerCase());
const money = n => `${Number(n || 0).toLocaleString('en-US')} UZS`;

async function rows(sheet) {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${sheet}!A:Z` });
  const v = r.data.values || [];
  if (!v.length) return [];
  const h = v[0];
  return v.slice(1).filter(row => row.some(Boolean)).map(row => Object.fromEntries(h.map((k, i) => [k, row[i] ?? ''])));
}

async function append(sheet, values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${sheet}!A:Z`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] },
  });
}

async function tableByParam(param) {
  return (await rows('Tables')).find(x => x.qr_start_param === param && yes(x.active));
}

async function restaurant(rid) {
  return (await rows('Restaurants')).find(x => x.restaurant_id === rid && yes(x.active));
}

async function menu(rid) {
  return (await rows('Menu'))
    .filter(x => x.restaurant_id === rid && yes(x.available))
    .map(x => ({ ...x, price: Number(x.price || 0), sort_order: Number(x.sort_order || 0) }))
    .sort((a, b) => a.sort_order - b.sort_order);
}

function homeKb() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🍲 Menu', 'menu'), Markup.button.callback('🛒 Cart', 'cart')],
    [Markup.button.callback('🔔 Call waiter', 'waiter')],
    [Markup.button.callback('🧾 Ask for bill', 'bill')],
  ]);
}

async function showHome(ctx) {
  const s = sessions.get(String(ctx.chat.id));
  if (!s) return ctx.reply('Please scan your table QR code first.');
  const r = await restaurant(s.restaurant_id);
  return ctx.reply(`🍽 ${r?.name || 'Restaurant'}\n📍 ${s.table_name}\n\nWhat would you like to do?`, homeKb());
}

async function showMenu(ctx) {
  const s = sessions.get(String(ctx.chat.id));
  if (!s) return ctx.reply('Please scan your table QR code first.');
  const items = await menu(s.restaurant_id);
  const cats = [...new Set(items.map(x => x.category).filter(Boolean))];
  s.categories = cats;
  sessions.set(String(ctx.chat.id), s);
  const kb = cats.map((c, i) => [Markup.button.callback(`🍽 ${c}`, `cat:${i}`)]);
  kb.push([Markup.button.callback('⬅️ Home', 'home')]);
  return ctx.reply(cats.length ? 'Choose a category:' : 'Menu is empty.', Markup.inlineKeyboard(kb));
}

async function showCategory(ctx, n) {
  const s = sessions.get(String(ctx.chat.id));
  if (!s) return ctx.reply('Please scan your table QR code first.');
  const cat = s.categories?.[Number(n)];
  if (!cat) return showMenu(ctx);
  const items = (await menu(s.restaurant_id)).filter(x => x.category === cat);
  const kb = items.map(x => [Markup.button.callback(`${x.item_name} — ${money(x.price)}`, `item:${x.menu_item_id}`)]);
  kb.push([Markup.button.callback('⬅️ Categories', 'menu')]);
  return ctx.reply(`🍽 ${cat}`, Markup.inlineKeyboard(kb));
}

async function showItem(ctx, itemId, note = '') {
  const s = sessions.get(String(ctx.chat.id));
  if (!s) return ctx.reply('Please scan your table QR code first.');
  const item = (await menu(s.restaurant_id)).find(x => String(x.menu_item_id) === String(itemId));
  if (!item) return ctx.reply('Item unavailable.');
  return ctx.reply(
    `${item.item_name}${item.description ? `\n${item.description}` : ''}\n\n💰 ${money(item.price)}${note ? `\n\n${note}` : ''}`,
    Markup.inlineKeyboard([
      [Markup.button.callback('➕ Add to cart', `add:${item.menu_item_id}`)],
      [Markup.button.callback('🛒 View cart', 'cart')],
      [Markup.button.callback('⬅️ Menu', 'menu')],
    ])
  );
}

async function showCart(ctx) {
  const s = sessions.get(String(ctx.chat.id));
  if (!s) return ctx.reply('Please scan your table QR code first.');
  const m = await menu(s.restaurant_id);
  const cart = s.cart || {};
  const ids = Object.keys(cart).filter(k => cart[k] > 0);
  if (!ids.length) return ctx.reply('🛒 Your cart is empty.', Markup.inlineKeyboard([[Markup.button.callback('🍲 Menu', 'menu')]]));
  let total = 0;
  const text = ['🛒 Your cart', ''];
  const kb = [];
  for (const mid of ids) {
    const x = m.find(i => String(i.menu_item_id) === String(mid));
    if (!x) continue;
    const q = Number(cart[mid]);
    total += q * x.price;
    text.push(`${q} × ${x.item_name} — ${money(q * x.price)}`);
    kb.push([Markup.button.callback(`➖ ${x.item_name}`, `dec:${mid}`), Markup.button.callback('➕', `inc:${mid}`)]);
  }
  text.push('', `Total: ${money(total)}`);
  kb.push([Markup.button.callback('✅ Place order', 'checkout')]);
  kb.push([Markup.button.callback('🗑 Clear cart', 'clear')]);
  return ctx.reply(text.join('\n'), Markup.inlineKeyboard(kb));
}

async function service(ctx, type) {
  const s = sessions.get(String(ctx.chat.id));
  if (!s) return ctx.reply('Please scan your table QR code first.');
  const reqId = id('SRV');
  await append('ServiceRequests', [reqId, s.restaurant_id, s.table_id, String(ctx.from.id), type, now(), 'OPEN', '', '']);
  const target = WAITER_CHAT_ID || KITCHEN_CHAT_ID;
  if (target) await bot.telegram.sendMessage(target, `${type === 'BILL' ? '🧾 BILL REQUEST' : '🔔 WAITER REQUEST'}\n📍 ${s.table_name}\n${reqId}`);
  return ctx.reply(type === 'BILL' ? '🧾 Bill request sent.' : '🔔 Waiter notified.');
}

async function checkout(ctx) {
  const s = sessions.get(String(ctx.chat.id));
  if (!s) return ctx.reply('Please scan your table QR code first.');
  const m = await menu(s.restaurant_id);
  const cart = s.cart || {};
  const selected = Object.keys(cart).filter(k => Number(cart[k]) > 0);
  if (!selected.length) return showCart(ctx);
  const orderId = id('ORD');
  const created = now();
  let total = 0;
  const itemRows = [];
  const kitchen = [];
  for (const mid of selected) {
    const x = m.find(i => String(i.menu_item_id) === String(mid));
    if (!x) continue;
    const q = Number(cart[mid]);
    const line = q * x.price;
    total += line;
    itemRows.push([id('ITM'), orderId, s.restaurant_id, x.menu_item_id, x.item_name, q, x.price, line, 'NEW', '', created]);
    kitchen.push(`${q} × ${x.item_name}`);
  }
  await append('Orders', [orderId, s.restaurant_id, s.table_id, String(ctx.from.id), ctx.from.first_name || '', created, 'NEW', total, total, 'UNPAID', '', '', '']);
  for (const row of itemRows) await append('OrderItems', row);
  s.cart = {};
  sessions.set(String(ctx.chat.id), s);
  if (KITCHEN_CHAT_ID) await bot.telegram.sendMessage(KITCHEN_CHAT_ID, `🔴 NEW ORDER ${orderId}\n📍 ${s.table_name}\n\n${kitchen.join('\n')}\n\n💰 ${money(total)}`);
  return ctx.reply(`✅ Order ${orderId} received.\n📍 ${s.table_name}\n💰 ${money(total)}`, homeKb());
}

async function markPaid(orderId, managerId) {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Orders!A:M' });
  const v = r.data.values || [];
  if (!v.length) return false;
  const h = v[0];
  const oi = h.indexOf('order_id'), si = h.indexOf('status'), pi = h.indexOf('payment_status'), ci = h.indexOf('closed_at');
  const rowIndex = v.findIndex((x, i) => i > 0 && x[oi] === orderId);
  if (rowIndex < 1) return false;
  const row = v[rowIndex];
  const sheetRow = rowIndex + 1;
  const data = [];
  const letter = i => String.fromCharCode(65 + i);
  if (si >= 0) data.push({ range: `Orders!${letter(si)}${sheetRow}`, values: [['CLOSED']] });
  if (pi >= 0) data.push({ range: `Orders!${letter(pi)}${sheetRow}`, values: [['PAID']] });
  if (ci >= 0) data.push({ range: `Orders!${letter(ci)}${sheetRow}`, values: [[now()]] });
  await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { valueInputOption: 'USER_ENTERED', data } });
  await append('Payments', [id('PAY'), row[h.indexOf('restaurant_id')] || '', orderId, row[h.indexOf('table_id')] || '', Number(row[h.indexOf('total')] || 0), 'CASH', 'CONFIRMED', managerId, now()]);
  return true;
}

bot.use(async (ctx, next) => {
  const uid = ctx.update?.update_id;
  if (uid !== undefined) {
    if (seen.has(uid)) return;
    seen.add(uid);
    if (seen.size > 5000) seen.clear();
  }
  return next();
});

bot.start(async ctx => {
  const t = await tableByParam(String(ctx.startPayload || '').trim());
  if (!t) return ctx.reply('Welcome 👋\nPlease scan the QR code on your table.');
  sessions.set(String(ctx.chat.id), { restaurant_id: t.restaurant_id, table_id: t.table_id, table_name: t.table_name, cart: {} });
  return showHome(ctx);
});

bot.action('home', async ctx => { await ctx.answerCbQuery(); return showHome(ctx); });
bot.action('menu', async ctx => { await ctx.answerCbQuery(); return showMenu(ctx); });
bot.action('cart', async ctx => { await ctx.answerCbQuery(); return showCart(ctx); });
bot.action('waiter', async ctx => { await ctx.answerCbQuery(); return service(ctx, 'WAITER'); });
bot.action('bill', async ctx => { await ctx.answerCbQuery(); return service(ctx, 'BILL'); });
bot.action('checkout', async ctx => { await ctx.answerCbQuery(); return checkout(ctx); });
bot.action('clear', async ctx => { await ctx.answerCbQuery(); const s = sessions.get(String(ctx.chat.id)); if (s) { s.cart = {}; sessions.set(String(ctx.chat.id), s); } return showCart(ctx); });
bot.action(/^cat:(\d+)$/, async ctx => { await ctx.answerCbQuery(); return showCategory(ctx, ctx.match[1]); });
bot.action(/^item:(.+)$/, async ctx => { await ctx.answerCbQuery(); return showItem(ctx, ctx.match[1]); });
bot.action(/^add:(.+)$/, async ctx => { await ctx.answerCbQuery('Added ✅'); const s = sessions.get(String(ctx.chat.id)); if (s) { s.cart[ctx.match[1]] = Number(s.cart[ctx.match[1]] || 0) + 1; sessions.set(String(ctx.chat.id), s); } return showItem(ctx, ctx.match[1], 'Added to cart ✅'); });
bot.action(/^inc:(.+)$/, async ctx => { await ctx.answerCbQuery(); const s = sessions.get(String(ctx.chat.id)); if (s) { s.cart[ctx.match[1]] = Number(s.cart[ctx.match[1]] || 0) + 1; } return showCart(ctx); });
bot.action(/^dec:(.+)$/, async ctx => { await ctx.answerCbQuery(); const s = sessions.get(String(ctx.chat.id)); if (s) { const k = ctx.match[1]; s.cart[k] = Math.max(0, Number(s.cart[k] || 0) - 1); if (!s.cart[k]) delete s.cart[k]; } return showCart(ctx); });

bot.command('paid', async ctx => {
  const mid = String(ctx.from.id);
  if (!managers.has(mid)) return ctx.reply('You are not authorized to confirm payments.');
  const orderId = String(ctx.message.text || '').split(/\s+/)[1] || '';
  if (!orderId) return ctx.reply('Use: /paid ORDER_ID');
  return ctx.reply(await markPaid(orderId, mid) ? `✅ ${orderId} marked PAID.` : 'Order not found.');
});

bot.catch(err => console.error('BOT ERROR', err));

app.get('/', (_req, res) => res.status(200).send('Restaurant bot is running'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

app.post('/telegram', (req, res) => {
  // ACK Telegram immediately. Processing continues after the HTTP 200 response.
  res.status(200).send('OK');
  bot.handleUpdate(req.body).catch(err => console.error('UPDATE ERROR', err));
});

app.listen(PORT, async () => {
  const webhook = `${PUBLIC_URL.replace(/\/$/, '')}/telegram`;
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  await bot.telegram.setWebhook(webhook, { drop_pending_updates: true });
  console.log(`Listening on ${PORT}`);
  console.log(`Telegram webhook: ${webhook}`);
});
