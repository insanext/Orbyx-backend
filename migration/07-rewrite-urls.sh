#!/usr/bin/env bash
# Detecta (y opcionalmente reescribe) URLs que llevan el ref del proyecto viejo, en TODAS las columnas de texto/json de public.
#
#   ./07-rewrite-urls.sh --target old            -> cuenta en el VIEJO (solo lectura): que columnas tienen URLs con el ref viejo
#   ./07-rewrite-urls.sh --target new            -> cuenta en el NUEVO (nada se cambia)
#   ./07-rewrite-urls.sh --target new --apply    -> reescribe en el NUEVO (viejo ref -> nuevo ref)
#
# Despues de reescribir, correr de nuevo sin --apply: debe decir "0 columna(s), 0 fila(s)".
# Los adjuntos de tickets y comprobantes de deposito NO necesitan reescritura (bucket privado, se firman al vuelo).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
need_cmd psql "Instala PostgreSQL 17 (Command Line Tools)."

TARGET="new"
for ((i=0;i<${#ARGS[@]};i++)); do [ "${ARGS[$i]}" = "--target" ] && TARGET="${ARGS[$((i+1))]:-}"; done

if [ "$TARGET" = "old" ]; then
  [ "$APPLY" = "0" ] || die "El proyecto viejo es solo lectura: --apply no aplica a --target old."
  guard_old
  say "Conteo de URLs con el ref viejo en el VIEJO ($OLD_REF) - solo lectura"
  psql_old -v old_ref="$OLD_REF" -v new_ref="$NEW_REF" -v do_apply=0 -f "$MIG_DIR/sql/07-rewrite-urls.sql" 2>&1 | grep -E 'NOTICE|ERROR' | sed -E 's/^psql:[^ ]+ //' || true
elif [ "$TARGET" = "new" ]; then
  guard_new
  if [ "$APPLY" = "1" ]; then
    confirm_ref "$NEW_REF" "REESCRIBIR URLs (ref viejo -> nuevo)"
    say "Reescribiendo en el NUEVO ($NEW_REF)"
    psql_new -v ON_ERROR_STOP=1 -v old_ref="$OLD_REF" -v new_ref="$NEW_REF" -v do_apply=1 -f "$MIG_DIR/sql/07-rewrite-urls.sql" 2>&1 | grep -E 'NOTICE|ERROR' | sed -E 's/^psql:[^ ]+ //' || true
    say "Verificacion (debe quedar en 0)"
    psql_new -v ON_ERROR_STOP=1 -v old_ref="$OLD_REF" -v new_ref="$NEW_REF" -v do_apply=0 -f "$MIG_DIR/sql/07-rewrite-urls.sql" 2>&1 | grep -E 'RESUMEN' || true
  else
    say "Conteo en el NUEVO ($NEW_REF) - no cambia nada"
    psql_new -v old_ref="$OLD_REF" -v new_ref="$NEW_REF" -v do_apply=0 -f "$MIG_DIR/sql/07-rewrite-urls.sql" 2>&1 | grep -E 'NOTICE|ERROR' | sed -E 's/^psql:[^ ]+ //' || true
    info "Para reescribir de verdad agrega --apply."
  fi
else
  die "Uso: $0 --target old|new [--apply]"
fi
