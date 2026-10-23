-- VERIFICACION de las 14 tablas que no tenian RLS y estaban abiertas para anon/authenticated.
-- SOLO LECTURA. Corre igual en el SQL Editor de Supabase (viejo o nuevo) y en psql.
-- Resultado esperado DESPUES del cierre: las 14 filas con estado = CERRADA
-- (rls_activo = true, anon y authenticated sin permisos, service_role con permisos, 0 politicas nuevas).
select t.tabla,
       c.relrowsecurity as rls_activo,
       coalesce(has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), false) as anon_tiene_permisos,
       coalesce(has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), false) as authenticated_tiene_permisos,
       coalesce(has_table_privilege('service_role', c.oid, 'SELECT') and has_table_privilege('service_role', c.oid, 'INSERT')
                and has_table_privilege('service_role', c.oid, 'UPDATE') and has_table_privilege('service_role', c.oid, 'DELETE'), false) as service_role_ok,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = t.tabla) as politicas,
       case
         when c.oid is null then 'NO EXISTE'
         when c.relrowsecurity
              and not has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
              and not has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
              and has_table_privilege('service_role', c.oid, 'SELECT')
              and has_table_privilege('service_role', c.oid, 'INSERT')
              and has_table_privilege('service_role', c.oid, 'UPDATE')
              and has_table_privilege('service_role', c.oid, 'DELETE')
           then 'CERRADA'
         else 'ABIERTA'
       end as estado
from unnest(array[
  'business_special_dates','calendar_tokens','campaign_delivery_logs','campaign_history','campaign_images',
  'clinical_notes','email_change_requests','pet_followups','pet_notes','pet_vaccines',
  'security_audit_log','staff_hours','support_ticket_messages','support_tickets'
]) as t(tabla)
left join pg_class c on c.relnamespace = 'public'::regnamespace and c.relname = t.tabla and c.relkind = 'r'
order by (case when c.oid is not null and c.relrowsecurity then 1 else 0 end), t.tabla;
