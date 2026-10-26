-- Boletas/facturas que Orbyx emite a cada negocio por sus cobros (plan y add-ons).
-- El Super Admin sube el PDF desde /admin y marca qué cobros de Flow cubre
-- (flow_orders = números de orden de Flow de customer/getCharges). Un mismo
-- documento puede cubrir varios cobros (p. ej. plan + add-on del mismo día).
-- El negocio lo ve y lo descarga en "Mi suscripción → Historial de pagos".
--
-- Seguridad: tabla solo para el service role (RLS activo y sin grants); el
-- backend valida dueño/admin del negocio. Bucket privado: los PDF se entregan
-- con URL firmada de corta duración, nunca pública.
--
-- tenant_id ON DELETE SET NULL a propósito: son documentos tributarios y se
-- conservan aunque se elimine el negocio (mismo criterio que legal_acceptances).

create table if not exists public.billing_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete set null,
  doc_type text not null default 'boleta',
  folio text,
  issued_at date,
  total integer,
  flow_orders text[] not null default '{}',
  file_path text not null,
  file_name text,
  uploaded_by uuid,
  uploaded_by_email text,
  created_at timestamptz not null default now()
);

create index if not exists billing_documents_tenant_idx
  on public.billing_documents (tenant_id, created_at desc);

alter table public.billing_documents enable row level security;
revoke all on public.billing_documents from anon, authenticated;

-- Bucket privado para los PDF.
insert into storage.buckets (id, name, public)
values ('billing-documents', 'billing-documents', false)
on conflict (id) do nothing;
