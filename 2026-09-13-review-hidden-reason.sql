-- =============================================================================
-- Migración: Motivo visible al ocultar una reseña
-- Fecha: 2026-09-13
-- Propósito: "ocultar una reseña" deja de ser borrar contenido sin dejar
--            rastro — el negocio elige un motivo (Spam / Insultos /
--            Contenido inapropiado) que queda registrado y se muestra en
--            la página pública en vez del contenido de la reseña oculta.
--            La reseña oculta SIGUE contando en el promedio/conteo público
--            (eso se resuelve en server.js, no acá).
-- =============================================================================

ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS hidden_reason text;
  -- NULL mientras status = 'visible'. Cuando status = 'hidden', uno de:
  -- 'Spam' | 'Insultos' | 'Contenido inapropiado' — validado a nivel de
  -- aplicación (server.js, ALLOWED_HIDDEN_REASONS), sin CHECK constraint,
  -- mismo criterio que reviews.reaction (2026-09-13-review-replies-and-reactions.sql).
  -- Se limpia (vuelve a NULL) cuando el negocio vuelve a mostrar la reseña.
