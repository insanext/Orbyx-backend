#!/usr/bin/env bash
# Prueba DESDE AFUERA (como la vera cualquiera en internet) si la llave publica puede tocar las 14 tablas.
# Solo hace peticiones HEAD de conteo (no lee filas ni escribe). Esperado tras el cierre: HTTP 401/403 en las 14.
#   ./14-check-anon-exposure.sh --target old   (la llave publica se toma del JavaScript publico de orbyx.cl: es la que ya ve todo el mundo)
#   ./14-check-anon-exposure.sh --target new   (usa NEW_ANON_KEY)
set -euo pipefail
. "$(dirname "$0")/lib.sh"
need_cmd curl "Viene con Git Bash."
TARGET=""
for ((i=0;i<${#ARGS[@]};i++)); do [ "${ARGS[$i]}" = "--target" ] && TARGET="${ARGS[$((i+1))]:-}"; done
TABLES="$NO_RLS_TABLES customers"   # customers es el control: ya estaba cerrada (debe dar 401)
case "$TARGET" in
  old)
    URL="https://$OLD_REF.supabase.co"
    TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
    curl -s "$SITE_URL/login" -o "$TMP/l.html"
    for c in $(grep -oE '/_next/static/[^"]+\.js' "$TMP/l.html" | sort -u); do curl -s "$SITE_URL$c"; done > "$TMP/all.js"
    KEY="$(grep -oE 'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}' "$TMP/all.js" | sort -u | head -1)"
    [ -n "$KEY" ] || die "No encontre la llave publica en el JavaScript de $SITE_URL"
    ;;
  new) need_env NEW_ANON_KEY; need_env NEW_SUPABASE_URL; URL="$NEW_SUPABASE_URL"; KEY="$NEW_ANON_KEY" ;;
  *) die "Uso: $0 --target old|new";;
esac
say "Exposicion con la llave publica en $URL"
OPEN=0
for t in $TABLES; do
  H=(-H "apikey: $KEY"); case "$KEY" in eyJ*) H+=(-H "Authorization: Bearer $KEY");; esac
  code="$(curl -s -o /dev/null -w '%{http_code}' -I "${H[@]}" -H "Prefer: count=exact" "$URL/rest/v1/$t?select=*&limit=0")"
  case "$code" in
    200|206) printf '   \033[31mABIERTA\033[0m  %-26s http=%s\n' "$t" "$code"; [ "$t" = "customers" ] || OPEN=$((OPEN+1));;
    *)       printf '   \033[32mcerrada\033[0m  %-26s http=%s\n' "$t" "$code";;
  esac
done
[ "$OPEN" = "0" ] && ok "ninguna de las 14 tablas responde a la llave publica" || die "$OPEN de las 14 tablas SIGUEN ABIERTAS"
