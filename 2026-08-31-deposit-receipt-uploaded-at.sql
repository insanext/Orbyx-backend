-- =============================================================================
-- Migración: Timestamp de subida del comprobante de depósito
-- Fecha: 2026-08-31
-- Propósito: appointments.deposit_receipt_path guarda el path del archivo
--            pero nunca guardó cuándo se subió. El modal "Depósitos
--            pendientes" (dashboard/[slug]/agenda/page.tsx) necesitaba ese
--            dato para reemplazar la cuenta regresiva por "esperando hace
--            X min" una vez que ya hay comprobante — no existía ninguna
--            columna (ni deposit_receipt_uploaded_at ni un updated_at
--            genérico en appointments) de la que derivarlo. Verificado
--            contra una fila real de producción (select("*") completo) antes
--            de escribir esta migración, no asumido desde los .sql del repo.
-- =============================================================================

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS deposit_receipt_uploaded_at timestamptz;

-- Se setea en POST /appointments/:id/deposit-receipt, en el mismo UPDATE que
-- ya guarda deposit_receipt_path (server.js). Filas con comprobante subido
-- ANTES de correr esta migración van a quedar con deposit_receipt_path
-- lleno y deposit_receipt_uploaded_at NULL — el frontend maneja ese caso
-- mostrando "Comprobante subido" sin hora/tiempo transcurrido, en vez de
-- asumir un valor.
