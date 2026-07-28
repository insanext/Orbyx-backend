-- Backfill de tenants.trial_ends_at para tenants YA EXISTENTES.
-- Ejecutar en Supabase SQL Editor SOLO tras revisar el resultado del
-- SELECT de abajo. Requiere que 2026-07-27-tenants-trial-ends-at.sql
-- ya se haya corrido antes (la columna debe existir).
--
-- Alcance: hoy (2026-07-27) solo hay 5 tenants en produccion. De esos,
-- 2 nacieron en plan 'pro' (el trial gratuito): santuario-fit (creado
-- 2026-07-02) y prueba-1 (creado 2026-07-22). Los otros 3 nacieron
-- directo en plan pago (vip/platinum) y no les aplica trial_ends_at.
--
-- IMPORTANTE sobre santuario-fit: tiene una fila en subscriptions con
-- status='active' (plan premium, desde 2026-07-18, cobro real via Flow
-- ya reconciliado -- ver scripts/reconcile-katherine-barberia-invoice-
-- 1174923.js). O sea, YA ESTA PAGANDO, aunque tenants.is_trial siga en
-- true y tenants.plan_slug siga diciendo 'pro' (ese desfase de plan_slug
-- es un problema aparte, no se toca en este script). El calculo de
-- estado real en server.js (getAccountStatus) ignora is_trial y revisa
-- subscriptions.status='active' primero -- asi que el valor que le
-- pongamos a trial_ends_at para santuario-fit es irrelevante en la
-- practica: como ya tiene suscripcion activa, nunca se le va a mostrar
-- como "trial expirado" ni se le va a bloquear el dashboard, sin
-- importar la fecha. Se backfillea igual por consistencia de datos.

-- 1) Revisar ANTES de aplicar nada:
SELECT
  t.slug,
  t.created_at,
  t.plan_slug,
  t.is_trial,
  pc.trial_days,
  (t.created_at + (pc.trial_days || ' days')::interval) AS trial_ends_at_calculado,
  EXISTS (
    SELECT 1 FROM public.subscriptions s
    WHERE s.tenant_id = t.id AND s.status = 'active'
  ) AS tiene_suscripcion_activa
FROM public.tenants t
LEFT JOIN public.plan_config pc ON pc.plan_slug = 'pro'
WHERE t.plan_slug = 'pro'
  AND t.trial_ends_at IS NULL
ORDER BY t.created_at;

-- 2) Recien despues de revisar el resultado de arriba y confirmar que
--    tiene sentido, correr este UPDATE:
-- UPDATE public.tenants t
-- SET trial_ends_at = t.created_at + (pc.trial_days || ' days')::interval
-- FROM public.plan_config pc
-- WHERE pc.plan_slug = 'pro'
--   AND t.plan_slug = 'pro'
--   AND t.trial_ends_at IS NULL;
