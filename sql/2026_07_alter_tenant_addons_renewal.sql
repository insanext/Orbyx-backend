-- Migración: renovación automática mensual para add-ons
-- Ejecutar en Supabase SQL editor (Dashboard → SQL Editor → New query → Run)
-- ANTES de deployar el server.js que la acompaña: POST /billing/addons/activate,
-- PATCH /billing/addons/quantity y el cron nuevo escriben estas columnas en
-- cada request — si no existen, esos endpoints empiezan a fallar con
-- "column does not exist" apenas se deploye el backend nuevo.

ALTER TABLE tenant_addons
  ADD COLUMN IF NOT EXISTS renewal_mode text NOT NULL DEFAULT 'manual'
    CHECK (renewal_mode IN ('manual', 'automatico')),
  ADD COLUMN IF NOT EXISTS last_charged_at timestamptz,
  ADD COLUMN IF NOT EXISTS failed_attempts integer NOT NULL DEFAULT 0;
