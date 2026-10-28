-- ============================================================
-- Sobrecupo controlado desde el panel (2026-10-28)
-- ============================================================
-- El negocio puede agendar una cita ENCIMA de otra del mismo profesional,
-- solo desde el panel (POST /appointments/slot autenticado, con
-- forzar_sobrecupo = true). La página pública sigue rechazando cruces:
-- las citas con sobrecupo = true se descuentan de la disponibilidad pública
-- igual que cualquier otra cita 'booked' (subtractAppointmentsFromWindows no
-- las excluye).
--
-- Qué hace esta migración (idempotente, se puede correr varias veces):
--   1. appointments.sobrecupo boolean not null default false (trazabilidad).
--   2. Si existe un índice único (no constraint) sobre appointments que incluya
--      start_at (p. ej. appointments_unique_slot), lo recrea excluyendo las filas
--      con sobrecupo = true. Si es una CONSTRAINT única, no se puede acotar con
--      un predicado: se avisa con un WARNING para resolverla a mano.
--   3. appointments_booking_guard(): parte de la versión de
--      2026-09-29-booking-guard-rescheduled.sql, mantiene los candados
--      (pg_advisory_xact_lock) y se salta SOLO la validación de cruce del
--      profesional / mismo inicio cuando NEW.sobrecupo = true. Una inserción con
--      sobrecupo = false sigue rechazando cruces contra cualquier cita 'booked',
--      incluidas las de sobrecupo. La rama de servicios grupales no cambia.
--
-- El trigger NO valida horario de atención (solo cruces y cupos grupales): agendar
-- fuera de horario no necesita ningún cambio en la base de datos.
--
-- ANTES de correrla, compara con producción (el repo no es inventario fiable):
--   select pg_get_functiondef('public.appointments_booking_guard'::regproc);
--   select indexname, indexdef from pg_indexes where tablename = 'appointments';
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.appointments'::regclass;
--
-- Reversible:
--   alter table public.appointments drop column sobrecupo;  -- (antes, volver a
--   correr la función de 2026-09-29-booking-guard-rescheduled.sql)
-- ============================================================

-- 1) Columna ---------------------------------------------------
alter table public.appointments
  add column if not exists sobrecupo boolean not null default false;

-- 2) Índices únicos que bloqueen el mismo start_at ---------------
do $$
declare
  r record;
begin
  for r in
    select i.indexrelid::regclass::text as idx_name,
           pg_get_indexdef(i.indexrelid) as idx_def,
           exists (
             select 1 from pg_constraint c
              where c.conindid = i.indexrelid and c.contype in ('u', 'x')
           ) as is_constraint
      from pg_index i
     where i.indrelid = 'public.appointments'::regclass
       and i.indisunique
       and not i.indisprimary
       and pg_get_indexdef(i.indexrelid) ilike '%start_at%'
       and pg_get_indexdef(i.indexrelid) not ilike '%sobrecupo%'
  loop
    if r.is_constraint then
      raise warning 'La constraint única % incluye start_at y no admite predicado: revisar a mano para excluir sobrecupo = true (%).',
        r.idx_name, r.idx_def;
      continue;
    end if;

    execute 'drop index ' || r.idx_name;

    if r.idx_def ~* ' where ' then
      -- ya era un índice parcial: se agrega la exclusión al predicado existente
      execute r.idx_def || ' and (not sobrecupo)';
    else
      execute r.idx_def || ' where (not sobrecupo)';
    end if;

    raise notice 'Índice único % recreado excluyendo sobrecupo = true.', r.idx_name;
  end loop;
end
$$;

-- 3) Trigger de reserva ---------------------------------------
create or replace function public.appointments_booking_guard()
returns trigger
language plpgsql
as $$
declare
  v_is_group boolean := false;
  v_capacity integer := 1;
  v_count integer;
begin
  if new.status is distinct from 'booked' then
    return new;
  end if;

  if new.service_id is not null then
    select coalesce(s.is_group, false), coalesce(s.capacity, 1)
      into v_is_group, v_capacity
      from public.services s
     where s.id = new.service_id;
  end if;

  -- Servicio grupal: sin cambios (los cupos nunca se exceden, tampoco con sobrecupo).
  if v_is_group then
    perform pg_advisory_xact_lock(
      hashtextextended('appt-group:' || new.tenant_id::text || ':' || new.service_id::text || ':' || new.start_at::text, 0)
    );

    select count(*) into v_count
      from public.appointments a
     where a.tenant_id = new.tenant_id
       and a.branch_id is not distinct from new.branch_id
       and a.service_id = new.service_id
       and a.start_at = new.start_at
       and (new.staff_id is null or a.staff_id = new.staff_id)
       and a.status in ('booked', 'completed', 'no_show');

    if v_count >= greatest(v_capacity, 1) then
      raise exception 'appointment_group_full' using errcode = '23P01';
    end if;

    return new;
  end if;

  -- Servicio individual. El candado se toma SIEMPRE (también con sobrecupo)
  -- para que un sobrecupo y una reserva normal del mismo profesional se
  -- serialicen; solo la validación de cruce se omite con sobrecupo = true.
  if new.staff_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('appt-staff:' || new.staff_id::text, 0));

    if not coalesce(new.sobrecupo, false) and exists (
      select 1
        from public.appointments a
       where a.staff_id = new.staff_id
         and a.status = 'booked'
         and a.start_at < new.end_at
         and a.end_at > new.start_at
    ) then
      raise exception 'appointment_slot_taken' using errcode = '23P01';
    end if;
  else
    perform pg_advisory_xact_lock(
      hashtextextended('appt-nostaff:' || coalesce(new.branch_id::text, new.tenant_id::text) || ':' || new.start_at::text, 0)
    );

    if not coalesce(new.sobrecupo, false) and exists (
      select 1
        from public.appointments a
       where a.tenant_id = new.tenant_id
         and a.branch_id is not distinct from new.branch_id
         and a.start_at = new.start_at
         and a.status = 'booked'
    ) then
      raise exception 'appointment_slot_taken' using errcode = '23P01';
    end if;
  end if;

  return new;
end;
$$;

-- El trigger ya apunta a la función (2026-09-29-appointments-booking-guard.sql);
-- se recrea igual para que esta migración sea autosuficiente.
drop trigger if exists appointments_booking_guard_trg on public.appointments;

create trigger appointments_booking_guard_trg
before insert on public.appointments
for each row
execute function public.appointments_booking_guard();
