#!/usr/bin/env bash
# Revisiones previas. Solo LEE (ambos proyectos). No cambia nada.
# Uso:  ./01-preflight.sh
set -euo pipefail
. "$(dirname "$0")/lib.sh"
FAILS=0
fail() { printf '   \033[31mFALLA\033[0m  %s\n' "$*"; FAILS=$((FAILS+1)); }

say "1. Herramientas"
need_cmd psql    "Instala PostgreSQL 17 (Command Line Tools). Ver RUNBOOK, seccion 'Antes de empezar'."
need_cmd pg_dump "Viene con PostgreSQL 17."
need_cmd node    "Instala Node.js (ya lo tienes si corre el backend)."
need_cmd curl    "Viene con Git Bash."
PGDUMP_MAJOR="$(pg_dump --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
ok "psql: $(psql --version | head -1)"
ok "pg_dump: $(pg_dump --version | head -1)"
[ "$PGDUMP_MAJOR" = "17" ] && ok "pg_dump es 17" || fail "pg_dump es $PGDUMP_MAJOR; se necesita EXACTAMENTE 17 (ambos proyectos son Postgres 17)."

say "2. Conexion y version de Postgres"
guard_old; guard_new
OLD_NUM="$(q_old "show server_version_num")" || die "No pude conectar al proyecto VIEJO. Revisa OLD_DB_URL."
NEW_NUM="$(q_new "show server_version_num")" || die "No pude conectar al proyecto NUEVO. Revisa NEW_DB_URL."
OLD_MAJOR=$((OLD_NUM/10000)); NEW_MAJOR=$((NEW_NUM/10000))
info "viejo = Postgres $OLD_MAJOR ($OLD_NUM)   nuevo = Postgres $NEW_MAJOR ($NEW_NUM)"
[ "$NEW_MAJOR" -ge "$OLD_MAJOR" ]    && ok "nuevo >= viejo"                 || fail "El nuevo ($NEW_MAJOR) es MENOR que el viejo ($OLD_MAJOR): el restore puede fallar."
[ "$NEW_MAJOR" -ge "$PGDUMP_MAJOR" ] && ok "nuevo >= pg_dump ($PGDUMP_MAJOR)" || fail "El nuevo ($NEW_MAJOR) es menor que pg_dump ($PGDUMP_MAJOR): el SQL generado (SET transaction_timeout, etc.) lo rechazaria."
info "zona horaria: viejo=$(q_old "show timezone")  nuevo=$(q_new "show timezone")"

say "3. Estado del proyecto NUEVO"
NEW_TABLES="$(q_new "select count(*) from pg_tables where schemaname='public'")"
NEW_USERS="$(q_new "select count(*) from auth.users")"
info "tablas en public: $NEW_TABLES   usuarios en auth.users: $NEW_USERS"
if [ "$NEW_TABLES" = "0" ] && [ "$NEW_USERS" = "0" ]; then ok "vacio (listo para el ensayo completo)"
else warn "no esta vacio. Para repetir una carga hay que usar 11-reset-new-data.sh (modo 'data') o dejar el esquema y cargar solo datos."; fi
HAS_PUB="$(q_new "select count(*) from pg_publication where pubname='supabase_realtime'")"
[ "$HAS_PUB" = "1" ] && ok "existe la publicacion supabase_realtime" || fail "no existe la publicacion supabase_realtime en el nuevo"

say "4. Extensiones del viejo disponibles en el nuevo"
if [ -f "$OUT_DIR/old-extensions.sql" ]; then
  while read -r ext; do
    [ -z "$ext" ] && continue
    n="$(q_new "select count(*) from pg_available_extensions where name='$ext'")"
    [ "$n" = "1" ] && ok "$ext" || fail "la extension '$ext' NO esta disponible en el nuevo"
  done < <(q_old "select extname from pg_extension where extname<>'plpgsql' order by 1")
else
  warn "falta $OUT_DIR/old-extensions.sql: corre primero ./00-inventory.sh"
fi

say "5. Llaves del proyecto NUEVO"
need_env NEW_SUPABASE_URL
need_env NEW_SERVICE_ROLE_KEY
case "$NEW_SERVICE_ROLE_KEY" in
  sb_secret_*) KEYTYPE_SECRET="sb_secret (formato NUEVO)";;
  eyJ*)        KEYTYPE_SECRET="service_role JWT (formato LEGACY)";;
  *)           KEYTYPE_SECRET="desconocido";;
esac
info "llave secreta del nuevo: $KEYTYPE_SECRET"
if [ -n "${NEW_ANON_KEY:-}" ]; then
  case "$NEW_ANON_KEY" in
    sb_publishable_*) info "llave publica del nuevo: sb_publishable (formato NUEVO)";;
    eyJ*)             info "llave publica del nuevo: anon JWT (formato LEGACY)";;
    *)                warn "llave publica de formato desconocido";;
  esac
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "apikey: $NEW_ANON_KEY" "$NEW_SUPABASE_URL/auth/v1/settings")"
  [ "$code" = "200" ] && ok "auth/v1/settings responde 200 con la llave publica" || fail "auth/v1/settings respondio $code con la llave publica"
else
  warn "NEW_ANON_KEY vacia: no pude probar la llave publica"
fi
code="$(curl -s -o /dev/null -w '%{http_code}' -H "apikey: $NEW_SERVICE_ROLE_KEY" "$NEW_SUPABASE_URL/rest/v1/")"
[ "$code" = "200" ] && ok "rest/v1 responde 200 con la llave secreta" || fail "rest/v1 respondio $code con la llave secreta"

say "6. Firma de los JWT del proyecto NUEVO (afecta la velocidad del middleware)"
JWKS="$(curl -s "$NEW_SUPABASE_URL/auth/v1/.well-known/jwks.json" || true)"
if echo "$JWKS" | grep -q '"alg"'; then
  ALGS="$(echo "$JWKS" | grep -oE '"alg" *: *"[A-Za-z0-9]+"' | sort -u | tr '\n' ' ')"
  ok "claves asimetricas publicadas: $ALGS -> getClaims() verifica en local (rapido)"
else
  warn "sin JWKS asimetrico (probable secreto HS256 legacy): getClaims() caera a getUser() por red. Funciona, pero mas lento."
fi

say "Resultado"
if [ "$FAILS" -gt 0 ]; then die "$FAILS comprobacion(es) fallaron. Corrigelas antes de seguir."; fi
ok "todo en orden"
