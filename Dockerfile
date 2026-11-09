# CRM — Dockerfile multi-etapa (v5.3.26, B8).
# Etapa 1 (build): instala TODAS las dependencias (incluidas las de
# desarrollo: vite, typescript) y compila el frontend.
# Etapa 2 (runtime): solo dependencias de producción
# (npm ci --omit=dev) y la app corre como usuario no-root (node).
# Antes la imagen final llevaba vite/typescript y el proceso corría
# como root.
#
# Nota para instalaciones existentes: los volúmenes nombrados creados
# con la imagen vieja pertenecen a root. Tras actualizar, si la app no
# puede escribir en /app/uploads, ejecuta una vez:
#   docker compose run --rm --user root app chown -R node:node /app/uploads /app/backups /app/.wwebjs_auth
# (los volúmenes nuevos ya nacen con el dueño correcto, porque los
# directorios de la imagen son de node y Docker copia su dueño al
# crear el volumen).

# ---------- Etapa 1: compilación ----------
FROM node:22-slim AS build

WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# El build (Vite) no necesita Chrome: no descargarlo aquí ahorra
# tiempo y evita confusión. Chrome se descarga solo en la etapa de
# ejecución, donde sí hace falta (WhatsApp por QR).
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Instalar dependencias (todas: el build necesita vite y typescript)
RUN npm ci

# Copiar el resto del código
COPY . .

# Construir el frontend (Vite)
RUN npm run build

# ---------- Etapa 2: ejecución ----------
FROM node:22-slim

# Instalar dependencias necesarias para Chrome/Puppeteer
# (gconf-service, libgconf-2-4 y libappindicator1 se quitaron: no existen
# en Debian 12/Bookworm y rompían el build de la imagen.)
# postgresql-client: el trabajo de respaldo de docker-compose usa
# pg_dump desde esta misma imagen. wget: lo usa el HEALTHCHECK.
RUN apt-get update && apt-get install -y \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libfontconfig1 \
    libgcc1 \
    libgdk-pixbuf2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    libxkbcommon0 \
    ca-certificates \
    fonts-liberation \
    libnss3 \
    lsb-release \
    xdg-utils \
    wget \
    libgbm-dev \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Crear directorio de la aplicación
WORKDIR /app

# v5.3.27 (corrección urgente de B8): dónde vive Chrome.
# Puppeteer descarga Chrome al instalarse (`npm ci`) en
# $PUPPETEER_CACHE_DIR, o en ~/.cache/puppeteer si no está definido.
# En la v5.3.26 no estaba definido: el `npm ci` de ejecución corría
# como root y Chrome quedaba en /root/.cache/puppeteer, pero la app
# corre como usuario `node` y lo buscaba en /home/node/.cache/puppeteer
# -> "Could not find Chrome" y WhatsApp caído en producción.
# Ahora el caché vive dentro de /app (con dueño node por el chown de
# abajo) y la variable queda en la imagen, así que en ejecución
# Puppeteer lo encuentra ahí.
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

# Solo dependencias de producción (sin vite/typescript/terser).
COPY package*.json ./
RUN npm ci --omit=dev

# Código del servidor + frontend compilado + scripts de mantenimiento
# (respaldo de docker-compose y descifrado de respaldos).
COPY server.js ./
COPY scripts ./scripts
COPY --from=build /app/dist ./dist

# Entrypoint (v5.3.28): el contenedor arranca como root SOLO para
# arreglar el dueño de los volúmenes (ver entrypoint.sh) y luego baja
# privilegios. Por eso aquí NO hay `USER node`: el entrypoint es quien
# ejecuta la app como node. Sin esto, el volumen de Railway (creado
# cuando la app corría como root) pertenece a root y `node` no puede
# crear la sesión de WhatsApp (EACCES) ni Chrome su perfil (Code: 21).
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Directorios que la app escribe (archivos subidos, sesión de WhatsApp
# QR y respaldos) con dueño node: los volúmenes nuevos heredan este
# dueño al crearse.
RUN mkdir -p /app/uploads /app/.wwebjs_auth /app/backups \
  && chown -R node:node /app

# Exponer el puerto 3000
EXPOSE 3000

# Salud: el monitor externo y Docker usan /api/health (no necesita login ni DB).
# v5.3.1: usa $PORT (Railway asigna un puerto distinto; en VPS/Docker Compose
# sigue siendo 3000). Sin esto, el chequeo de salud fallaba en Railway.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/api/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]

# Comando para iniciar la aplicación (el entrypoint lo ejecuta como node).
CMD ["npm", "start"]
