-- =============================================================================
-- Migración: contador simple de visitas a la página pública
-- Fecha: 2026-08-27
-- Propósito: soportar la sección "Estadísticas del negocio" del panel de
--            admin interno (GET /admin/estadisticas) — no existía ningún
--            tracking de analytics en el proyecto (se verificó: sin Google
--            Analytics, sin Vercel Analytics, sin contador propio). Por
--            pedido explícito, esto es un contador simple (un solo total
--            acumulado), no un dashboard de analytics.
--
-- Se incrementa desde GET /public/services/:slug (server.js) — es el único
-- endpoint que se llama exactamente una vez por carga real de la página
-- pública de reservas ([slug]/page.tsx), a diferencia de GET /public/
-- business/:slug que también usan pantallas del dashboard/campañas y
-- contaría tráfico que no es de un visitante público real.
-- =============================================================================

CREATE TABLE IF NOT EXISTS site_visit_counter (
  id smallint PRIMARY KEY DEFAULT 1,
  total bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT single_row CHECK (id = 1)
);

INSERT INTO site_visit_counter (id, total)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

-- Increment atómico (evita el read-then-write no atómico que tendría hacer
-- esto directo desde el cliente Supabase JS con select + update separados —
-- relevante acá porque puede haber cargas concurrentes de la página pública).
CREATE OR REPLACE FUNCTION increment_site_visit_counter()
RETURNS void
LANGUAGE sql
AS $$
  UPDATE site_visit_counter SET total = total + 1, updated_at = now() WHERE id = 1;
$$;

-- -----------------------------------------------------------------------------
-- Notas de implementación
-- -----------------------------------------------------------------------------

-- Sin RLS habilitada a propósito: esta tabla solo la toca el backend con la
-- service_role key (increment fire-and-forget en /public/services/:slug,
-- lectura en GET /admin/estadisticas) — nunca se consulta desde el cliente
-- del frontend con el anon key, así que no aplica el mismo riesgo que
-- tenant_monthly_usage/appointments (ver 2026-08-02-tenant-monthly-usage-rls.sql).

-- Es un total histórico único, no un contador por día/mes — no permite ver
-- tendencia ni comparar períodos. Si más adelante se pide eso, esta tabla
-- necesitaría convertirse en filas por día (site_visits(day date primary
-- key, total int)) — no se construyó así ahora porque el pedido explícito
-- fue "contador simple", no un dashboard de analytics.
