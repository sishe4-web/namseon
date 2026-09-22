@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js LTS is required. Install it from https://nodejs.org/ then run this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies...
  npm install
)
echo.
echo 17步 server starting...
echo Open http://localhost:3000
npm start
pause
