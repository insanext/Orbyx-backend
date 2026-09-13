-- =============================================================================
-- Migración: Link personalizado con token para pedir reseñas
-- Fecha: 2026-09-13
-- Propósito: reemplaza la verificación manual (teléfono/correo tipeado en
--            /{slug}/opinar) por un link único que el negocio ya envía por
--            WhatsApp al mismo cliente — sin fricción. La verificación
--            manual NO se elimina: sigue como fallback cuando alguien entra
--            a /opinar sin token (ej. comparte el link genérico).
-- =============================================================================

CREATE TABLE IF NOT EXISTS review_request_tokens (
  token text PRIMARY KEY,
  -- Generado con crypto.randomBytes(24).toString("hex") — no adivinable,
  -- no incremental. No expira en v1 (no hace falta más sofisticación).
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, customer_id)
  -- Un token por cliente por negocio: "Pedir reseña" reutiliza el mismo
  -- token en vez de crear uno nuevo cada vez (ver POST /reviews/:slug/request-link
  -- en server.js), así el link que ya se compartió sigue funcionando.
);

CREATE INDEX IF NOT EXISTS review_request_tokens_tenant_customer
  ON review_request_tokens (tenant_id, customer_id);

-- Defensa en profundidad, mismo patrón que reviews (ver 2026-09-12-reviews.sql)
-- — el acceso real siempre pasa por server.js con la service_role key.
ALTER TABLE review_request_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "review_request_tokens_tenant_members_select" ON review_request_tokens;
CREATE POLICY "review_request_tokens_tenant_members_select" ON review_request_tokens
  FOR SELECT TO authenticated
  USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid() AND is_active = true
    )
  );
