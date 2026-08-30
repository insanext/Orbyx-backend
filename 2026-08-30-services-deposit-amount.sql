-- =============================================================================
-- Migración: Monto de depósito por servicio
-- Fecha: 2026-08-30
-- Propósito: services.requires_deposit (2026-08-03-services-requires-deposit.sql)
--            era binario, sin monto — el tenant no podía indicar cuánto debe
--            transferir el cliente (no siempre es el precio completo del
--            servicio). Esta columna guarda ese monto.
-- =============================================================================

-- Mismo tipo que services.price (numeric, sin precisión/escala fija — ver
-- OpenAPI de PostgREST: {"format":"numeric","type":"number"} para ambas),
-- para ser consistente con la columna de monto ya existente en la misma
-- tabla. CLP no usa decimales (ver formatPrice en la página pública,
-- maximumFractionDigits: 0), pero el tipo de columna no fuerza eso — es la
-- UI la que trunca a enteros, igual que ya hace con price.
ALTER TABLE services
  ADD COLUMN IF NOT EXISTS deposit_amount numeric;

-- Nullable a nivel de columna a propósito: la obligatoriedad de
-- "requires_deposit=true implica deposit_amount > 0" se aplica solo a nivel
-- de aplicación (PATCH /services/:id en server.js), no como CHECK constraint
-- — así esta migración no rompe filas existentes que ya tengan
-- requires_deposit=true sin monto (verificado en prod al escribir esta
-- migración: 2 servicios del tenant 824e31a7-1fa8-4c8e-a47d-3efd28aeee13,
-- "Consulta Médica" y "Teñido de pelo mujer", tienen requires_deposit=true
-- y van a quedar con deposit_amount=NULL hasta que el tenant lo complete
-- desde el dashboard. Mientras tanto, el frontend público muestra el
-- mensaje genérico de depósito sin monto en vez de ocultar la sección —
-- ver AccountStatusWidget.tsx y app/[Slug]/page.tsx).
