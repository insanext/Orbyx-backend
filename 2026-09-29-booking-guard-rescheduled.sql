-- ============================================================
-- "Reagendó" libera el cupo en servicios grupales (auditoría 2026-09-29,
-- sesión 2, I4)
-- ============================================================
-- Antes, el conteo de cupos grupales incluía 'rescheduled': si el negocio
-- marcaba a un asistente como "Reagendó" (se movió a otra clase), su cupo
-- seguía ocupado y no se podía volver a ofrecer. Ahora solo cuentan
-- booked/completed/no_show — mismo criterio que server.js en
-- POST /appointments/slot y GET /public/slots (cambiados en la misma ronda).
--
-- Solo reemplaza la función; el trigger appointments_booking_guard_trg
-- (creado en 2026-09-29-appointments-booking-guard.sql) sigue apuntando a
-- ella y no hay que recrearlo. Correr DESPUÉS de esa migración.
--
-- Reversible: volver a correr la función de
-- 2026-09-29-appointments-booking-guard.sql.
-- ============================================================

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

  if new.staff_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('appt-staff:' || new.staff_id::text, 0));

    if exists (
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

    if exists (
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
