-- =============================================================================
-- Migración: Depósito previo configurable por servicio
-- Fecha: 2026-08-03
-- Propósito: tenants.deposit_required sigue siendo el interruptor maestro
--            (activa el sistema completo + la configuración de datos
--            bancarios, sin cambios). Esta columna nueva permite acotar el
--            flujo de depósito a solo algunos servicios, en vez de aplicarlo
--            a todas las reservas del tenant por igual.
--            Ver 2026-08-02-deposit-required.sql para la arquitectura base.
-- =============================================================================

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS requires_deposit boolean NOT NULL DEFAULT false;

-- Una reserva entra en flujo de depósito solo si AMBAS condiciones se
-- cumplen: tenants.deposit_required = true Y services.requires_deposit = true
-- para el servicio puntual que se está reservando (ver POST /appointments/slot
-- en server.js). Si el tenant desactiva el interruptor maestro, esta columna
-- por servicio queda sin efecto (no se limpia, mismo criterio que los campos
-- bancarios del tenant — reactivar no debería obligar a reconfigurar todo).
