#!/usr/bin/env bash
# Compara los DATOS del viejo y del nuevo (solo lectura en ambos): conteos exactos por tabla, md5 de contenido,
# usuarios, secuencias, buckets y referencias cruzadas. Las URLs reescritas se normalizan para que no cuenten como diferencia.
# Uso:  ./09-verify-data.sh              (conteos + md5)
#       ./09-verify-data.sh --counts     (solo conteos; mas rapido)
# IMPORTANTE: para que la comparacion sea valida, el viejo no debe recibir escrituras (en el corte, Render esta suspendido).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
need_cmd psql "Instala PostgreSQL 17 (Command Line Tools)."
need_cmd diff "Viene con Git Bash."
guard_old; guard_new
CHK=1; [ "${ARGS[0]:-}" = "--counts" ] && CHK=0
mkdir -p "$OUT_DIR"
OLD_O="$OUT_DIR/data-old.txt"; NEW_O="$OUT_DIR/data-new.txt"

say "Datos: viejo vs nuevo (checksum=$CHK)"
psql_old -v old_ref="$OLD_REF" -v new_ref="$NEW_REF" -v checksum="$CHK" -f "$MIG_DIR/sql/09-verify-data.sql" > "$OLD_O" 2>&1 || true
psql_new -v old_ref="$OLD_REF" -v new_ref="$NEW_REF" -v checksum="$CHK" -f "$MIG_DIR/sql/09-verify-data.sql" > "$NEW_O" 2>&1 || true
grep -n 'ERROR' "$OLD_O" "$NEW_O" | head -10 || true

if diff -u "$OLD_O" "$NEW_O" > "$OUT_DIR/data.diff"; then
  ok "RESULTADO: OK - viejo y nuevo coinciden ($(wc -l < "$NEW_O") lineas comparadas)"
else
  head -60 "$OUT_DIR/data.diff"
  info "Archivo completo: $OUT_DIR/data.diff"
  info "Nota: 'storage.objects' (seccion D) puede diferir hasta que corra 06-copy-storage.js --apply."
  die "RESULTADO: HAY DIFERENCIAS (viejo = '-', nuevo = '+')"
fi
