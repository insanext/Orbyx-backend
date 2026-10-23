#!/usr/bin/env bash
# Respaldo del proyecto VIEJO (solo lectura) a una carpeta local FUERA del repo.
#
# Uso:  ./02-dump-old.sh --mode full     # ensayo: esquema + datos de public, usuarios de auth
#       ./02-dump-old.sh --mode data     # dia del corte: SOLO datos (el esquema ya esta en el nuevo)
#
# Diferencias con el respaldo diario de GitHub (db-backup.yml):
#  - auth: solo auth.users, auth.identities y auth.mfa_factors. NO incluye auth.schema_migrations
#    ni nada transitorio: eso lo maneja el Auth del proyecto nuevo.
#  - public: se conservan los GRANT (no se usa --no-acl). El REVOKE a anon se asegura aparte
#    (03-prepare-new.sh antes de restaurar y 08-compare-schema.sh despues).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
need_cmd pg_dump "Instala PostgreSQL 17 (Command Line Tools)."
guard_old

MODE=""
for ((i=0;i<${#ARGS[@]};i++)); do [ "${ARGS[$i]}" = "--mode" ] && MODE="${ARGS[$((i+1))]:-}"; done
case "$MODE" in full|data) ;; *) die "Uso: $0 --mode full|data";; esac

PGDUMP_MAJOR="$(pg_dump --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
[ "$PGDUMP_MAJOR" = "17" ] || die "pg_dump $PGDUMP_MAJOR: se necesita EXACTAMENTE 17."

STAMP="$(date -u +%Y%m%d-%H%M%S)"
DEST="$OUT_DIR/dump-$STAMP-$MODE"
say "Respaldo ($MODE) del proyecto VIEJO $OLD_REF -> $DEST"
if [ "$APPLY" != "1" ]; then
  simulacro "pg_dump public ($MODE) -> public$([ "$MODE" = data ] && echo -data).sql"
  simulacro "pg_dump auth.users + auth.identities + auth.mfa_factors (solo datos) -> auth-data.sql"
  simulacro "MANIFIESTO.txt con conteos exactos"
  info "Es solo lectura sobre el viejo. Para ejecutarlo de verdad agrega --apply."
  exit 0
fi

mkdir -p "$DEST"; chmod 700 "$DEST" || true
export PGOPTIONS="-c default_transaction_read_only=on"

if [ "$MODE" = "full" ]; then
  pg_dump "$OLD_DB_URL" --schema=public --no-owner --file="$DEST/public.sql"
  grep -q 'CREATE TABLE public.tenants '      "$DEST/public.sql" || die "public.sql no contiene la tabla tenants"
  grep -q 'CREATE TABLE public.appointments ' "$DEST/public.sql" || die "public.sql no contiene la tabla appointments"
else
  pg_dump "$OLD_DB_URL" --schema=public --data-only --no-owner --file="$DEST/public-data.sql"
  test -s "$DEST/public-data.sql" || die "public-data.sql quedo vacio"
fi
ok "public listo"

pg_dump "$OLD_DB_URL" --data-only --no-owner \
  --table=auth.users --table=auth.identities --table=auth.mfa_factors \
  --file="$DEST/auth-data.sql"
grep -q 'COPY auth.users ' "$DEST/auth-data.sql" || die "auth-data.sql no contiene auth.users"
if grep -q 'schema_migrations' "$DEST/auth-data.sql"; then die "auth-data.sql contiene schema_migrations (no deberia)"; fi
ok "auth listo (users, identities, mfa_factors)"

{
  echo "Respaldo Orbyx ($MODE) - proyecto viejo $OLD_REF"
  echo "Fecha (UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Servidor: $(q_old 'select version()')"
  echo "pg_dump: $(pg_dump --version)"
  echo "auth.users: $(q_old 'select count(*) from auth.users')"
  echo "auth.identities: $(q_old 'select count(*) from auth.identities')"
  echo "auth.mfa_factors: $(q_old 'select count(*) from auth.mfa_factors')"
  echo "tenants: $(q_old 'select count(*) from public.tenants')"
  echo "appointments: $(q_old 'select count(*) from public.appointments')"
} > "$DEST/MANIFIESTO.txt"
cat "$DEST/MANIFIESTO.txt"

echo
warn "Estos archivos NO estan cifrados y tienen datos personales. Borralos con ./99-cleanup.sh al terminar."
ok "Carpeta: $DEST"
