-- 2026-09-28 — Add-ons con pago único (Flow /payment/create) + Flow por ambiente.
-- Aditiva e idempotente: se puede correr más de una vez sin efecto extra.
-- Correr en Supabase (SQL Editor) ANTES de probar el pago único.
-- El backend tolera que esto no haya corrido (ver isMissingSchemaError en
-- server.js): lista add-ons y crea planes de Flow igual que antes, y el
-- checkout de pago único responde "falta correr la migración".

-- ---------------------------------------------------------------------
-- 1) tenant_addons: vencimiento del pago único + aviso previo
-- ---------------------------------------------------------------------
alter table public.tenant_addons
  add column if not exists expires_at timestamptz;

alter table public.tenant_addons
  add column if not exists last_expiry_reminder_sent_at timestamptz;

create index if not exists tenant_addons_one_time_expiry_idx
  on public.tenant_addons (expires_at)
  where status = 'active' and renewal_mode = 'pago_unico';

-- renewal_mode pasa a aceptar 'pago_unico'. La columna no tiene migración
-- en el repo (se agregó directo en Supabase), así que se elimina cualquier
-- CHECK existente sobre renewal_mode, con el nombre que tenga, y se recrea.
do $$
declare
  c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'tenant_addons'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%renewal_mode%'
  loop
    execute format('alter table public.tenant_addons drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.tenant_addons
  add constraint tenant_addons_renewal_mode_check
  check (renewal_mode in ('manual', 'automatico', 'pago_unico'));

-- ---------------------------------------------------------------------
-- 2) addon_purchase_intents: intención de pago único (una por checkout)
-- ---------------------------------------------------------------------
create table if not exists public.addon_purchase_intents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  items jsonb not null,               -- [{ addon_key, quantity, net_amount, unit_price }]
  net_amount integer not null,
  amount integer not null,            -- total con IVA enviado a Flow
  commerce_order text not null unique,
  flow_token text,
  flow_order bigint,
  flow_env text not null default 'sandbox',
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'paid', 'rejected', 'canceled', 'error', 'needs_review')),
  error_message text,
  created_by uuid,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists addon_purchase_intents_tenant_idx
  on public.addon_purchase_intents (tenant_id, created_at desc);

-- Solo el backend (service role) lee/escribe esta tabla.
alter table public.addon_purchase_intents enable row level security;

-- ---------------------------------------------------------------------
-- 3) flow_plans por ambiente de Flow (sandbox / live)
-- Los planes cacheados hoy son del sandbox. Al pasar a producción
-- (FLOW_API_URL de producción), el backend crea y cachea los planes de la
-- cuenta real en filas flow_env = 'live', sin reutilizar los del sandbox.
-- ---------------------------------------------------------------------
alter table public.flow_plans
  add column if not exists flow_env text not null default 'sandbox';

alter table public.flow_plans
  drop constraint if exists flow_plans_plan_id_periodicidad_monto_key;

alter table public.flow_plans
  drop constraint if exists flow_plans_plan_id_periodicidad_monto_env_key;

alter table public.flow_plans
  add constraint flow_plans_plan_id_periodicidad_monto_env_key
  unique (plan_id, periodicidad, monto, flow_env);
