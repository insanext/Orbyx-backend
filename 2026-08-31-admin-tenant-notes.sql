-- ============================================================
-- Notas internas de Super Admin por tenant (bitacora)
-- ============================================================
-- Lista acumulable (no un solo campo que se sobreescribe): cada nota queda
-- como fila propia con fecha y que admin la escribio. Solo visible en el
-- panel /admin, nunca expuesta al tenant.
create table if not exists admin_tenant_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  admin_user_id uuid,
  admin_email text,
  note text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_admin_tenant_notes_tenant_id
  on admin_tenant_notes (tenant_id, created_at desc);
