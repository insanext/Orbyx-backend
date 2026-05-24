create extension if not exists pgcrypto;

create table if not exists public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  branch_id uuid null,
  staff_id uuid null,
  provider text not null,
  provider_calendar_id text null,
  account_email text null,
  access_token text null,
  refresh_token text null,
  expires_at timestamptz null,
  scope text null,
  token_type text null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.calendar_connections
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists tenant_id uuid,
  add column if not exists branch_id uuid,
  add column if not exists staff_id uuid,
  add column if not exists provider text,
  add column if not exists provider_calendar_id text,
  add column if not exists account_email text,
  add column if not exists access_token text,
  add column if not exists refresh_token text,
  add column if not exists expires_at timestamptz,
  add column if not exists scope text,
  add column if not exists token_type text,
  add column if not exists is_active boolean default true,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

alter table public.calendar_connections
  alter column id set default gen_random_uuid(),
  alter column is_active set default true,
  alter column created_at set default now(),
  alter column updated_at set default now();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'calendar_connections_provider_check'
      and conrelid = 'public.calendar_connections'::regclass
  ) then
    alter table public.calendar_connections
      add constraint calendar_connections_provider_check
      check (provider in ('google', 'microsoft', 'apple'));
  end if;
end $$;

create index if not exists calendar_connections_tenant_provider_active_idx
  on public.calendar_connections (tenant_id, provider, is_active);

create index if not exists calendar_connections_tenant_staff_active_idx
  on public.calendar_connections (tenant_id, staff_id, is_active);

create index if not exists calendar_connections_tenant_branch_active_idx
  on public.calendar_connections (tenant_id, branch_id, is_active);
