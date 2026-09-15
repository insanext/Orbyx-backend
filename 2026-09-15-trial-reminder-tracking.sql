-- ============================================================
-- Tracking de recordatorio diario de vencimiento de prueba gratis
-- ============================================================
-- Contexto: banner en el dashboard + email diario cuando a un tenant en
-- trial (sin suscripción de pago activa, mismo criterio que trial_active/
-- awaiting_payment en GET /billing/account-status) le quedan 3 días o
-- menos para trial_ends_at (incluye después de vencido, sin tope fijo).
-- last_trial_reminder_sent_at evita reenviar el mismo día si el cron de
-- POST /trial/maintenance/send-reminders corre más de una vez (reinicio
-- del proceso, corrida manual de prueba + corrida real del cron, etc.) --
-- mismo criterio que appointments.wa_recordatorio_enviado, pero acá se
-- necesita la fecha (no un boolean) porque el envío se repite día a día,
-- no una sola vez.
-- ============================================================

alter table tenants add column if not exists last_trial_reminder_sent_at timestamptz;
