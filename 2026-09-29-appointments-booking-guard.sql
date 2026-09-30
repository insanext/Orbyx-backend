-- ============================================================
-- Protección contra reservas simultáneas (auditoría 2026-09-29, I1)
-- ============================================================
-- Problema: POST /appointments/slot revisa disponibilidad y LUEGO inserta,
-- en dos pasos separados. Dos clientes reservando la misma hora casi al
-- mismo tiempo pueden pasar ambos la revisión (doble reserva individual, o
-- sobrecupo en servicios grupales).
--
-- Solución: trigger BEFORE INSERT que, dentro de la misma transacción del
-- insert, toma un candado (pg_advisory_xact_lock) y vuelve a revisar:
--   * Servicio individual con profesional: no puede cruzarse con otra cita
--     'booked' del mismo profesional (mismo criterio que
--     subtractAppointmentsFromWindows en server.js: cualquier cita booked
--     del profesional, rango [start_at, end_at) que ya incluye buffers).
--   * Servicio individual sin profesional: no puede existir otra cita
--     'booked' en la misma sucursal con la misma hora de inicio (mismo
--     criterio que el chequeo actual del backend).
--   * Servicio grupal: la cantidad de reservas de ESE servicio a esa hora
--     (booked/completed/no_show/rescheduled, mismos estados que el backend)
--     no puede superar services.capacity.
-- El candado hace que dos inserts del mismo profesional (o del mismo
-- horario grupal) se ejecuten uno detrás del otro: el segundo ve la cita
-- del primero ya confirmada y es rechazado.
--
-- Por qué trigger y no EXCLUDE constraint:
--   1. Un EXCLUDE falla al crearse si ya hay citas encimadas en prod (las
--      puede haber, justamente por el bug de zona horaria C2), y habría
--      que limpiarlas a mano antes del lanzamiento.
--   2. Un EXCLUDE también se aplica a UPDATE: endpoints del dashboard que
--      cambian estado/hora podrían empezar a fallar con un error no
--      manejado. El trigger solo actúa en INSERT (el único INSERT de
--      citas en todo server.js es POST /appointments/slot).
--   3. Los cupos grupales dependen de services.capacity (otra tabla), que
--      un constraint no puede expresar.
--
-- El error se lanza con SQLSTATE 23P01 (exclusion_violation) y un mensaje
-- identificable; server.js lo traduce a 409 con el mensaje de siempre.
--
-- Aditiva y reversible: DROP TRIGGER appointments_booking_guard_trg ON
-- appointments; DROP FUNCTION appointments_booking_guard();
-- ============================================================

-- Diagnóstico previo (solo lectura, opcional): índices actuales de la tabla.
-- SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'appointments';

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
       and a.status in ('booked', 'completed', 'no_show', 'rescheduled');

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

drop trigger if exists appointments_booking_guard_trg on public.appointments;

create trigger appointments_booking_guard_trg
before insert on public.appointments
for each row
execute function public.appointments_booking_guard();
