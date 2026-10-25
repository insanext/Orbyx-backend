-- =============================================================================
-- Migración: tenants.is_demo
-- Fecha: 2026-10-24
-- Propósito: marcar los 4 tenants DEMO (datos ficticios para videos y demos,
--            creados por scripts/seed-demo.js). Un tenant demo:
--              - nunca envía WhatsApp ni correos (guards en server.js,
--                email.js y whatsapp.js),
--              - no suma a los contadores de uso (tenant_monthly_usage),
--              - no puede tocar Flow ni cambiar plan (POST/PATCH /billing → 403),
--              - nace sin trial (is_trial = false, trial_ends_at NULL) y con
--                billing_cycle_end 2099-12-31, así nunca se bloquea.
-- Solo agrega una columna con default false: ningún tenant real cambia.
-- El backend tolera que esta migración todavía no esté aplicada.
-- =============================================================================

alter table public.tenants
  add column if not exists is_demo boolean not null default false;

-- Índice parcial: el backend consulta "tenants demo" con un cache de 60 s.
create index if not exists tenants_is_demo_idx
  on public.tenants (id)
  where is_demo = true;
