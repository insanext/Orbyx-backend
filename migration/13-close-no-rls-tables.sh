#!/usr/bin/env bash
# Cierra las 14 tablas sin RLS que estaban abiertas para anon/authenticated (ver sql/13a, 13b).
#   ./13-close-no-rls-tables.sh --target old            -> SOLO verifica el viejo (lectura). El viejo se cierra a mano en su SQL Editor.
#   ./13-close-no-rls-tables.sh --target new            -> simulacro: verifica el nuevo y dice que haria
#   ./13-close-no-rls-tables.sh --target new --apply    -> verifica ANTES, cierra, verifica DESPUES (pide escribir el ref del NUEVO)
set -euo pipefail
. "$(dirname "$0")/lib.sh"
need_cmd psql "Instala PostgreSQL 17 (Command Line Tools)."
TARGET=""
for ((i=0;i<${#ARGS[@]};i++)); do [ "${ARGS[$i]}" = "--target" ] && TARGET="${ARGS[$((i+1))]:-}"; done

verify() { # $1 = old|new
  if [ "$1" = "old" ]; then psql_old -f "$MIG_DIR/sql/13a-estado-14-tablas.sql"; else psql_new -f "$MIG_DIR/sql/13a-estado-14-tablas.sql"; fi
}

case "$TARGET" in
  old)
    [ "$APPLY" = "0" ] || die "El proyecto viejo es solo lectura: --apply no aplica. Se cierra a mano en su SQL Editor (sql/13b)."
    guard_old
    say "Estado de las 14 tablas en el VIEJO (solo lectura)"
    verify old
    info "Si alguna dice ABIERTA: pegar sql/13b-cerrar-14-tablas.sql en el SQL Editor del viejo y volver a correr esto."
    ;;
  new)
    guard_new
    say "ANTES - estado de las 14 tablas en el NUEVO ($NEW_REF)"
    verify new
    if [ "$APPLY" != "1" ]; then
      simulacro "ejecutar sql/13b-cerrar-14-tablas.sql en el NUEVO (RLS + REVOKE a anon/authenticated)"
      info "Para ejecutar de verdad agrega --apply."; exit 0
    fi
    confirm_ref "$NEW_REF" "CERRAR las 14 tablas (RLS + REVOKE)"
    psql_new -v ON_ERROR_STOP=1 -f "$MIG_DIR/sql/13b-cerrar-14-tablas.sql"
    say "DESPUES - estado de las 14 tablas en el NUEVO"
    OUT="$(psql_new -At -F '|' -f "$MIG_DIR/sql/13a-estado-14-tablas.sql")"
    echo "$OUT" | sed 's/^/   /'
    N_OK="$(echo "$OUT" | grep -c '|CERRADA$' || true)"
    [ "$N_OK" = "14" ] && ok "las 14 tablas quedaron CERRADAS" || die "Solo $N_OK de 14 quedaron CERRADAS. NO seguir."
    ;;
  *) die "Uso: $0 --target old|new [--apply]";;
esac
