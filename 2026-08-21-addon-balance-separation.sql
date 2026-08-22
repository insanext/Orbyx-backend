-- Migración: separa el cupo mensual del plan del saldo comprado en add-ons
-- Ejecutar en Supabase SQL editor (Dashboard → SQL Editor → New query → Run)
--
-- Problema que corrige: hoy tenant_addons.quantity (packs contratados de
-- wa_confirmacion/campanas_wa/emails_campana) se traduce en una capacidad
-- que se recalcula íntegra cada mes (quantity × pack_size) contra un
-- tenant_monthly_usage.used que arranca en 0 cada período nuevo (columna
-- "period" = 'YYYY-MM'). Eso significa que el saldo comprado y no gastado
-- NUNCA se acumula: cada mes el tenant vuelve a tener el mismo total, haya
-- gastado 0 o el máximo el mes anterior. Fix: un número nuevo,
-- tenant_addons.balance, que es plata (saldo, en unidades de mensaje/email)
-- ya pagada — sube al comprar/renovar el add-on, baja al consumirse, y
-- JAMÁS se resetea solo. El cupo del plan (tenant_monthly_usage.used) sigue
-- reseteando solo, porque ya lo hace por naturaleza del period key — no
-- necesita cambio de esquema.
--
-- Ver server.js: consumeResourceUsage() consume primero del cupo del plan
-- (tenant_monthly_usage) y recién después del balance. checkMonthlyUsage()
-- reporta ambos números por separado.

ALTER TABLE tenant_addons
  ADD COLUMN IF NOT EXISTS balance integer NOT NULL DEFAULT 0;

-- Backfill: a cada add-on de mensajería ACTIVO hoy se le da un saldo
-- equivalente a su quantity actual × pack_size vigente, para no perder de
-- golpe la capacidad ya pagada al desplegar este cambio. Usa el pack_size
-- vigente en addon_config si existe fila para ese addon_key; si no, cae al
-- default hardcodeado en DEFAULT_ADDON_CATALOG (server.js).
UPDATE tenant_addons ta
SET balance = ta.quantity * COALESCE(
  (SELECT ac.pack_size FROM addon_config ac WHERE ac.addon_key = ta.addon_key),
  CASE ta.addon_key
    WHEN 'wa_confirmacion' THEN 50
    WHEN 'campanas_wa' THEN 50
    WHEN 'emails_campana' THEN 500
    ELSE 0
  END
)
WHERE ta.status = 'active'
  AND ta.addon_key IN ('wa_confirmacion', 'campanas_wa', 'emails_campana');

-- staff/sucursal/group_capacity no usan balance (su capacidad sigue siendo
-- quantity directamente, ver getEffectiveLimit/getEffectiveGroupCapacity en
-- server.js) — quedan en balance=0 por default, sin uso, sin efecto.
