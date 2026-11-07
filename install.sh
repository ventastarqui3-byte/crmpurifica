#!/usr/bin/env bash
# Instalador de Purifica CRM v5.3 — Linux / macOS
# Uso: ./install.sh
set -e
cd "$(dirname "$0")"

# sed -i de GNU (Linux) y BSD (macOS) no se escriben igual.
if [[ "$OSTYPE" == "darwin"* ]]; then SED_I=(-i ''); else SED_I=(-i); fi
# Escapar & y | en valores que van a sed (una clave con & rompería el reemplazo).
esc() { printf '%s' "$1" | sed 's/[&|]/\\&/g'; }

echo "== Purifica CRM v5.3 — Instalador =="
command -v docker >/dev/null 2>&1 || { echo "ERROR: Docker no está instalado. Instálalo primero (https://docs.docker.com/get-docker/) y vuelve a correr ./install.sh"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "ERROR: Docker Compose no está disponible."; exit 1; }

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Se creó .env desde .env.example — revísalo antes de seguir si quieres cambiar claves o puerto."
fi

# Generar JWT_SECRET si está vacío
if grep -q '^JWT_SECRET=$' .env; then
  SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  sed "${SED_I[@]}" "s|^JWT_SECRET=$|JWT_SECRET=$SECRET|" .env
  echo "JWT_SECRET generado."
fi

# Pedir clave de Postgres si sigue la de ejemplo
if grep -q '^POSTGRES_PASSWORD=cambia-esta-clave$' .env; then
  read -rsp "Clave de la base de datos (se usará para Postgres): " PGPASS; echo
  [ -n "$PGPASS" ] && sed "${SED_I[@]}" "s|^POSTGRES_PASSWORD=cambia-esta-clave$|POSTGRES_PASSWORD=$(esc "$PGPASS")|" .env
fi

# Pedir admin inicial si sigue la clave de ejemplo
if grep -q '^ADMIN_PASSWORD=cambia-esta-clave$' .env; then
  read -rp "Correo del administrador inicial [admin@purifica.com]: " AEMAIL
  read -rsp "Contraseña del administrador inicial: " APASS; echo
  [ -n "$AEMAIL" ] && sed "${SED_I[@]}" "s|^ADMIN_EMAIL=.*|ADMIN_EMAIL=$(esc "$AEMAIL")|" .env
  [ -n "$APASS" ] && sed "${SED_I[@]}" "s|^ADMIN_PASSWORD=cambia-esta-clave$|ADMIN_PASSWORD=$(esc "$APASS")|" .env
fi

echo "Levantando app + base de datos..."
docker compose up -d --build

PORT=$(grep '^APP_PORT=' .env | cut -d= -f2)
PORT=${PORT:-8080}
echo ""
echo "Listo. Abre http://localhost:$PORT"
echo "Entra con el correo y la contraseña de administrador que definiste en .env."
echo "Después de entrar, cambia la contraseña desde Equipo y conecta WhatsApp en Canales WhatsApp (escanea el QR)."
