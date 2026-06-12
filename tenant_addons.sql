-- Migración: tabla de add-ons contratados por tenant
-- Ejecutar en Supabase SQL editor (Dashboard → SQL Editor → New query → Run)
-- Catálogo y reglas de disponibilidad: ADDON_CATALOG en server.js

CREATE TABLE IF NOT EXISTS tenant_addons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  addon_key text NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'canceled')),
  billing_cycle text NOT NULL DEFAULT 'mensual',
  activated_at timestamptz NOT NULL DEFAULT now(),
  canceled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Índices
CREATE INDEX IF NOT EXISTS tenant_addons_tenant_id_idx ON tenant_addons(tenant_id);
CREATE INDEX IF NOT EXISTS tenant_addons_status_idx ON tenant_addons(status);

-- Un tenant no puede tener el mismo addon duplicado activo
CREATE UNIQUE INDEX IF NOT EXISTS tenant_addons_unique_active
  ON tenant_addons(tenant_id, addon_key)
  WHERE status = 'active';
