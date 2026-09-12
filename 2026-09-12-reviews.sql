-- =============================================================================
-- Migración: Sistema de reseñas/calificaciones
-- Fecha: 2026-09-12
-- Propósito: reseñas públicas verificadas (solo clientes con al menos una
--            cita completed en el tenant), con pregunta de mejora privada
--            para calificaciones bajas (<=3) y moderación desde el dashboard.
--            Incluido en los 3 planes (Starter/Business/Premium) — sin gating.
-- =============================================================================

CREATE TABLE IF NOT EXISTS reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  client_identifier text NOT NULL,
  -- Teléfono (+56...) o correo, ya normalizado, usado para verificar la
  -- elegibilidad al momento de dejar/actualizar la reseña.
  client_name text,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text,
  -- Comentario público, opcional, máx. ~300 caracteres (validado en server.js).
  private_feedback text,
  -- Solo se completa cuando rating <= 3 ("¿en qué podemos mejorar?").
  -- Privado: NUNCA se devuelve en ningún endpoint público — ver server.js.
  status text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden')),
  -- 'hidden' = el negocio la ocultó por moderación (abuso/spam/spam
  -- publicitario/contenido ofensivo) desde el dashboard. NO existe
  -- aprobación previa: toda reseña nace 'visible' — ocultar es la única
  -- acción de moderación disponible, y es posterior a la publicación.
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, customer_id)
  -- Un cliente = una reseña por negocio (v1, sin lógica más sofisticada).
  -- Reenviar una reseña para el mismo tenant hace upsert sobre esta fila
  -- (ver POST /public/reviews/:slug en server.js). Ese upsert NO incluye
  -- `status` en su payload a propósito: si el negocio ya había ocultado la
  -- reseña por moderación, un reenvío del cliente (nuevo rating/comentario)
  -- no debe reactivarla automáticamente a 'visible'.
);

CREATE INDEX IF NOT EXISTS reviews_tenant_status ON reviews (tenant_id, status);

-- Defensa en profundidad: todo el acceso real hoy pasa por server.js con la
-- service_role key (que ignora RLS). Esta policy solo protege si algún día
-- se lee esta tabla directo desde el browser con el anon key — mismo patrón
-- ya establecido en 2026-08-02-tenant-monthly-usage-rls.sql.
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reviews_tenant_members_select" ON reviews;
CREATE POLICY "reviews_tenant_members_select" ON reviews
  FOR SELECT TO authenticated
  USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid() AND is_active = true
    )
  );
