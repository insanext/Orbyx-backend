-- =====================================================================
-- Auditoría 2026-09-30 sesión 4, C2: cerrar lectura/escritura anónima
-- en 9 tablas.
--
-- Hallazgo: con solo la anon key pública (la que viaja en el JS del
-- sitio), estas 9 tablas devolvían filas sin login: customers, staff,
-- branches, staff_services, business_hours, staff_special_dates,
-- service_groups, tenant_addons, pets.
--
-- Por qué cerrarlas no rompe nada (revisado tabla por tabla en el código
-- el 2026-09-30):
--   - El frontend (orbyx-web) no consulta ninguna de estas 9 tablas con
--     el cliente del navegador (anon/authenticated). Sus únicas lecturas
--     directas son tenants, tenant_users y subscriptions (middleware.ts,
--     login/page.tsx).
--   - Realtime solo se usa sobre appointments, reviews y
--     tenant_monthly_usage — ninguna de estas 9.
--   - El único acceso a estas tablas desde orbyx-web es
--     app/api/upload-staff-photo (staff), que corre en servidor con la
--     SERVICE ROLE KEY: la service role ignora RLS y no depende de los
--     permisos de anon.
--   - El backend (server.js) usa siempre la service role.
--
-- Cómo correrlo: Supabase Dashboard → SQL Editor. Correr el PASO 1
-- primero (solo lectura) y revisar el resultado antes del PASO 2.
-- =====================================================================


-- ---------------------------------------------------------------------
-- PASO 1 — Diagnóstico (solo lectura, no cambia nada)
-- ---------------------------------------------------------------------

-- 1a. ¿RLS activo? (relrowsecurity = false → RLS apagado)
select c.relname as tabla, c.relrowsecurity as rls_activo, c.relforcerowsecurity as rls_forzado
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('customers','staff','branches','staff_services','business_hours',
                    'staff_special_dates','service_groups','tenant_addons','pets')
order by 1;

-- 1b. Políticas existentes. Ojo con las que tengan roles {public}, {anon}
--     o {authenticated} y qual = 'true': son las que dejan ver todo.
select tablename, policyname, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('customers','staff','branches','staff_services','business_hours',
                    'staff_special_dates','service_groups','tenant_addons','pets')
order by 1, 2;

-- 1c. Permisos de tabla de anon y authenticated (SELECT/INSERT/UPDATE/DELETE...).
select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as permisos
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated')
  and table_name in ('customers','staff','branches','staff_services','business_hours',
                     'staff_special_dates','service_groups','tenant_addons','pets')
group by 1, 2
order by 1, 2;

-- 1d. Totales reales, para comparar con lo que veía anon el 2026-09-30
--     (customers 6, staff 8, branches 4, staff_services 12,
--     business_hours 28, staff_special_dates 5, service_groups 2,
--     tenant_addons 5, pets 1). Si coinciden → RLS estaba apagado.
select 'customers' as tabla, count(*) from public.customers
union all select 'staff', count(*) from public.staff
union all select 'branches', count(*) from public.branches
union all select 'staff_services', count(*) from public.staff_services
union all select 'business_hours', count(*) from public.business_hours
union all select 'staff_special_dates', count(*) from public.staff_special_dates
union all select 'service_groups', count(*) from public.service_groups
union all select 'tenant_addons', count(*) from public.tenant_addons
union all select 'pets', count(*) from public.pets;


-- ---------------------------------------------------------------------
-- PASO 2 — Cierre
-- ---------------------------------------------------------------------
-- Dos barreras independientes:
--   a) RLS activo: sin una política que lo permita, anon y authenticated
--      no ven ni modifican filas.
--   b) REVOKE a anon: sin permiso de tabla, anon queda bloqueado para
--      SELECT/INSERT/UPDATE/DELETE aunque exista (o se cree por error en
--      el futuro) una política permisiva.
-- No se tocan políticas existentes: si el PASO 1b mostró alguna
-- permisiva para {public}/{authenticated}, ver PASO 3.

begin;

alter table public.customers           enable row level security;
alter table public.staff               enable row level security;
alter table public.branches            enable row level security;
alter table public.staff_services      enable row level security;
alter table public.business_hours      enable row level security;
alter table public.staff_special_dates enable row level security;
alter table public.service_groups      enable row level security;
alter table public.tenant_addons       enable row level security;
alter table public.pets                enable row level security;

revoke all on table public.customers           from anon;
revoke all on table public.staff               from anon;
revoke all on table public.branches            from anon;
revoke all on table public.staff_services      from anon;
revoke all on table public.business_hours      from anon;
revoke all on table public.staff_special_dates from anon;
revoke all on table public.service_groups      from anon;
revoke all on table public.tenant_addons       from anon;
revoke all on table public.pets                from anon;

commit;


-- ---------------------------------------------------------------------
-- PASO 3 — Opcional, recomendado: cerrar también a usuarios con sesión
-- ---------------------------------------------------------------------
-- Cualquiera puede crear una cuenta de prueba y obtener un token
-- "authenticated". Si el PASO 1b mostró políticas permisivas para
-- {public} o {authenticated} en estas tablas, esas cuentas siguen
-- viendo datos de TODOS los negocios aunque anon ya esté cerrado.
-- Como el frontend no usa estas tablas con el cliente del navegador,
-- quitar el permiso a authenticated tampoco debería romper nada.
-- Descomentar solo después de revisar el PASO 1b:
--
-- begin;
-- revoke all on table public.customers           from authenticated;
-- revoke all on table public.staff               from authenticated;
-- revoke all on table public.branches            from authenticated;
-- revoke all on table public.staff_services      from authenticated;
-- revoke all on table public.business_hours      from authenticated;
-- revoke all on table public.staff_special_dates from authenticated;
-- revoke all on table public.service_groups      from authenticated;
-- revoke all on table public.tenant_addons       from authenticated;
-- revoke all on table public.pets                from authenticated;
-- commit;


-- ---------------------------------------------------------------------
-- PASO 4 — Verificación (solo lectura)
-- ---------------------------------------------------------------------
-- Repetir 1a (todas rls_activo = true) y 1c (anon ya no debe aparecer).
-- Luego, desde fuera de Supabase, un conteo con la anon key sobre estas
-- 9 tablas debe devolver 0 filas o un error de permiso.
--
-- Nota para el futuro: Supabase otorga por defecto permisos a anon y
-- authenticated sobre cada tabla NUEVA del schema public. Toda tabla
-- nueva debe crearse con RLS activo desde su migración.
