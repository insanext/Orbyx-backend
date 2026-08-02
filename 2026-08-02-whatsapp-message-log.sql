-- =============================================================================
-- Migración: whatsapp_message_log
-- Fecha: 2026-08-02
-- Propósito: rastrear el resultado real (delivered/failed/undelivered/etc.)
--            de cada envío de WhatsApp vía Twilio, para que el cupo mensual
--            (tenant_monthly_usage, resource "wa_confirmacion") se descuente
--            solo cuando el mensaje realmente se entregó — no en el momento
--            del intento de envío. Se llena vía POST /whatsapp/status-callback
--            (Twilio Status Callback), configurado en whatsapp.js.
-- =============================================================================

CREATE TABLE IF NOT EXISTS whatsapp_message_log (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  message_sid  text        NOT NULL UNIQUE,
  tenant_id    uuid        NOT NULL REFERENCES tenants(id),

  -- Hoy siempre "wa_confirmacion" (confirmación + recordatorio comparten el
  -- mismo cupo/counter, ver CLAUDE.md). Columna separada por si en el futuro
  -- se descompone en resources distintos.
  resource     text        NOT NULL,

  -- queued -> sent -> delivered/read, o failed/undelivered.
  status       text        NOT NULL DEFAULT 'queued',

  -- true una vez que se llamó a incrementMonthlyUsage por este mensaje.
  -- Evita doble conteo si Twilio manda delivered y después read (WhatsApp
  -- soporta ambos eventos) — solo se cuenta la primera vez que llega a
  -- "delivered".
  counted      boolean     NOT NULL DEFAULT false,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS whatsapp_message_log_tenant
  ON whatsapp_message_log (tenant_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- Notas de implementación
-- -----------------------------------------------------------------------------

-- REQUIERE una env var nueva en Render: TWILIO_AUTH_TOKEN (el Auth Token
-- clásico de la cuenta, Twilio Console -> Account -> API keys & tokens ->
-- "Auth Token" — DISTINTO de TWILIO_API_KEY_SID/TWILIO_API_KEY_SECRET que ya
-- están configurados y se usan para enviar). Es el único secreto con el que
-- Twilio firma sus webhooks (X-Twilio-Signature); sin esto, POST
-- /whatsapp/status-callback no puede validar que la request viene de Twilio
-- y la ignora por seguridad (no cuenta nada, solo loguea un error).

-- No hay backfill de datos históricos: los envíos hechos ANTES de este
-- deploy ya incrementaron tenant_monthly_usage directamente al momento del
-- intento (comportamiento viejo) y no tienen fila acá. Si alguno de esos
-- intentos viejos falló y quedó contado de más, hay que corregirlo a mano
-- en tenant_monthly_usage (ver CLAUDE.md / notas de la sesión 2026-08-02).
