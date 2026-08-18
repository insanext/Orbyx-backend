-- Migración: registro histórico de consentimiento de cobro automático de add-ons
-- Ejecutar en Supabase SQL editor (Dashboard → SQL Editor → New query → Run)
-- ANTES de deployar el server.js que la acompaña: PATCH /billing/addons/
-- renewal-mode y PATCH /billing/addons/low-balance-recharge insertan en
-- esta tabla en cada activación — si no existe, esos paths empiezan a
-- fallar con "relation does not exist" apenas se deploye el backend nuevo
-- (el insert está envuelto en try/catch y solo loguea el error, así que
-- no rompería el toggle, pero se perdería el registro legal).
--
-- Registro histórico: nunca se actualiza, solo se inserta una fila nueva
-- cada vez que el tenant activa cualquiera de los dos toggles de cobro
-- automático (renewal_mode o low_balance_recharge), incluso si ya lo
-- había aceptado antes y lo está reactivando.

CREATE TABLE IF NOT EXISTS addon_auto_charge_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  addon_key text NOT NULL,
  consent_type text NOT NULL CHECK (consent_type IN ('renewal_mode', 'low_balance_recharge')),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  amount_shown numeric,
  text_shown text NOT NULL
);

CREATE INDEX IF NOT EXISTS addon_auto_charge_consents_tenant_id_idx ON addon_auto_charge_consents(tenant_id);
