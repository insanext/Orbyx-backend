-- =============================================================================
-- Reparación de esquema: proyecto Supabase de Virginia (fqmdcbvtrgc…)
-- Fecha: 2026-10-25
-- Motivo: al correr scripts/seed-demo.js contra producción (Virginia) faltaban
--   columnas que server.js ya usa:
--     - appointments.email_recordatorio_enviado  → 2026-10-18-booking-abuse-protection.sql
--       (recordatorio por correo de 24 h; sin ella el cron falla)
--     - clinical_notes.customer_id (+ symptoms, medications, referrals,
--       follow_up_notes, extra_fields) → se habían agregado a mano en São Paulo
--       y nunca quedaron en un archivo del repo (fichas de clínica/odontología).
-- Todo es idempotente (if not exists): se puede correr aunque parte ya exista.
-- No borra ni modifica datos.
-- =============================================================================

begin;

-- 1) Mismo contenido que 2026-10-18-booking-abuse-protection.sql
create table if not exists public.blocked_contacts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  phone         text,
  email         text,
  contact_name  text,
  created_by    uuid,
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

alter table public.appointments
  add column if not exists email_recordatorio_enviado boolean not null default false;
create index if not exists appointments_email_reminder_pending_idx
  on public.appointments (start_at)
  where status = 'booked' and email_recordatorio_enviado = false;
create index if not exists appointments_public_phone_created_idx
  on public.appointments (customer_phone, created_at desc)
  where source = 'public_page';
create index if not exists appointments_public_email_created_idx
  on public.appointments (customer_email, created_at desc)
  where source = 'public_page';
create index if not exists appointments_public_tenant_created_idx
  on public.appointments (tenant_id, created_at desc)
  where source = 'public_page';

-- 2) Columnas de clinical_notes que usa server.js (POST /clinical-notes/:slug,
--    PATCH /appointments/:id/clinical, GET /clinical-notes/:slug)
alter table public.clinical_notes
  add column if not exists customer_id     uuid references public.customers(id),
  add column if not exists symptoms        text,
  add column if not exists medications     text,
  add column if not exists referrals       text,
  add column if not exists follow_up_notes text,
  add column if not exists extra_fields    jsonb;

-- Las fichas de pacientes humanos (clínica/odontología) no tienen mascota.
alter table public.clinical_notes alter column pet_id drop not null;

create index if not exists clinical_notes_tenant_customer
  on public.clinical_notes (tenant_id, customer_id, date desc)
  where customer_id is not null;

commit;

-- Verificación (debe devolver 7 filas):
-- select table_name, column_name from information_schema.columns
--  where (table_name = 'appointments' and column_name = 'email_recordatorio_enviado')
--     or (table_name = 'clinical_notes' and column_name in
--         ('customer_id','symptoms','medications','referrals','follow_up_notes','extra_fields'));
