'use strict';
const crypto = require('crypto');

/**
 * Browser QR ordering and staff console, sharing the existing Supabase tables.
 * Set STAFF_DASHBOARD_KEY to a long random secret and RESTAURANT_ID (default R0001).
 * Existing Telegram webhook and ordering flow remain unchanged.
 */
module.exports = function installRestaurantOS(app, db) {
  const restaurantId = process.env.RESTAURANT_ID || 'R0001';
  const accessKey = process.env.STAFF_DASHBOARD_KEY || '';
  const money = n => Number(n || 0).toLocaleString('en-US') + ' UZS';
  const id = p => p + '-' + crypto.randomUUID();
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const check = ({data,error}) => { if(error) throw error; return data; };
  const sendError = (res, err) => {console.error('RESTAURANTOS ERROR',err);res.status(500).json({error:'Unable to complete request'});};
  const login = (req,res,next) => {
    const supplied = String(req.get('x-staff-key') || '');
    if (!accessKey || supplied.length !== accessKey.length ||
      !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(accessKey))) {
      return res.status(401).json({error:'Staff access denied'});
    }
    next();
  };
  const getTable = async param => check(await db.from('restaurant_tables').select('*').eq('qr_start_param',param).eq('active',true).eq('restaurant_id',restaurantId).maybeSingle());
  const getMenu = async rid => check(await db.from('restaurant_menu').select('menu_item_id,item_name,description,category,price,currency').eq('restaurant_id',rid).eq('available',true).order('sort_order',{ascending:true}));
  const html = (title,body) => '<!doctype html><html lang="uz"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+esc(title)+'</title><style>body{font:16px system-ui;background:#f5f6f8;color:#17202a;margin:0}header{background:#14283a;color:white;padding:18px}main{max-width:980px;margin:auto;padding:16px}.card{background:white;border:1px solid #dde2e7;border-radius:12px;padding:16px;margin:12px 0}button,input{font:inherit;padding:10px;border-radius:8px;border:1px solid #cbd5e1}button{background:#176b51;color:white;border:0;cursor:pointer}button:disabled{opacity:.4}.muted{color:#637186}.row{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}h1{font-size:22px;margin:0}h2{font-size:18px}.error{color:#a21d1d}#message{min-height:24px}.pill{background:#e8eef3;border-radius:30px;padding:5px 9px}</style></head><body><header><h1>🍽 Las Vegas · RestaurantOS</h1></header><main>'+body+'</main></body></html>';

  app.get('/qr/:param',async(req,res)=>{
    try {
      const table=await getTable(req.params.param);
      if(!table)return res.status(404).send('QR code is not active');
      res.type('html').send(html('Menu · '+table.table_name,
        '<h2>'+esc(table.table_name)+'</h2><p class="muted">Scan → select meals → send to kitchen. Payment is verified by cashier.</p><div id="message" aria-live="polite"></div><div id="menu"></div><div class="card"><h2>🛒 Savat · Cart</h2><div id="cart"></div><button id="checkout">✅ Buyurtma berish</button></div>'+
        '<script>const p='+JSON.stringify(req.params.param)+';let menu=[],cart={};const el=id=>document.getElementById(id);const fmt=n=>Number(n).toLocaleString("en-US")+" UZS";function draw(){el("menu").innerHTML=menu.map(m=>"<div class=card><div class=row><div><b>"+safe(m.item_name)+"</b><div class=muted>"+safe(m.category||"")+"</div></div><b>"+fmt(m.price)+"</b></div><div class=row><span>"+safe(m.description||"")+"</span><span><button data-id="+JSON.stringify(String(m.menu_item_id))+" data-d=-1>−</button> <b>"+(cart[m.menu_item_id]||0)+"</b> <button data-id="+JSON.stringify(String(m.menu_item_id))+" data-d=1>+</button></span></div></div>").join("");const entries=Object.entries(cart).filter(x=>x[1]>0);el("cart").textContent=entries.map(([id,q])=>{const m=menu.find(x=>String(x.menu_item_id)===id);return m?q+" × "+m.item_name+" — "+fmt(q*m.price):""}).join(" | ")+" · Jami: "+fmt(entries.reduce((s,[id,q])=>{const m=menu.find(x=>String(x.menu_item_id)===id);return s+(m?q*m.price:0)},0));el("checkout").disabled=!entries.length;}function safe(s){return String(s).replace(/[&<>"\\u0027]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;", "\\u0022":"&quot;","\\u0027":"&#39;"}[c]||""))}el("menu").addEventListener("click",e=>{const b=e.target.closest("button[data-id]");if(!b)return;const id=b.dataset.id;cart[id]=Math.max(0,(cart[id]||0)+Number(b.dataset.d));draw()});el("checkout").addEventListener("click",async()=>{const b=el("checkout");b.disabled=true;el("message").textContent="Saving order…";try{const r=await fetch("/api/qr/"+encodeURIComponent(p)+"/orders",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({items:Object.entries(cart).filter(x=>x[1]>0).map(([menu_item_id,quantity])=>({menu_item_id,quantity}))})});const d=await r.json();if(!r.ok)throw Error(d.error||"Order failed");cart={};el("message").textContent="✅ Order "+d.order_id+" saved. Total: "+fmt(d.total);draw()}catch(e){el("message").textContent=e.message;b.disabled=false}});fetch("/api/qr/"+encodeURIComponent(p)+"/menu").then(r=>r.json()).then(d=>{if(!d.items)throw Error(d.error);menu=d.items;draw()}).catch(e=>el("message").textContent=e.message);</script>'));
    } catch(e){res.status(500).send('Unable to open menu');}
  });
  app.get('/api/qr/:param/menu',async(req,res)=>{
    try{const table=await getTable(req.params.param);if(!table)return res.status(404).json({error:'Invalid QR'});res.json({table:table.table_name,items:await getMenu(table.restaurant_id)});}
    catch(e){sendError(res,e);}
  });
  // A bounded, validated public endpoint; prices and table identity always come from DB.
  const recent = new Map();
  app.post('/api/qr/:param/orders',async(req,res)=>{
    try{
      const ip=String(req.ip),current=Date.now(),last=recent.get(ip)||0;
      if(current-last<1500)return res.status(429).json({error:'Try again in a moment'});
      recent.set(ip,current);
      if(recent.size>5000)for(const [key,t] of recent)if(current-t>60000)recent.delete(key);
      const table=await getTable(req.params.param);
      if(!table)return res.status(404).json({error:'Invalid QR'});
      const input=req.body?.items;
      if(!Array.isArray(input)||!input.length||input.length>50)return res.status(400).json({error:'Choose 1–50 menu items'});
      const quantities=new Map();
      for(const item of input){
        if(!item||!Number.isInteger(item.quantity)||item.quantity<1||item.quantity>30||typeof item.menu_item_id!=='string')
          return res.status(400).json({error:'Invalid item quantity'});
        quantities.set(item.menu_item_id,(quantities.get(item.menu_item_id)||0)+item.quantity);
      }
      if([...quantities.values()].some(x=>x>30))return res.status(400).json({error:'Maximum 30 per item'});
      const menu=await getMenu(table.restaurant_id),items=[];
      let total=0;
      for(const [itemId,quantity] of quantities){
        const m=menu.find(x=>String(x.menu_item_id)===itemId);
        if(!m)return res.status(400).json({error:'An item is unavailable'});
        const line=Number(m.price)*quantity;
        if(!Number.isFinite(line)||line<0)return res.status(400).json({error:'Menu price invalid'});
        total+=line;
        items.push({order_item_id:id('ITM'),restaurant_id:table.restaurant_id,menu_item_id:m.menu_item_id,item_name:m.item_name,quantity,unit_price:m.price,line_total:line,status:'NEW'});
      }
      const orderId=id('ORD');
      check(await db.from('restaurant_orders').insert({order_id:orderId,restaurant_id:table.restaurant_id,table_id:table.table_id,customer_name:'QR guest',status:'NEW',subtotal:total,total,payment_status:'UNPAID'}));
      try{check(await db.from('restaurant_order_items').insert(items.map(x=>({...x,order_id:orderId}))));}
      catch(e){await db.from('restaurant_orders').delete().eq('order_id',orderId).eq('payment_status','UNPAID');throw e;}
      res.status(201).json({order_id:orderId,total,status:'NEW'});
    }catch(e){sendError(res,e);}
  });

  app.get('/staff',(_req,res)=>res.type('html').send(html('Staff Console',
    '<h2>Kitchen · Waiter · Cashier · Manager</h2><p class=muted>Staff only. Enter the long dashboard key supplied by the restaurant owner.</p><div class=card><input id=key type=password placeholder="Staff access key" autocomplete=off><button id=load>Open dashboard</button><div id=message aria-live=polite></div></div><div id=summary></div><div id=orders></div>'+
    '<script>const el=id=>document.getElementById(id),money=n=>Number(n).toLocaleString("en-US")+" UZS";let key="";const h=()=>({"x-staff-key":key,"Content-Type":"application/json"});async function refresh(){try{const r=await fetch("/api/staff/orders",{headers:h()});const d=await r.json();if(!r.ok)throw Error(d.error);el("message").textContent="Connected · "+new Date().toLocaleTimeString();const paid=d.orders.filter(o=>o.payment_status==="PAID");el("summary").innerHTML="<div class=card><h2>Manager summary</h2><b>Paid: "+paid.length+" · Revenue: "+money(paid.reduce((s,o)=>s+Number(o.total),0))+"</b><p>Unpaid: "+d.orders.filter(o=>o.payment_status!=="PAID").length+"</p></div>";el("orders").innerHTML=d.orders.map(o=>"<div class=card><div class=row><b>"+safe(o.table_id)+" · "+safe(o.order_id)+"</b><span class=pill>"+safe(o.status)+"</span></div><p>"+(d.items[o.order_id]||[]).map(i=>i.quantity+" × "+safe(i.item_name)).join(" · ")+"</p><b>"+money(o.total)+" · "+safe(o.payment_status)+"</b><p>"+["PREPARING","READY","SERVED"].map(s=>"<button data-order="+JSON.stringify(o.order_id)+" data-status="+s+">"+s+"</button>").join(" ")+" "+(o.payment_status==="PAID"?"":"<button data-order="+JSON.stringify(o.order_id)+" data-status=PAID>Confirm cash paid</button>")+"</p></div>").join("")}catch(e){el("message").textContent=e.message}}function safe(s){return String(s||"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;", "\\u0022":"&quot;"}[c]||""))}el("load").onclick=()=>{key=el("key").value;el("key").value="";refresh()};el("orders").onclick=async e=>{const b=e.target.closest("button[data-status]");if(!b)return;b.disabled=true;try{const r=await fetch("/api/staff/orders/"+encodeURIComponent(b.dataset.order)+"/status",{method:"POST",headers:h(),body:JSON.stringify({status:b.dataset.status})});const d=await r.json();if(!r.ok)throw Error(d.error);await refresh()}catch(e){el("message").textContent=e.message;b.disabled=false}};</script>'
  )));
  app.get('/api/staff/orders',login,async(_req,res)=>{
    try{
      const orders=check(await db.from('restaurant_orders').select('order_id,table_id,status,payment_status,total,created_at').eq('restaurant_id',restaurantId).order('created_at',{ascending:false}).limit(100));
      const ids=orders.map(o=>o.order_id);
      const rows=ids.length?check(await db.from('restaurant_order_items').select('order_id,item_name,quantity').in('order_id',ids)):[];
      const items={};for(const row of rows){(items[row.order_id]??=[]).push(row);}
      res.json({orders,items});
    }catch(e){sendError(res,e);}
  });
  app.post('/api/staff/orders/:id/status',login,async(req,res)=>{
    try{
      const status=String(req.body?.status||'');
      if(!['PREPARING','READY','SERVED','PAID'].includes(status))return res.status(400).json({error:'Invalid status'});
      const order=check(await db.from('restaurant_orders').select('*').eq('restaurant_id',restaurantId).eq('order_id',req.params.id).maybeSingle());
      if(!order)return res.status(404).json({error:'Order not found'});
      if(status==='PAID'){
        if(order.payment_status==='PAID')return res.json({ok:true,already_paid:true});
        const updated=check(await db.from('restaurant_orders').update({payment_status:'PAID',status:'CLOSED',closed_at:new Date().toISOString()}).eq('restaurant_id',restaurantId).eq('order_id',order.order_id).eq('payment_status','UNPAID').select('order_id'));
        if(!updated.length)return res.status(409).json({error:'Order changed; refresh'});
        const payment=await db.from('restaurant_payments').insert({payment_id:id('PAY'),restaurant_id:restaurantId,order_id:order.order_id,table_id:order.table_id,amount:order.total,method:'CASH',status:'CONFIRMED',confirmed_by:'STAFF_DASHBOARD'});
        if(payment.error){console.error('PAYMENT RECORD FAILURE',payment.error);return res.status(500).json({error:'Paid flag set, payment log failed: contact manager'});}
      }else{
        if(order.payment_status==='PAID'||!({NEW:['PREPARING','READY'],PREPARING:['READY'],READY:['SERVED'],SERVED:[]}[order.status]||[]).includes(status))
          return res.status(409).json({error:'Invalid order progression; refresh'});
        const updated=check(await db.from('restaurant_orders').update({status}).eq('restaurant_id',restaurantId).eq('order_id',order.order_id).eq('status',order.status).select('order_id'));
        if(!updated.length)return res.status(409).json({error:'Order changed; refresh'});
      }
      res.json({ok:true});
    }catch(e){sendError(res,e);}
  });
};
