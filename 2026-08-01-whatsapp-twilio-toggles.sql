-- =============================================================================
-- Migración: toggles de WhatsApp (Twilio) por tenant + flag anti-duplicado
-- Fecha: 2026-08-01
-- Propósito: Soportar 2 toggles independientes por tenant (confirmación al
--            agendar, recordatorio antes de la cita) y evitar que el cron de
--            recordatorios envíe el mismo recordatorio dos veces si corre
--            varias veces dentro de la misma ventana. No modifica ninguna
--            columna existente.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Toggles en tenants (siguiendo el patrón existente: columnas planas,
--    no un JSON de settings genérico — mismo criterio que el resto de la
--    tabla tenants hoy).
-- -----------------------------------------------------------------------------

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS wa_confirmation_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS wa_reminder_enabled boolean NOT NULL DEFAULT false;

-- Horas antes de la cita para el recordatorio. Solo 1 o 2 son válidos hoy
-- (enforced en server.js, no acá, para no bloquear si el producto agrega
-- más opciones más adelante).
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS wa_reminder_hours_before smallint NOT NULL DEFAULT 1;

-- -----------------------------------------------------------------------------
-- 2. Flag anti-duplicado en appointments para el cron de recordatorios.
--    Sin este flag, si el cron corre cada 15-30 min y la cita cae dentro de
--    la ventana de margen más de una vez, se reenviaría el mismo recordatorio.
-- -----------------------------------------------------------------------------

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS wa_recordatorio_enviado boolean NOT NULL DEFAULT false;

-- Índice para la query del cron: citas "booked", con recordatorio pendiente,
-- dentro de una ventana de start_at.
CREATE INDEX IF NOT EXISTS appointments_wa_reminder_pending
  ON appointments (start_at)
  WHERE status = 'booked' AND wa_recordatorio_enviado = false;

-- -----------------------------------------------------------------------------
-- 3. Notas de implementación
-- -----------------------------------------------------------------------------

-- wa_confirmation_enabled y wa_reminder_enabled quedan en false por defecto
-- para TODOS los tenants existentes — nadie recibe WhatsApp hasta que se
-- active explícitamente. Hoy no hay UI en el dashboard para prender estos
-- toggles (fuera de alcance de esta sesión); se activan por ahora con un
-- UPDATE manual, ej.:
--   UPDATE tenants SET wa_confirmation_enabled = true WHERE slug = 'mi-negocio';
--   UPDATE tenants SET wa_reminder_enabled = true, wa_reminder_hours_before = 2
--     WHERE slug = 'mi-negocio';

-- Confirmación y recordatorio comparten el mismo contador de cupo mensual
-- (resource = 'wa_confirmacion' en tenant_monthly_usage), tal como ya lo
-- define el addon "WA confirmación+recordatorio" en addon_config
-- (grants.wa_confirmacion). No se crea un contador separado para
-- recordatorios.
