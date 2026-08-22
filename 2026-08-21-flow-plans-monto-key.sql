-- flow_plans: agrega `monto` a la unique key (antes solo plan_id+periodicidad).
--
-- Por qué: plan_id es un string reusable entre eras de precios. Antes de la
-- migración 2026-08-21 de 4 planes (pro/premium/vip/platinum) a 3
-- (starter/business/premium), "premium" era un plan_id LEGACY a $29.990.
-- Hoy "premium" es el plan nuevo (más alto) a $54.990 -- mismo string,
-- precio distinto. getOrCreateFlowPlan() en server.js cacheaba el
-- flow_plan_id solo por (plan_id, periodicidad): si ya existía una fila para
-- plan_id="premium" con el monto legacy (probable, dado que el checkout
-- Premium/VIP/Platinum procesó clientes reales antes de esta migración,
-- ver commit 46428c1), cualquier upgrade al plan Premium NUEVO reutilizaría
-- en silencio ese Flow plan viejo y prorratearía/cobraría contra $29.990 en
-- vez de $54.990.
--
-- Este fix (server.js: getOrCreateFlowPlan) ahora incluye `monto` en el
-- lookup/upsert y versiona el flowPlanId por monto
-- (`orbyx_${plan_id}_${periodicidad}_${monto}`), así que necesita poder
-- insertar más de una fila por (plan_id, periodicidad) cuando el monto
-- cambia -- de ahí este ajuste de constraint. No borra ni modifica filas
-- existentes: una fila legacy con el monto viejo simplemente deja de
-- matchear el lookup nuevo y una fila nueva se crea la primera vez que se
-- necesite, sin tocar el mapeo histórico (relevante para los 3 tenants
-- legacy con plan pro/vip/platinum aún no migrados, ver CLAUDE.md).

alter table flow_plans drop constraint if exists flow_plans_plan_id_periodicidad_key;

alter table flow_plans add constraint flow_plans_plan_id_periodicidad_monto_key
  unique (plan_id, periodicidad, monto);
