-- =============================================================================
-- Migración: Flag de confirmación automática por WhatsApp enviada
-- Fecha: 2026-09-13
-- Propósito: distinguir, para una reserva puntual, si la confirmación
--            automática por WhatsApp efectivamente se envió (modo
--            Confirmación activo Y cupo disponible en el momento de crear
--            la reserva) — para no ofrecerle al negocio el botón de
--            confirmación MANUAL cuando el cliente ya fue avisado solo.
--
-- Antes de esto no existía ningún registro por-reserva de esto:
-- whatsapp_message_log (2026-08-02) guarda message_sid/tenant_id/resource,
-- sin appointment_id — no se puede unir de vuelta a una reserva específica.
-- =============================================================================

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS wa_confirmacion_enviada boolean NOT NULL DEFAULT false;
  -- true únicamente cuando sendBookingConfirmations() confirma que Twilio
  -- aceptó el envío (mismo criterio de éxito que ya usa trackWhatsAppMessage
  -- para el cupo) — seteado en el momento de crear la reserva
  -- (POST /appointments/slot) o al confirmar un depósito
  -- (POST /appointments/:id/deposit/confirm), los 2 lugares donde se llama
  -- a sendBookingConfirmations(). Nunca se vuelve a poner en false después.
