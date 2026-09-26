-- Migration: selección de profesionales/sucursales a mantener en un downgrade programado
-- Ejecutar en Supabase SQL Editor ANTES de desplegar el backend que la usa.
--
-- Cuando un tenant programa un downgrade y tiene más staff/sucursales
-- activas de las que el plan destino permite, elige en /planes cuáles
-- mantener. La selección se guarda acá junto con scheduled_plan_slug y
-- recién se aplica (is_active = false al resto, mismo cambio que hace la
-- desactivación manual de Staff/Sucursales) cuando el cron de
-- applyScheduledPlanChanges ejecuta el downgrade en scheduled_change_at.
-- NULL = no hay selección para ese recurso (no se desactiva nada de él).

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS scheduled_keep_staff_ids uuid[] NULL,
  ADD COLUMN IF NOT EXISTS scheduled_keep_branch_ids uuid[] NULL;
