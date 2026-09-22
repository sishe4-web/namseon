@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  npm install
)
echo.
echo 17步 server starting...
echo Open http://localhost:3000
npm start
pause
