-- Migración: recarga automática por saldo bajo de mensajes (wa_confirmacion)
-- Ejecutar en Supabase SQL editor (Dashboard → SQL Editor → New query → Run)
-- ANTES de deployar el server.js que la acompaña: checkMonthlyUsage(),
-- triggerLowBalanceRecharge(), PATCH /billing/addons/low-balance-recharge
-- y GET /billing/addons (getActiveAddons) leen/escriben estas columnas en
-- cada request — si no existen, esos paths empiezan a fallar con
-- "column does not exist" apenas se deploye el backend nuevo.

ALTER TABLE tenant_addons
  ADD COLUMN IF NOT EXISTS low_balance_recharge_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS low_balance_recharge_in_progress boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS low_balance_recharge_failed_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS low_balance_recharge_consented_at timestamptz NULL;
