alter table public.tenants
  add column if not exists logo_url text;

alter table public.branches
  add column if not exists whatsapp text,
  add column if not exists email text,
  add column if not exists description text,
  add column if not exists city text,
  add column if not exists commune text,
  add column if not exists map_url text,
  add column if not exists latitude numeric,
  add column if not exists longitude numeric,
  add column if not exists instagram_url text,
  add column if not exists facebook_url text,
  add column if not exists tiktok_url text,
  add column if not exists website_url text,
  add column if not exists use_global_socials boolean not null default true,
  add column if not exists use_global_contact boolean not null default true;

insert into storage.buckets (id, name, public)
values ('business-logos', 'business-logos', true)
on conflict (id) do nothing;
