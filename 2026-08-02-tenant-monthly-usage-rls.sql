-- =============================================================================
-- Migración: RLS + Realtime en tenant_monthly_usage
-- Fecha: 2026-08-02
-- Propósito: permitir que el dashboard escuche cambios en tiempo real
--            (Supabase Realtime, postgres_changes) sobre tenant_monthly_usage
--            para el widget "Estado de mi cuenta", sin que un usuario pueda
--            suscribirse a cambios de cupo de OTRO tenant.
--
-- CONTEXTO IMPORTANTE (leer antes de correr):
-- server.js siempre lee/escribe esta tabla con la service_role key, que
-- SIEMPRE bypassea RLS — este cambio no afecta nada del backend existente.
-- Solo afecta al cliente del frontend (orbyx-web, que usa el anon key +
-- sesión del usuario), que es el que abre el canal de Realtime.
--
-- Verificado (no asumido): tenant_monthly_usage hoy NO tiene RLS activa
-- (grep en el repo no encontró ningún ALTER TABLE ... ENABLE ROW LEVEL
-- SECURITY para esta tabla). Sin RLS, Supabase Realtime transmite TODOS los
-- cambios a TODOS los clientes suscritos a la tabla, sin importar el filtro
-- que mande el cliente (el filtro tenant_id=eq.X del lado del cliente es
-- solo una conveniencia, NO un límite de seguridad por sí solo).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Habilitar RLS
-- -----------------------------------------------------------------------------

ALTER TABLE public.tenant_monthly_usage ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 2. Política: un usuario autenticado solo puede leer filas de tenants
--    donde es miembro activo (mismo criterio que resolveTenantMembership()
--    en server.js: tenant_users.user_id = auth.uid() AND is_active = true).
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS "tenant_monthly_usage_own_tenant" ON public.tenant_monthly_usage;
CREATE POLICY "tenant_monthly_usage_own_tenant"
  ON public.tenant_monthly_usage
  FOR SELECT
  TO authenticated
  USING (
    tenant_id IN (
      SELECT tenant_id FROM public.tenant_users
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

-- -----------------------------------------------------------------------------
-- 3. Agregar la tabla a la publicación de Realtime (paso aparte de RLS —
--    sin esto, postgres_changes no emite eventos para esta tabla en
--    absoluto, con o sin RLS).
-- -----------------------------------------------------------------------------

-- NOTA: si esta tabla ya está en la publicación (por ejemplo si alguien la
-- agregó manualmente desde el Dashboard de Supabase), este comando falla
-- con "relation is already member of publication" — no es un problema, solo
-- salta ese error y segui.
ALTER PUBLICATION supabase_realtime ADD TABLE public.tenant_monthly_usage;

-- -----------------------------------------------------------------------------
-- 4. Verificación recomendada después de correr esto (Supabase Dashboard):
-- -----------------------------------------------------------------------------

-- Authentication > Policies > tenant_monthly_usage: confirmar que aparece
-- la política de arriba y que RLS dice "Enabled".
-- Database > Replication > supabase_realtime: confirmar que
-- tenant_monthly_usage aparece en la lista de tablas.

-- -----------------------------------------------------------------------------
-- 5. Hallazgo relacionado, fuera de alcance de esta migración
-- -----------------------------------------------------------------------------

-- La tabla `appointments`, que ya se usa para Realtime hoy (notificaciones
-- del dashboard, orbyx-web/app/dashboard/[slug]/layout.tsx), tiene el MISMO
-- problema: no se encontró ningún ALTER TABLE ... ENABLE ROW LEVEL SECURITY
-- para `appointments` en ningún archivo .sql del repo. Si es así en producción
-- también, cualquier usuario autenticado podría suscribirse a los cambios de
-- appointments de OTRO tenant (nombres de clientes, teléfonos, horarios)
-- ignorando el filtro tenant_id del lado del cliente. No se tocó en esta
-- migración porque es una funcionalidad ya en producción y el pedido de esta
-- sesión fue específicamente sobre tenant_monthly_usage — se dejó como tarea
-- aparte (ver project_realtime_rls_appointments_gap en la memoria del
-- proyecto / chip de tarea sugerida).
