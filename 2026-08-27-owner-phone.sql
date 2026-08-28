-- =============================================================================
-- Migración: teléfono del administrador en el registro
-- Fecha: 2026-08-27
-- Propósito: el directorio de tenants del panel admin (admin/tenants/[id])
--            mostraba "No disponible" en el teléfono del dueño porque el
--            dato nunca se pedía ni se guardaba en ningún lado (confirmado
--            antes de esta migración: sin columna phone en tenant_users ni
--            en signup_intents). Ahora se pide obligatorio en los dos flujos
--            reales de registro de un tenant nuevo:
--            - Flow Pro/gratis (/signup -> primer login -> POST /tenants/
--              provision) guarda directo en tenant_users.phone.
--            - Flow pago (/checkout-premium -> POST /signup/start-paid)
--              guarda primero en signup_intents.phone (tenant_users todavía
--              no existe en ese punto) y se copia a tenant_users.phone
--              recién en POST /signup/claim-account.
-- =============================================================================

ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE signup_intents ADD COLUMN IF NOT EXISTS phone text;

-- -----------------------------------------------------------------------------
-- Notas de implementación
-- -----------------------------------------------------------------------------

-- Sin NOT NULL a propósito: tenants/usuarios registrados ANTES de este
-- cambio quedan con phone = null — no se puede reconstruir retroactivamente
-- (ver instrucción original: "no tocar tenants que ya se registraron").
-- La obligatoriedad es solo a nivel de aplicación (frontend + validación en
-- POST /signup/start-paid) para los registros NUEVOS de ahora en adelante.

-- tenant_users.phone es el teléfono personal de quien administra el
-- negocio (el "owner"), DISTINTO de tenants.phone/whatsapp que son el
-- contacto PÚBLICO del negocio mostrado en la página de reservas — no
-- confundir ni fusionar ambos campos.
