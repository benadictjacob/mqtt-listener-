-- Idempotent schema. Runs on first Postgres boot and again on every API start,
-- so each statement must be safe to repeat against an existing database.
create extension if not exists pgcrypto;

create table if not exists vendors(
  id text primary key default gen_random_uuid()::text,
  name text not null,
  created_at timestamptz not null default now()
);
create table if not exists customers(
  id text primary key default gen_random_uuid()::text,
  vendor_id text not null references vendors(id),
  name text not null,
  created_at timestamptz not null default now()
);
create table if not exists app_users(
  id text primary key default gen_random_uuid()::text,
  email text unique not null,
  password_hash text not null,
  full_name text not null,
  role text not null check(role in('admin','vendor','customer')),
  vendor_id text references vendors(id),
  customer_id text references customers(id),
  created_at timestamptz not null default now()
);
create table if not exists devices(
  id text primary key default gen_random_uuid()::text,
  customer_id text not null references customers(id),
  imei text unique not null,
  name text not null,
  device_type text,
  location text,
  status text not null default 'active',
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists device_current_data(
  device_id text primary key references devices(id) on delete cascade,
  received_at timestamptz not null,
  voltage double precision,
  current double precision,
  power double precision,
  soc double precision,
  soh double precision,
  temperature double precision,
  status text,
  raw_data jsonb not null default '{}'
);
create table if not exists telemetry_history(
  id bigserial primary key,
  device_id text not null references devices(id) on delete cascade,
  received_at timestamptz not null,
  payload jsonb not null
);

-- Upgrades for databases created by the first version of this file.
alter table vendors alter column id set default gen_random_uuid()::text;
alter table customers alter column id set default gen_random_uuid()::text;
alter table app_users alter column id set default gen_random_uuid()::text;
alter table devices alter column id set default gen_random_uuid()::text;
alter table vendors add column if not exists code text;
alter table vendors add column if not exists status text not null default 'active';
alter table vendors add column if not exists contact_email text;
alter table customers add column if not exists code text;
alter table customers add column if not exists status text not null default 'active';
alter table customers add column if not exists contact_email text;
alter table app_users add column if not exists must_change_password boolean not null default false;
alter table app_users add column if not exists created_by text references app_users(id);
alter table app_users add column if not exists last_login_at timestamptz;
alter table devices add column if not exists created_by text references app_users(id);
create unique index if not exists vendors_code_key on vendors(code);
create unique index if not exists customers_code_key on customers(code);
create index if not exists customers_vendor_idx on customers(vendor_id);
create index if not exists devices_customer_idx on devices(customer_id);
create index if not exists telemetry_history_device_time_idx on telemetry_history(device_id, received_at desc);
