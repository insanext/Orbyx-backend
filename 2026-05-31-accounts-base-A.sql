-- =============================================================================
-- ORBYX CUENTAS — Fase 1A / PARTE A: Estructura de tablas
-- Segura para ejecutar ahora. No toca RLS ni políticas.
-- Fecha: 2026-05-31
-- Actualizado: 2026-06-04 — agrega roles 'branch' y 'readonly' al ENUM
--              y corrige CHECK de tenant_invitations.role al modelo de roles vigente.
-- =============================================================================


-- =============================================================================
-- 1. ENUM tenant_role — agregar valores faltantes
--
--    Valores actuales confirmados: owner, admin, agent
--    Valores a agregar: operator, staff, branch, readonly
--
--    ALTER TYPE ... ADD VALUE es seguro en Postgres:
--    - No bloquea filas existentes
--    - No modifica datos actuales
--    - Idempotente con IF NOT EXISTS
-- =============================================================================

ALTER TYPE public.tenant_role ADD VALUE IF NOT EXISTS 'operator';
ALTER TYPE public.tenant_role ADD VALUE IF NOT EXISTS 'staff';
ALTER TYPE public.tenant_role ADD VALUE IF NOT EXISTS 'branch';
ALTER TYPE public.tenant_role ADD VALUE IF NOT EXISTS 'readonly';


-- =============================================================================
-- 2. tenant_users — agregar columnas faltantes
--    No toca la columna role (ya es ENUM tenant_role, no se modifica).
--    No agrega CHECK constraint sobre role (el ENUM ya lo garantiza).
-- =============================================================================

ALTER TABLE public.tenant_users
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();


-- =============================================================================
-- 3. branch_access — nueva tabla
--    role usa text con CHECK constraint propio (no comparte el ENUM de tenant).
--    Los valores aquí son roles internos dentro de una sucursal.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.branch_access (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL,
  tenant_id   uuid        NOT NULL,
  branch_id   uuid        NOT NULL,
  role        text        NOT NULL DEFAULT 'operator',
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        NULL,

  CONSTRAINT branch_access_role_check
    CHECK (role IN ('manager', 'operator', 'staff')),

  CONSTRAINT branch_access_user_branch_unique
    UNIQUE (user_id, branch_id)
);

CREATE INDEX IF NOT EXISTS branch_access_user_idx
  ON public.branch_access (user_id);

CREATE INDEX IF NOT EXISTS branch_access_branch_idx
  ON public.branch_access (branch_id);

CREATE INDEX IF NOT EXISTS branch_access_tenant_idx
  ON public.branch_access (tenant_id);


-- =============================================================================
-- 4. tenant_invitations — nueva tabla
--
--    role usa text con CHECK constraint propio.
--    Modelo de roles vigente en Orbyx:
--      owner    — dueño del negocio (no se invita, se crea en provision)
--      admin    — acceso total, invitado por el owner
--      branch   — acceso restringido a una sucursal específica
--      readonly — puede ver todo pero no modificar nada
--
--    Los valores anteriores (operator, staff, manager) quedan fuera del
--    modelo de invitaciones — se gestionan en staffing, no en acceso al
--    dashboard.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.tenant_invitations (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL,
  branch_id   uuid        NULL,
  email       text        NOT NULL,
  role        text        NOT NULL,
  token       text        NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  status      text        NOT NULL DEFAULT 'pending',
  invited_by  uuid        NULL,
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_at timestamptz NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tenant_invitations_role_check
    CHECK (role IN ('owner', 'admin', 'branch', 'readonly')),

  CONSTRAINT tenant_invitations_status_check
    CHECK (status IN ('pending', 'accepted', 'expired', 'canceled'))
);

CREATE INDEX IF NOT EXISTS tenant_invitations_token_idx
  ON public.tenant_invitations (token);

CREATE INDEX IF NOT EXISTS tenant_invitations_email_idx
  ON public.tenant_invitations (email);

CREATE INDEX IF NOT EXISTS tenant_invitations_tenant_idx
  ON public.tenant_invitations (tenant_id);
