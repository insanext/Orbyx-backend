-- =============================================================================
-- Migración: Extras de servicios
-- Fecha: 2026-10-25
-- Propósito: agregados opcionales que el cliente suma a un servicio al
--   reservar (ej. "Lavado +$2.000 +15 min").
--   - service_extras: catálogo de extras POR SUCURSAL (igual que services).
--     Precio obligatorio (puede ser 0), minutos opcionales (0 = no alarga la cita).
--   - service_extra_links: qué extras ofrece cada servicio (muchos a muchos:
--     un mismo extra puede estar en varios servicios).
--   - appointments: snapshot de los extras elegidos y precio total, para que
--     un cambio posterior de precio/nombre no altere citas ya hechas.
-- Solo agrega tablas/columnas: ninguna cita, servicio ni tenant cambia.
-- Las tablas quedan cerradas a anon/authenticated: solo el backend (service
-- role) las lee y escribe, igual que blocked_contacts.
-- =============================================================================

begin;

create table if not exists public.service_extras (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  branch_id         uuid not null references public.branches(id) on delete cascade,
  name              text not null,
  description       text,
  price             numeric not null default 0 check (price >= 0),
  duration_minutes  integer not null default 0 check (duration_minutes >= 0 and duration_minutes <= 480),
  active            boolean not null default true,
  sort_order        integer not null default 0,
  deleted_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists service_extras_tenant_branch_idx
  on public.service_extras (tenant_id, branch_id, sort_order)
  where deleted_at is null;

create table if not exists public.service_extra_links (
  service_id  uuid not null references public.services(id) on delete cascade,
  extra_id    uuid not null references public.service_extras(id) on delete cascade,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  branch_id   uuid references public.branches(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (service_id, extra_id)
);

create index if not exists service_extra_links_tenant_branch_idx
  on public.service_extra_links (tenant_id, branch_id);
create index if not exists service_extra_links_extra_idx
  on public.service_extra_links (extra_id);

alter table public.service_extras enable row level security;
alter table public.service_extra_links enable row level security;
revoke all on table public.service_extras from anon;
revoke all on table public.service_extras from authenticated;
revoke all on table public.service_extra_links from anon;
revoke all on table public.service_extra_links from authenticated;

-- Snapshot en la cita. extras = [{ id, name, price, duration_minutes }].
alter table public.appointments
  add column if not exists extras          jsonb,
  add column if not exists extras_minutes  integer not null default 0,
  add column if not exists extras_price    numeric not null default 0,
  add column if not exists price_snapshot  numeric;

commit;

-- Verificación (debe devolver 2 y 4 filas):
-- select table_name from information_schema.tables
--  where table_name in ('service_extras', 'service_extra_links');
-- select column_name from information_schema.columns
--  where table_name = 'appointments'
--    and column_name in ('extras', 'extras_minutes', 'extras_price', 'price_snapshot');
