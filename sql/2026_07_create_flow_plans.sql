create table if not exists flow_plans (
  id uuid primary key default gen_random_uuid(),
  plan_id text not null, -- 'pro' | 'premium' | 'vip' | 'platinum'
  periodicidad text not null, -- 'mensual' | 'semestral' | 'anual'
  monto integer not null,
  flow_plan_id text, -- lo devuelve Flow al crearlo
  created_at timestamptz default now(),
  unique(plan_id, periodicidad)
);
