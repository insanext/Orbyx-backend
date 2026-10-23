-- SOLO EN EMERGENCIA: deshace 13b-cerrar-14-tablas.sql (vuelve a abrir las 14 tablas para anon y authenticated).
-- Usalo unicamente si algo del sistema dejo de funcionar tras el cierre y no hay tiempo de investigar.
-- Dejar estas tablas abiertas es el estado de riesgo original.
do $$
declare t text; s record;
  tablas text[] := array[
    'business_special_dates','calendar_tokens','campaign_delivery_logs','campaign_history','campaign_images',
    'clinical_notes','email_change_requests','pet_followups','pet_notes','pet_vaccines',
    'security_audit_log','staff_hours','support_ticket_messages','support_tickets'
  ];
begin
  foreach t in array tablas loop
    execute format('alter table public.%I disable row level security', t);
    execute format('grant all on table public.%I to anon, authenticated', t);
    for s in
      select seq.relname from pg_class seq
      join pg_depend d on d.objid = seq.oid and d.deptype in ('a', 'i')
      join pg_class tbl on tbl.oid = d.refobjid
      where seq.relkind = 'S' and tbl.relnamespace = 'public'::regnamespace and tbl.relname = t
    loop
      execute format('grant all on sequence public.%I to anon, authenticated', s.relname);
    end loop;
  end loop;
end $$;
