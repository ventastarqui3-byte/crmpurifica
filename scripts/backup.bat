@echo off
REM Respaldo de la base de datos del CRM (Postgres) con pg_dump - Windows.
REM Requiere pg_dump en el PATH y DATABASE_URL definida. El respaldo diario
REM automatico ya lo hace el servidor a las 02:00; esto es para hacerlo a mano.
REM   set DATABASE_URL=postgres://purifica:CLAVE@localhost:5432/purifica
REM   scripts\backup.bat
REM Restaurar un respaldo (borra los datos actuales y los reemplaza):
REM   descomprime el .zip y luego:  psql "%DATABASE_URL%" -f backups\purifica-AAAA-MM-DD-HHmm.sql
setlocal
if "%DATABASE_URL%"=="" (
  echo Falta DATABASE_URL. Ejemplo:
  echo   set DATABASE_URL=postgres://purifica:CLAVE@localhost:5432/purifica
  exit /b 1
)
where pg_dump >nul 2>nul
if errorlevel 1 (
  echo pg_dump no esta instalado. Instala PostgreSQL y agrega su carpeta bin al PATH.
  exit /b 1
)
if not exist backups mkdir backups
for /f %%a in ('powershell -Command "Get-Date -Format yyyy-MM-dd-HHmm"') do set STAMP=%%a
set FILE=backups\purifica-%STAMP%.sql
pg_dump "%DATABASE_URL%" > "%FILE%"
if errorlevel 1 (
  echo El respaldo fallo.
  exit /b 1
)
powershell -Command "Compress-Archive -Path '%FILE%' -DestinationPath '%FILE%.zip' -Force; Remove-Item '%FILE%'"
echo Respaldo guardado en %FILE%.zip
REM Borrar respaldos de mas de 7 dias:
forfiles /p backups /m purifica-*.sql.zip /d -7 /c "cmd /c del @path" 2>nul
endlocal
