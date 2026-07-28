-- Normaliza business_category = 'generico' (espanol) a 'generic' (ingles).
-- Ejecutar en Supabase SQL Editor.
--
-- Contexto: el wizard de onboarding escribia 'generico' para el grupo
-- "Otro tipo de negocio" mientras el resto del sistema (middleware,
-- login, pagina publica, Business settings) siempre comparo contra
-- 'generic' -- nunca hacian match. El codigo ya se corrigio para
-- escribir 'generic' de aca en adelante (commit b76b54c en orbyx-web);
-- este script solo corrige los tenants que ya quedaron con el valor
-- viejo en espanol.
--
-- Hoy (2026-07-28) son exactamente 2 tenants: prueba-1 y taller-camilo.

-- 1) Revisar ANTES de aplicar nada:
SELECT id, slug, name, business_category, business_subtype
FROM public.tenants
WHERE business_category = 'generico';

-- 2) Aplicar la normalizacion:
UPDATE public.tenants
SET business_category = 'generic'
WHERE business_category = 'generico';

-- 3) Confirmar que no queda ninguno en espanol:
SELECT id, slug, name, business_category
FROM public.tenants
WHERE business_category = 'generico';
-- Debe devolver 0 filas.
