-- INVENTARIO (solo lectura). Se corre contra el proyecto VIEJO (y opcionalmente el nuevo).
-- Si una consulta da error "schema ... does not exist", significa que esa función no se usa: es lo esperado.
\pset pager off
\echo ===== 1. VERSION / ZONA HORARIA / TAMANO
select version(), current_setting('server_version_num') as version_num, current_setting('TimeZone') as tz,
       pg_size_pretty(pg_database_size(current_database())) as tamano;

\echo ===== 2. EXTENSIONES
select e.extname, e.extversion, n.nspname as esquema from pg_extension e join pg_namespace n on n.oid = e.extnamespace order by 1;

\echo ===== 3. PUBLICACION REALTIME (supabase_realtime)
select schemaname, tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 2;

\echo ===== 4. TRIGGERS EN auth / storage
select event_object_schema, event_object_table, trigger_name, action_timing, event_manipulation, action_statement
from information_schema.triggers where event_object_schema in ('auth','storage') order by 1,2,3;

\echo ===== 5. FUNCIONES PROPIAS FUERA DE public
select n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname not in ('pg_catalog','information_schema','auth','storage','extensions','realtime','graphql',
  'graphql_public','pgsodium','pgsodium_masks','vault','supabase_functions','net','pgbouncer','public','_realtime',
  'supabase_migrations','cron')
order by 1,2;

\echo ===== 6. BUCKETS
select id, name, public, file_size_limit, allowed_mime_types from storage.buckets order by id;

\echo ===== 7. POLITICAS DE STORAGE
select policyname, cmd, roles, qual, with_check from pg_policies where schemaname = 'storage' order by 1;

\echo ===== 8. ARCHIVOS POR BUCKET
select bucket_id, count(*) as archivos, pg_size_pretty(coalesce(sum((metadata->>'size')::bigint),0)) as peso
from storage.objects group by 1 order by 1;

\echo ===== 9a. PERMISOS POR DEFECTO (pg_default_acl)
select defaclrole::regrole as rol, defaclnamespace::regnamespace as esquema, defaclobjtype as tipo, defaclacl from pg_default_acl order by 1,2,3;
\echo ===== 9b. AJUSTES POR ROL / BASE
select * from pg_db_role_setting;

\echo ===== 10. RLS EN public
select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forzado
from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1;

\echo ===== 11a. pg_cron (error = no se usa)
select jobid, schedule, command from cron.job;
\echo ===== 11b. Database Webhooks (error = no se usan)
select * from supabase_functions.hooks;
\echo ===== 11c. Vault (error = no se usa)
select count(*) as secretos from vault.secrets;

\echo ===== 12. AUTH: CONTEOS
select (select count(*) from auth.users) as usuarios,
       (select count(*) from auth.identities) as identidades,
       (select count(*) from auth.mfa_factors) as factores_mfa;

\echo ===== 13. FILAS APROXIMADAS POR TABLA
select relname, n_live_tup from pg_stat_user_tables where schemaname = 'public' order by 2 desc;

\echo ===== 14. TRIGGERS EN public
select event_object_table, trigger_name from information_schema.triggers where trigger_schema = 'public' order by 1,2;

\echo ===== 15. FUNCIONES EN public (security definer marcado)
select p.proname, p.prosecdef as security_definer from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1;
