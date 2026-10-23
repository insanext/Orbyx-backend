#!/usr/bin/env bash
# VACIA LOS DATOS del proyecto NUEVO (no toca el esquema, permisos ni politicas), para repetir la carga el dia del corte.
# Borra: todas las filas de las tablas de public, los usuarios de auth (auth.users en cascada) (los archivos de Storage no se tocan).
# NUNCA se puede apuntar al proyecto viejo (guard_new lo impide).
#
# Uso:  ./11-reset-new-data.sh              (simulacro: muestra que borraria)
#       ./11-reset-new-data.sh --apply      (borra de verdad, pide escribir el ref del NUEVO)
set -euo pipefail
. "$(dirname "$0")/lib.sh"
need_cmd psql "Instala PostgreSQL 17 (Command Line Tools)."
guard_new
say "Reset de DATOS del proyecto NUEVO ($NEW_REF)"

psql_new -c "select tablename from pg_tables where schemaname='public' order by 1" -At | tr '\n' ' ' | fold -s -w 100 | sed 's/^/   /'
echo
info "usuarios en auth.users: $(q_new 'select count(*) from auth.users')"
if [ "$APPLY" != "1" ]; then
  simulacro "TRUNCATE de todas las tablas de public (RESTART IDENTITY CASCADE) + DELETE FROM auth.users (en cascada)"
  info "Los archivos de Storage NO se borran (06-copy-storage.js es idempotente y sobreescribe)."
  info "Para ejecutar de verdad agrega --apply."
  exit 0
fi

confirm_ref "$NEW_REF" "BORRAR TODOS LOS DATOS"
psql_new -v ON_ERROR_STOP=1 <<'SQL'
set session_replication_role = replica;
do $$
declare t text;
begin
  for t in select format('%I.%I', schemaname, tablename) from pg_tables where schemaname = 'public' loop
    execute 'truncate table ' || t || ' restart identity cascade';
  end loop;
end $$;
-- Con replica los ON DELETE CASCADE no corren: se vuelve al modo normal para que se borren identities, sesiones y factores.
reset session_replication_role;
delete from auth.users;
SQL
ok "datos borrados. usuarios: $(q_new 'select count(*) from auth.users')"
info "Siguiente: ./04-restore-new.sh --mode data --apply"
