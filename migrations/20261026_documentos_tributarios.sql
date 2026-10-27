-- Documentos tributarios (boleta / factura) por cada pago de Flow.
-- Reemplaza el flujo de billing_documents (2026-10-26-billing-documents.sql):
-- cada pago confirmado crea una fila 'pendiente'; el admin emite el documento
-- en el SII a mano, sube el PDF y la fila pasa a 'emitido'.
--
-- Idempotente: se puede correr más de una vez.
--
-- Identidad del pago = flow_order (UNIQUE). No existe una tabla de pagos en
-- Supabase (los cobros se leen de Flow), por eso no hay pago_id: flow_order
-- cumple el rol "un pago = un documento" y hace idempotentes los reintentos
-- del webhook de Flow.
--
-- tenant_id ON DELETE SET NULL a propósito: son documentos tributarios y se
-- conservan aunque se elimine el negocio (mismo criterio que billing_documents
-- y legal_acceptances).

-- ============================================================
-- 1) Preferencias / datos de facturación del tenant
-- ============================================================
alter table public.tenants
  add column if not exists tipo_documento_preferido text not null default 'boleta',
  add column if not exists rut_facturacion text,
  add column if not exists razon_social text,
  add column if not exists giro text,
  add column if not exists direccion_facturacion text,
  add column if not exists comuna_facturacion text,
  add column if not exists email_dte text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tenants_tipo_documento_preferido_check'
  ) then
    alter table public.tenants
      add constraint tenants_tipo_documento_preferido_check
      check (tipo_documento_preferido in ('boleta', 'factura'));
  end if;
end $$;

-- ============================================================
-- 2) Tabla documentos_tributarios
-- ============================================================
create table if not exists public.documentos_tributarios (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete set null,
  flow_order text not null,
  origen text not null default 'suscripcion',
  tipo text not null default 'boleta',
  estado text not null default 'pendiente',
  folio text,
  fecha_emision date,
  fecha_pago date not null default ((now() at time zone 'America/Santiago')::date),
  monto_total integer not null,
  monto_neto integer not null,
  monto_iva integer not null,
  concepto text not null,
  datos_receptor jsonb,
  archivo_bucket text not null default 'documentos-tributarios',
  archivo_path text,
  archivo_nombre text,
  nota_credito_folio text,
  nota_credito_path text,
  motivo_anulacion text,
  observaciones text,
  subido_por uuid,
  subido_por_email text,
  subido_at timestamptz,
  aviso_admin_enviado_at timestamptz,
  aviso_tenant_enviado_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint documentos_tributarios_flow_order_key unique (flow_order),
  constraint documentos_tributarios_tipo_check check (tipo in ('boleta', 'factura')),
  constraint documentos_tributarios_estado_check check (estado in ('pendiente', 'emitido', 'anulado')),
  constraint documentos_tributarios_montos_check check (monto_total >= 0 and monto_neto >= 0 and monto_iva >= 0)
);

create index if not exists documentos_tributarios_estado_idx
  on public.documentos_tributarios (estado);
create index if not exists documentos_tributarios_tenant_idx
  on public.documentos_tributarios (tenant_id);
create index if not exists documentos_tributarios_created_idx
  on public.documentos_tributarios (created_at desc);
create index if not exists documentos_tributarios_fecha_pago_idx
  on public.documentos_tributarios (fecha_pago desc);

-- ============================================================
-- 3) RLS: el tenant solo LEE sus documentos; escribir solo con service role
--    (el backend). Las columnas internas (observaciones, quién subió, rutas
--    de nota de crédito) no se conceden al rol authenticated.
-- ============================================================
alter table public.documentos_tributarios enable row level security;

revoke all on public.documentos_tributarios from anon, authenticated;
grant select (
  id, tenant_id, flow_order, origen, tipo, estado, folio, fecha_emision,
  fecha_pago, monto_total, monto_neto, monto_iva, concepto, created_at, updated_at
) on public.documentos_tributarios to authenticated;

drop policy if exists documentos_tributarios_tenant_select on public.documentos_tributarios;
create policy documentos_tributarios_tenant_select
  on public.documentos_tributarios
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.tenant_users tu
      where tu.tenant_id = documentos_tributarios.tenant_id
        and tu.user_id = auth.uid()
        and tu.is_active = true
    )
  );

-- ============================================================
-- 4) Bucket privado. Sin policies en storage.objects: solo el service role
--    (backend) lee/escribe; los PDF se entregan con URL firmada corta.
-- ============================================================
insert into storage.buckets (id, name, public)
values ('documentos-tributarios', 'documentos-tributarios', false)
on conflict (id) do nothing;

-- ============================================================
-- 5) Backfill: boletas ya subidas con el sistema anterior (billing_documents)
--    pasan a 'emitido'. Una fila por cobro de Flow cubierto; el PDF se queda
--    en su bucket original (archivo_bucket = 'billing-documents'), no se mueve.
--    Si la boleta cubría varios cobros, el monto de cada uno queda en 0 y se
--    corrige con "Sincronizar con Flow" en el panel admin.
--    Los pagos históricos que solo existen en Flow (sin boleta) se importan
--    con ese mismo botón: desde SQL no se pueden consultar.
-- ============================================================
do $$
begin
  if to_regclass('public.billing_documents') is not null then
    insert into public.documentos_tributarios (
      tenant_id, flow_order, origen, tipo, estado, folio, fecha_emision,
      fecha_pago, monto_total, monto_neto, monto_iva, concepto,
      archivo_bucket, archivo_path, archivo_nombre, observaciones,
      subido_por, subido_por_email, subido_at, created_at
    )
    select
      d.tenant_id,
      fo.flow_order,
      'otro',
      case when d.doc_type in ('boleta', 'factura') then d.doc_type else 'boleta' end,
      'emitido',
      d.folio,
      d.issued_at,
      coalesce(d.issued_at, (d.created_at at time zone 'America/Santiago')::date),
      case when cardinality(d.flow_orders) = 1 then coalesce(d.total, 0) else 0 end,
      case when cardinality(d.flow_orders) = 1 then round(coalesce(d.total, 0) / 1.19)::int else 0 end,
      case when cardinality(d.flow_orders) = 1
           then coalesce(d.total, 0) - round(coalesce(d.total, 0) / 1.19)::int
           else 0 end,
      'Cobro Flow #' || fo.flow_order,
      'billing-documents',
      d.file_path,
      d.file_name,
      case when cardinality(d.flow_orders) > 1
           then 'Migrado: el documento cubría ' || cardinality(d.flow_orders) || ' cobros; monto por confirmar.'
           else 'Migrado desde billing_documents.' end,
      d.uploaded_by,
      d.uploaded_by_email,
      d.created_at,
      d.created_at
    from public.billing_documents d
    cross join lateral unnest(d.flow_orders) as fo(flow_order)
    on conflict (flow_order) do nothing;
  end if;
end $$;
