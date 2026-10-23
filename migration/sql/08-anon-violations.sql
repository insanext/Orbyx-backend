-- CRITERIO DE ACEPTACION DE SEGURIDAD (solo lectura). La PRIMERA consulta debe devolver CERO filas en el proyecto nuevo.
-- Variables (las pone 08-compare-schema.sh): forbidden_tables, forbidden_functions, closed_tables (listas separadas por coma)
\pset pager off
\pset format aligned
\pset tuples_only off

\echo === VIOLACIONES (debe salir 0 filas)
select 'TABLA protegida con permisos para anon' as problema, g.table_name::text as objeto, g.privilege_type::text as detalle
from information_schema.role_table_grants g
where g.table_schema = 'public' and g.grantee = 'anon'
  and g.table_name = any (string_to_array(:'forbidden_tables', ','))
union all
select 'FUNCION ejecutable por anon/PUBLIC', p.proname::text, 'EXECUTE'
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname = any (string_to_array(:'forbidden_functions', ','))
  and has_function_privilege('anon', p.oid, 'EXECUTE')
union all
select 'TABLA sin cerrar (debe tener RLS, sin permisos para anon/authenticated y con permisos para service_role)', t,
       'rls=' || coalesce(c.relrowsecurity::text, 'no existe')
         || ' anon=' || coalesce(has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')::text, '-')
         || ' authenticated=' || coalesce(has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')::text, '-')
         || ' service_role_ok=' || coalesce((has_table_privilege('service_role', c.oid, 'SELECT') and has_table_privilege('service_role', c.oid, 'INSERT')
              and has_table_privilege('service_role', c.oid, 'UPDATE') and has_table_privilege('service_role', c.oid, 'DELETE'))::text, '-')
from unnest(string_to_array(:'closed_tables', ',')) as t
left join pg_class c on c.relnamespace = 'public'::regnamespace and c.relname = t and c.relkind = 'r'
where c.oid is null
   or not c.relrowsecurity
   or has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   or has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   or not (has_table_privilege('service_role', c.oid, 'SELECT') and has_table_privilege('service_role', c.oid, 'INSERT')
           and has_table_privilege('service_role', c.oid, 'UPDATE') and has_table_privilege('service_role', c.oid, 'DELETE'))
order by 1, 2;

\echo === (informativo) tablas de public SIN RLS
select c.relname as tabla_sin_rls
from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity order by 1;

\echo === (informativo) tablas de public donde anon tiene ALGUN permiso
select distinct g.table_name as tabla_con_permisos_para_anon
from information_schema.role_table_grants g where g.table_schema = 'public' and g.grantee = 'anon' order by 1;
