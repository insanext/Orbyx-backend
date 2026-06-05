-- =============================================================================
-- Migración: clinical_notes
-- Fecha: 2026-06-04
-- Propósito: Desacoplar la información clínica veterinaria de la tabla
--            appointments. No modifica ninguna tabla existente.
--            Compatible con pets/pet_followups actuales.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tabla principal
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS clinical_notes (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES tenants(id),
  branch_id          uuid        REFERENCES branches(id),

  -- Paciente: hoy apunta a pets. Cuando se introduzca patients,
  -- este campo se renombra a patient_id sin cambiar nada más.
  pet_id             uuid        NOT NULL REFERENCES pets(id),

  -- Appointment que generó la nota. Nullable: en el futuro
  -- se podrán crear notas sin appointment (notas libres).
  appointment_id     uuid        REFERENCES appointments(id),

  -- Staff que atendió. Nullable para notas históricas migradas.
  staff_id           uuid        REFERENCES staff(id),

  -- Gancho para clinical_records (agrupador de episodios clínicos).
  -- Queda nullable ahora; se activa cuando se introduzca esa tabla.
  record_id          uuid,

  -- Campos clínicos
  date               date        NOT NULL,
  control_type       text,       -- "Consulta", "Vacuna", "Control", "Procedimiento"
  reason             text,       -- motivo de consulta
  diagnosis          text,       -- diagnóstico (campo nuevo, no existía en appointments)
  treatment          text,       -- tratamiento indicado (campo nuevo)
  observations       text,       -- equivale a notes en appointments/close
  next_control_at    timestamptz,
  next_control_label text,       -- "3 meses", "6 meses", etc.

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 2. Índices
-- -----------------------------------------------------------------------------

-- Consultas frecuentes: historial de una mascota por tenant
CREATE INDEX IF NOT EXISTS clinical_notes_tenant_pet
  ON clinical_notes (tenant_id, pet_id, date DESC);

-- Lookup por appointment (upsert en PATCH /clinical)
CREATE INDEX IF NOT EXISTS clinical_notes_appointment
  ON clinical_notes (appointment_id)
  WHERE appointment_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 3. Migración de datos históricos
--    Lee appointments veterinarios existentes (pet_id IS NOT NULL)
--    que tengan al menos reason o notes, y crea una clinical_note por cada uno.
--    Solo hace INSERTs. No toca appointments ni pet_followups.
--    Es idempotente si se agrega la restricción UNIQUE en appointment_id
--    (ver comentario al final).
-- -----------------------------------------------------------------------------

INSERT INTO clinical_notes (
  tenant_id,
  branch_id,
  pet_id,
  appointment_id,
  staff_id,
  date,
  control_type,
  reason,
  observations,
  next_control_at,
  created_at,
  updated_at
)
SELECT
  a.tenant_id,
  a.branch_id,
  a.pet_id,
  a.id           AS appointment_id,
  a.staff_id,
  a.start_at::date AS date,
  -- control_type no existe en appointments; se aproxima con service_name_snapshot
  a.service_name_snapshot AS control_type,
  a.reason,
  a.notes        AS observations,
  a.next_control_at,
  a.created_at,
  COALESCE(a.updated_at, a.created_at) AS updated_at
FROM appointments a
WHERE a.pet_id IS NOT NULL
  AND (a.reason IS NOT NULL OR a.notes IS NOT NULL)
  -- Evita duplicar si la migración se ejecuta más de una vez
  AND NOT EXISTS (
    SELECT 1 FROM clinical_notes cn
    WHERE cn.appointment_id = a.id
  );

-- -----------------------------------------------------------------------------
-- 4. Notas de implementación
-- -----------------------------------------------------------------------------

-- Los campos diagnosis y treatment quedan vacíos en datos históricos porque
-- appointments no los tenía. Se poblarán en nuevas atenciones desde el deploy.

-- El campo record_id queda NULL en todos los registros. Se usará cuando se
-- introduzca la tabla clinical_records para agrupar episodios clínicos.

-- Para hacer la migración idempotente de forma más robusta, se puede agregar:
--   ALTER TABLE clinical_notes
--     ADD CONSTRAINT clinical_notes_appointment_unique
--     UNIQUE (appointment_id);
-- Esto además previene duplicados si PATCH /clinical se llama varias veces
-- sobre el mismo appointment. Activar solo si se confirma que no hay
-- appointments con múltiples notas deseadas (hoy no es el caso).
