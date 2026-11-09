@echo off
REM EnableDelayedExpansion: las variables que se asignan dentro de un
REM bloque ( ) solo se leen bien con !VAR! (con %VAR% se lee el valor
REM de ANTES del bloque). Sin esto, las claves pedidas no se guardaban.
setlocal EnableDelayedExpansion
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
  powershell -NoProfile -Command "(Get-Content .env) | ForEach-Object { $_.Replace('JWT_SECRET=', 'JWT_SECRET=!JWTSECRET!') } | Set-Content .env"
  echo JWT_SECRET generado.
)

REM Pedir clave de Postgres si está vacía o sigue la de ejemplo.
REM Enter genera una aleatoria segura; si se escribe una, mínimo 12 caracteres.
REM v5.3.29 (H-A5): antes, pulsar Enter dejaba la clave pública 'cambia-esta-clave'.
set "GEN_PGPASS="
findstr /R /C:"^POSTGRES_PASSWORD=$" /C:"^POSTGRES_PASSWORD=cambia-esta-clave$" .env >nul 2>&1
if not errorlevel 1 (
  set /p "PGPASS=Clave de la base de datos (Enter = generar una aleatoria segura): "
  if "!PGPASS!"=="" (
    for /f "delims=" %%S in ('powershell -NoProfile -Command "[System.Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24))"') do set "PGPASS=%%S"
    set "GEN_PGPASS=!PGPASS!"
    echo Clave generada: !PGPASS!  (guardala, no se vuelve a mostrar)
  )
  powershell -NoProfile -Command "if ($env:PGPASS.Length -lt 12) { exit 1 }" >nul 2>&1
  if errorlevel 1 (
    echo La clave debe tener al menos 12 caracteres.
    set /p "PGPASS=Clave de la base de datos (Enter = generar una): "
    if "!PGPASS!"=="" (
      for /f "delims=" %%S in ('powershell -NoProfile -Command "[System.Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24))"') do set "PGPASS=%%S"
      set "GEN_PGPASS=!PGPASS!"
      echo Clave generada: !PGPASS!  (guardala, no se vuelve a mostrar)
    )
  )
  powershell -NoProfile -Command "if ($env:PGPASS.Length -lt 12) { exit 1 }" >nul 2>&1
  if errorlevel 1 (
    echo La clave sigue corta: se genera una aleatoria segura.
    for /f "delims=" %%S in ('powershell -NoProfile -Command "[System.Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24))"') do set "PGPASS=%%S"
    set "GEN_PGPASS=!PGPASS!"
    echo Clave generada: !PGPASS!  (guardala, no se vuelve a mostrar)
  )
  powershell -NoProfile -Command "(Get-Content .env) | ForEach-Object { if ($_ -match '^POSTGRES_PASSWORD=') { 'POSTGRES_PASSWORD=' + $env:PGPASS } else { $_ } } | Set-Content .env"
)

REM Pedir admin inicial si la clave está vacía o sigue la de ejemplo.
set "GEN_APASS="
findstr /R /C:"^ADMIN_PASSWORD=$" /C:"^ADMIN_PASSWORD=cambia-esta-clave$" .env >nul 2>&1
if not errorlevel 1 (
  set /p "AEMAIL=Correo del administrador inicial [admin@purifica.com]: "
  set /p "APASS=Contrasena del administrador inicial (Enter = generar una aleatoria segura): "
  if "!APASS!"=="" (
    for /f "delims=" %%S in ('powershell -NoProfile -Command "[System.Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24))"') do set "APASS=%%S"
    set "GEN_APASS=!APASS!"
    echo Contrasena generada: !APASS!  (guardala, no se vuelve a mostrar)
  )
  powershell -NoProfile -Command "if ($env:APASS.Length -lt 12) { exit 1 }" >nul 2>&1
  if errorlevel 1 (
    echo La contrasena debe tener al menos 12 caracteres.
    set /p "APASS=Contrasena del administrador inicial (Enter = generar una): "
    if "!APASS!"=="" (
      for /f "delims=" %%S in ('powershell -NoProfile -Command "[System.Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24))"') do set "APASS=%%S"
      set "GEN_APASS=!APASS!"
      echo Contrasena generada: !APASS!  (guardala, no se vuelve a mostrar)
    )
  )
  powershell -NoProfile -Command "if ($env:APASS.Length -lt 12) { exit 1 }" >nul 2>&1
  if errorlevel 1 (
    echo La contrasena sigue corta: se genera una aleatoria segura.
    for /f "delims=" %%S in ('powershell -NoProfile -Command "[System.Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24))"') do set "APASS=%%S"
    set "GEN_APASS=!APASS!"
    echo Contrasena generada: !APASS!  (guardala, no se vuelve a mostrar)
  )
  if not "!AEMAIL!"=="" powershell -NoProfile -Command "(Get-Content .env) | ForEach-Object { if ($_ -match '^ADMIN_EMAIL=') { 'ADMIN_EMAIL=' + $env:AEMAIL } else { $_ } } | Set-Content .env"
  powershell -NoProfile -Command "(Get-Content .env) | ForEach-Object { if ($_ -match '^ADMIN_PASSWORD=') { 'ADMIN_PASSWORD=' + $env:APASS } else { $_ } } | Set-Content .env"
)

echo Levantando app + base de datos...
docker compose up -d --build
for /f "tokens=2 delims==" %%P in ('findstr /R /C:"^APP_PORT=" .env') do set "APPPORT=%%P"
if "%APPPORT%"=="" set "APPPORT=8080"
echo.
echo Listo. Abre http://localhost:%APPPORT%
echo Entra con el correo y la contrasena de administrador definidos en .env (ADMIN_EMAIL / ADMIN_PASSWORD).
REM v5.3.29 (H-A5): las claves generadas se imprimen al final para guardarlas.
if not "%GEN_PGPASS%"=="" echo   Base de datos: %GEN_PGPASS%
if not "%GEN_APASS%"=="" echo   Administrador: %GEN_APASS%
echo Despues de entrar, cambia la contrasena desde Equipo y conecta WhatsApp en Canales WhatsApp (escanea el QR).
pause
