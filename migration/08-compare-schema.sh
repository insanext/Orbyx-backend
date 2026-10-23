#!/usr/bin/env bash
# Compara permisos, RLS, politicas, columnas, funciones, triggers, indices, constraints y Realtime
# entre el proyecto VIEJO y el NUEVO (solo lectura en ambos), y revisa que anon quede sin acceso.
# Uso:  ./08-compare-schema.sh
# Termina con error si hay diferencias o violaciones. NO reabrir el trafico hasta que termine en OK.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
need_cmd psql "Instala PostgreSQL 17 (Command Line Tools)."
need_cmd diff "Viene con Git Bash."
guard_old; guard_new
mkdir -p "$OUT_DIR"
OLD_SIG="$OUT_DIR/schema-old.txt"; NEW_SIG="$OUT_DIR/schema-new.txt"
BAD=0

say "1. Firma del esquema (viejo vs nuevo)"
psql_old -f "$MIG_DIR/sql/08-compare.sql" > "$OLD_SIG" 2>&1 || true
psql_new -f "$MIG_DIR/sql/08-compare.sql" > "$NEW_SIG" 2>&1 || true
info "viejo: $(wc -l < "$OLD_SIG") lineas   nuevo: $(wc -l < "$NEW_SIG") lineas"
# Las 14 tablas sin RLS se cierran a proposito (13-close-no-rls-tables.sh): sus permisos/RLS pueden diferir del viejo si el viejo aun
# no se cerro. Se excluyen de ESTA comparacion (secciones 1, 3 y 5) y se verifican de forma estricta en el paso 2.
NORM() { awk -v list="$NO_RLS_TABLES" 'BEGIN{n=split(list,a," "); for(i=1;i<=n;i++) skip[a[i]]=1}
  /^### /{sec=$2} { if ((sec=="1." || sec=="3." || sec=="5.") && ($1 in skip)) next; print }' "$1"; }
NORM "$OLD_SIG" > "$OLD_SIG.norm"; NORM "$NEW_SIG" > "$NEW_SIG.norm"
if diff -u "$OLD_SIG.norm" "$NEW_SIG.norm" > "$OUT_DIR/schema.diff"; then
  ok "identicos"
else
  BAD=1
  printf '   \033[31mDIFERENCIAS\033[0m (viejo = "-", nuevo = "+"). Archivo completo: %s\n' "$OUT_DIR/schema.diff"
  head -80 "$OUT_DIR/schema.diff"
  info "Las secciones '### 1', '### 2' y '### 3' son las de permisos: un '+ ... anon ...' que el viejo no tiene es el riesgo conocido."
  info "Las secciones '### 8' y '### 14' pueden diferir si las versiones de Postgres/extensiones son distintas: revisalas a mano."
fi

say "2. Criterio de seguridad: anon sin acceso (NUEVO)"
OUT="$(psql_new -v forbidden_tables="$(echo $ANON_FORBIDDEN_TABLES | tr ' ' ',')" -v forbidden_functions="$(echo $ANON_FORBIDDEN_FUNCTIONS | tr ' ' ',')" -v closed_tables="$(echo $NO_RLS_TABLES | tr ' ' ',')" -f "$MIG_DIR/sql/08-anon-violations.sql" 2>&1 || true)"
echo "$OUT" | sed 's/^/   /'
# La PRIMERA consulta (violaciones: tablas, funciones y las 14 tablas) debe terminar en "(0 rows)".
FIRST="$(echo "$OUT" | grep -m1 -E '^\([0-9]+ rows?\)' || true)"
if [ "$FIRST" != "(0 rows)" ]; then BAD=1; printf '   \033[31mVIOLACION\033[0m  hay objetos abiertos para anon/authenticated o sin cerrar (ver arriba: %s).\n' "$FIRST"; else ok "anon sin acceso a lo protegido y las 14 tablas cerradas"; fi

say "Si anon quedo con permisos de mas, arreglo (solo si el diff lo confirma; lo corre Claude):"
cat <<'HINT'
   revoke all on table public.<tabla> from anon;
   revoke all on function public.<funcion>(<args>) from public, anon, authenticated;
   (usar exactamente lo que muestre el diff; luego repetir este script)
HINT

[ "$BAD" = "0" ] && ok "RESULTADO: OK" || die "RESULTADO: HAY DIFERENCIAS O VIOLACIONES"
