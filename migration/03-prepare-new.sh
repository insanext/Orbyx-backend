#!/usr/bin/env bash
# Prepara el proyecto NUEVO antes de restaurar: extensiones + permisos por defecto de public.
# Solo para el ensayo completo (modo full). En el corte (modo data) el esquema ya esta listo: no se repite.
# Uso:  ./03-prepare-new.sh            (simulacro)
#       ./03-prepare-new.sh --apply    (escribe en el NUEVO)
set -euo pipefail
. "$(dirname "$0")/lib.sh"
need_cmd psql "Instala PostgreSQL 17 (Command Line Tools)."
guard_new

say "Preparar proyecto NUEVO ($NEW_REF)"
EXT_FILE="$OUT_DIR/old-extensions.sql"
[ -f "$EXT_FILE" ] || die "Falta $EXT_FILE. Corre antes ./00-inventory.sh"

if [ "$APPLY" != "1" ]; then
  simulacro "crear extensiones (si no existen):"; sed 's/^/        /' "$EXT_FILE"
  simulacro "quitar permisos por defecto de public para anon/authenticated/service_role (sql/03-prepare-new.sql)"
  info "Para ejecutar de verdad agrega --apply."
  exit 0
fi

confirm_ref "$NEW_REF" "PREPARAR (extensiones y permisos por defecto)"
psql_new -v ON_ERROR_STOP=1 -f "$EXT_FILE"
psql_new -v ON_ERROR_STOP=1 -f "$MIG_DIR/sql/03-prepare-new.sql"
ok "listo. Siguiente: ./04-restore-new.sh --mode full --apply"
