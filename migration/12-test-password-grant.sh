#!/usr/bin/env bash
# Prueba el punto de riesgo de las llaves nuevas: server.js verifyCurrentPassword() llama a
#   POST <SUPABASE_URL>/auth/v1/token?grant_type=password   con  apikey: <llave secreta>   (sin Authorization)
# Con Captcha activo en el proyecto, hay que comprobar que NO responda captcha_failed.
#
# Cuenta y contrasena de PRUEBA (ya restauradas en el NUEVO), en este orden de prioridad:
#   1) argumento:  ./12-test-password-grant.sh correo@ejemplo.cl
#   2) variables TEST_EMAIL y TEST_PASSWORD en ~/orbyx-migration.env (borrar TEST_PASSWORD al terminar)
#   3) si no hay contrasena: se pide por teclado (no se muestra ni se guarda)
# Llaves que prueba:
#   - NEW_SERVICE_ROLE_KEY (la que esta usando el plan: legacy service_role o sb_secret)
#   - NEW_SB_SECRET_KEY (opcional: una sb_secret_..., para saber tambien si la llave nueva serviria)
# Resultado esperado por llave:  contrasena correcta -> 200 | incorrecta -> 400 invalid_credentials | nunca "captcha"
set -euo pipefail
. "$(dirname "$0")/lib.sh"
need_cmd curl "Viene con Git Bash."
need_env NEW_SUPABASE_URL; need_env NEW_SERVICE_ROLE_KEY
EMAIL="${ARGS[0]:-${TEST_EMAIL:-}}"; [ -n "$EMAIL" ] || die "Falta el correo: pasalo como argumento o define TEST_EMAIL"
PASS="${TEST_PASSWORD:-}"
if [ -z "$PASS" ]; then printf 'Contrasena de %s (no se muestra): ' "$EMAIL"; read -rs PASS; echo; fi
[ -n "$PASS" ] || die "Contrasena vacia"

BAD=0
# $1 = contrasena  $2 = llave  $3 = "solo-apikey" (como el codigo de hoy) o "con-authorization" (como el parche)
call() {
  local pw body key="$2" mode="$3"; local -a hdr=(-H "apikey: $key")
  [ "$mode" = "con-authorization" ] && hdr+=(-H "Authorization: Bearer $key")
  pw="$1"; pw="${pw//\/\\}"; pw="${pw//\"/\\\"}"   # escapa \ y " para el JSON
  body="$(mktemp)"
  CODE="$(curl -s -o "$body" -w '%{http_code}' -X POST "$NEW_SUPABASE_URL/auth/v1/token?grant_type=password" \
    "${hdr[@]}" -H "Content-Type: application/json" \
    --data "$(printf '{"email":"%s","password":"%s"}' "$EMAIL" "$pw")")"
  # Solo se muestra el codigo y el tipo de error; nunca los tokens.
  printf '   http=%s  %s\n' "$CODE" "$(grep -oE '"(error_code|msg|error_description)":"[^"]*"' "$body" | tr '\n' ' ')"
  rm -f "$body"
}
probar() { # $1 = nombre  $2 = llave  $3 = modo
  local tipo="otro"; case "$2" in sb_secret_*) tipo="sb_secret";; eyJ*) tipo="legacy service_role JWT";; esac
  say "Llave: $1 ($tipo) - modo: $3"
  local ok1 ok2
  echo "  contrasena correcta (esperado http=200):";  call "$PASS" "$2" "$3"; ok1="$CODE"
  echo "  contrasena incorrecta (esperado http=400):"; call "contrasena-incorrecta-$RANDOM" "$2" "$3"; ok2="$CODE"
  if [ "$ok1" = "200" ] && [ "$ok2" = "400" ]; then ok "funciona"; return 0; fi
  warn "NO funciona con este modo"; return 1
}
# El modo 'solo-apikey' es el codigo ACTUAL de server.js; 'con-authorization' es el parche
# migration/patches/verifyCurrentPassword-authorization-header.patch. Lo que importa es que el parche funcione.
probar "NEW_SERVICE_ROLE_KEY" "$NEW_SERVICE_ROLE_KEY" "solo-apikey" || true
probar "NEW_SERVICE_ROLE_KEY" "$NEW_SERVICE_ROLE_KEY" "con-authorization" || BAD=1
if [ -n "${NEW_SB_SECRET_KEY:-}" ]; then
  probar "NEW_SB_SECRET_KEY" "$NEW_SB_SECRET_KEY" "solo-apikey" || true
  probar "NEW_SB_SECRET_KEY" "$NEW_SB_SECRET_KEY" "con-authorization" || true
fi
echo
[ "$BAD" = "0" ] && ok "RESULTADO: OK con el parche (apikey + Authorization)" || die "RESULTADO: el parche NO resuelve el captcha"
