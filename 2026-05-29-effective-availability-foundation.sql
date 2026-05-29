alter table public.branches
  add column if not exists use_global_hours boolean not null default true,
  add column if not exists use_global_special_dates boolean not null default true;

alter table public.business_hours
  alter column branch_id drop not null;

alter table public.business_special_dates
  alter column branch_id drop not null;

drop index if exists public.business_hours_global_unique;
drop index if exists public.business_hours_branch_unique;

create index if not exists business_hours_global_idx
  on public.business_hours (tenant_id, day_of_week)
  where branch_id is null;

create index if not exists business_hours_branch_idx
  on public.business_hours (tenant_id, branch_id, day_of_week)
  where branch_id is not null;

create index if not exists business_special_dates_global_idx
  on public.business_special_dates (tenant_id, date)
  where branch_id is null;

create index if not exists business_special_dates_branch_idx
  on public.business_special_dates (tenant_id, branch_id, date)
  where branch_id is not null;
