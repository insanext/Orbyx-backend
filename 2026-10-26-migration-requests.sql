-- Migración de datos (una sola vez por negocio).
-- El negocio sube desde Clientes los archivos que exportó de su sistema
-- anterior (clientes, reservas pasadas y futuras). El equipo de Orbyx recibe
-- un correo, los descarga desde /admin/migraciones y los carga a mano.
--
-- unique(tenant_id): una sola solicitud por negocio. Si el equipo la elimina
-- desde el admin, el negocio puede volver a subir.
--
-- Seguridad: tabla solo para el service role (RLS activo, sin grants); el
-- backend valida dueño/admin del negocio. Bucket privado: los archivos se
-- descargan solo desde el admin con URL firmada de corta duración.

create table if not exists public.migration_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references public.tenants(id) on delete cascade,
  status text not null default 'pending',
  notes text,
  files jsonb not null default '[]'::jsonb,
  created_by uuid,
  created_by_email text,
  admin_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists migration_requests_status_idx
  on public.migration_requests (status, created_at desc);

alter table public.migration_requests enable row level security;
revoke all on public.migration_requests from anon, authenticated;

insert into storage.buckets (id, name, public)
values ('migration-uploads', 'migration-uploads', false)
on conflict (id) do nothing;
