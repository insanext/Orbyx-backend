-- ============================================================
-- Importador de clientes (Excel / CSV) — 2026-10-12
--
-- Qué agrega:
--   1) customer_imports: registro de cada importación (quién, cuándo,
--      archivo, cantidades) y su estado (completed / undone).
--   2) customers.import_id: de qué importación viene cada cliente creado.
--      customers.imported_last_visit_at / imported_visit_count: historial
--      traído del sistema anterior. La categoría del cliente
--      (getCustomerCategoryMap en server.js) lo suma a las visitas reales
--      de Orbyx: la última visita es la más reciente de ambas y las visitas
--      se suman.
--   3) import_customers_batch(): crea los clientes y completa datos vacíos
--      de los que ya existían en UNA transacción (todo o nada).
--   4) undo_customer_import(): "Deshacer importación" — elimina los clientes
--      creados por ese import_id que aún no tienen citas.
--
-- Es seguro correrlo más de una vez (IF NOT EXISTS / CREATE OR REPLACE).
-- Correr ANTES de desplegar el backend que usa estas columnas.
-- ============================================================

-- 1) Registro de importaciones ---------------------------------
create table if not exists customer_imports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid,
  file_name text,
  file_size_bytes integer,
  total_rows integer not null default 0,
  created_count integer not null default 0,
  updated_count integer not null default 0,
  skipped_count integer not null default 0,
  error_count integer not null default 0,
  duplicate_mode text not null default 'skip' check (duplicate_mode in ('skip', 'fill_empty')),
  status text not null default 'completed' check (status in ('completed', 'undone')),
  terms_accepted_at timestamptz,
  undone_at timestamptz,
  undone_count integer,
  undone_kept_count integer,
  created_at timestamptz not null default now()
);

create index if not exists customer_imports_tenant_created_idx
  on customer_imports (tenant_id, created_at desc);

-- Solo el backend (service role) lee/escribe esta tabla: RLS activado y sin
-- políticas, así ni anon ni usuarios autenticados la ven por la API pública.
alter table customer_imports enable row level security;

-- 2) Columnas nuevas en customers ------------------------------
alter table customers
  add column if not exists import_id uuid references customer_imports(id) on delete set null;
alter table customers
  add column if not exists imported_last_visit_at timestamptz;
alter table customers
  add column if not exists imported_visit_count integer;

create index if not exists customers_import_id_idx
  on customers (import_id)
  where import_id is not null;

-- 3) Importación atómica ---------------------------------------
-- p_new_rows: [{ name, email, phone, rut, birth_date, notes,
--                imported_last_visit_at, imported_visit_count }]
-- p_fills:    [{ id, email?, phone?, rut?, birth_date?, notes?,
--                imported_last_visit_at?, imported_visit_count? }]
--             Solo rellena campos que HOY están vacíos (se revisa dentro de
--             la transacción); nunca sobrescribe datos existentes.
create or replace function import_customers_batch(
  p_tenant_id uuid,
  p_user_id uuid,
  p_file_name text,
  p_file_size integer,
  p_total_rows integer,
  p_skipped_count integer,
  p_error_count integer,
  p_duplicate_mode text,
  p_new_rows jsonb,
  p_fills jsonb
) returns jsonb
language plpgsql
as $$
declare
  v_import_id uuid;
  v_created integer := 0;
  v_updated integer := 0;
  v_fill jsonb;
