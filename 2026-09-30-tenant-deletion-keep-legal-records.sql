-- ============================================================
-- 2026-09-30 — Borrado de tenant: conservar evidencia legal
-- (auditoría sesión 3, C4b) + tablas de reseñas que faltaban (I16)
-- ============================================================
-- ANTES DE CORRER (solo lectura, en el SQL Editor):
--   select pg_get_functiondef('delete_tenant_cascade'::regproc);
-- Esta migración reemplaza la función con la versión del repo
-- (2026-08-30-admin-tenant-deletion.sql) + los cambios de abajo. Si la
-- versión que devuelve esa consulta tiene tablas que NO están acá (alguien
-- la editó directo en Supabase), agrégalas a esta migración antes de
-- correrla, o se volverían a omitir.
--
-- Cambios:
--   1) legal_acceptances y addon_auto_charge_consents ya no se borran al
--      borrar un tenant: son la prueba de la aceptación de los Términos
--      (Ley 19.496 art. 12 A) y del consentimiento de cobro automático.
--      Para poder conservarlas sin el tenant, se eliminan sus foreign keys
--      hacia tenants y auth.users (tenant_id/user_id quedan como uuid de
--      referencia histórica). Nada en server.js hace embeds por esas FK.
--   2) Se borran reviews, review_replies y review_request_tokens ANTES de
--      customers: reviews.customer_id y review_request_tokens.customer_id
--      apuntan a customers sin on delete cascade (verificado en vivo vía
--      OpenAPI de PostgREST 2026-09-30), así que el borrado de un tenant
--      con reseñas fallaba.
--   addon_purchase_intents y marketing_email_preferences tienen
--   on delete cascade hacia tenants (ver sus migraciones): se borran solos.
--
-- Idempotente: se puede correr más de una vez.
-- ============================================================

do $$
declare
  c record;
begin
  for c in
    select con.conname, rel.relname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname in ('legal_acceptances', 'addon_auto_charge_consents')
       and con.contype = 'f'
       and con.confrelid in ('public.tenants'::regclass, 'auth.users'::regclass)
  loop
    execute format('alter table public.%I drop constraint %I', c.relname, c.conname);
  end loop;
end $$;

create or replace function delete_tenant_cascade(p_tenant_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_counts jsonb := '{}'::jsonb;
  v_rows int;
begin
  if not exists (select 1 from tenants where id = p_tenant_id) then
    raise exception 'Tenant % no existe', p_tenant_id;
  end if;

  -- Campañas
  delete from campaign_delivery_logs where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('campaign_delivery_logs', v_rows);

  delete from campaign_history where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('campaign_history', v_rows);

  delete from campaign_images where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('campaign_images', v_rows);

  -- WhatsApp
  delete from whatsapp_message_log where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('whatsapp_message_log', v_rows);

  -- Clínico / fichas (referencian appointments, pets, staff)
  delete from clinical_notes where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('clinical_notes', v_rows);

  delete from pet_followups where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('pet_followups', v_rows);

  delete from pet_notes where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('pet_notes', v_rows);

  delete from pet_vaccines where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('pet_vaccines', v_rows);

  -- Reservas
  delete from appointments where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('appointments', v_rows);

  -- Calendario
  delete from calendar_connections where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('calendar_connections', v_rows);

  -- Staff (y sus tablas hijas)
  delete from staff_services where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('staff_services', v_rows);

  delete from staff_hours where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('staff_hours', v_rows);

  delete from staff_special_dates where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('staff_special_dates', v_rows);

  delete from staff where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('staff', v_rows);

  -- Reseñas (2026-09-12/13): review_replies -> reviews; reviews y
  -- review_request_tokens -> customers y tenants, sin on delete cascade.
  -- Faltaban en la versión 2026-08-30: borrar un tenant con reseñas fallaba.
  delete from review_replies where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('review_replies', v_rows);

  delete from reviews where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('reviews', v_rows);

  delete from review_request_tokens where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('review_request_tokens', v_rows);

  -- Pacientes / clientes
  delete from pets where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('pets', v_rows);

  delete from customers where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('customers', v_rows);

  -- Legacy (hoy vacías en todos los tenants, se incluyen por completitud)
  delete from availability_exceptions where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('availability_exceptions', v_rows);

  delete from working_hours where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('working_hours', v_rows);

  -- Horarios de negocio
  delete from business_hours where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('business_hours', v_rows);

  delete from business_special_dates where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('business_special_dates', v_rows);

  -- Accesos y sucursales
  delete from branch_access where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('branch_access', v_rows);

  delete from calendar_tokens where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('calendar_tokens', v_rows);

  delete from calendars where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('calendars', v_rows);

  -- Servicios (services referencia service_groups, por eso van en ese orden)
  delete from services where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('services', v_rows);

  delete from service_groups where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('service_groups', v_rows);

  delete from branches where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('branches', v_rows);

  -- Plan / facturación / add-ons
  delete from tenant_addons where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('tenant_addons', v_rows);

  delete from tenant_monthly_usage where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('tenant_monthly_usage', v_rows);

  delete from subscriptions where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('subscriptions', v_rows);


  -- Soporte (support_ticket_messages no tiene tenant_id propio, se
  -- vincula vía ticket_id -> support_tickets.id)
  delete from support_ticket_messages
    where ticket_id in (select id from support_tickets where tenant_id = p_tenant_id);
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('support_ticket_messages', v_rows);

  delete from support_tickets where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('support_tickets', v_rows);

  -- Cuenta (legal_acceptances y addon_auto_charge_consents se CONSERVAN,
  -- ver cabecera de 2026-09-30-tenant-deletion-keep-legal-records.sql)

  delete from email_change_requests where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('email_change_requests', v_rows);

  delete from tenant_invitations where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('tenant_invitations', v_rows);

  delete from signup_intents where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('signup_intents', v_rows);

  -- Auditoría / legacy
  delete from security_audit_log where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('security_audit_log', v_rows);

  delete from channels where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('channels', v_rows);

  -- Membresía
  delete from tenant_users where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('tenant_users', v_rows);

  -- El tenant en sí, al final
  delete from tenants where id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('tenants', v_rows);

  return v_counts;
end;
$$;
