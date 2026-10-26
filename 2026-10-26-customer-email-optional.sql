-- Email opcional en clientes y citas (2026-10-26).
--
-- Motivo: el negocio crea citas desde el dashboard para clientes migrados de
-- otro sistema que no tienen email. El backend ahora guarda NULL (nunca '')
-- cuando no hay email; la reserva pública sigue exigiéndolo (validado en
-- server.js, no en la BD).
--
-- Es idempotente: se puede correr más de una vez sin efecto extra.
-- El DDL base de `customers` / `appointments` no está en el repo, por eso cada
-- paso mira primero el estado real de la columna.
--
-- Sobre unicidad: en Postgres un índice/constraint UNIQUE trata los NULL como
-- distintos, así que varios clientes del mismo tenant con email NULL conviven
-- sin problema en un UNIQUE (tenant_id, email) o UNIQUE (tenant_id, lower(email)).
-- Lo que SÍ chocaría son dos filas con email '' (cadena vacía): por eso el paso
-- 2 normaliza '' → NULL. Esta migración no borra ningún índice único.

-- 1) Quitar NOT NULL si existe.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'customers'
      and column_name = 'email' and is_nullable = 'NO'
  ) then
    alter table public.customers alter column email drop not null;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'appointments'
      and column_name = 'customer_email' and is_nullable = 'NO'
  ) then
    alter table public.appointments alter column customer_email drop not null;
  end if;
end $$;

-- 2) Normalizar emails vacíos ('' o solo espacios) a NULL.
update public.customers
   set email = null
 where email is not null and btrim(email) = '';

update public.appointments
   set customer_email = null
 where customer_email is not null and btrim(customer_email) = '';

-- 3) Diagnóstico (solo lectura): índices únicos y CHECK que mencionen el email
--    en estas dos tablas. Esperado: ningún CHECK que prohíba NULL/vacío, y los
--    UNIQUE (si los hay) sin condición que trate NULL como igual.
select 'unique_or_index' as kind, tablename as tbl, indexname as name, indexdef as definition
  from pg_indexes
 where schemaname = 'public'
   and tablename in ('customers', 'appointments')
   and indexdef ilike '%email%'
union all
select 'constraint', conrelid::regclass::text, conname, pg_get_constraintdef(oid)
  from pg_constraint
 where conrelid in ('public.customers'::regclass, 'public.appointments'::regclass)
   and pg_get_constraintdef(oid) ilike '%email%';
