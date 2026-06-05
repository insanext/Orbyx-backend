-- =============================================================================
-- ORBYX CUENTAS — Fase 1A / PARTE B: Row Level Security
-- PENDIENTE — no ejecutar hasta validar login con Parte A.
-- Ejecutar solo después de confirmar que el flujo de login funciona
-- y de revisar qué políticas ya existen en tenant_users y tenants.
-- Fecha: 2026-05-31
-- Revisado: 2026-06-04 — sin cambios necesarios. Las políticas trabajan
--   con user_id y email, no con valores de rol. Compatible con el modelo
--   de roles actualizado (admin, branch, readonly).
-- =============================================================================


-- =============================================================================
-- 1. Habilitar RLS en tablas nuevas
-- =============================================================================

ALTER TABLE public.branch_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_invitations ENABLE ROW LEVEL SECURITY;


-- =============================================================================
-- 2. Políticas para branch_access
--    Un usuario solo ve sus propias filas.
-- =============================================================================

DROP POLICY IF EXISTS "branch_access_own_rows" ON public.branch_access;
CREATE POLICY "branch_access_own_rows"
  ON public.branch_access
  FOR SELECT
  USING (auth.uid() = user_id);


-- =============================================================================
-- 3. Políticas para tenant_invitations
--    Un usuario ve las invitaciones dirigidas a su email.
-- =============================================================================

DROP POLICY IF EXISTS "tenant_invitations_own_email" ON public.tenant_invitations;
CREATE POLICY "tenant_invitations_own_email"
  ON public.tenant_invitations
  FOR SELECT
  USING (email = (SELECT email FROM auth.users WHERE id = auth.uid()));


-- =============================================================================
-- 4. Políticas sugeridas para tenant_users y tenants
--    Ejecutar solo si esas tablas tienen RLS activa y les falta
--    permitir que cada usuario lea sus propios datos.
--
--    VERIFICAR ANTES en:
--    Supabase Dashboard > Authentication > Policies
-- =============================================================================

-- tenant_users: cada usuario lee solo sus propias filas
-- DROP POLICY IF EXISTS "tenant_users_own_rows" ON public.tenant_users;
-- CREATE POLICY "tenant_users_own_rows"
--   ON public.tenant_users
--   FOR SELECT
--   USING (auth.uid() = user_id);

-- tenants: un usuario lee los tenants donde es miembro
-- DROP POLICY IF EXISTS "tenants_member_read" ON public.tenants;
-- CREATE POLICY "tenants_member_read"
--   ON public.tenants
--   FOR SELECT
--   USING (
--     id IN (
--       SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()
--     )
--   );
