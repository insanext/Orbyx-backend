#!/usr/bin/env bash
# Comprobaciones automaticas DESPUES del corte (solo GET publicos a orbyx.cl y api.orbyx.cl; no escribe nada).
# Uso:  ./10-post-cutover-checks.sh [slug-de-un-negocio]
# Con slug tambien revisa que la API publica no devuelva URLs con el ref viejo y mide la latencia (compara con 0,44 s/consulta de antes).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
need_cmd curl "Viene con Git Bash."
SLUG="${ARGS[0]:-}"
BAD=0
bad() { printf '   \033[31mFALLA\033[0m  %s\n' "$*"; BAD=1; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

say "1. Backend vivo: $API_URL/health"
for i in 1 2 3; do curl -s -o /dev/null -w "   intento $i: http=%{http_code} ttfb=%{time_starttransfer}s\n" "$API_URL/health"; done
[ "$(curl -s "$API_URL/health")" = '{"status":"ok"}' ] && ok "health ok" || bad "health no devolvio {\"status\":\"ok\"}"

say "2. El JavaScript publicado ya apunta al proyecto NUEVO"
for page in /login /signup /; do
  curl -s "$SITE_URL$page" -o "$TMP/p.html"
  grep -oE '/_next/static/[^"]+\.js' "$TMP/p.html" | sort -u > "$TMP/chunks.txt" || true
  : > "$TMP/all.js"
  while read -r c; do curl -s "$SITE_URL$c" >> "$TMP/all.js"; done < "$TMP/chunks.txt"
  N_OLD="$(grep -o "$OLD_REF" "$TMP/all.js" | wc -l | tr -d ' ' || true)"   # sin coincidencias grep sale 1: no abortar
  N_NEW="$(grep -o "$NEW_REF" "$TMP/all.js" | wc -l | tr -d ' ' || true)"
  info "$page: $(wc -l < "$TMP/chunks.txt" | tr -d ' ') archivos JS; ref viejo x$N_OLD, ref nuevo x$N_NEW"
  [ "$N_OLD" = "0" ] || bad "$page todavia contiene el ref VIEJO (Vercel no reconstruyo o falta redeploy sin cache)"
done
[ "$BAD" = "0" ] && ok "sin referencias al proyecto viejo"

say "3. Auth del proyecto NUEVO responde con la llave publica"
if [ -n "${NEW_ANON_KEY:-}" ] && [ -n "${NEW_SUPABASE_URL:-}" ]; then
  code="$(curl -s -o "$TMP/settings.json" -w '%{http_code}' -H "apikey: $NEW_ANON_KEY" "$NEW_SUPABASE_URL/auth/v1/settings")"
  [ "$code" = "200" ] && ok "auth/v1/settings 200" || bad "auth/v1/settings respondio $code"
  grep -oE '"(mailer_autoconfirm|disable_signup|external_email_enabled)":[a-z]+' "$TMP/settings.json" | sed 's/^/   /' || true
else warn "NEW_ANON_KEY / NEW_SUPABASE_URL no definidos: se omite"; fi

if [ -n "$SLUG" ]; then
  say "4. API publica del negocio '$SLUG'"
  for ep in "public/business/$SLUG" "public/services/$SLUG"; do
    curl -s -o "$TMP/r.json" -w "   $ep: http=%{http_code} ttfb=%{time_starttransfer}s\n" "$API_URL/$ep"
    if grep -q "$OLD_REF" "$TMP/r.json"; then bad "$ep devuelve URLs con el ref VIEJO (falta 07-rewrite-urls.sh --apply)"; fi
  done
  say "5. Latencia: 5 repeticiones de /public/services (antes: ~12 consultas secuenciales, 2 a 5 s)"
  for i in 1 2 3 4 5; do curl -s -o /dev/null -w "   %{time_total}s\n" "$API_URL/public/services/$SLUG"; done
else
  info "(sin slug: se omiten las pruebas 4 y 5. Uso: $0 mi-negocio)"
fi

echo
[ "$BAD" = "0" ] && ok "RESULTADO: OK (faltan las pruebas manuales con login del RUNBOOK)" || die "RESULTADO: HAY FALLAS"
