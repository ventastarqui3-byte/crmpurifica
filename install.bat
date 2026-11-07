@echo off
REM Instalador de Purifica CRM v5.3 — Windows
REM Uso: doble clic en install.bat (con Docker Desktop instalado y corriendo)
cd /d "%~dp0"
echo == Purifica CRM v5.3 — Instalador ==
where docker >nul 2>&1
if errorlevel 1 (
  echo ERROR: Docker no esta instalado o Docker Desktop no esta corriendo.
  echo Instalalo desde https://docs.docker.com/desktop/ y vuelve a correr install.bat
  pause
  exit /b 1
)
if not exist .env (
  copy .env.example .env >nul
  echo Se creo .env desde .env.example.
)

REM Generar JWT_SECRET si esta vacio (PowerShell, hex aleatorio de 32 bytes)
findstr /R /C:"^JWT_SECRET=$" .env >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%S in ('powershell -NoProfile -Command "[System.Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))"') do set "JWTSECRET=%%S"
  powershell -NoProfile -Command "(Get-Content .env) | ForEach-Object { $_.Replace('JWT_SECRET=', 'JWT_SECRET=%JWTSECRET%') } | Set-Content .env"
  echo JWT_SECRET generado.
)

REM Pedir clave de Postgres si sigue la de ejemplo
findstr /R /C:"^POSTGRES_PASSWORD=cambia-esta-clave$" .env >nul 2>&1
if not errorlevel 1 (
  set /p "PGPASS=Clave de la base de datos (se usara para Postgres): "
  if not "%PGPASS%"=="" powershell -NoProfile -Command "(Get-Content .env) | ForEach-Object { $_.Replace('POSTGRES_PASSWORD=cambia-esta-clave', 'POSTGRES_PASSWORD=' + $env:PGPASS) } | Set-Content .env"
)

REM Pedir admin inicial si sigue la clave de ejemplo
findstr /R /C:"^ADMIN_PASSWORD=cambia-esta-clave$" .env >nul 2>&1
if not errorlevel 1 (
  set /p "AEMAIL=Correo del administrador inicial [admin@purifica.com]: "
  set /p "APASS=Contrasena del administrador inicial: "
  if not "%AEMAIL%"=="" powershell -NoProfile -Command "(Get-Content .env) | ForEach-Object { if ($_ -match '^ADMIN_EMAIL=') { 'ADMIN_EMAIL=' + $env:AEMAIL } else { $_ } } | Set-Content .env"
  if not "%APASS%"=="" powershell -NoProfile -Command "(Get-Content .env) | ForEach-Object { $_.Replace('ADMIN_PASSWORD=cambia-esta-clave', 'ADMIN_PASSWORD=' + $env:APASS) } | Set-Content .env"
)

echo Levantando app + base de datos...
docker compose up -d --build
for /f "tokens=2 delims==" %%P in ('findstr /R /C:"^APP_PORT=" .env') do set "APPPORT=%%P"
if "%APPPORT%"=="" set "APPPORT=8080"
echo.
echo Listo. Abre http://localhost:%APPPORT%
echo Entra con el correo y la contrasena de administrador definidos en .env (ADMIN_EMAIL / ADMIN_PASSWORD).
echo Despues de entrar, cambia la contrasena desde Equipo y conecta WhatsApp en Canales WhatsApp (escanea el QR).
pause
