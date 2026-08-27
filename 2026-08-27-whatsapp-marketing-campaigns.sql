-- =============================================================================
-- Migración: WhatsApp Marketing — trazabilidad por destinatario + plantilla
-- Fecha: 2026-08-27
-- Propósito: separar el wizard de campañas WhatsApp del de Email, con envío
--            real vía Twilio Content Templates (reemplaza el antiguo
--            POST /campaigns/save-whatsapp, que solo guardaba historial
--            simulado y nunca llamaba a Twilio). Dos columnas nuevas:
--            - campaign_delivery_logs.message_sid: liga cada fila de log a
--              su envío real en Twilio, para que POST /whatsapp/status-callback
--              (ya existente, usado hoy por confirmación/recordatorio) pueda
--              actualizar el estado real (delivered/failed/undelivered) y el
--              motivo de falla por destinatario, no solo "se mandó el request".
--            - campaign_history.template_id: qué de las 3 plantillas de
--              marketing se usó.
--            - campaign_history.skipped_count: cuántos destinatarios quedaron
--              sin enviar por quedarse sin saldo de campanas_wa a mitad de
--              envío (status "skipped_no_balance" en campaign_delivery_logs).
-- =============================================================================

ALTER TABLE campaign_delivery_logs ADD COLUMN IF NOT EXISTS message_sid text;

CREATE INDEX IF NOT EXISTS idx_campaign_delivery_logs_message_sid
  ON campaign_delivery_logs (message_sid);

ALTER TABLE campaign_history ADD COLUMN IF NOT EXISTS template_id text;
ALTER TABLE campaign_history ADD COLUMN IF NOT EXISTS skipped_count integer NOT NULL DEFAULT 0;

-- -----------------------------------------------------------------------------
-- Notas de implementación
-- -----------------------------------------------------------------------------

-- No requiere backfill: campañas WhatsApp anteriores a este deploy fueron
-- guardadas por el endpoint viejo (simulado, sin message_sid ni template_id
-- reales) — quedan con esas columnas en null, no se puede reconstruir su
-- estado real de entrega retroactivamente.

-- El cupo (campanas_wa) sigue sin descontarse acá — se descuenta en
-- POST /whatsapp/status-callback cuando Twilio confirma "delivered", igual
-- que wa_confirmacion (ver 2026-08-02-whatsapp-message-log.sql). Esta
-- migración solo agrega trazabilidad, no toca esa lógica de cupo.
