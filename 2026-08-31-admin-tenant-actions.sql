-- ============================================================
-- Auditoria generica de acciones de Super Admin sobre un tenant
-- ============================================================
-- Contexto: la ficha de tenant del panel admin (/admin/tenants/:id) se esta
-- convirtiendo en herramienta de soporte real (notas internas, ver tickets,
-- ver dashboard como el tenant, reenviar email/reset password, otorgar
-- creditos de saldo, pausar/reactivar). Todas esas acciones deben quedar
-- auditadas en un solo lugar, no solo el borrado (que ya tenia su propia
-- tabla dedicada, admin_tenant_deletions, ver 2026-08-30-admin-tenant-deletion.sql).
--
-- Decision: se deja admin_tenant_deletions tal cual (no se migran sus filas
-- aca) y se agrega esta tabla nueva y generica en paralelo -- server.js
-- ahora inserta en AMBAS al borrar un tenant. Es la opcion menos riesgosa:
-- no toca una tabla ya en uso ni reescribe su historial, y admin_tenant_actions
-- pasa a ser la fuente completa para todo lo nuevo hacia adelante.
create table if not exists admin_tenant_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  admin_user_id uuid,
  admin_email text,
  action_type text not null,
  details jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_admin_tenant_actions_tenant_id
  on admin_tenant_actions (tenant_id, created_at desc);
