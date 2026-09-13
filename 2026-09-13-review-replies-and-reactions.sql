-- =============================================================================
-- Migración: Respuestas del negocio + reacciones en reseñas
-- Fecha: 2026-09-13
-- Propósito: el negocio puede responder públicamente a una reseña (hilo
--            unidireccional, solo el negocio escribe) y reaccionar con un
--            emoji fijo. Ambas son públicas, se muestran junto a la reseña
--            en orbyx.cl/{slug} — nunca se mezclan con private_feedback.
-- =============================================================================

ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS reaction text;
  -- Uno de: '👍' | '❤️' | '🙏' | '😊', o NULL si no hay reacción. Validado a
  -- nivel de aplicación (server.js, ALLOWED_REVIEW_REACTIONS) contra un set
  -- fijo — sin CHECK constraint para no tener que migrar si el set cambia.

CREATE TABLE IF NOT EXISTS review_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL REFERENCES reviews(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  message text NOT NULL,
  -- Público, máx. ~500 caracteres (validado en server.js). Siempre
  -- atribuido al negocio — no hay campo de autor porque no hace falta: el
  -- cliente nunca puede escribir en este hilo (unidireccional).
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS review_replies_review_id ON review_replies (review_id, created_at);
CREATE INDEX IF NOT EXISTS review_replies_tenant_id ON review_replies (tenant_id);

-- Mismo patrón de RLS defensiva que reviews (ver 2026-09-12-reviews.sql) —
-- el acceso real siempre pasa por server.js con la service_role key.
ALTER TABLE review_replies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "review_replies_tenant_members_select" ON review_replies;
CREATE POLICY "review_replies_tenant_members_select" ON review_replies
  FOR SELECT TO authenticated
  USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid() AND is_active = true
    )
  );

-- -----------------------------------------------------------------------------
-- Realtime: nueva reseña -> notificación en la campanita del dashboard.
-- Reutiliza el mismo canal/patrón que ya escucha INSERT en `appointments`
-- (dashboard/[slug]/layout.tsx) — no se inventa un mecanismo de
-- notificaciones aparte. `reviews` ya tiene RLS con policy tenant-scoped
-- desde 2026-09-12-reviews.sql; falta agregarla a la publicación de
-- Realtime, sin lo cual postgres_changes no emite eventos para esta tabla
-- en absoluto (con o sin RLS) — mismo paso que
-- 2026-08-02-tenant-monthly-usage-rls.sql hizo para esa tabla.
-- -----------------------------------------------------------------------------

-- NOTA: si `reviews` ya está en la publicación, este comando falla con
-- "relation is already member of publication" — no es un problema, seguir.
ALTER PUBLICATION supabase_realtime ADD TABLE public.reviews;
