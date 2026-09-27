-- 2026-09-27 — Bloqueo/desbloqueo rápido de horarios desde la Agenda.
--
-- No se crea tabla nueva: los bloqueos rápidos se guardan como filas de
-- staff_special_dates (is_closed = true), que es la tabla de excepciones
-- puntuales que YA respeta toda la cadena de disponibilidad
-- (getEffectiveStaffAvailability -> /public/slots, POST /appointments/slot,
-- reserva manual). Así un bloqueo rápido se respeta en la reserva pública
-- y en la validación del backend sin tocar la lógica de disponibilidad.
--
-- Solo se agregan 2 columnas (aditivas, con default) para distinguir el
-- origen del bloqueo:
--   source               'config'      = creada desde Staff > Fechas especiales (todas las filas existentes)
--                        'quick_block' = creada desde el flujo rápido de la Agenda
--   quick_block_group_id agrupa las filas creadas en un mismo bloqueo
--                        (un bloqueo "toda la sucursal" = 1 fila por profesional)
--
-- La Agenda solo ofrece "Desbloquear" para source = 'quick_block', y el
-- endpoint DELETE /agenda/quick-blocks/:id rechaza cualquier otra fila.

alter table public.staff_special_dates
  add column if not exists source text not null default 'config';

alter table public.staff_special_dates
  drop constraint if exists staff_special_dates_source_check;

alter table public.staff_special_dates
  add constraint staff_special_dates_source_check
  check (source in ('config', 'quick_block'));

alter table public.staff_special_dates
  add column if not exists quick_block_group_id uuid;

create index if not exists staff_special_dates_quick_block_group_idx
  on public.staff_special_dates (quick_block_group_id)
  where quick_block_group_id is not null;

-- Verificación (correr después): el flujo inserta varias filas por
-- (staff_id, date) — confirmar que no haya un UNIQUE que lo impida.
-- select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--  where conrelid = 'public.staff_special_dates'::regclass;
