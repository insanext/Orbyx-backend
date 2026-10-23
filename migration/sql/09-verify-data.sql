-- VERIFICACION DE DATOS (solo lectura). Se corre en viejo y nuevo; las salidas deben ser identicas.
-- Variables: old_ref, new_ref (para normalizar las URLs reescritas), checksum ('1' calcula md5 por tabla, '0' solo conteos)
\pset pager off
\pset format unaligned
\pset tuples_only on
\pset fieldsep ' | '
set timezone = 'UTC';
set datestyle = 'ISO, YMD';

\echo ### A. FILAS (exactas) Y MD5 POR TABLA DE public   [las URLs con el ref viejo se normalizan al nuevo en ambos lados]
select tablename,
  (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', tablename), false, true, '')))[1]::text as filas,
  case when :'checksum' = '1' then
    (xpath('/row/h/text()', query_to_xml(
      format('select md5(coalesce(string_agg(replace(t::text, %L, %L), %L order by replace(t::text, %L, %L)), %L)) as h from public.%I t',
             :'old_ref', :'new_ref', '', :'old_ref', :'new_ref', '', tablename), false, true, '')))[1]::text
  else '-' end as md5
from pg_tables where schemaname = 'public' order by 1;

\echo ### B. AUTH
select 'auth.users', count(*), md5(coalesce(string_agg(id::text || coalesce(email,'') || coalesce(encrypted_password,'') || coalesce(raw_user_meta_data::text,''), '' order by id), '')) from auth.users;
select 'auth.identities', count(*), md5(coalesce(string_agg(id::text || user_id::text || provider, '' order by id), '')) from auth.identities;
select 'auth.mfa_factors', count(*), md5(coalesce(string_agg(id::text || user_id::text || factor_type::text || status::text, '' order by id), '')) from auth.mfa_factors;
select 'usuarios_sin_tenant_users(info)', count(*) from auth.users u where not exists (select 1 from public.tenant_users t where t.user_id = u.id);

\echo ### C. SECUENCIAS (ultimo valor)
select sequencename, coalesce(last_value::text, 'null') from pg_sequences where schemaname = 'public' order by 1;

\echo ### D. STORAGE (objetos por bucket; el contenido real se compara con 06-copy-storage.js --verify)
select bucket_id, count(*), coalesce(sum((metadata->>'size')::bigint), 0) from storage.objects group by 1 order by 1;
select id, public, coalesce(file_size_limit::text, '-'), coalesce(allowed_mime_types::text, '-') from storage.buckets order by 1;

\echo ### E. REFERENCIAS CRUZADAS ROTAS (deben ser 0)
select 'tenant_users sin usuario', count(*) from public.tenant_users t where not exists (select 1 from auth.users u where u.id = t.user_id);
select 'tenant_users sin tenant',  count(*) from public.tenant_users t where not exists (select 1 from public.tenants x where x.id = t.tenant_id);
select 'appointments sin tenant',  count(*) from public.appointments a where not exists (select 1 from public.tenants x where x.id = a.tenant_id);
select 'admin_users sin usuario',  count(*) from public.admin_users a where not exists (select 1 from auth.users u where u.id = a.user_id);
