-- Dirección completa: calle + comuna + región (2026-10-02)
--
-- Contexto: hoy la dirección es texto libre ("Gacitúa 77") y el mapa/los
-- mensajes al cliente no aclaran en qué comuna/región está. Región y
-- comuna pasan a ser selectores fijos (lista oficial de Chile) y se guardan
-- como columnas aparte, para armar "Gacitúa 77, Concepción, Región del
-- Biobío" en WhatsApp, email, página pública y mapa.
--
--   * tenants.commune / tenants.region: NUEVAS. Es la dirección del negocio,
--     que la sucursal hereda mientras branches.use_global_contact = true.
--   * branches.region: NUEVA.
--   * branches.commune: ya existía (migración 2026-05-28, texto libre) y se
--     REUTILIZA para la comuna — no se crea otra columna. branches.city
--     queda sin cambios y sin uso (ya no hay input para ella).
--
-- Los valores guardados son los nombres tal cual de lib/chile-regions.ts
-- en orbyx-web (p. ej. region = 'Región del Biobío', commune = 'Concepción').
-- No se intenta inferir comuna/región desde el texto libre viejo: las filas
-- existentes quedan en NULL y se completan a mano desde el dashboard.
--
-- ORDEN DE DEPLOY: correr este SQL ANTES de desplegar el backend. El backend
-- nuevo pide estas columnas en varios SELECT (página pública, mapa, GET
-- /branches...); si no existen, esos endpoints devuelven error.

alter table public.tenants
  add column if not exists commune text,
  add column if not exists region text;

alter table public.branches
  add column if not exists commune text,
  add column if not exists region text;

-- ------------------------------------------------------------------
-- (Opcional, solo lectura) Antes de cargar región/comuna a mano: sucursales
-- que heredan el contacto del negocio (use_global_contact = true) pero que
-- tienen una calle propia guardada de antes. Con el cambio, el sistema usa
-- la dirección del NEGOCIO para ellas (así lo hace el dashboard desde
-- siempre); si alguna de estas calles era la "buena", pasar la sucursal a
-- contacto propio.
-- ------------------------------------------------------------------
-- select b.id, b.tenant_id, b.name, b.address as calle_sucursal, t.address as calle_negocio
--   from public.branches b
--   join public.tenants t on t.id = b.tenant_id
--  where coalesce(b.use_global_contact, true) = true
--    and nullif(trim(coalesce(b.address, '')), '') is not null
--    and nullif(trim(coalesce(t.address, '')), '') is distinct from nullif(trim(b.address), '');
