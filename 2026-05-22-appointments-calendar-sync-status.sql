alter table public.appointments
  add column if not exists calendar_sync_status text not null default 'pending',
  add column if not exists calendar_sync_error text null,
  add column if not exists calendar_synced_at timestamptz null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'appointments_calendar_sync_status_check'
  ) then
    alter table public.appointments
      add constraint appointments_calendar_sync_status_check
      check (calendar_sync_status in ('pending', 'synced', 'error'));
  end if;
end
$$;

update public.appointments
set
  calendar_sync_status = 'synced',
  calendar_sync_error = null,
  calendar_synced_at = coalesce(calendar_synced_at, now())
where event_id is not null;
