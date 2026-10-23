#!/usr/bin/env bash
# Borra los archivos locales de la migracion (respaldos SIN CIFRAR con datos personales, logs, comparaciones).
# Solo toca la carpeta OUT_DIR (por defecto ~/orbyx-migration-out). No toca el repo, ni el archivo de variables, ni ninguna base.
# Uso:  ./99-cleanup.sh            (muestra que borraria)
#       ./99-cleanup.sh --apply
set -euo pipefail
. "$(dirname "$0")/lib.sh"
[ -d "$OUT_DIR" ] || { info "No existe $OUT_DIR. Nada que borrar."; exit 0; }
case "$OUT_DIR" in ""|"/"|"$HOME") die "OUT_DIR peligroso: '$OUT_DIR'";; esac
say "Contenido de $OUT_DIR"
ls -la "$OUT_DIR" | sed 's/^/   /'
if [ "$APPLY" != "1" ]; then simulacro "rm -rf $OUT_DIR"; info "Agrega --apply para borrar."; exit 0; fi
printf 'Escribe BORRAR para eliminar %s: ' "$OUT_DIR"; read -r x; [ "$x" = "BORRAR" ] || die "Cancelado."
rm -rf "$OUT_DIR"; ok "borrado"
info "Recuerda tambien borrar $ENV_FILE cuando todo termine (tiene contrasenas y llaves)."
