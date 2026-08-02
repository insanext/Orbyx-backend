-- =============================================================================
-- Migración: Depósito previo obligatorio por tenant
-- Fecha: 2026-08-02
-- Propósito: soportar el flujo de "depósito antes de confirmar" — toggle +
--            datos bancarios por tenant, estado de revisión del depósito por
--            cita, y el bucket de Storage donde se guardan los comprobantes.
--
-- DECISIÓN DE DISEÑO (importante, leer antes de tocar el código que usa esto):
-- NO se agrega un nuevo valor a appointments.status (ej. "pending_deposit").
-- El status en la práctica es una lista de valores validada solo a nivel de
-- aplicación (server.js:8627: ["booked","completed","no_show","rescheduled",
-- "canceled"] — no existe un CREATE TYPE ni CHECK constraint para esto en
-- ningún .sql del repo), y el bloqueo de horario está repartido en al menos
-- 4 puntos distintos de server.js que filtran explícitamente por
-- status = 'booked' (subtractAppointmentsFromWindows, el chequeo de
-- capacidad/duplicado en POST /appointments/slot, y GET /public/slots).
-- Agregar un status nuevo habría exigido tocar los 4 puntos de forma
-- consistente — alto riesgo de dejar uno sin actualizar y permitir doble
-- reserva. En vez de eso: la cita con depósito pendiente se crea con
-- status = 'booked' igual que cualquier otra (bloquea el horario gratis, sin
-- tocar NINGUNA de esas 4 rutas), y el estado de revisión del depósito vive
-- en una columna aparte (deposit_status). Rechazar o dejar expirar el
-- depósito simplemente pone status = 'canceled', que ya libera el horario en
-- todos lados sin cambios adicionales.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Configuración por tenant (mismo patrón que los toggles de WhatsApp:
--    columnas planas en tenants, no un JSON de settings).
-- -----------------------------------------------------------------------------

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS deposit_required boolean NOT NULL DEFAULT false;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS deposit_bank_name text;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS deposit_account_type text;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS deposit_account_number text;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS deposit_holder_rut text;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS deposit_holder_name text;

-- Nota de producto: si el tenant desactiva deposit_required, estos 5 campos
-- NO se limpian (decisión explícita — ver CLAUDE.md). Se conservan para que
-- reactivar el toggle no obligue a volver a escribir los datos bancarios.

-- -----------------------------------------------------------------------------
-- 2. Estado del depósito por cita.
-- -----------------------------------------------------------------------------

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS deposit_status text;
  -- NULL = no aplica (tenant sin deposit_required, o cita anterior a esta
  -- migración). Valores en uso: 'pending' | 'confirmed' | 'rejected' | 'expired'.
  -- 'rejected' = el tenant lo rechazó manualmente. 'expired' = el cron de
  -- mantenimiento lo liberó porque pasaron los 15 minutos sin revisión.
  -- Separar ambos casos es solo para reporting/auditoría, no cambia el
  -- comportamiento (los dos ponen status = 'canceled').

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS deposit_receipt_path text;
  -- Path dentro del bucket de Storage (NO una URL pública — ver punto 4).

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS deposit_hold_expires_at timestamptz;
  -- Solo tiene valor mientras deposit_status = 'pending'. Es lo que consulta
  -- el cron de liberación (POST /appointments/maintenance/release-expired-deposits).

CREATE INDEX IF NOT EXISTS appointments_deposit_pending
  ON appointments (deposit_hold_expires_at)
  WHERE deposit_status = 'pending';

-- -----------------------------------------------------------------------------
-- 3. Bucket de Storage para comprobantes.
-- -----------------------------------------------------------------------------

-- A diferencia de business-logos (bucket público, getPublicUrl), este bucket
-- se crea PRIVADO a propósito: un comprobante de transferencia es un
-- documento financiero (puede mostrar número de cuenta, monto, RUT), más
-- sensible que un logo. La vista del dashboard genera un signed URL de corta
-- duración bajo demanda (GET /appointments/:id/deposit-receipt-url,
-- autenticado, mismo chequeo de permisos que el resto de Agenda) en vez de
-- servir el archivo desde una URL pública fija.
INSERT INTO storage.buckets (id, name, public)
VALUES ('deposit-receipts', 'deposit-receipts', false)
ON CONFLICT (id) DO NOTHING;

-- Si el INSERT de arriba falla por permisos (algunos proyectos Supabase
-- restringen storage.buckets a la consola), crear el bucket manualmente:
-- Dashboard > Storage > New bucket > "deposit-receipts" > Public: OFF.

-- -----------------------------------------------------------------------------
-- 4. Notas de implementación
-- -----------------------------------------------------------------------------

-- La subida del archivo (orbyx-web/app/api/upload-deposit-receipt/route.ts)
-- usa la service_role key igual que upload-business-logo/upload-staff-photo
-- (ninguna de las dos tiene auth propia hoy — ver CLAUDE.md). El paso que sí
-- queda protegido es asociar el comprobante a una cita puntual: eso lo hace
-- el backend (POST /appointments/:id/deposit-receipt) validando el mismo
-- cancel_token que ya existe para la cancelación pública — mismo patrón,
-- mismo nivel de secreto, sin inventar un mecanismo de auth nuevo.

-- No se implementa borrado automático de comprobantes antiguos esta sesión
-- (Storage se puede llenar con el tiempo) — queda anotado como mejora futura.
