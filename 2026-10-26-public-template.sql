-- =============================================================================
-- Migración: tenants.public_template
-- Fecha: 2026-10-26
-- Propósito: guardar qué "plantilla" visual usa la página pública de reservas
--            de cada negocio (/{slug}). 'clasica' es la página de siempre.
-- Seguro: solo agrega una columna con default 'clasica', así que ningún
--         negocio existente cambia de aspecto.
-- Sin CHECK a propósito: los ids válidos se validan en el backend
-- (PUBLIC_TEMPLATE_IDS en server.js), para poder agregar plantillas nuevas
-- sin tocar la base de datos.
-- El backend tolera que esta migración todavía no esté aplicada: la página
-- pública sigue funcionando (con la plantilla clásica) y el selector del
-- dashboard avisa que falta la migración.
-- =============================================================================

alter table public.tenants
  add column if not exists public_template text not null default 'clasica';
