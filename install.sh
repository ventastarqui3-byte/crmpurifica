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

# Generar una contraseña aleatoria larga (48 caracteres hex).
gen_pass() { openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# Clave de Postgres: si está vacía o sigue el placeholder viejo, pedirla.
# Enter genera una aleatoria segura; si se escribe una, mínimo 12 caracteres.
# v5.3.29 (H-A5): antes, pulsar Enter dejaba la clave pública 'cambia-esta-clave'.
GEN_PGPASS=""
if grep -qE '^POSTGRES_PASSWORD=(cambia-esta-clave)?$' .env; then
  read -rsp "Clave de la base de datos (Enter = generar una aleatoria segura): " PGPASS; echo
  if [ -z "$PGPASS" ]; then
    PGPASS=$(gen_pass); GEN_PGPASS="$PGPASS"
    echo "Clave de la base de datos generada: $PGPASS  (guárdala)"
  fi
  while [ ${#PGPASS} -lt 12 ]; do
    echo "La clave debe tener al menos 12 caracteres."
    read -rsp "Clave de la base de datos (Enter = generar una): " PGPASS; echo
    if [ -z "$PGPASS" ]; then
      PGPASS=$(gen_pass); GEN_PGPASS="$PGPASS"
      echo "Clave de la base de datos generada: $PGPASS  (guárdala)"
    fi
  done
  sed "${SED_I[@]}" "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(esc "$PGPASS")|" .env
fi

# Admin inicial: si la clave está vacía o sigue el placeholder viejo.
GEN_APASS=""
if grep -qE '^ADMIN_PASSWORD=(cambia-esta-clave)?$' .env; then
  read -rp "Correo del administrador inicial [admin@purifica.com]: " AEMAIL
  read -rsp "Contraseña del administrador inicial (Enter = generar una aleatoria segura): " APASS; echo
  if [ -z "$APASS" ]; then
    APASS=$(gen_pass); GEN_APASS="$APASS"
    echo "Contraseña del administrador generada: $APASS  (guárdala)"
  fi
  while [ ${#APASS} -lt 12 ]; do
    echo "La contraseña debe tener al menos 12 caracteres."
    read -rsp "Contraseña del administrador inicial (Enter = generar una): " APASS; echo
    if [ -z "$APASS" ]; then
      APASS=$(gen_pass); GEN_APASS="$APASS"
      echo "Contraseña del administrador generada: $APASS  (guárdala)"
    fi
  done
  [ -n "$AEMAIL" ] && sed "${SED_I[@]}" "s|^ADMIN_EMAIL=.*|ADMIN_EMAIL=$(esc "$AEMAIL")|" .env
  sed "${SED_I[@]}" "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$(esc "$APASS")|" .env
fi

echo "Levantando app + base de datos..."
docker compose up -d --build

PORT=$(grep '^APP_PORT=' .env | cut -d= -f2)
PORT=${PORT:-8080}
echo ""
echo "Listo. Abre http://localhost:$PORT"
echo "Entra con el correo y la contraseña de administrador que definiste en .env."
# v5.3.29 (H-A5): las claves generadas se imprimen al final para guardarlas.
if [ -n "$GEN_PGPASS" ] || [ -n "$GEN_APASS" ]; then
  echo ""
  echo "Claves generadas automáticamente (guárdalas, no se vuelven a mostrar):"
  [ -n "$GEN_PGPASS" ] && echo "  Base de datos: $GEN_PGPASS"
  [ -n "$GEN_APASS" ] && echo "  Administrador: $GEN_APASS"
fi
echo "Después de entrar, cambia la contraseña desde Equipo y conecta WhatsApp en Canales WhatsApp (escanea el QR)."
