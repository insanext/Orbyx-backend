-- ============================================================
-- Starter: acceso a Campañas → Email, 100 correos/mes incluidos
-- ============================================================
-- Decisión de producto 2026-09-20 (reemplaza MIGRACION_PLANES_STARTER_
-- BUSINESS_PREMIUM.md punto 3, que decía "Starter SIN campañas email/
-- WhatsApp"): Starter ahora tiene acceso al panel Campañas, pero SOLO al
-- canal Email -- WhatsApp de campañas sigue exclusivo de Business/Premium
-- (sin cambios ahí, ver addon_config.campanas_wa, que se deja intacto).
--
-- El cupo de 100 correos/mes solo cuenta desde que el tenant empieza a
-- pagar (o compra el add-on ahora para empezar de inmediato) -- mismo
-- criterio ya usado para wa_confirmacion durante el trial. Eso lo aplica
-- código nuevo en server.js (checkMonthlyUsage/isStarterTenantInTrial),
-- no esta migración -- acá solo se corrige el cupo BASE del plan (para
-- un Starter ya pagando) y se habilita la compra del add-on.
-- ============================================================

-- Cupo base de Starter: 0 -> 100 correos de campaña/mes.
UPDATE plan_config
SET email_campaign_limit = 100
WHERE plan_slug = 'starter';

-- El add-on "Pack emails campaña" (emails_campana) hoy es exclusivo de
-- Business/Premium (min_plan 'business', available_for sin 'starter') --
-- se habilita para que un Starter en trial pueda comprarlo y empezar a
-- usar el canal Email de inmediato, sin esperar a pagar el plan.
UPDATE addon_config
SET min_plan = 'starter',
    available_for = ARRAY['starter', 'business', 'premium']
WHERE addon_key = 'emails_campana';
