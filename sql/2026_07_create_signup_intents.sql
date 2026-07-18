create table if not exists signup_intents (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  business_name text,
  plan_id text not null, -- 'premium' | 'vip' | 'platinum'
  periodicidad text not null, -- 'mensual' | 'semestral' | 'anual'
  monto integer not null,
  flow_customer_id text,
  flow_subscription_id text,
  status text not null default 'started', -- started | paid | tenant_creation_failed | completed | expired
  recovery_token text unique,
  tenant_id uuid references tenants(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_signup_intents_email on signup_intents(email);
create index if not exists idx_signup_intents_token on signup_intents(recovery_token);
