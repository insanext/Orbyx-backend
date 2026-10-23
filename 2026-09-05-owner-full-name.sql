-- =============================================================================
-- Migración: nombre y apellido del administrador/dueño del tenant
-- Fecha: 2026-09-05
-- Propósito: cuando se hizo obligatorio el teléfono del dueño (ver
--            2026-08-27-owner-phone.sql), nunca se agregó el campo
--            equivalente para su nombre -- solo se captura el nombre del
--            NEGOCIO (tenants.name / business_name), no el de la persona
--            que lo administra. Confirmado antes de esta migración
--            (auditoría, sin asumir): tenant_users NO tiene ninguna
--            columna de nombre de persona -- ni en ningún INSERT/SELECT de
--            server.js, ni en el propio panel admin (admin/tenants/[id],
--            que ya dejaba la nota "Nombre del administrador no está
--            modelado en ningún lugar hoy"). Mismo patrón exacto que la
--            migración del teléfono:
--            - Flow Pro/gratis (/signup -> primer login -> POST /tenants/
--              provision) guarda directo en tenant_users.full_name.
--            - Flow pago (/checkout-premium -> POST /signup/start-paid)
--              guarda primero en signup_intents.full_name (tenant_users
--              todavía no existe en ese punto) y se copia a
--              tenant_users.full_name recién en POST /signup/claim-account.
--
--            Hallazgo de la auditoría: /signup YA tenía un campo "Nombre
--            completo" (renombrado a "Nombre y Apellido" en este cambio)
--            desde antes de que el teléfono se hiciera obligatorio -- pero
--            el valor solo se guardaba en el user_metadata de Supabase
--            Auth, nunca se pasaba a POST /tenants/provision ni se
--            persistía en tenant_users. Quedaba huérfano. Este cambio
--            conecta ese cableado faltante, además de agregar el campo
--            (nuevo, antes no existía) en checkout-premium.
-- =============================================================================

ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS full_name text;
ALTER TABLE signup_intents ADD COLUMN IF NOT EXISTS full_name text;

-- -----------------------------------------------------------------------------
-- Notas de implementación
-- -----------------------------------------------------------------------------

-- Sin NOT NULL a propósito: mismo criterio que phone -- tenants/usuarios
-- registrados ANTES de este cambio quedan con full_name = null (no se puede
-- reconstruir retroactivamente). La obligatoriedad es solo a nivel de
-- aplicación (frontend + validación en POST /signup/start-paid) para los
-- registros NUEVOS de ahora en adelante. POST /tenants/provision (flujo
-- Starter/gratis) tampoco la exige de forma dura -- corre en el primer
-- login, que puede ser días después del signup, y bloquear ahí rompería a
-- alguien que se registró justo antes de este deploy.

-- tenant_users.full_name es el nombre de la PERSONA que administra el
-- negocio (el "owner"), DISTINTO de tenants.name/business_name que son el
-- nombre del NEGOCIO -- no confundir ni fusionar ambos campos (mismo
-- criterio que ya se documentó para phone vs tenants.phone/whatsapp).

-- NO se muestra todavía en ningún lugar (panel admin / dashboard) --
-- pendiente de confirmar con Camilo dónde debe aparecer antes de tocar esa
-- parte. Esta migración y el cableado de guardado son independientes de
-- esa decisión.
