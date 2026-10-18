-- =====================================================================
-- Ronda 2 (2026-10-18): protección contra reservas falsas + recordatorio
-- por correo 24 h.
--
-- Qué hace:
--   1) blocked_contacts: contactos (teléfono/correo) que un negocio bloquea
--      para la reserva pública. Solo el backend (service role) la usa:
--      RLS activo, sin políticas, y sin permisos para anon/authenticated
--      (mismo criterio que 2026-09-30-rls-close-anon-tables.sql).
--   2) appointments.email_recordatorio_enviado: marca idempotente del
--      recordatorio por correo (independiente de wa_recordatorio_enviado).
--   3) Índices para las consultas nuevas del backend:
--        - tope por teléfono/correo en 24 h (entre todos los negocios)
--        - tope de reservas públicas por negocio y por hora
--        - búsqueda de citas pendientes de recordatorio
--
-- Es seguro correrlo ANTES de desplegar el código nuevo (el código viejo
-- ignora la tabla y la columna) y también después: mientras no exista, el
-- backend nuevo omite el antiabuso por contactos bloqueados y el recordatorio
-- (solo deja un warning en los logs).
--
-- Cómo correrlo: Supabase Dashboard → SQL Editor, pegar todo y ejecutar.
-- Es idempotente (IF NOT EXISTS).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1) Contactos bloqueados
-- ---------------------------------------------------------------------
create table if not exists public.blocked_contacts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  phone         text,                       -- normalizado: +569XXXXXXXX
  email         text,                       -- en minúsculas
  contact_name  text,                       -- solo para mostrar en la lista
  created_by    uuid,                       -- auth.users.id de quien bloqueó
  created_at    timestamptz not null default now(),
  constraint blocked_contacts_phone_or_email check (phone is not null or email is not null)
);

create unique index if not exists blocked_contacts_tenant_phone_uniq
  on public.blocked_contacts (tenant_id, phone) where phone is not null;

create unique index if not exists blocked_contacts_tenant_email_uniq
  on public.blocked_contacts (tenant_id, email) where email is not null;

alter table public.blocked_contacts enable row level security;
revoke all on table public.blocked_contacts from anon;
revoke all on table public.blocked_contacts from authenticated;

-- ---------------------------------------------------------------------
-- 2) Recordatorio por correo 24 h
-- ---------------------------------------------------------------------
alter table public.appointments
  add column if not exists email_recordatorio_enviado boolean not null default false;

create index if not exists appointments_email_reminder_pending_idx
  on public.appointments (start_at)
  where status = 'booked' and email_recordatorio_enviado = false;

-- ---------------------------------------------------------------------
-- 3) Índices del antiabuso de la reserva pública (source = 'public_page')
-- ---------------------------------------------------------------------
create index if not exists appointments_public_phone_created_idx
  on public.appointments (customer_phone, created_at desc)
  where source = 'public_page';

create index if not exists appointments_public_email_created_idx
  on public.appointments (customer_email, created_at desc)
  where source = 'public_page';

create index if not exists appointments_public_tenant_created_idx
  on public.appointments (tenant_id, created_at desc)
  where source = 'public_page';

commit;

-- Verificación (opcional, solo lectura):
--   select relname, relrowsecurity from pg_class where relname = 'blocked_contacts';          -- debe dar true
--   select column_name from information_schema.columns
--    where table_name = 'appointments' and column_name = 'email_recordatorio_enviado';        -- 1 fila
