-- ============================================================
-- Desuscripción de correos de campaña (auditoría 2026-09-29, sesión 2, I13)
-- ============================================================
-- Ley 19.496 art. 28 B: toda comunicación promocional por correo debe
-- indicar una forma expedita de pedir que se suspenda, y una vez pedido no
-- se puede volver a enviar.
--
-- Una fila por (negocio, email). Se crea sola la primera vez que ese email
-- entra en una campaña de ese negocio (POST /campaigns/send-email), y su
-- `token` va en el enlace "darte de baja" del correo
-- (https://www.orbyx.cl/desuscribir/{token}) y en el encabezado
-- List-Unsubscribe (baja con un clic desde Gmail/Outlook). Al darse de baja
-- se marca `unsubscribed_at` y ese email queda excluido de las próximas
-- campañas de ESE negocio (no de otros negocios de Orbyx).
--
-- Es por email y no una columna en `customers` porque las campañas también
-- se envían a destinatarios agregados a mano que no son clientes, y porque
-- un mismo cliente puede estar duplicado (ver auditoría I12): la baja debe
-- valer para la dirección, no para una fila puntual. GET /customers/:slug
-- expone el estado como `marketing_opt_out` en cada cliente.
--
-- Solo el backend (service role) lee/escribe esta tabla: RLS activado sin
-- políticas para anon/authenticated.
--
-- IMPORTANTE: correr ANTES de desplegar el backend de esta ronda — sin la
-- tabla, POST /campaigns/send-email responde error en vez de enviar
-- correos sin enlace de baja.
--
-- Aditiva y reversible: DROP TABLE public.marketing_email_preferences;
-- ============================================================

create table if not exists public.marketing_email_preferences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  email text not null,
  token uuid not null default gen_random_uuid(),
  unsubscribed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint marketing_email_preferences_tenant_email_key unique (tenant_id, email),
  constraint marketing_email_preferences_token_key unique (token)
);

create index if not exists marketing_email_preferences_unsubscribed_idx
  on public.marketing_email_preferences (tenant_id)
  where unsubscribed_at is not null;

alter table public.marketing_email_preferences enable row level security;
