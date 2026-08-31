-- ============================================================
-- Borrado completo e irreversible de un tenant (panel Super Admin)
-- ============================================================
-- Contexto: Camilo necesita borrar tenants de prueba completos (y liberar
-- los correos asociados) sin correr SQL manual cada vez. Esta migración
-- agrega:
--   1) admin_tenant_deletions: registro simple de auditoría (qué tenant
--      se borró, cuándo, quién lo hizo desde el panel admin). No existe
--      ninguna tabla de auditoría genérica para acciones de admin hoy
--      (security_audit_log está scopeada a eventos de seguridad de
--      usuario final, no a acciones del panel /admin) — se optó por una
--      tabla nueva y dedicada en vez de reusar esa.
--   2) delete_tenant_cascade(p_tenant_id uuid): función Postgres que
--      borra, en una sola transacción atómica, todas las filas de todas
--      las tablas que referencian a ese tenant. Se eligió una función de
--      base de datos (invocada vía supabase.rpc desde server.js) en vez
--      de una secuencia de deletes desde Node porque son ~35 tablas con
--      foreign keys entre sí — si un delete a mitad de camino fallara
--      (timeout de red, error de la API REST, etc.), un enfoque desde
--      Node dejaría datos huérfanos. Una función plpgsql corre dentro de
--      una única transacción de Postgres: si cualquier DELETE falla, TODO
--      se revierte automáticamente, sin estados intermedios.
--
-- El orden de los DELETE respeta las foreign keys reales, verificadas
-- en vivo contra la base de datos de producción (no asumidas desde las
-- migraciones del repo, que pueden estar desactualizadas respecto a lo
-- realmente aplicado — ver CLAUDE.md "Known Risks" sobre esto). Se
-- confirmó cada FK probando embeds de PostgREST antes de escribir esta
-- función. Relaciones confirmadas que determinan el orden (hijo antes
-- que padre): appointments -> customers/pets/staff/branches,
-- clinical_notes -> appointments/pets/staff, pet_followups ->
-- appointments/customers/pets, pet_notes/pet_vaccines -> pets,
-- staff_services -> staff/services, staff_hours/staff_special_dates ->
-- staff, support_ticket_messages -> support_tickets,
-- campaign_delivery_logs -> campaign_history, business_hours/
-- business_special_dates -> branches, services -> branches,
-- services -> service_groups, pets -> customers, staff -> branches.
-- Algunas relaciones esperadas resultaron NO tener FK real a nivel de
-- base de datos (solo se usan a nivel de aplicación): appointments ->
-- services, calendar_connections -> staff/branches, branch_access ->
-- branches, calendar_tokens -> calendars/branches, tenant_invitations ->
-- branches. Para esas no hay restricción de orden estricta, pero se
-- mantiene un orden razonable de todas formas.
--
-- Tablas con tenant_id incluidas (37 confirmadas en vivo). Se incluyen
-- 5 tablas legacy que hoy están vacías en TODOS los tenants
-- (availability_exceptions, channels, pet_notes, pet_vaccines,
-- working_hours) — probablemente reemplazadas por tablas más nuevas
-- (business_special_dates/staff_special_dates, clinical_notes,
-- business_hours/staff_hours), pero se incluyen por completitud/
-- a prueba de futuro, ya que siguen teniendo la columna tenant_id.
--
-- NO se tocan tablas globales sin tenant_id: admin_users, addon_config,
-- plan_config, flow_plans.
--
-- Storage (buckets) y el usuario de Supabase Auth del owner NO se
-- borran acá — eso lo hace el backend (server.js) antes/después de
-- llamar a esta función, ya que Storage y Auth no son accesibles desde
-- SQL plano vía RPC de PostgREST de la misma forma. Ver server.js,
-- endpoint DELETE /admin/tenants/:id.
-- ============================================================

create table if not exists admin_tenant_deletions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  tenant_name text,
  tenant_slug text,
  deleted_by_admin_user_id uuid,
  deleted_by_admin_email text,
  deleted_at timestamptz not null default now(),
  details jsonb
);

create index if not exists idx_admin_tenant_deletions_tenant_id
  on admin_tenant_deletions (tenant_id);

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

  delete from addon_auto_charge_consents where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('addon_auto_charge_consents', v_rows);

  -- Soporte (support_ticket_messages no tiene tenant_id propio, se
  -- vincula vía ticket_id -> support_tickets.id)
  delete from support_ticket_messages
    where ticket_id in (select id from support_tickets where tenant_id = p_tenant_id);
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('support_ticket_messages', v_rows);

  delete from support_tickets where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('support_tickets', v_rows);

  -- Legal / cuenta
  delete from legal_acceptances where tenant_id = p_tenant_id;
  get diagnostics v_rows = row_count; v_counts := v_counts || jsonb_build_object('legal_acceptances', v_rows);

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
