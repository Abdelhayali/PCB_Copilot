@echo off
rem CircuitPilot: start the app server (and optionally a public Cloudflare link).
cd /d "%~dp0"
if not exist access-password.txt (
  echo No access-password.txt found - create one with your login password, or remove --password-file below.
)
start "CircuitPilot server" python server.py 5173 --allow-ports 8080 --password-file access-password.txt
timeout /t 2 >nul
echo.
echo CircuitPilot is running:
echo   This PC:      http://localhost:5173
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo   Same Wi-Fi:  http:%%a:5173
echo.
where cloudflared >nul 2>nul
if %errorlevel%==0 (
  choice /c YN /m "Also open a public link (Cloudflare tunnel) for use from anywhere"
  if errorlevel 2 goto end
  start "CircuitPilot public link" cloudflared tunnel --url http://localhost:5173
  echo The public https://...trycloudflare.com link appears in the "CircuitPilot public link" window.
)
:end
start "" http://localhost:5173
