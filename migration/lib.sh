#!/usr/bin/env bash
# Funciones comunes de los scripts de migración. No se ejecuta solo: lo cargan los demás.
# Regla de oro: NADA escribe en ninguna base sin la bandera --apply. Sin ella, cada
# script solo muestra lo que haría ("[SIMULACRO]"). Las conexiones al proyecto VIEJO
# siempre son de solo lectura.

MIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Windows (Git Bash): PostgreSQL 17+ instalado con "Command Line Tools".
# SIEMPRE la 17 (ambos proyectos son Postgres 17): un pg_dump 18 genera SQL que un servidor 17 puede rechazar.
[ -d "/c/Program Files/PostgreSQL/17/bin" ] && PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"
export PATH

# Variables: archivo FUERA del repo (tiene contraseñas y claves). Plantilla: migration/orbyx-migration.env.example
ENV_FILE="${ORBYX_MIGRATION_ENV:-$HOME/orbyx-migration.env}"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi

OLD_REF="${OLD_REF:-vmxjqhndepvgoexajtfc}"
NEW_REF="${NEW_REF:-fqmdcbvtrgcnftlwcojc}"
OUT_DIR="${OUT_DIR:-$HOME/orbyx-migration-out}"
SITE_URL="${SITE_URL:-https://www.orbyx.cl}"
API_URL="${API_URL:-https://api.orbyx.cl}"

# Las 9 tablas del REVOKE a anon del 2026-09-30 + tablas/funciones que NUNCA deben ser visibles para anon.
ANON_FORBIDDEN_TABLES="customers staff branches staff_services business_hours staff_special_dates service_groups tenant_addons pets blocked_contacts"
ANON_FORBIDDEN_FUNCTIONS="import_customers_batch undo_customer_import"
# Las 14 tablas que NO tenian RLS y estaban abiertas para anon/authenticated (ver sql/13a-13b). Deben quedar CERRADAS.
NO_RLS_TABLES="business_special_dates calendar_tokens campaign_delivery_logs campaign_history campaign_images clinical_notes email_change_requests pet_followups pet_notes pet_vaccines security_audit_log staff_hours support_ticket_messages support_tickets"

APPLY=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    *) ARGS+=("$a") ;;
  esac
done

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
ok()   { printf '   \033[32mOK\033[0m  %s\n' "$*"; }
warn() { printf '   \033[33mAVISO\033[0m  %s\n' "$*"; }
die()  { printf '\n\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "Falta '$1'. $2"; }
need_env() { [ -n "${!1:-}" ] || die "Falta la variable $1 en $ENV_FILE (ver migration/orbyx-migration.env.example)"; }

# Evita el error más peligroso: apuntar un script a la base equivocada.
guard_old() {
  need_env OLD_DB_URL
  case "$OLD_DB_URL" in *"$OLD_REF"*) ;; *) die "OLD_DB_URL no contiene el ref del proyecto viejo ($OLD_REF)";; esac
  case "$OLD_DB_URL" in *"$NEW_REF"*) die "OLD_DB_URL contiene el ref del proyecto NUEVO. Revisa las variables.";; esac
}
guard_new() {
  need_env NEW_DB_URL
  case "$NEW_DB_URL" in *"$NEW_REF"*) ;; *) die "NEW_DB_URL no contiene el ref del proyecto nuevo ($NEW_REF)";; esac
  case "$NEW_DB_URL" in *"$OLD_REF"*) die "NEW_DB_URL contiene el ref del proyecto VIEJO. Revisa las variables.";; esac
}

# Proyecto VIEJO: siempre solo lectura.
psql_old() { PGOPTIONS="-c default_transaction_read_only=on" psql "$OLD_DB_URL" -X -v ON_ERROR_STOP=0 "$@"; }
psql_new() { psql "$NEW_DB_URL" -X -v ON_ERROR_STOP=0 "$@"; }
# Una sola consulta, salida limpia (sin encabezados ni alineación).
q_old() { PGOPTIONS="-c default_transaction_read_only=on" psql "$OLD_DB_URL" -X -At -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'; }
q_new() { psql "$NEW_DB_URL" -X -At -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'; }

# Pide escribir el ref del proyecto que se va a modificar. Solo para acciones que escriben.
confirm_ref() {
  local ref="$1" what="$2"
  [ "$APPLY" = "1" ] || return 0
  printf '\n\033[33mVas a %s en el proyecto %s.\033[0m\nEscribe el ref para continuar: ' "$what" "$ref"
  # CONFIRM_REF permite confirmar sin teclado (autorizacion expresa del dueno). Se compara SIEMPRE contra el ref
  # que el script va a modificar (siempre el NUEVO): el ref viejo nunca puede pasar esta confirmacion.
  local typed
  if [ -n "${CONFIRM_REF:-}" ]; then typed="$CONFIRM_REF"; echo "$typed (desde CONFIRM_REF)"; else read -r typed; fi
  [ "$typed" = "$ref" ] || die "No coincide. Cancelado."
  [ "$ref" != "$OLD_REF" ] || die "El ref a modificar es el del proyecto VIEJO. Cancelado."
}

simulacro() { printf '   [SIMULACRO] %s\n' "$*"; }

latest_dump_dir() { ls -1d "$OUT_DIR"/dump-* 2>/dev/null | sort | tail -1; }
