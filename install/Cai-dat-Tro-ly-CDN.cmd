@echo off
chcp 65001 >nul
title Cài đặt Trợ lý CDN
echo.
echo   Đang tải bộ cài Trợ lý CDN, vui lòng chờ...
echo.
rem Tải bộ cài mới nhất từ GitHub Releases rồi chạy. Đặt CDN_INSTALLER_URL để thử bộ cài khác.
if "%CDN_INSTALLER_URL%"=="" set "CDN_INSTALLER_URL=https://github.com/nextstepacademyvietnam/tro-ly-cdn/releases/latest/download/install.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $f=Join-Path $env:TEMP 'tro-ly-cdn-install.ps1'; try { Invoke-WebRequest -UseBasicParsing -Uri $env:CDN_INSTALLER_URL -OutFile $f } catch { Write-Host '  Không tải được bộ cài. Kiểm tra mạng rồi bấm đúp lại file này.' -ForegroundColor Red; exit 1 }; & $f; exit $LASTEXITCODE"
echo.
pause
