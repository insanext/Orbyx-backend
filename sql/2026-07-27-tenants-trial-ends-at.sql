-- Migration: agrega tenants.trial_ends_at.
-- Ejecutar en Supabase SQL Editor.
--
-- Solo agrega la columna, nullable, sin backfill. El backfill de tenants
-- existentes va en un script SEPARADO (2026-07-27-tenants-trial-ends-at-backfill.sql)
-- que se revisa y corre a mano, uno por uno si hace falta.
--
-- A partir de este cambio, server.js (provisionTenantCore) setea
-- trial_ends_at = created_at + plan_config.trial_days SOLO para tenants
-- nuevos que nacen en plan 'pro' (el plan gratuito/trial). Tenants que
-- nacen directo en un plan pago (vip/platinum vía checkout) quedan con
-- trial_ends_at = NULL: nunca tuvieron trial gratuito que expire.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;

COMMENT ON COLUMN public.tenants.trial_ends_at IS
  'Fecha en que expira el trial gratuito de 30 dias (plan pro). NULL = no aplica (tenant nacio en plan pago, o backfill pendiente). No usar tenants.is_trial para decidir si el trial sigue activo -- ver server.js getAccountStatus.';
