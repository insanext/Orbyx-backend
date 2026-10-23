#!/usr/bin/env bash
# Despues de cargar datos: Realtime (incluye reviews), permisos por defecto del viejo, ANALYZE.
# Uso:  ./05-post-restore.sh            (simulacro)
#       ./05-post-restore.sh --apply    (escribe en el NUEVO)
set -euo pipefail
. "$(dirname "$0")/lib.sh"
need_cmd psql "Instala PostgreSQL 17 (Command Line Tools)."
guard_new
say "Post-restauracion en el NUEVO ($NEW_REF)"

# Tablas que SIEMPRE deben estar en la publicacion (migraciones del repo) + las que tenia el viejo.
REQUIRED="public.appointments public.tenant_monthly_usage public.reviews"
TABLES="$REQUIRED"
if [ -f "$OUT_DIR/old-realtime-tables.txt" ]; then TABLES="$TABLES $(tr -d '\r' < "$OUT_DIR/old-realtime-tables.txt" | tr '\n' ' ')"; else
  warn "No existe old-realtime-tables.txt (corre ./00-inventory.sh). Se usan solo las 3 conocidas."; fi
TABLES="$(printf '%s\n' $TABLES | sort -u | tr '\n' ' ')"

SQL="$OUT_DIR/05-post-restore.generated.sql"
mkdir -p "$OUT_DIR"
{
  echo "-- generado por 05-post-restore.sh"
  for t in $TABLES; do
    [[ "$t" =~ ^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$ ]] || { echo "-- tabla ignorada (nombre raro): $t"; continue; }
    s="${t%%.*}"; n="${t##*.}"
    cat <<SQLBLOCK
do \$\$ begin
  if to_regclass('$s.$n') is null then
    raise notice 'Realtime: la tabla $s.$n no existe en el nuevo, se omite';
  elsif not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='$s' and tablename='$n') then
    alter publication supabase_realtime add table $s.$n;
    raise notice 'Realtime: agregada $s.$n';
  else
    raise notice 'Realtime: $s.$n ya estaba';
  end if;
end \$\$;
SQLBLOCK
  done
  echo "analyze;"
} > "$SQL"

info "Realtime: $TABLES"
DEFAULTS="$OUT_DIR/old-default-privileges.sql"
if [ "$APPLY" != "1" ]; then
  simulacro "ejecutar $SQL (agrega tablas a supabase_realtime y ANALYZE)"
  [ -s "$DEFAULTS" ] && simulacro "re-aplicar permisos por defecto del viejo ($(wc -l < "$DEFAULTS") lineas de $DEFAULTS)" || warn "sin old-default-privileges.sql: los permisos por defecto del nuevo quedarian quitados (03). Revisar con Claude."
  info "Para ejecutar de verdad agrega --apply."
  exit 0
fi

confirm_ref "$NEW_REF" "ajustar Realtime y permisos por defecto"
psql_new -v ON_ERROR_STOP=1 -f "$SQL"
if [ -s "$DEFAULTS" ]; then
  say "Permisos por defecto (como los tenia el viejo; solo afectan objetos NUEVOS futuros)"
  cat "$DEFAULTS"
  psql_new -v ON_ERROR_STOP=1 -f "$DEFAULTS"
fi
say "Publicacion Realtime en el nuevo"
psql_new -c "select schemaname, tablename from pg_publication_tables where pubname='supabase_realtime' order by 2"
ok "listo. Siguiente: ./06-copy-storage.js, ./07-rewrite-urls.sh, ./08-compare-schema.sh"
