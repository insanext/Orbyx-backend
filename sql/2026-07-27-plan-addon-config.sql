-- Migration: plan_config y addon_config para el panel admin de planes/precios.
-- Ejecutar en Supabase SQL Editor.
--
-- Los valores iniciales (INSERT) son EXACTAMENTE los que hoy estan
-- hardcodeados en server.js: getPlanCapabilities (linea 84), PLAN_PRICES
-- (linea ~145), BILLING_CYCLES (linea ~163), y ADDON_CATALOG (linea ~235).
-- No se inventa ni se redondea ningun numero.

-- =========================================================
-- plan_config
-- =========================================================
CREATE TABLE IF NOT EXISTS public.plan_config (
  plan_slug text PRIMARY KEY CHECK (plan_slug IN ('pro', 'premium', 'vip', 'platinum')),
  price_monthly integer NOT NULL,
  -- Descuento en % sobre (price_monthly * meses del ciclo). Ej: 10 = 10% off.
  -- Hoy este descuento es global (mismo para los 4 planes) via BILLING_CYCLES;
  -- se duplica por plan aca para que el admin pueda diferenciarlo a futuro
  -- si quisiera, sin forzar que sea igual para todos.
  price_semestral_discount_pct numeric NOT NULL DEFAULT 0,
  price_annual_discount_pct numeric NOT NULL DEFAULT 0,
  trial_days integer NOT NULL DEFAULT 30,
  staff_limit integer NOT NULL,
  services_limit integer NOT NULL,
  branches_limit integer NOT NULL,
  email_campaign_limit integer NOT NULL,
  max_wa_confirmacion integer NOT NULL DEFAULT 0,
  max_ia_wa integer NOT NULL DEFAULT 0,
  max_group_capacity integer NOT NULL DEFAULT 0,
  max_campanas_wa integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.plan_config ENABLE ROW LEVEL SECURITY;
-- Deny-all: sin policies, solo el backend con service_role key puede leer/escribir
-- (mismo patron que admin_users en 2026-06-21-admin-users.sql).

INSERT INTO public.plan_config
  (plan_slug, price_monthly, price_semestral_discount_pct, price_annual_discount_pct,
   trial_days, staff_limit, services_limit, branches_limit, email_campaign_limit,
   max_wa_confirmacion, max_ia_wa, max_group_capacity, max_campanas_wa, is_active)
VALUES
  ('pro',      12990,  10, 15, 30, 2,  999999, 1,  200,  100, 0,   10,  0, true),
  ('premium',  29990,  10, 15, 30, 5,  999999, 2,  1000, 200, 0,   25,  0, true),
  ('vip',      54990,  10, 15, 30, 10, 999999, 3,  2000, 300, 500, 50,  0, true),
  ('platinum', 149990, 10, 15, 30, 25, 999999, 10, 5000, 500, 1500, 100, 0, true)
ON CONFLICT (plan_slug) DO NOTHING;

-- =========================================================
-- addon_config
-- =========================================================
CREATE TABLE IF NOT EXISTS public.addon_config (
  addon_key text PRIMARY KEY,
  -- Sin CHECK sobre addon_key a proposito: el panel admin debe poder
  -- crear add-ons nuevos sin necesitar otra migracion.
  name text NOT NULL,
  description text,
  price integer NOT NULL,
  promo_price integer,
  promo_active boolean NOT NULL DEFAULT false,
  promo_starts_at timestamptz,
  promo_ends_at timestamptz,
  pack2_price integer,
  pack3_price integer,
  -- Cuanta cantidad otorga UNA unidad comprada (ej. wa_confirmacion = 50
  -- mensajes por unidad). Reemplaza el campo "grants" de ADDON_CATALOG:
  -- hoy grants siempre es { [addon_key]: pack_size }, un solo numero
  -- alcanza para reconstruirlo al leer desde esta tabla.
  pack_size integer NOT NULL,
  min_plan text NOT NULL CHECK (min_plan IN ('pro', 'premium', 'vip', 'platinum')),
  -- Lista de PLANES que pueden comprar este addon (no categorias de
  -- negocio - no existe ese filtro hoy). Ej: ["vip","platinum"].
  available_for jsonb NOT NULL DEFAULT '[]'::jsonb,
  resets_monthly boolean NOT NULL DEFAULT true,
  accumulates boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.addon_config ENABLE ROW LEVEL SECURITY;
-- Deny-all, mismo patron que arriba.

INSERT INTO public.addon_config
  (addon_key, name, description, price, pack2_price, pack3_price, pack_size,
   min_plan, available_for, resets_monthly, accumulates, is_active)
VALUES
  ('wa_confirmacion', 'WA confirmación+recordatorio', '50 msgs WA adicionales/mes',
    2990, 2691, 2542, 50, 'pro', '["pro","premium","vip","platinum"]'::jsonb, true, false, true),
  ('campanas_wa', 'Campañas WhatsApp', '50 msgs campaña marketing adicionales/mes',
    6990, 6291, 5942, 50, 'vip', '["vip","platinum"]'::jsonb, true, false, true),
  ('ia_wa', 'IA WhatsApp', '500 conversaciones IA adicionales/mes',
    14990, 13491, 12742, 500, 'vip', '["vip","platinum"]'::jsonb, true, false, true),
  ('emails_campana', 'Pack emails campaña', '2.000 correos campaña adicionales/mes',
    1990, 1990, 1990, 2000, 'pro', '["pro","premium","vip","platinum"]'::jsonb, true, false, true),
  ('staff', '+ 1 Profesional', '1 staff adicional sobre límite del plan',
    5990, 5990, 5990, 1, 'premium', '["premium","vip","platinum"]'::jsonb, false, false, true),
  ('sucursal', '+ 1 Sucursal', '1 sucursal adicional sobre límite del plan',
    9990, 9990, 9990, 1, 'premium', '["premium","vip","platinum"]'::jsonb, false, false, true),
  ('group_capacity', '+ Cupos grupales', '25 cupos adicionales por slot grupal',
    4900, 4900, 4900, 25, 'premium', '["premium","vip","platinum"]'::jsonb, false, false, true)
ON CONFLICT (addon_key) DO NOTHING;
