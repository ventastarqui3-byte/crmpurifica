# Usar una imagen base de Node.js con soporte para Puppeteer (necesario para whatsapp-web.js)
FROM node:22-slim

# Instalar dependencias necesarias para Chrome/Puppeteer
# (gconf-service, libgconf-2-4 y libappindicator1 se quitaron: no existen
# en Debian 12/Bookworm y rompían el build de la imagen.)
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

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias
RUN npm ci

# Copiar el resto del código
COPY . .

# Construir el frontend (Vite)
RUN npm run build

# Exponer el puerto 3000
EXPOSE 3000

# Salud: el monitor externo y Docker usan /api/health (no necesita login ni DB).
# v5.3.1: usa $PORT (Railway asigna un puerto distinto; en VPS/Docker Compose
# sigue siendo 3000). Sin esto, el chequeo de salud fallaba en Railway.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/api/health || exit 1

# Comando para iniciar la aplicación
CMD ["npm", "start"]