begin
  insert into customer_imports (
    tenant_id, user_id, file_name, file_size_bytes, total_rows,
    skipped_count, error_count, duplicate_mode, terms_accepted_at
  ) values (
    p_tenant_id, p_user_id, p_file_name, p_file_size, p_total_rows,
    p_skipped_count, p_error_count,
    case when p_duplicate_mode = 'fill_empty' then 'fill_empty' else 'skip' end,
    now()
  ) returning id into v_import_id;

  insert into customers (
    tenant_id, name, email, phone, rut, birth_date, notes,
    imported_last_visit_at, imported_visit_count, import_id,
    total_visits, created_at, updated_at
  )
  select
    p_tenant_id,
    r->>'name',
    nullif(r->>'email', ''),
    nullif(r->>'phone', ''),
    nullif(r->>'rut', ''),
    nullif(r->>'birth_date', '')::date,
    nullif(r->>'notes', ''),
    nullif(r->>'imported_last_visit_at', '')::timestamptz,
    nullif(r->>'imported_visit_count', '')::integer,
    v_import_id,
    0,
    now(),
    now()
  from jsonb_array_elements(coalesce(p_new_rows, '[]'::jsonb)) as r;
  get diagnostics v_created = row_count;

  for v_fill in select * from jsonb_array_elements(coalesce(p_fills, '[]'::jsonb)) loop
    update customers c set
      email = case when (c.email is null or btrim(c.email) = '') and v_fill ? 'email'
                   then v_fill->>'email' else c.email end,
      phone = case when (c.phone is null or btrim(c.phone) = '') and v_fill ? 'phone'
                   then v_fill->>'phone' else c.phone end,
      rut = case when (c.rut is null or btrim(c.rut) = '') and v_fill ? 'rut'
                 then v_fill->>'rut' else c.rut end,
      birth_date = case when c.birth_date is null and v_fill ? 'birth_date'
                        then (v_fill->>'birth_date')::date else c.birth_date end,
      notes = case when (c.notes is null or btrim(c.notes) = '') and v_fill ? 'notes'
                   then v_fill->>'notes' else c.notes end,
      imported_last_visit_at = case when c.imported_last_visit_at is null and v_fill ? 'imported_last_visit_at'
                                    then (v_fill->>'imported_last_visit_at')::timestamptz
                                    else c.imported_last_visit_at end,
      imported_visit_count = case when (c.imported_visit_count is null or c.imported_visit_count = 0)
                                       and v_fill ? 'imported_visit_count'
                                  then (v_fill->>'imported_visit_count')::integer
                                  else c.imported_visit_count end,
      updated_at = now()
    where c.id = (v_fill->>'id')::uuid
      and c.tenant_id = p_tenant_id;

    if found then
      v_updated := v_updated + 1;
    end if;
  end loop;

  update customer_imports
     set created_count = v_created, updated_count = v_updated
   where id = v_import_id;

  return jsonb_build_object('import_id', v_import_id, 'created', v_created, 'updated', v_updated);
end;
$$;

-- 4) Deshacer importación --------------------------------------
-- Elimina los clientes creados por esa importación que todavía no tienen
-- citas (ni ninguna otra ficha que los referencie: si la base de datos
-- impide borrarlos, se conservan). Los clientes a los que solo se les
-- "completaron datos vacíos" NO se tocan: ya existían.
create or replace function undo_customer_import(
  p_tenant_id uuid,
  p_import_id uuid
) returns jsonb
language plpgsql
as $$
declare
  v_status text;
  v_deleted integer := 0;
  v_kept integer := 0;
  v_customer record;
begin
  select status into v_status
    from customer_imports
   where id = p_import_id and tenant_id = p_tenant_id
   for update;

  if v_status is null then
    raise exception 'IMPORT_NOT_FOUND';
  end if;
  if v_status = 'undone' then
    raise exception 'IMPORT_ALREADY_UNDONE';
  end if;

  for v_customer in
    select id from customers
     where import_id = p_import_id and tenant_id = p_tenant_id
  loop
    if exists (select 1 from appointments a where a.customer_id = v_customer.id) then
      v_kept := v_kept + 1;
      continue;
    end if;

    begin
      delete from customers where id = v_customer.id and tenant_id = p_tenant_id;
      v_deleted := v_deleted + 1;
    exception when foreign_key_violation then
      v_kept := v_kept + 1;
    end;
  end loop;

  update customer_imports
     set status = 'undone', undone_at = now(), undone_count = v_deleted, undone_kept_count = v_kept
   where id = p_import_id;

  return jsonb_build_object('deleted', v_deleted, 'kept', v_kept);
end;
$$;

-- Estas funciones reciben tenant_id como parámetro: solo el backend (service
-- role) debe poder ejecutarlas, nunca anon ni usuarios autenticados.
revoke all on function import_customers_batch(uuid, uuid, text, integer, integer, integer, integer, text, jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function undo_customer_import(uuid, uuid)
  from public, anon, authenticated;
grant execute on function import_customers_batch(uuid, uuid, text, integer, integer, integer, integer, text, jsonb, jsonb)
  to service_role;
grant execute on function undo_customer_import(uuid, uuid)
  to service_role;
