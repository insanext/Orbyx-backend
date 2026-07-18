create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  plan_id text not null,
  flow_customer_id text,
  flow_subscription_id text,
  status text not null default 'pending', -- pending | card_registered | active | canceled | error
  periodicidad text not null default 'mensual', -- mensual | semestral | anual
  monto integer,
  consentimiento jsonb, -- { ip, timestamp, user_agent, texto_autorizacion_version }
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_subscriptions_tenant on subscriptions(tenant_id);
