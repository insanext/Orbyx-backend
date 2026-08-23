-- Diagnosticado 2026-08-23: middleware.ts consulta `subscriptions` con la
-- anon key (sujeta a RLS, corre como el usuario autenticado), mientras que
-- server.js (GET /billing/account-status) y el SQL Editor consultan con
-- service_role (bypassa RLS). Si RLS esta activado en `subscriptions` sin
-- ninguna policy de SELECT para `authenticated`, la consulta del middleware
-- devuelve cero filas (sin error) para CUALQUIER tenant, aunque la
-- suscripcion este realmente activa -- eso hace que `hasActiveSubscription`
-- de siempre false ahi, y el tenant queda bloqueado del dashboard en cuanto
-- su billing_cycle_end pasa. No es un problema especifico de sonex ni de
-- tenants legacy: les toca a todos, uno por uno, el dia que vence su ciclo.
--
-- Mismo patron que la policy ya existente en tenant_monthly_usage: join
-- contra tenant_users por user_id = auth.uid() AND is_active = true.
--
-- Verificar antes de correr esto:
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'subscriptions';
--   SELECT policyname, cmd, qual FROM pg_policies WHERE tablename = 'subscriptions';

alter table subscriptions enable row level security;

create policy "tenant_users_can_read_own_subscriptions"
on subscriptions
for select
using (
  tenant_id in (
    select tenant_id from tenant_users
    where user_id = auth.uid() and is_active = true
  )
);
