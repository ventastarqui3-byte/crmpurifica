#!/bin/sh
# Entrypoint del CRM (v5.3.28).
# El contenedor arranca como root SOLO para arreglar el dueño de los
# directorios que la app escribe, y luego baja privilegios: la app
# corre como usuario `node` (B8). Sin esto, el volumen de Railway
# (creado cuando la app corría como root) pertenece a root y `node`
# no puede crear la sesión de WhatsApp (EACCES: permission denied,
# mkdir '/app/data/session-wa-session-...') ni Chrome puede bloquear
# su perfil (Code: 21). El chown solo se hace si el dueño no es
# node, para no re-recorrer el volumen en cada arranque.
set -e

for d in /app/data /app/uploads /app/backups /app/.wwebjs_auth /app/.cache/puppeteer; do
  if [ -d "$d" ] && [ "$(stat -c %U "$d" 2>/dev/null)" != "node" ]; then
    chown -R node:node "$d" 2>/dev/null || true
  fi
done

# Bajar privilegios y arrancar la app como node.
if command -v runuser >/dev/null 2>&1; then
  exec runuser -u node -- "$@"
else
  exec su node -s /bin/sh -c 'exec "$@"' sh "$@"
fi
