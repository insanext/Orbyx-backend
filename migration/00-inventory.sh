#!/usr/bin/env bash
# Inventario del proyecto VIEJO (solo lectura) + archivos de apoyo que usan los demás scripts.
# Uso:  ./00-inventory.sh            (viejo)
#       ./00-inventory.sh --new      (inventario del proyecto nuevo, para comparar)
set -euo pipefail
. "$(dirname "$0")/lib.sh"
need_cmd psql "Instala PostgreSQL 17 (solo 'Command Line Tools'). Ver RUNBOOK."
mkdir -p "$OUT_DIR"

if [ "${ARGS[0]:-}" = "--new" ]; then
  guard_new
  say "Inventario del proyecto NUEVO ($NEW_REF)"
  psql_new -f "$MIG_DIR/sql/00-inventory.sql" > "$OUT_DIR/inventory-new.txt" 2>&1 || true
  ok "Guardado en $OUT_DIR/inventory-new.txt"
  exit 0
fi

guard_old
say "Inventario del proyecto VIEJO ($OLD_REF) - solo lectura"
psql_old -f "$MIG_DIR/sql/00-inventory.sql" > "$OUT_DIR/inventory-old.txt" 2>&1 || true
ok "Guardado en $OUT_DIR/inventory-old.txt  (revisalo o pegamelo)"

say "Generando archivos de apoyo desde el viejo"
# Extensiones a crear en el nuevo (idempotente).
q_old "select format('create extension if not exists %I with schema %I;', e.extname, n.nspname)
       from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname <> 'plpgsql' order by 1" \
  > "$OUT_DIR/old-extensions.sql"
ok "old-extensions.sql ($(wc -l < "$OUT_DIR/old-extensions.sql") extensiones)"

# Tablas en la publicacion de Realtime.
q_old "select schemaname||'.'||tablename from pg_publication_tables where pubname='supabase_realtime' order by 1" \
  > "$OUT_DIR/old-realtime-tables.txt"
ok "old-realtime-tables.txt: $(tr '\n' ' ' < "$OUT_DIR/old-realtime-tables.txt")"

# Permisos por defecto del rol postgres en public (solo ese rol se puede cambiar desde el nuevo).
q_old "select format('alter default privileges for role %I in schema %I grant %s on %s to %s;',
         r.rolname, n.nspname, a.privilege_type,
         case d.defaclobjtype when 'r' then 'tables' when 'S' then 'sequences' when 'f' then 'functions' end,
         case when a.grantee=0 then 'public' else quote_ident(g.rolname) end)
       from pg_default_acl d
       join pg_roles r on r.oid=d.defaclrole and r.rolname='postgres'
       join pg_namespace n on n.oid=d.defaclnamespace and n.nspname='public'
       cross join lateral aclexplode(d.defaclacl) a
       left join pg_roles g on g.oid=a.grantee
       where d.defaclobjtype in ('r','S','f') and a.grantee <> d.defaclrole
       order by 1" > "$OUT_DIR/old-default-privileges.sql"
ok "old-default-privileges.sql ($(wc -l < "$OUT_DIR/old-default-privileges.sql") lineas)"

# Buckets (informativo; la copia real la hace 06-copy-storage.js).
q_old "select id||' | public='||public||' | limite='||coalesce(file_size_limit::text,'-')||' | mime='||coalesce(allowed_mime_types::text,'-') from storage.buckets order by id" \
  > "$OUT_DIR/old-buckets.txt"
ok "old-buckets.txt"

echo
info "Revisa $OUT_DIR/inventory-old.txt. Todo lo que aparezca en las secciones 4, 5, 7, 9b y 11"
info "(triggers en auth/storage, funciones fuera de public, politicas de storage, ajustes por rol, cron/webhooks/vault)"
info "NO lo replica ningun script automaticamente: hay que decidirlo caso por caso con Claude."
