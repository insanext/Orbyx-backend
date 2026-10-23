-- Auditoría + corrección puntual del backfill de tenant_addons.balance
-- (2026-08-21-addon-balance-separation.sql), que ya corriste antes de que
-- revisáramos el problema de la fórmula. NO deshace el ALTER TABLE ni
-- vuelve a tocar filas que no lo necesiten.
--
-- El problema teórico: el backfill puso
--   balance = quantity * pack_size
-- para cada addon activo de wa_confirmacion/campanas_wa/emails_campana, sin
-- restar lo que el tenant ya hubiera gastado ESTE período contra el cupo
-- del plan. Si en el momento del backfill un tenant ya tenía
-- tenant_monthly_usage.used > cupo_del_plan (es decir, bajo el modelo
-- viejo ya había empezado a gastar de su capacidad de addon, no solo del
-- plan), el backfill le dio balance completo de todas formas — ese
-- excedente quedó "regalado" dos veces.
--
-- Paso 1 (solo lectura, ejecutar primero): busca tenants con addon activo
-- de estos 3 recursos cuyo `used` del período actual supera el cupo de su
-- plan. Si esto no devuelve filas, el backfill quedó correcto de hecho (no
-- hay excedente que corregir) y no hace falta correr el Paso 2.

WITH plan_caps AS (
  SELECT
    t.id AS tenant_id,
    t.slug AS tenant_slug,
    LOWER(COALESCE(t.plan_slug, t.plan, 'starter')) AS plan_slug_normalizado,
    COALESCE(pc.max_wa_confirmacion, pc_default.max_wa_confirmacion)   AS cap_wa_confirmacion,
    COALESCE(pc.max_campanas_wa, pc_default.max_campanas_wa)           AS cap_campanas_wa,
    COALESCE(pc.email_campaign_limit, pc_default.email_campaign_limit) AS cap_emails_campana
  FROM tenants t
  LEFT JOIN plan_config pc
    ON pc.plan_slug = LOWER(COALESCE(t.plan_slug, t.plan, 'starter'))
  -- normalizePlanSlug() en server.js cae a 'starter' para cualquier
  -- plan_slug no reconocido (ni starter/business/premium ni pro/vip/
  -- platinum) — este fallback replica exactamente ese comportamiento.
  LEFT JOIN plan_config pc_default
    ON pc_default.plan_slug = 'starter'
)
SELECT
  ta.tenant_id,
  pcap.tenant_slug,
  pcap.plan_slug_normalizado,
  ta.addon_key AS resource,
  ta.quantity,
  ta.balance AS balance_actual_post_backfill,
  tmu.used AS used_periodo_actual,
  CASE ta.addon_key
    WHEN 'wa_confirmacion' THEN pcap.cap_wa_confirmacion
    WHEN 'campanas_wa'     THEN pcap.cap_campanas_wa
    WHEN 'emails_campana'  THEN pcap.cap_emails_campana
  END AS cupo_plan,
  tmu.used - CASE ta.addon_key
    WHEN 'wa_confirmacion' THEN pcap.cap_wa_confirmacion
    WHEN 'campanas_wa'     THEN pcap.cap_campanas_wa
    WHEN 'emails_campana'  THEN pcap.cap_emails_campana
  END AS excedente_a_descontar_de_balance
FROM tenant_addons ta
JOIN plan_caps pcap ON pcap.tenant_id = ta.tenant_id
JOIN tenant_monthly_usage tmu
  ON tmu.tenant_id = ta.tenant_id
 AND tmu.resource = ta.addon_key
 AND tmu.period = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')  -- mismo criterio que server.js: new Date().toISOString().slice(0,7), siempre UTC
WHERE ta.status = 'active'
  AND ta.addon_key IN ('wa_confirmacion', 'campanas_wa', 'emails_campana')
  AND tmu.used > CASE ta.addon_key
      WHEN 'wa_confirmacion' THEN pcap.cap_wa_confirmacion
      WHEN 'campanas_wa'     THEN pcap.cap_campanas_wa
      WHEN 'emails_campana'  THEN pcap.cap_emails_campana
    END
ORDER BY excedente_a_descontar_de_balance DESC;


-- Paso 2 (solo si el Paso 1 devolvió filas): resta el excedente exacto de
-- cada fila afectada, sin tocar ninguna otra. Usa la misma lógica que el
-- SELECT de arriba, así que toca únicamente las filas donde used > cupo_plan
-- — en cualquier otro tenant es un no-op. Nunca baja balance de 0.
--
-- UPDATE tenant_addons ta
-- SET balance = GREATEST(0, ta.balance - sub.excedente),
--     updated_at = now()
-- FROM (
--   SELECT
--     ta.id AS tenant_addon_id,
--     tmu.used - CASE ta.addon_key
--       WHEN 'wa_confirmacion' THEN pcap.cap_wa_confirmacion
--       WHEN 'campanas_wa'     THEN pcap.cap_campanas_wa
--       WHEN 'emails_campana'  THEN pcap.cap_emails_campana
--     END AS excedente
--   FROM tenant_addons ta
--   JOIN (
--     SELECT
--       t.id AS tenant_id,
--       LOWER(COALESCE(t.plan_slug, t.plan, 'starter')) AS plan_slug_normalizado,
--       COALESCE(pc.max_wa_confirmacion, pc_default.max_wa_confirmacion)   AS cap_wa_confirmacion,
--       COALESCE(pc.max_campanas_wa, pc_default.max_campanas_wa)           AS cap_campanas_wa,
--       COALESCE(pc.email_campaign_limit, pc_default.email_campaign_limit) AS cap_emails_campana
--     FROM tenants t
--     LEFT JOIN plan_config pc ON pc.plan_slug = LOWER(COALESCE(t.plan_slug, t.plan, 'starter'))
--     LEFT JOIN plan_config pc_default ON pc_default.plan_slug = 'starter'
--   ) pcap ON pcap.tenant_id = ta.tenant_id
--   JOIN tenant_monthly_usage tmu
--     ON tmu.tenant_id = ta.tenant_id
--    AND tmu.resource = ta.addon_key
--    AND tmu.period = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')
--   WHERE ta.status = 'active'
--     AND ta.addon_key IN ('wa_confirmacion', 'campanas_wa', 'emails_campana')
--     AND tmu.used > CASE ta.addon_key
--         WHEN 'wa_confirmacion' THEN pcap.cap_wa_confirmacion
--         WHEN 'campanas_wa'     THEN pcap.cap_campanas_wa
--         WHEN 'emails_campana'  THEN pcap.cap_emails_campana
--       END
-- ) sub
-- WHERE ta.id = sub.tenant_addon_id;
