@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   GameApi - quick setup (Windows / dev)
echo ============================================
echo.

rem --- prerequisites -------------------------------------------------
where node >nul 2>&1 || (echo [ERROR] Node.js 20+ not found. Install it from https://nodejs.org and re-run. & pause & exit /b 1)
where npm  >nul 2>&1 || (echo [ERROR] npm not found ^(comes with Node.js^). & pause & exit /b 1)

for /f "delims=" %%v in ('node -v') do set "NODEV=%%v"
echo Using Node %NODEV%
echo.

rem --- 1) dependencies ----------------------------------------------
echo [1/3] Installing dependencies ^(npm install^)...
call npm install || (echo [ERROR] npm install failed. & pause & exit /b 1)
echo.

rem --- 2) .env ------------------------------------------------------
echo [2/3] Preparing .env...
if exist ".env" (
  echo   .env already exists - keeping it.
) else (
  copy /y ".env.example" ".env" >nul
  echo   .env created from .env.example - REMEMBER to set API_KEYS before running.
)
echo.

rem --- 3) build -----------------------------------------------------
echo [3/3] Building ^(npm run build^)...
call npm run build || (echo [ERROR] build failed. & pause & exit /b 1)
echo.

echo ============================================
echo   Done! Next steps:
echo     - Local dev (needs Postgres + Redis):  npm run dev
echo     - Everything via Docker:               docker compose up --build
echo ============================================
echo.
pause
endlocal
