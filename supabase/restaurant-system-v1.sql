-- Restaurant System v1 database extensions
-- Applied to the current pilot Supabase project on 2026-11-03.

create table if not exists public.restaurant_printers (
  printer_id text primary key,
  restaurant_id text not null,
  name text not null,
  printer_type text not null default 'RECEIPT',
  connection_type text not null default 'NETWORK',
  address text,
  paper_width_mm integer not null default 80,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.restaurant_order_events (
  event_id text primary key,
  restaurant_id text not null,
  order_id text not null,
  actor_id text,
  actor_role text,
  event_type text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.restaurant_devices (
  device_id text primary key,
  restaurant_id text not null,
  name text not null,
  device_type text not null,
  last_seen_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.restaurant_printers enable row level security;
alter table public.restaurant_order_events enable row level security;
alter table public.restaurant_devices enable row level security;

create index if not exists restaurant_order_events_order_idx
  on public.restaurant_order_events(order_id, created_at);
create index if not exists restaurant_order_events_restaurant_idx
  on public.restaurant_order_events(restaurant_id, created_at);
create index if not exists restaurant_printers_restaurant_idx
  on public.restaurant_printers(restaurant_id);
create index if not exists restaurant_devices_restaurant_idx
  on public.restaurant_devices(restaurant_id);
