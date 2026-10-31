const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

const { BOT_TOKEN, SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  throw new Error('Missing BOT_TOKEN, SUPABASE_URL or SUPABASE_SECRET_KEY for daily report');
}

const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const bot = new Telegraf(BOT_TOKEN);
const running = new Set();
const money = n => `${Number(n || 0).toLocaleString('en-US')} UZS`;

function tashkentParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tashkent',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}

function previousLocalDayWindow() {
  const p = tashkentParts();
  const current = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
  const previous = new Date(current.getTime() - 86400000);
  const y = previous.getUTCFullYear();
  const m = String(previous.getUTCMonth() + 1).padStart(2, '0');
  const d = String(previous.getUTCDate()).padStart(2, '0');
  const cy = current.getUTCFullYear();
  const cm = String(current.getUTCMonth() + 1).padStart(2, '0');
  const cd = String(current.getUTCDate()).padStart(2, '0');
  return {
    reportDate: `${y}-${m}-${d}`,
    label: `${d}.${m}.${y}`,
    startIso: `${y}-${m}-${d}T00:00:00+05:00`,
    endIso: `${cy}-${cm}-${cd}T00:00:00+05:00`,
  };
}

async function sendReportForRestaurant(restaurant) {
  const { reportDate, label, startIso, endIso } = previousLocalDayWindow();
  const lockKey = `${restaurant.restaurant_id}:${reportDate}`;
  if (running.has(lockKey)) return;
  running.add(lockKey);

  try {
    const { data: existing, error: runErr } = await db
      .from('restaurant_daily_report_runs')
      .select('status')
      .eq('restaurant_id', restaurant.restaurant_id)
      .eq('report_date', reportDate)
      .maybeSingle();
    if (runErr) throw runErr;
    if (existing?.status === 'SENT') return;

    const { data: orders, error: orderErr } = await db
      .from('restaurant_orders')
      .select('order_id,table_id,total,closed_at,payment_status')
      .eq('restaurant_id', restaurant.restaurant_id)
      .eq('payment_status', 'PAID')
      .gte('closed_at', startIso)
      .lt('closed_at', endIso)
      .order('closed_at', { ascending: true });
    if (orderErr) throw orderErr;

    const { data: tables, error: tableErr } = await db
      .from('restaurant_tables')
      .select('table_id,table_name')
      .eq('restaurant_id', restaurant.restaurant_id);
    if (tableErr) throw tableErr;

    const tableNames = new Map((tables || []).map(t => [String(t.table_id), t.table_name]));
    const paidOrders = orders || [];
    const total = paidOrders.reduce((sum, o) => sum + Number(o.total || 0), 0);

    const lines = [
      `📊 KUNLIK HISOBOT — ${label}`,
      '',
      '✅ Faqat menejer tasdiqlagan TO‘LANGAN buyurtmalar',
      `📦 To‘langan buyurtmalar: ${paidOrders.length}`,
      `💰 Jami tushum: ${money(total)}`,
    ];

    if (paidOrders.length) {
      lines.push('', 'Buyurtmalar:');
      for (const [index, order] of paidOrders.entries()) {
        const place = tableNames.get(String(order.table_id)) || order.table_id || 'Noma’lum joy';
        lines.push(`${index + 1}. ${place} — ${money(order.total)}`);
      }
    } else {
      lines.push('', 'Bu kun uchun menejer tasdiqlagan to‘langan buyurtma yo‘q.');
    }

    await bot.telegram.sendMessage(restaurant.report_channel_id, lines.join('\n'));

    const { error: saveErr } = await db.from('restaurant_daily_report_runs').upsert({
      restaurant_id: restaurant.restaurant_id,
      report_date: reportDate,
      status: 'SENT',
      sent_at: new Date().toISOString(),
      error_message: null,
    }, { onConflict: 'restaurant_id,report_date' });
    if (saveErr) throw saveErr;

    console.log(`Daily report sent: ${restaurant.restaurant_id} ${reportDate}`);
  } catch (err) {
    console.error('DAILY REPORT ERROR', err);
    try {
      await db.from('restaurant_daily_report_runs').upsert({
        restaurant_id: restaurant.restaurant_id,
        report_date: previousLocalDayWindow().reportDate,
        status: 'FAILED',
        sent_at: null,
        error_message: String(err?.message || err).slice(0, 1000),
      }, { onConflict: 'restaurant_id,report_date' });
    } catch (_) {}
  } finally {
    running.delete(lockKey);
  }
}

async function runDailyReportsIfDue() {
  const p = tashkentParts();
  const hour = Number(p.hour);
  const minute = Number(p.minute);

  // Target 00:01 Tashkent. Retry window covers cold starts, but SENT reports never duplicate.
  if (hour !== 0 || minute < 1 || minute > 10) return;

  const { data: restaurants, error } = await db
    .from('restaurant_restaurants')
    .select('restaurant_id,name,report_channel_id')
    .eq('active', true)
    .not('report_channel_id', 'is', null);
  if (error) throw error;

  for (const restaurant of restaurants || []) {
    if (restaurant.report_channel_id) await sendReportForRestaurant(restaurant);
  }
}

setInterval(() => {
  runDailyReportsIfDue().catch(err => console.error('DAILY REPORT LOOP ERROR', err));
}, 15000);

runDailyReportsIfDue().catch(err => console.error('DAILY REPORT STARTUP ERROR', err));

module.exports = { runDailyReportsIfDue };
