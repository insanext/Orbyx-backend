#!/usr/bin/env bash
# Carga el respaldo en el proyecto NUEVO.
#
# Uso:  ./04-restore-new.sh --mode full [--dir CARPETA]          # ensayo (esquema + datos). Simulacro sin --apply
#       ./04-restore-new.sh --mode data [--dir CARPETA] --apply  # corte: solo datos (despues de 11-reset-new-data.sh)
#
# Orden: primero auth (usuarios), despues public (las tablas de Orbyx apuntan a los usuarios).
# Se usa session_replication_role=replica en la misma sesion (no dispara triggers ni valida FK durante la carga).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
need_cmd psql "Instala PostgreSQL 17 (Command Line Tools)."
guard_new

MODE=""; DIR=""
for ((i=0;i<${#ARGS[@]};i++)); do
  [ "${ARGS[$i]}" = "--mode" ] && MODE="${ARGS[$((i+1))]:-}"
  [ "${ARGS[$i]}" = "--dir" ]  && DIR="${ARGS[$((i+1))]:-}"
done
case "$MODE" in full|data) ;; *) die "Uso: $0 --mode full|data [--dir CARPETA] [--apply]";; esac
[ -n "$DIR" ] || DIR="$(ls -1d "$OUT_DIR"/dump-*-"$MODE" 2>/dev/null | sort | tail -1)"
[ -n "$DIR" ] && [ -d "$DIR" ] || die "No encuentro una carpeta de respaldo '$MODE'. Corre ./02-dump-old.sh --mode $MODE --apply"
PUB="$DIR/public.sql"; [ "$MODE" = "data" ] && PUB="$DIR/public-data.sql"
[ -s "$PUB" ] && [ -s "$DIR/auth-data.sql" ] || die "Faltan archivos en $DIR"
say "Restaurar ($MODE) desde $DIR en el proyecto NUEVO $NEW_REF"
cat "$DIR/MANIFIESTO.txt" 2>/dev/null | sed 's/^/   /'

NEW_TABLES="$(q_new "select count(*) from pg_tables where schemaname='public'")"
NEW_USERS="$(q_new "select count(*) from auth.users")"
if [ "$MODE" = "full" ]; then
  [ "$NEW_TABLES" = "0" ] || die "El nuevo ya tiene $NEW_TABLES tablas en public. El modo full es para un proyecto vacio."
  [ "$NEW_USERS" = "0" ]  || die "El nuevo ya tiene $NEW_USERS usuarios."
else
  [ "$NEW_TABLES" != "0" ] || die "Modo data: el nuevo no tiene esquema. Haz primero el ensayo --mode full."
  [ "$NEW_USERS" = "0" ]  || die "Modo data: auth.users no esta vacio. Corre ./11-reset-new-data.sh --apply primero."
  ROWS="$(q_new "select coalesce(sum((xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', tablename), false, true, '')))[1]::text::bigint),0) from pg_tables where schemaname='public'")"
  [ "$ROWS" = "0" ] || die "Modo data: las tablas de public tienen $ROWS filas. Corre ./11-reset-new-data.sh --apply primero."
fi

if [ "$APPLY" != "1" ]; then
  simulacro "psql NUEVO: set session_replication_role=replica; cargar $DIR/auth-data.sql"
  simulacro "psql NUEVO: set session_replication_role=replica; cargar $PUB"
  info "Para ejecutar de verdad agrega --apply."
  exit 0
fi

confirm_ref "$NEW_REF" "CARGAR datos"
LOG="$DIR/restore-$(date -u +%H%M%S).log"

if [ "$MODE" = "data" ]; then
  # Datos: todo o nada (una transaccion por archivo) y se detiene al primer error.
  psql "$NEW_DB_URL" -X -v ON_ERROR_STOP=1 --single-transaction -c "set session_replication_role = replica" -f "$DIR/auth-data.sql" 2>&1 | tee "$LOG"
  psql "$NEW_DB_URL" -X -v ON_ERROR_STOP=1 --single-transaction -c "set session_replication_role = replica" -f "$PUB"              2>&1 | tee -a "$LOG"
  ok "datos cargados"
else
  # Ensayo completo: algunos objetos ya existen de fabrica ("already exists" es normal).
  psql "$NEW_DB_URL" -X -v ON_ERROR_STOP=0 -c "set session_replication_role = replica" -f "$DIR/auth-data.sql" > "$LOG" 2>&1 || true
  psql "$NEW_DB_URL" -X -v ON_ERROR_STOP=0 -c "set session_replication_role = replica" -f "$PUB"              >> "$LOG" 2>&1 || true
  ERRS="$(grep -E '^psql:.*ERROR' "$LOG" | grep -vE 'already exists|permission denied to change default privileges' || true)"
  EXPECTED="$(grep -cE '^psql:.*ERROR.*already exists' "$LOG" || true)"
  info "errores 'already exists' (normales): $EXPECTED"
  if [ -n "$ERRS" ]; then
    echo "$ERRS" | head -40
    die "Hay errores que NO son 'already exists'. Revisa $LOG antes de seguir (relation does not exist / violates foreign key / permission denied son graves)."
  fi
  ok "restauracion sin errores inesperados (log: $LOG)"
fi
info "Siguiente: ./05-post-restore.sh --apply"
