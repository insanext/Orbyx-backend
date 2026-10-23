-- CIERRE de las 14 tablas: activa RLS (sin politicas = anon y authenticated no pueden nada) y quita todos los
-- permisos a anon y authenticated, tambien sobre las secuencias de esas tablas.
-- NO toca service_role ni postgres: el backend usa service_role y sigue funcionando igual (service_role se salta el RLS).
-- Verificado por grep: ni el navegador ni Next usan estas tablas (el frontend solo consulta appointments, branches,
-- staff, subscriptions, tenant_users y tenants; Realtime solo appointments, reviews y tenant_monthly_usage).
-- Es un solo bloque DO: o se aplica todo o nada. Es idempotente (se puede correr dos veces).
do $$
declare
  t text;
  s record;
  tablas text[] := array[
    'business_special_dates','calendar_tokens','campaign_delivery_logs','campaign_history','campaign_images',
    'clinical_notes','email_change_requests','pet_followups','pet_notes','pet_vaccines',
    'security_audit_log','staff_hours','support_ticket_messages','support_tickets'
  ];
begin
  foreach t in array tablas loop
    if to_regclass(format('public.%I', t)) is null then
      raise exception 'La tabla public.% no existe: se cancela todo el cierre', t;
    end if;
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    for s in
      select seq.relname
      from pg_class seq
      join pg_depend d on d.objid = seq.oid and d.deptype in ('a', 'i')
      join pg_class tbl on tbl.oid = d.refobjid
      where seq.relkind = 'S' and tbl.relnamespace = 'public'::regnamespace and tbl.relname = t
    loop
      execute format('revoke all on sequence public.%I from anon, authenticated', s.relname);
    end loop;
    raise notice 'cerrada: public.%', t;
  end loop;
end $$;
