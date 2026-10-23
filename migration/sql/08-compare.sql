-- FIRMA DEL ESQUEMA public (solo lectura). Se corre en el viejo y en el nuevo y se comparan las salidas con diff.
-- Salida determinista y ordenada. Todo lo que difiera hay que explicarlo antes de reabrir el trafico.
\pset pager off
\pset format unaligned
\pset tuples_only on
\pset fieldsep ' | '

\echo ### 1. PERMISOS SOBRE TABLAS (anon / authenticated / service_role)
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type)
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon','authenticated','service_role')
group by 1,2 order by 1,2;

\echo ### 2. PERMISOS SOBRE FUNCIONES (PUBLIC / anon / authenticated / service_role)
select routine_name, grantee, string_agg(privilege_type, ',' order by privilege_type)
from information_schema.routine_privileges
where specific_schema = 'public' and grantee in ('PUBLIC','anon','authenticated','service_role')
group by 1,2 order by 1,2;

\echo ### 3. PERMISOS SOBRE SECUENCIAS
select c.relname, a.grantee::regrole::text, string_agg(a.privilege_type, ',' order by a.privilege_type)
from pg_class c cross join lateral aclexplode(c.relacl) a
where c.relnamespace = 'public'::regnamespace and c.relkind = 'S' and a.grantee <> 0
  and a.grantee::regrole::text in ('anon','authenticated','service_role')
group by 1,2 order by 1,2;

\echo ### 4. PERMISOS SOBRE EL ESQUEMA public
select r, has_schema_privilege(r, 'public', 'USAGE') as usage, has_schema_privilege(r, 'public', 'CREATE') as create_
from unnest(array['anon','authenticated','service_role']) r order by 1;

\echo ### 5. RLS POR TABLA
select c.relname, c.relrowsecurity, c.relforcerowsecurity
from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1;

\echo ### 6. POLITICAS
select tablename, policyname, cmd, roles::text, coalesce(qual,''), coalesce(with_check,'')
from pg_policies where schemaname = 'public' order by 1,2;

\echo ### 7. COLUMNAS
select table_name, column_name, data_type, udt_name, is_nullable, coalesce(column_default,'')
from information_schema.columns where table_schema = 'public' order by 1, column_name;

\echo ### 8. FUNCIONES (md5 de la definicion)
select p.proname, pg_get_function_identity_arguments(p.oid), md5(pg_get_functiondef(p.oid)), p.prosecdef
from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f','p') order by 1,2;

\echo ### 9. TRIGGERS
select c.relname, t.tgname, md5(pg_get_triggerdef(t.oid)), t.tgenabled
from pg_trigger t join pg_class c on c.oid = t.tgrelid
where c.relnamespace = 'public'::regnamespace and not t.tgisinternal order by 1,2;

\echo ### 10. INDICES
select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 1,2;

\echo ### 11. CONSTRAINTS
select c.relname, k.conname, k.contype, pg_get_constraintdef(k.oid)
from pg_constraint k join pg_class c on c.oid = k.conrelid
where c.relnamespace = 'public'::regnamespace order by 1,2;

\echo ### 12. VISTAS
select viewname, md5(definition) from pg_views where schemaname = 'public' order by 1;

\echo ### 13. PUBLICACION REALTIME
select schemaname, tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1,2;

\echo ### 14. EXTENSIONES (nombre)
select extname from pg_extension order by 1;
