-- Banner de portada de la página pública de reservas.
-- Negocio: tenants.banner_url (global). Sucursal: branches.banner_url propio,
-- que solo se usa si use_global_banner = false (mismo patrón que
-- use_global_contact). El logo sigue siendo solo global.
-- Las imágenes se guardan en el bucket público existente `business-logos`
-- (prefijo tenants/<tenant_id>/banner-... o .../branches/<branch_id>/banner-...).

alter table public.tenants
  add column if not exists banner_url text;

alter table public.branches
  add column if not exists banner_url text,
  add column if not exists use_global_banner boolean not null default true;
