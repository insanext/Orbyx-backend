-- Migration: admin_users para panel de administración personal
-- Ejecutar en Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS public.admin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;

-- Deny-all: no policies = ningún rol (anon, authenticated) puede leer/escribir.
-- Solo accesible desde backend con service_role key.

INSERT INTO public.admin_users (user_id, email)
VALUES ('dd60e777-6f45-413b-870b-b0c20ecaab36', 'camilo.merino.m@gmail.com')
ON CONFLICT (user_id) DO NOTHING;
